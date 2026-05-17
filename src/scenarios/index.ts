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

import type { Posture, ScenarioFn } from '../client/script/context.js';
import {
  DeltasMessage,
  decodeGroupDelta,
  decodeGroupInviterDelta,
} from '../messages/game/baselines/deltas-message.js';
import { ObjectTypeTags } from '../messages/game/baselines/registry.js';
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
 * Queue `attack` against a target every ~tickMs for durationMs.
 *
 * When `targetId` is omitted, the scenario auto-resolves a victim from the
 * live `WorldModel` via the Wave-A sugar API:
 *   - `mode=manual` (default) → `ctx.findNearest(CREO, { maxRadiusM: 40 })`
 *   - `mode=hostile`          → `ctx.nearestHostile({ maxRadiusM: 40 })`
 * If nothing matches, the scenario soft-fails via `ctx.fail('no target')`
 * and returns without sending any commands.
 *
 * Args:
 *   targetId   (optional) hex (0x...) or decimal NetworkId of the victim.
 *                         When omitted, auto-resolved from `ctx.world`.
 *   mode       (default 'manual') 'manual' picks any nearby CREO;
 *                                 'hostile' restricts to CREOs whose
 *                                 SHARED_NP `inCombat` flag is set.
 *   durationMs (default 5000) total attack window
 *   tickMs     (default 1000) cadence between enqueues
 */
export const combatAttack: ScenarioFactory = (args) => {
  const hasTargetId = args.targetId !== undefined && args.targetId !== '';
  const targetId: NetworkId | null = hasTargetId ? networkIdArg(args, 'targetId') : null;
  const mode = args.mode === 'hostile' ? 'hostile' : 'manual';
  const durationMs = numArg(args, 'durationMs', 5000);
  const tickMs = numArg(args, 'tickMs', 1000);
  if (tickMs <= 0) {
    throw new Error(`combat-attack: tickMs must be > 0 (got ${tickMs})`);
  }
  return async (ctx) => {
    let victim = targetId;
    if (victim === null) {
      const found =
        mode === 'hostile'
          ? ctx.nearestHostile({ maxRadiusM: 40 })
          : ctx.findNearest(ObjectTypeTags.CREO, { maxRadiusM: 40 });
      if (found === undefined) {
        ctx.fail('no target');
        return;
      }
      victim = found.id;
    }
    const deadline = Date.now() + durationMs;
    // Emit one immediately, then re-queue every tickMs until durationMs elapses.
    ctx.attackTarget(victim);
    while (Date.now() + tickMs <= deadline) {
      await ctx.wait(tickMs);
      ctx.attackTarget(victim);
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
    throw new Error(
      'survey scenario: --script-arg=resourceTypeName=<name> is required (must be a specific resource type, not a class)',
    );
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
 * Wire flow:
 *   1. Leader  → `useAbility('invite', otherId)` (command_table.tab:'invite')
 *                Server (authoritative for the invitee on a single-server
 *                cluster) sets `CreatureObject::m_groupInviter` directly via
 *                its AutoDeltaVariable; the change propagates to the invitee
 *                as a `DeltasMessage(target=inviteeId, typeId=CREO,
 *                packageId=SHARED_NP, idx=14)` carrying the
 *                `(inviterId, inviterName, inviterShipId)` triple. The
 *                cross-server `CM_setGroupInviter(351)` ObjController is
 *                ONLY used when the invite hops between auth servers —
 *                NOT on our single-server test cluster (see
 *                CreatureObject.cpp:5655-5676, the isAuthoritative branch).
 *   2. Invitee → waits for that DeltasMessage with a non-zero inviterId,
 *                then `useAbility('join')` (command_table.tab:'join').
 *                Server sets `CreatureObject::m_group` → propagated to both
 *                sides as `DeltasMessage(target=self, typeId=CREO,
 *                packageId=SHARED_NP, idx=13)` carrying the new groupId.
 *                The `CM_setGroup(421)` ObjController is again only sent
 *                cross-server (CreatureObject.cpp:5557-5618).
 *   3. Both    → wait for that group-id delta with a non-zero groupId.
 *   4. Leader  → if `tradeAmount > 0`, drives the FULL SecureTrade handshake
 *                via `ctx.tradeWith(otherId, { credits: tradeAmount })`. This
 *                sends `CM_secureTrade(RequestTrade)` → waits for
 *                `BeginTradeMessage` → `GiveMoneyMessage(credits)` →
 *                `AcceptTransactionMessage` → waits for `VerifyTradeMessage` →
 *                echoes `VerifyTradeMessage` back → waits for
 *                `TradeCompleteMessage`. Any failure is recorded as a soft
 *                assertion failure (`assertionFailures`). The handshake is
 *                fully wire-modeled — see src/messages/game/trade/.
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
 *   otherId         (optional) NetworkId of the other character (hex or decimal).
 *                   When omitted, the scenario auto-resolves via
 *                   `ctx.playersInRange(50)[0]`. If no other player is within
 *                   range, soft-fails via `ctx.fail('no other player in range')`
 *                   and returns.
 *   tradeAmount     (default 0) credits to transfer leader → invitee via the
 *                   full SecureTrade handshake. Skipped when 0.
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
  const hasOtherId = args.otherId !== undefined && args.otherId !== '';
  const otherIdArg: NetworkId | null = hasOtherId ? networkIdArg(args, 'otherId') : null;
  const tradeAmount = numArg(args, 'tradeAmount', 0);
  const waitForOtherMs = numArg(args, 'waitForOtherMs', 8_000);
  const dwellMs = numArg(args, 'dwellMs', 1_000);

  return async (ctx) => {
    const selfId = ctx.sceneStart.playerNetworkId;
    let otherId = otherIdArg;
    if (otherId === null) {
      const candidates = ctx.playersInRange(50);
      const other = candidates[0];
      if (other === undefined) {
        ctx.fail('no other player in range');
        return;
      }
      otherId = other.id;
    }

    if (role === 'leader') {
      // 0. Clear stale group state from any prior aborted test run.
      //    `disband` (= server's `groupDisband`) is a no-op when not in a
      //    group; safe to send unconditionally. Without this, a previous
      //    test that died mid-handshake leaves us as the leader of a stale
      //    group and the new invite hits `SID_GROUP_ALREADY_GROUPED` on
      //    our side. See CreatureObject.cpp:10010-10020 (the "already
      //    considering / already grouped" silent-reject branch).
      ctx.useAbility('disband');
      await ctx.wait(250);

      // 1. Brief settle so the invitee is also zoned-in and listening.
      await ctx.wait(1_000);

      // 2. Send the invite.
      ctx.useAbility('invite', otherId);

      // 3. Wait for the group to form. On a single-server cluster the server
      //    is authoritative for our own creature, so `setGroup` writes the
      //    `m_group` AutoDeltaVariable directly and propagates it to us as a
      //    `DeltasMessage(target=selfId, CREO, SHARED_NP, idx=13)` carrying
      //    the new groupId. (The `CM_setGroup(421)` ObjController is only
      //    used for cross-auth-server forwarding — see CreatureObject.cpp:5557.)
      //    On timeout, `expectWithin({soft:true})` records the failure to
      //    `assertionFailures` and returns undefined.
      await ctx.expectWithin(DeltasMessage, waitForOtherMs, {
        predicate: (m) => {
          if (m.target !== selfId) return false;
          const decoded = decodeGroupDelta(m);
          return decoded !== null && decoded.groupId !== 0n;
        },
        soft: true,
      });

      // 4. Drive the full SecureTrade handshake.
      if (tradeAmount > 0) {
        const result = await ctx.tradeWith(otherId, { credits: tradeAmount });
        if (!result.completed) {
          ctx.fail(
            `trade with ${otherId.toString()} did not complete (${result.abortReason ?? 'unknown'})`,
          );
        }
      }

      // 5. Brief dwell, then disband + let Fleet handle logout.
      if (dwellMs > 0) await ctx.wait(dwellMs);
      ctx.useAbility('disband');
      await ctx.wait(300);
    } else {
      // Invitee side.

      // 0. Clear stale group/invite state from any prior aborted run.
      //    The server's `groupDecline` clears `m_inviterForPendingGroup`
      //    iff it's set (no-op otherwise — CommandCppFuncs.cpp:3937), and
      //    `disband` (= server's `groupDisband`) leaves a stale group
      //    (also a no-op when not grouped). Without these, the leader's
      //    invite is silently dropped by the
      //    SID_GROUP_CONSIDERING_OTHER_GROUP / SID_GROUP_ALREADY_GROUPED
      //    branches in CreatureObject.cpp:10010-10020 — the m_groupInviter
      //    delta below never arrives and the wait times out.
      ctx.useAbility('decline');
      await ctx.wait(150);
      ctx.useAbility('disband');
      await ctx.wait(150);

      // 1. Wait for the inbound invite. On a single-server cluster the
      //    server writes the invitee's `m_groupInviter` AutoDeltaVariable
      //    directly (CreatureObject.cpp:5655-5676 isAuthoritative branch),
      //    so the invite arrives as a `DeltasMessage(target=selfId, CREO,
      //    SHARED_NP, idx=14)` rather than a `CM_setGroupInviter(351)`
      //    ObjController. The 351 controller path is cross-auth-server only.
      const invite = await ctx.expectWithin(DeltasMessage, waitForOtherMs, {
        predicate: (m) => {
          if (m.target !== selfId) return false;
          const decoded = decodeGroupInviterDelta(m);
          return decoded !== null && decoded.inviterId !== 0n;
        },
        soft: true,
      });
      if (invite !== undefined) {
        // 2. Accept the invite.
        ctx.useAbility('join');

        // 3. Wait for the group-formation confirmation (m_group delta on us).
        await ctx.expectWithin(DeltasMessage, waitForOtherMs, {
          predicate: (m) => {
            if (m.target !== selfId) return false;
            const decoded = decodeGroupDelta(m);
            return decoded !== null && decoded.groupId !== 0n;
          },
          soft: true,
        });
      }

      // 4. Dwell to let the leader's trade handshake land (if any).
      if (dwellMs > 0) await ctx.wait(dwellMs);

      // 5. Leave the group, then let Fleet handle logout.
      ctx.useAbility('leaveGroup');
      await ctx.wait(300);
    }
  };
};

/**
 * Call a vehicle from the datapad PCD, mount it, ride a circle at speeder
 * speed, dismount, and store. Smoke-tests the full vehicle wire flow end
 * to end.
 *
 * The datapad PCD id is the persistent control device for the vehicle —
 * it's in the player's datapad container. When omitted, the scenario
 * auto-resolves by scanning `ctx.world` for an object whose `templateName`
 * matches `/vehicle_control_device|_pcd\.iff/`. Pass `datapadItemId`
 * explicitly to keep CI runs deterministic.
 *
 * Wire flow:
 *   1. `ObjectMenuSelectMessage(datapadItemId, PET_CALL=45)` — spawns the
 *      vehicle creature beside the player. (Server-side: fires
 *      `pet_control_device.OnObjectMenuSelect(PET_CALL)` which calls
 *      `callable.callCallable(player, vehicle)`.)
 *   2. wait `settleMs` for the vehicle to materialize.
 *   3. `useAbility('mount', vehicleId)` — server validates and sets
 *      `States::RidingMount`. We set `mountedSpeedCap` to 12 m/s.
 *   4. `walkCircle(...)` — movement primitives clamp the requested speed
 *      to the mounted cap.
 *   5. `useAbility('dismount')` — clears the riding state.
 *   6. `ObjectMenuSelectMessage(vehicleId, PET_STORE=60)` — stores it
 *      back into the PCD.
 *
 * Args:
 *   datapadItemId  (optional) hex/decimal NetworkId of the datapad PCD.
 *                  When omitted, auto-resolved by scanning `ctx.world` for
 *                  a vehicle_control_device / _pcd object. If none found,
 *                  soft-fails via `ctx.fail('no vehicle PCD found')`.
 *   vehicleId      (optional) NetworkId of the spawned vehicle creature.
 *                  If omitted, the scenario tries to grab the most-recent
 *                  inbound CreateObjectByCrc that lands during `settleMs`;
 *                  otherwise it skips the mount step. Most CI flows know
 *                  the id ahead of time and pass it explicitly.
 *   radius         (default 30) circle radius in meters
 *   durationMs     (default 10000) circle duration
 *   speed          (default 12) requested speed; will be clamped by the
 *                  mounted cap
 *   settleMs       (default 1500) wait between call→mount and dismount→store
 *   skipMount      (default false) for transcript-only smoke tests:
 *                  only call/store, never mount
 */
export const rideVehicle: ScenarioFactory = (args) => {
  const hasDatapadItemId = args.datapadItemId !== undefined && args.datapadItemId !== '';
  const datapadItemIdArg: NetworkId | null = hasDatapadItemId
    ? networkIdArg(args, 'datapadItemId')
    : null;
  const radius = numArg(args, 'radius', 30);
  const durationMs = numArg(args, 'durationMs', 10_000);
  const speed = numArg(args, 'speed', 12);
  const settleMs = numArg(args, 'settleMs', 1_500);
  const skipMount = args.skipMount === '1' || args.skipMount === 'true';
  const vehicleIdRaw = args.vehicleId;
  const vehicleId = vehicleIdRaw !== undefined && vehicleIdRaw !== '' ? BigInt(vehicleIdRaw) : null;

  return async (ctx) => {
    let datapadItemId = datapadItemIdArg;
    if (datapadItemId === null) {
      const found = ctx.world.filter((o) =>
        /vehicle_control_device|_pcd\.iff/.test(o.templateName ?? ''),
      )[0];
      if (found === undefined) {
        ctx.fail('no vehicle PCD found');
        return;
      }
      datapadItemId = found.id;
    }

    ctx.callVehicle(datapadItemId);
    if (settleMs > 0) await ctx.wait(settleMs);

    if (skipMount || vehicleId === null) {
      if (settleMs > 0) await ctx.wait(settleMs);
      ctx.storeVehicle(vehicleId ?? datapadItemId);
      return;
    }

    ctx.mount(vehicleId);
    const cur = ctx.position();
    await ctx.walkCircle({
      centerX: cur.x,
      centerZ: cur.z,
      radius,
      durationMs,
      speed,
    });
    ctx.dismount();
    if (settleMs > 0) await ctx.wait(settleMs);
    ctx.storeVehicle(vehicleId);
  };
};

/**
 * Bid-and-snipe scenario for the bazaar / commodity marketplace.
 *
 * Two modes:
 *  - With `auctionId` set, fire a `BidAuctionMessage(auctionId, credits)`
 *    (fire-and-forget, no wait for response).
 *  - Without `auctionId`, browse the bazaar at `terminalId` for `browseMs`,
 *    then surface the top three lowest-priced listings via `ctx.fail(...)`
 *    (soft-log into `ScriptResult.assertionFailures`; no other console
 *    primitive exists from a scenario).
 *
 * When `terminalId` is omitted, the scenario auto-resolves by scanning
 * `ctx.world` for an object whose `templateName` matches
 * `/bazaar|commodities/i`, then picks the one nearest the player (2D
 * distance). Anything farther than 30m is rejected and the scenario
 * soft-fails via `ctx.fail('no bazaar terminal nearby')`.
 *
 * Args:
 *   terminalId  (optional) bazaar terminal NetworkId. When omitted,
 *               auto-resolved from `ctx.world` (must be within 30m).
 *   auctionId   (optional) when set, just bid; otherwise browse
 *   credits     (required iff auctionId is set) bid amount
 *   browseMs    (default 5000) wait window for the browse response
 */
export const bazaarSnipe: ScenarioFactory = (args) => {
  const hasTerminalId = args.terminalId !== undefined && args.terminalId !== '';
  const terminalIdArg: NetworkId | null = hasTerminalId ? networkIdArg(args, 'terminalId') : null;
  const hasAuctionId = args.auctionId !== undefined && args.auctionId !== '';
  const browseMs = numArg(args, 'browseMs', 5000);
  let auctionId: NetworkId | null = null;
  let credits = 0;
  if (hasAuctionId) {
    auctionId = networkIdArg(args, 'auctionId');
    credits = numArg(args, 'credits', -1);
    if (credits < 0) {
      throw new Error('bazaar-snipe: --script-arg=credits=<n> is required when auctionId is set');
    }
  }
  return async (ctx) => {
    if (auctionId !== null) {
      ctx.bidOn(auctionId, credits);
      return;
    }
    let terminalId = terminalIdArg;
    if (terminalId === null) {
      const here = ctx.position();
      const MAX_RADIUS_M = 30;
      const maxR2 = MAX_RADIUS_M * MAX_RADIUS_M;
      const candidates = ctx.world
        .filter((o) => /bazaar|commodities/i.test(o.templateName ?? ''))
        .map((o) => {
          const dx = o.position.x - here.x;
          const dz = o.position.z - here.z;
          return { obj: o, d2: dx * dx + dz * dz };
        })
        .sort((a, b) => a.d2 - b.d2);
      const nearest = candidates[0];
      if (nearest === undefined || nearest.d2 > maxR2) {
        ctx.fail('no bazaar terminal nearby');
        return;
      }
      terminalId = nearest.obj.id;
    }
    const listings = await ctx.browseBazaar(terminalId, { timeoutMs: browseMs });
    const sorted = [...listings].sort((a, b) => {
      const ap = a.buyNowPrice > 0 ? a.buyNowPrice : a.highBid;
      const bp = b.buyNowPrice > 0 ? b.buyNowPrice : b.highBid;
      return ap - bp;
    });
    ctx.fail(`bazaar-snipe: ${listings.length} listings returned`);
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
      const l = sorted[i];
      if (!l) continue;
      const price = l.buyNowPrice > 0 ? l.buyNowPrice : l.highBid;
      ctx.fail(
        `  #${i + 1}: itemId=${l.itemId} name="${l.itemName}" price=${price} owner=${l.ownerName}`,
      );
    }
  };
};

export const scenarios: Record<string, ScenarioFactory> = {
  'walk-line': walkLine,
  'walk-circle': walkCircle,
  'open-inventory': openInventory,
  'combat-attack': combatAttack,
  'posture-cycle': postureCycle,
  survey: surveyScenario,
  'group-trade': groupTradeScenario,
  'ride-vehicle': rideVehicle,
  'bazaar-snipe': bazaarSnipe,
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
