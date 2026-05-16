/**
 * Bundled scenarios for the CLI's `--script=<name>` flag. Each factory
 * accepts a `Record<string,string>` of CLI-supplied args and returns a
 * `ScenarioFn` ready to hand to `SwgClient.fullLifecycle({ script })`.
 *
 * Add a new scenario:
 *   1. Define a factory below.
 *   2. Add it to the `scenarios` map at the bottom.
 *   3. Document its args.
 */

import { ByteStream } from '../archive/byte-stream.js';
import type { Posture, ScenarioFn, ScriptContext } from '../client/script/context.js';
import { CLIENT_TO_AUTH_SERVER_FLAGS } from '../messages/game/command-queue/index.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import {
  ObjControllerSubtypeIds,
  TradeMessageId,
  TradeStartDecoder,
  TradeStartKind,
} from '../messages/game/obj-controller/index.js';
import type { NetworkId } from '../types.js';

export type ScenarioFactory = (args: Record<string, string>) => ScenarioFn;

/** Walk in a straight line from spawn to (x, z) then idle for `holdMs`. */
export const walkLine: ScenarioFactory = (args) => {
  const x = numArg(args, 'x', 0);
  const z = numArg(args, 'z', 0);
  const speed = numArg(args, 'speed', 5);
  const holdMs = numArg(args, 'holdMs', 1000);
  return async (ctx) => {
    await ctx.walkTo({ x, z }, { speed });
    if (holdMs > 0) await ctx.wait(holdMs);
  };
};

/** Walk a circle centred on (centerX, centerZ) (defaults to current pos) for `durationMs`. */
export const walkCircle: ScenarioFactory = (args) => {
  const radius = numArg(args, 'radius', 8);
  const durationMs = numArg(args, 'durationMs', 5000);
  const speed = args.speed !== undefined ? Number(args.speed) : undefined;
  const direction = args.direction === '-1' ? -1 : 1;
  return async (ctx) => {
    const cur = ctx.position();
    const centerX = args.centerX !== undefined ? Number(args.centerX) : cur.x;
    const centerZ = args.centerZ !== undefined ? Number(args.centerZ) : cur.z;
    await ctx.walkCircle({
      centerX,
      centerZ,
      radius,
      durationMs,
      direction,
      ...(speed !== undefined ? { speed } : {}),
    });
  };
};

/** Open the player's inventory, hold for `holdMs`, then close (no-op on wire). */
export const openInventory: ScenarioFactory = (args) => {
  const holdMs = numArg(args, 'holdMs', 2000);
  return async (ctx) => {
    ctx.openPlayerInventory();
    if (holdMs > 0) await ctx.wait(holdMs);
    ctx.closeContainer(ctx.sceneStart.playerNetworkId);
  };
};

/** Just idle for `durationMs` — useful as a sanity baseline. */
export const dwell: ScenarioFactory = (args) => {
  const durationMs = numArg(args, 'durationMs', 5000);
  return async (ctx) => {
    if (durationMs > 0) await ctx.wait(durationMs);
  };
};

/**
 * Queue `attack` against a fixed target every ~tickMs for durationMs.
 *
 * Args:
 *   targetId   (required) hex (0x...) or decimal NetworkId of the victim
 *   durationMs (default 5000) total attack window
 *   tickMs     (default 1000) cadence between enqueues
 */
export const combatAttack: ScenarioFactory = (args) => {
  const targetId = networkIdArg(args, 'targetId');
  const durationMs = numArg(args, 'durationMs', 5000);
  const tickMs = numArg(args, 'tickMs', 1000);
  if (tickMs <= 0) {
    throw new Error(`combat-attack: tickMs must be > 0 (got ${tickMs})`);
  }
  return async (ctx) => {
    const deadline = Date.now() + durationMs;
    // Emit one immediately, then re-queue every tickMs until durationMs elapses.
    ctx.attackTarget(targetId);
    while (Date.now() + tickMs <= deadline) {
      await ctx.wait(tickMs);
      ctx.attackTarget(targetId);
    }
  };
};

/**
 * Cycle through postures (standing → crouched → prone → standing) every
 * `tickMs` for `durationMs`. Useful as a visual smoke test that the
 * combat-engine wiring round-trips end to end.
 *
 * Args:
 *   durationMs (default 5000)
 *   tickMs     (default 1000) ms between posture changes
 */
export const postureCycle: ScenarioFactory = (args) => {
  const durationMs = numArg(args, 'durationMs', 5000);
  const tickMs = numArg(args, 'tickMs', 1000);
  if (tickMs <= 0) {
    throw new Error(`posture-cycle: tickMs must be > 0 (got ${tickMs})`);
  }
  const sequence: Posture[] = ['standing', 'crouched', 'prone', 'standing'];
  return async (ctx) => {
    const deadline = Date.now() + durationMs;
    let i = 0;
    ctx.changePosture(sequence[i++ % sequence.length] as Posture);
    while (Date.now() + tickMs <= deadline) {
      await ctx.wait(tickMs);
      ctx.changePosture(sequence[i++ % sequence.length] as Posture);
    }
  };
};

/**
 * Issue a survey command and dwell briefly for any response.
 *
 * Args:
 *   toolId            (required) hex (0x...) or decimal NetworkId of the survey tool
 *   resourceTypeName  (required) the specific resource type name to survey for
 *                     (e.g. "Resotine") — NOT a class name like "mineral"
 *   waitMs            (default 2000) how long to dwell after the request
 *
 * Discover legal `resourceTypeName` values for a tool by calling
 * `ctx.fetchSurveyResources(toolId)` first.
 *
 * The scenario fires the requestsurvey unconditionally (useful for wire
 * regression coverage) and tolerates silence — if the server's TaskSurvey
 * doesn't broadcast a SurveyMessage, the scenario still exits cleanly.
 */
export const surveyScenario: ScenarioFactory = (args) => {
  const toolId = networkIdArg(args, 'toolId');
  const resourceTypeName = args.resourceTypeName;
  if (resourceTypeName === undefined || resourceTypeName === '') {
    throw new Error(`survey scenario: --script-arg=resourceTypeName=<name> is required (must be a specific resource type, not a class)`);
  }
  const waitMs = numArg(args, 'waitMs', 2_000);
  return async (ctx) => {
    ctx.survey(toolId, resourceTypeName);
    if (waitMs > 0) await ctx.wait(waitMs);
  };
};

/**
 * Two-client group-and-trade scenario. Use with Fleet: launch 2 clients
 * where one's script is `groupTradeScenario({ role: 'leader', otherId: ... })`
 * and the other's is `groupTradeScenario({ role: 'invitee', otherId: ... })`.
 *
 * Wire flow (subtype IDs from `ObjControllerSubtypeIds`):
 *   1. Leader  → `useAbility('invite', otherId)` (command_table.tab:'invite')
 *                Server forwards as `CM_setGroupInviter` (351) to the invitee.
 *   2. Invitee → waits for inbound `ObjControllerMessage` with
 *                `message === CM_setGroupInviter`, then `useAbility('join')`
 *                (command_table.tab:'join') to accept.
 *                Server confirms with `CM_setGroup` (421) to both sides.
 *   3. Both    → wait for `CM_setGroup` (421) with non-zero groupId.
 *   4. Leader  → if `tradeAmount > 0`, attempt to open trade window via a
 *                `CM_secureTrade` (277) ObjController with
 *                `TradeMessageId.RequestTrade`. The full trade handshake uses
 *                top-level SecureTrade messages (BeginTradeMessage,
 *                AddItemMessage, GiveMoneyMessage, AcceptTransactionMessage,
 *                VerifyTradeMessage, TradeCompleteMessage) that this client
 *                does NOT model yet — see SecureTradeMessages.h. The scenario
 *                sends the initial RequestTrade as a smoke test, dwells, and
 *                considers the step "best-effort" — it does NOT assert trade
 *                completion. The unmodeled trade-window step is documented
 *                in CLAUDE.md.
 *   5. Both    → leader sends `useAbility('disband')`, invitee sends
 *                `useAbility('leaveGroup')`. Fleet handles logout.
 *
 * Cross-client coordination is via shared scenario state — the driver
 * resolves each character's NetworkId via Stage 1+2 first, then passes
 * the OTHER character's id in as `otherId`. There is NO chat-based
 * rendezvous; the leader can call `invite` immediately because
 * `otherId` is already known.
 *
 * Args:
 *   role            (required) 'leader' or 'invitee'
 *   otherId         (required) NetworkId of the other character (hex or decimal)
 *   tradeAmount     (default 0) credits to ATTEMPT to transfer leader → invitee.
 *                   The actual transfer is unmodeled (see note above).
 *   waitForOtherMs  (default 8000) per-step timeout for cross-client waits.
 *   dwellMs         (default 1000) idle window before disbanding.
 */
export const groupTradeScenario: ScenarioFactory = (args) => {
  const role = args.role === 'invitee' ? 'invitee' : 'leader';
  if (args.role !== 'leader' && args.role !== 'invitee') {
    throw new Error(
      `group-trade: --script-arg=role=leader|invitee is required (got "${args.role ?? ''}")`,
    );
  }
  const otherId = networkIdArg(args, 'otherId');
  const tradeAmount = numArg(args, 'tradeAmount', 0);
  const waitForOtherMs = numArg(args, 'waitForOtherMs', 8_000);
  const dwellMs = numArg(args, 'dwellMs', 1_000);

  return async (ctx) => {
    if (role === 'leader') {
      // 1. Brief settle so the invitee is also zoned-in and listening.
      await ctx.wait(1_000);

      // 2. Send the invite.
      ctx.useAbility('invite', otherId);

      // 3. Wait for the group to form (inbound CM_setGroup with non-zero
      //    groupId). On timeout, `expectWithin({soft:true})` auto-records the
      //    failure to `assertionFailures` and returns undefined.
      await ctx.expectWithin(ObjControllerMessage, waitForOtherMs, {
        predicate: (m) => {
          if (m.message !== ObjControllerSubtypeIds.CM_setGroup) return false;
          // Look at the decoded trailer for a non-zero groupId.
          const sub = m.decodedSubtype;
          if (sub === null || sub.kind !== 'GroupAccept') return true;
          const data = sub.data as { groupId: bigint };
          return data.groupId !== 0n;
        },
        soft: true,
      });

      // 4. Trade attempt (best-effort — see scenario docs above).
      if (tradeAmount > 0) {
        // Send the RequestTrade ObjController as a smoke test. The full
        // trade-window flow uses unmodeled top-level SecureTrade messages.
        sendRequestTrade(ctx, otherId, ctx.sceneStart.playerNetworkId);
        await ctx.wait(500);
      }

      // 5. Brief dwell, then disband + let Fleet handle logout.
      if (dwellMs > 0) await ctx.wait(dwellMs);
      ctx.useAbility('disband');
      await ctx.wait(300);
    } else {
      // Invitee side.

      // 1. Wait for the inbound GroupInvite (CM_setGroupInviter with non-empty
      //    inviter). On timeout the soft expectWithin auto-records the failure.
      const invite = await ctx.expectWithin(ObjControllerMessage, waitForOtherMs, {
        predicate: (m) => {
          if (m.message !== ObjControllerSubtypeIds.CM_setGroupInviter) return false;
          // The "clear inviter" form has inviterId == 0n; we want the real invite.
          const sub = m.decodedSubtype;
          if (sub === null || sub.kind !== 'GroupInvite') return true;
          const data = sub.data as { inviterId: bigint };
          return data.inviterId !== 0n;
        },
        soft: true,
      });
      if (invite !== undefined) {
        // 2. Accept the invite.
        ctx.useAbility('join');

        // 3. Wait for the group-formation confirmation.
        await ctx.expectWithin(ObjControllerMessage, waitForOtherMs, {
          predicate: (m) => {
            if (m.message !== ObjControllerSubtypeIds.CM_setGroup) return false;
            const sub = m.decodedSubtype;
            if (sub === null || sub.kind !== 'GroupAccept') return true;
            const data = sub.data as { groupId: bigint };
            return data.groupId !== 0n;
          },
          soft: true,
        });
      }

      // 4. Dwell to let the leader's trade attempt land (if any).
      if (dwellMs > 0) await ctx.wait(dwellMs);

      // 5. Leave the group, then let Fleet handle logout.
      ctx.useAbility('leaveGroup');
      await ctx.wait(300);
    }
  };
};

/**
 * Send a `CM_secureTrade` ObjController with `tradeMessageId =
 * RequestTrade` to open a trade window. This is the FIRST message of the
 * secure-trade handshake; the rest of the handshake uses top-level
 * SecureTradeMessages (BeginTradeMessage / AddItemMessage / GiveMoneyMessage /
 * AcceptTransactionMessage / VerifyTradeMessage / TradeCompleteMessage)
 * that are NOT yet modeled in this client. Use this as a smoke test only.
 */
function sendRequestTrade(
  ctx: ScriptContext,
  recipientId: NetworkId,
  initiatorId: NetworkId,
): void {
  // Build the trailer for the CM_secureTrade subtype manually since there's
  // no ScriptContext helper for it.
  const stream = new ByteStream();
  const tradeData = {
    tradeMessageId: TradeMessageId.RequestTrade,
    initiatorId,
    recipientId,
  };
  TradeStartDecoder.encode(stream, tradeData);
  const wrapped = new ObjControllerMessage(
    CLIENT_TO_AUTH_SERVER_FLAGS,
    ObjControllerSubtypeIds.CM_secureTrade,
    initiatorId,
    0,
    stream.toBytes(),
    { kind: TradeStartKind, data: tradeData },
  );
  ctx.send(wrapped);
}

export const scenarios: Record<string, ScenarioFactory> = {
  'walk-line': walkLine,
  'walk-circle': walkCircle,
  'open-inventory': openInventory,
  'combat-attack': combatAttack,
  'posture-cycle': postureCycle,
  survey: surveyScenario,
  'group-trade': groupTradeScenario,
  dwell,
};

function numArg(args: Record<string, string>, key: string, defaultValue: number): number {
  const raw = args[key];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`scenario arg --script-arg=${key}=${raw} is not a number`);
  }
  return n;
}

/**
 * Parse a required NetworkId from `args[key]`. Accepts:
 *   - hex literal:  "0xdeadbeef"  / "0xDEADBEEF"
 *   - decimal:      "16039260784"
 *
 * Throws with a clear error if the arg is missing or unparseable.
 */
function networkIdArg(args: Record<string, string>, key: string): NetworkId {
  const raw = args[key];
  if (raw === undefined || raw === '') {
    throw new Error(`missing required scenario arg --script-arg=${key}=<NetworkId>`);
  }
  try {
    return BigInt(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`scenario arg --script-arg=${key}=${raw} is not a valid NetworkId (${reason})`);
  }
}
