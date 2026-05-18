#!/usr/bin/env node --import tsx
/**
 * group-hunt-expedition.ts — 4-character coordinated hunting expedition.
 *
 * The leader invites three members into a group, all four mount vehicles
 * from their datapads, ride to a hunting ground, focus-fire a tough hostile
 * creature, then the leader splits the bounty via SecureTrade to each
 * member.
 *
 * Cross-character coordination follows the `src/scenarios/group-trade.ts`
 * model:
 *   Phase 1 — `Fleet.run([...], { skipGameStage: true })` runs Stages 1+2
 *             for each character so we can resolve every NetworkId before
 *             anyone tries to send an invite. The leader's id is then
 *             passed to each member's scenario as `leaderId`; the leader
 *             receives the three `memberIds`.
 *   Phase 2 — The actual scenario fleet runs with each role's scenario
 *             constructed against the resolved ids.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/group-hunt-expedition.ts \
 *     --host=10.254.0.253 --minutes=5
 */

import {
  Fleet,
  type FleetClientConfig,
  type LifecycleResult,
  type NetworkId,
  ObjectTypeTags,
  type ScenarioFn,
  type ScriptContext,
  type WorldObject,
} from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runFleet, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/group-hunt-expedition.ts';

const LEADER_ACCOUNT = 'tslive10';
const MEMBER_ACCOUNTS = ['tslive11', 'tslive12', 'tslive13'] as const;
const LEADER_CHARACTER = 'ExHuntLeader';
const MEMBER_CHARACTERS = ['ExHuntMember1', 'ExHuntMember2', 'ExHuntMember3'] as const;

const DEFAULT_HUNT_X = 100;
const DEFAULT_HUNT_Z = -4700;
const TOUGH_RE = /rancor|krayt|nightsister|nightspider|gronda|dragonet|reek/i;

interface ScriptArgs {
  huntX: number;
  huntZ: number;
  bounty: number;
  mountSpeedCap: number;
  attackTickMs: number;
  attackTimeoutMs: number;
  groupTimeoutMs: number;
  tradeTimeoutMs: number;
  staggerMs: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    huntX: Number.parseFloat(extra.get('hunt-x') ?? String(DEFAULT_HUNT_X)),
    huntZ: Number.parseFloat(extra.get('hunt-z') ?? String(DEFAULT_HUNT_Z)),
    bounty: Number.parseInt(extra.get('bounty') ?? '40000', 10),
    mountSpeedCap: Number.parseFloat(extra.get('mount-speed-cap') ?? '12'),
    attackTickMs: Number.parseInt(extra.get('attack-tick-ms') ?? '1500', 10),
    attackTimeoutMs: Number.parseInt(extra.get('attack-timeout-ms') ?? '90000', 10),
    groupTimeoutMs: Number.parseInt(extra.get('group-timeout-ms') ?? '20000', 10),
    tradeTimeoutMs: Number.parseInt(extra.get('trade-timeout-ms') ?? '20000', 10),
    staggerMs: Number.parseInt(extra.get('stagger-ms') ?? '300', 10),
  };
}

interface HuntOutcome {
  groupFormed: boolean;
  bossTargetId: string | null;
  bossKilled: boolean;
  lootShared: boolean;
  creditsPerMember: number;
  tradeResults: Array<{ memberId: string; completed: boolean; abortReason?: string }>;
  notes: string[];
}

/**
 * Find a tough hostile creature. Prefers CREOs whose `templateName` matches
 * the tough-monster regex, falling back to any CREO that's `inCombat` (a
 * proxy for "non-trivial encounter"), and finally the nearest CREO so we
 * never leave the leader idle when the planet is sparse.
 */
function pickBossCandidate(ctx: ScriptContext): WorldObject | null {
  const here = ctx.position();
  const creatures = ctx.world.byType(ObjectTypeTags.CREO);
  const candidates: Array<{ obj: WorldObject; d2: number; weight: number }> = [];
  for (const o of creatures) {
    if (o.id === ctx.sceneStart.playerNetworkId) continue;
    if (o.typeIdString === 'PLAY') continue;
    const dx = o.position.x - here.x;
    const dz = o.position.z - here.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 250 * 250) continue;
    const tmpl = o.templateName ?? '';
    const np = o.baselines.get(6) as { inCombat?: boolean; name?: string } | undefined;
    let weight = 0;
    if (TOUGH_RE.test(tmpl)) weight = 100;
    else if (np?.inCombat === true) weight = 50;
    else weight = 1;
    candidates.push({ obj: o, d2, weight });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.weight - a.weight || a.d2 - b.d2);
  return candidates[0]?.obj ?? null;
}

/**
 * Try to call & mount a vehicle from the datapad. Returns the vehicle's
 * NetworkId on success, or null when nothing's available — riding is a
 * best-effort enhancement; on-foot still completes the lifecycle.
 */
async function tryMountVehicle(
  ctx: ScriptContext,
  mountSpeedCap: number,
  log: (m: string) => void,
): Promise<NetworkId | null> {
  const vehicles = ctx.datapad.vehicles();
  if (vehicles.length === 0) {
    log('no vehicle PCD in datapad');
    return null;
  }
  const pcdId = vehicles[0]?.networkId;
  if (pcdId === undefined) return null;
  ctx.callVehicle(pcdId);
  await ctx.wait(1_500);
  const fresh = ctx.world
    .byType(ObjectTypeTags.CREO)
    .filter((o) => /vehicle|speeder|swoop|landspeeder/i.test(o.templateName ?? ''))
    .filter((o) => o.id !== ctx.sceneStart.playerNetworkId)
    .sort((a, b) => b.firstSeenAt - a.firstSeenAt);
  const vehicle = fresh[0];
  if (vehicle === undefined) {
    log('vehicle called but no spawn observed');
    return null;
  }
  ctx.mount(vehicle.id, { speedCap: mountSpeedCap });
  log(`mounted vehicle 0x${vehicle.id.toString(16)}`);
  return vehicle.id;
}

function makeLeaderScenario(
  args: ScriptArgs,
  memberIds: readonly NetworkId[],
  verbose: boolean,
  outcome: HuntOutcome,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('hunt-leader', verbose);
    // Clear stale group state from any prior aborted run — see group-trade
    // scenario header for why this is safe / required.
    ctx.useAbility('disband');
    await ctx.wait(300);
    await ctx.wait(1_000);

    for (const m of memberIds) {
      ctx.useAbility('invite', m);
      log(`invited 0x${m.toString(16)}`);
      await ctx.wait(250);
    }

    const groupDeadline = Date.now() + args.groupTimeoutMs;
    while (Date.now() < groupDeadline && ctx.group.size < 1 + memberIds.length) {
      await ctx.wait(500);
    }
    outcome.groupFormed = ctx.group.size >= 1 + memberIds.length;
    log(`group size after wait: ${ctx.group.size} (expected ${1 + memberIds.length})`);
    if (!outcome.groupFormed) outcome.notes.push('group did not fully form before timeout');

    const vehicleId = await tryMountVehicle(ctx, args.mountSpeedCap, log);
    void vehicleId;

    log(`riding to hunting ground (${args.huntX}, ${args.huntZ})`);
    await ctx.walkTo({ x: args.huntX, z: args.huntZ });

    if (ctx.mountedSpeedCap() !== null) {
      ctx.dismount();
      await ctx.wait(500);
    }

    const boss = pickBossCandidate(ctx);
    if (boss === null) {
      outcome.notes.push('no tough hostile found within 250m of hunting ground');
      log('no boss candidate found; skipping combat phase');
    } else {
      outcome.bossTargetId = `0x${boss.id.toString(16)}`;
      log(`engaging boss 0x${boss.id.toString(16)} template=${boss.templateName ?? '?'}`);
      ctx.combat.autoLoot = true;
      const combatDeadline = Date.now() + args.attackTimeoutMs;
      ctx.attackTarget(boss.id);
      while (Date.now() < combatDeadline && ctx.world.has(boss.id)) {
        await ctx.wait(args.attackTickMs);
        if (ctx.world.has(boss.id)) ctx.attackTarget(boss.id);
      }
      outcome.bossKilled = !ctx.world.has(boss.id);
      log(`boss kill outcome: killed=${outcome.bossKilled}`);
    }

    const perMember = Math.max(1, Math.floor(args.bounty / Math.max(1, memberIds.length)));
    outcome.creditsPerMember = perMember;
    let anyTradeOk = false;
    for (const m of memberIds) {
      log(`opening trade with 0x${m.toString(16)} for ${perMember} credits`);
      const res = await ctx.tradeWith(m, {
        credits: perMember,
        beginTimeoutMs: args.tradeTimeoutMs,
        acceptTimeoutMs: args.tradeTimeoutMs,
        verifyTimeoutMs: args.tradeTimeoutMs,
      });
      const entry: HuntOutcome['tradeResults'][number] = {
        memberId: `0x${m.toString(16)}`,
        completed: res.completed,
      };
      if (res.abortReason !== undefined) entry.abortReason = res.abortReason;
      outcome.tradeResults.push(entry);
      if (res.completed) anyTradeOk = true;
      else log(`trade with 0x${m.toString(16)} aborted: ${res.abortReason ?? 'unknown'}`);
      await ctx.wait(500);
    }
    outcome.lootShared = anyTradeOk;

    await ctx.wait(500);
    ctx.useAbility('disband');
    await ctx.wait(500);
  };
}

function makeMemberScenario(
  args: ScriptArgs,
  leaderId: NetworkId,
  verbose: boolean,
  label: string,
  outcome: HuntOutcome,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger(label, verbose);
    ctx.useAbility('decline');
    await ctx.wait(150);
    ctx.useAbility('disband');
    await ctx.wait(300);

    const inviteDeadline = Date.now() + args.groupTimeoutMs;
    while (Date.now() < inviteDeadline && ctx.character.groupInviter === null) {
      await ctx.wait(250);
    }
    if (ctx.character.groupInviter === null) {
      outcome.notes.push(`${label} never saw invite from leader`);
      log('invite never arrived');
      return;
    }
    log(`invite from 0x${ctx.character.groupInviter.id.toString(16)} accepted`);
    ctx.useAbility('join');

    const groupDeadline = Date.now() + args.groupTimeoutMs;
    while (Date.now() < groupDeadline && ctx.group.size < 2) {
      await ctx.wait(300);
    }
    outcome.groupFormed = ctx.group.size >= 2;
    if (!outcome.groupFormed) {
      outcome.notes.push(`${label} group never formed`);
      return;
    }

    const vehicleId = await tryMountVehicle(ctx, args.mountSpeedCap, log);
    void vehicleId;

    // `group.follow` re-emits leader transforms directly through the dispatcher,
    // bypassing movement primitives that auto-ack teleports. Required after zone-in.
    await ctx.ackPendingTeleports();
    const unfollow = ctx.group.follow(leaderId);
    try {
      const rideDeadline = Date.now() + Math.max(15_000, args.attackTimeoutMs);
      while (Date.now() < rideDeadline) {
        const targets = ctx.combat.targets();
        if (targets.length > 0) {
          const focus = targets[0]?.id;
          if (focus !== undefined) {
            log(`focus-firing on 0x${focus.toString(16)}`);
            ctx.attackTarget(focus);
          }
        } else {
          const boss = pickBossCandidate(ctx);
          if (
            boss !== null &&
            boss.templateName !== undefined &&
            TOUGH_RE.test(boss.templateName)
          ) {
            ctx.attackTarget(boss.id);
          }
        }
        await ctx.wait(args.attackTickMs);
      }
    } finally {
      unfollow();
    }

    if (ctx.mountedSpeedCap() !== null) {
      ctx.dismount();
      await ctx.wait(400);
    }

    const tradeRes = await ctx.acceptIncomingTrade({
      requestTimeoutMs: args.tradeTimeoutMs,
      beginTimeoutMs: args.tradeTimeoutMs,
      acceptTimeoutMs: args.tradeTimeoutMs,
      verifyTimeoutMs: args.tradeTimeoutMs,
    });
    const entry: HuntOutcome['tradeResults'][number] = {
      memberId: `0x${ctx.sceneStart.playerNetworkId.toString(16)}`,
      completed: tradeRes.completed,
    };
    if (tradeRes.abortReason !== undefined) entry.abortReason = tradeRes.abortReason;
    outcome.tradeResults.push(entry);
    if (tradeRes.completed) outcome.lootShared = true;

    await ctx.wait(400);
    ctx.useAbility('leaveGroup');
    await ctx.wait(400);
  };
}

async function resolveNetworkIds(
  host: string,
  port: number,
  configs: ReadonlyArray<{ account: string; characterName: string }>,
  staggerMs: number,
): Promise<NetworkId[]> {
  const fleet = new Fleet({ loginServer: { host, port } });
  const lookup = await fleet.run(
    configs.map(
      (c): FleetClientConfig => ({
        account: c.account,
        characterName: c.characterName,
        planet: 'mos_eisley',
        skipGameStage: true,
      }),
    ),
    { staggerMs },
  );
  const out: NetworkId[] = [];
  for (let i = 0; i < configs.length; i++) {
    const lr = lookup.outcomes[i]?.lifecycleResult as LifecycleResult | undefined;
    if (lr === undefined) {
      throw new Error(`lookup failed for ${configs[i]?.account}: no lifecycle result`);
    }
    out.push(lr.character.networkId);
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2), { minutes: 5 });
  if (args.help) {
    usage(SCRIPT, 'Group Hunting Expedition — 4-char invite/mount/ride/kill/loot-share flow.', [
      '  --hunt-x=N               hunting-ground X (default 100)',
      '  --hunt-z=N               hunting-ground Z (default -4700)',
      '  --bounty=N               total credits the leader divides (default 40000)',
      '  --mount-speed-cap=N      m/s cap passed to ctx.mount() for ride-to-hunt (default 12)',
      '  --attack-tick-ms=N       ms between attack enqueues (default 1500)',
      '  --attack-timeout-ms=N    boss kill budget in ms (default 90000)',
      '  --group-timeout-ms=N     per-step group-form/invite timeout (default 20000)',
      '  --trade-timeout-ms=N     per-step SecureTrade timeout (default 20000)',
      '  --stagger-ms=N           launch stagger between clients (default 300)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  void totalMs;

  const leaderOutcome: HuntOutcome = {
    groupFormed: false,
    bossTargetId: null,
    bossKilled: false,
    lootShared: false,
    creditsPerMember: 0,
    tradeResults: [],
    notes: [],
  };
  const memberOutcomes: HuntOutcome[] = MEMBER_CHARACTERS.map(() => ({
    groupFormed: false,
    bossTargetId: null,
    bossKilled: false,
    lootShared: false,
    creditsPerMember: 0,
    tradeResults: [],
    notes: [],
  }));

  const lookupConfigs = [
    { account: LEADER_ACCOUNT, characterName: LEADER_CHARACTER },
    ...MEMBER_ACCOUNTS.map((acc, i) => ({
      account: acc,
      characterName: MEMBER_CHARACTERS[i] ?? `ExHuntMember${i + 1}`,
    })),
  ];

  let leaderId: NetworkId;
  let memberIds: NetworkId[];
  try {
    const ids = await resolveNetworkIds(args.host, args.port, lookupConfigs, script.staggerMs);
    leaderId = ids[0] as NetworkId;
    memberIds = ids.slice(1);
  } catch (err) {
    process.stdout.write(
      formatJson(
        {
          ok: false,
          host: args.host,
          phase: 'lookup',
          error: err instanceof Error ? err.message : String(err),
        },
        args.pretty,
      ),
    );
    return 1;
  }

  const configs: FleetClientConfig[] = [
    {
      account: LEADER_ACCOUNT,
      characterName: LEADER_CHARACTER,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: makeLeaderScenario(script, memberIds, args.verbose, leaderOutcome),
    },
    ...MEMBER_ACCOUNTS.map(
      (acc, i): FleetClientConfig => ({
        account: acc,
        characterName: MEMBER_CHARACTERS[i] ?? `ExHuntMember${i + 1}`,
        planet: 'mos_eisley',
        holdZonedInMs: 0,
        script: makeMemberScenario(
          script,
          leaderId,
          args.verbose,
          `hunt-m${i + 1}`,
          memberOutcomes[i] as HuntOutcome,
        ),
      }),
    ),
  ];

  const { summary } = await runFleet(args, configs, { staggerMs: script.staggerMs });

  const combinedGroupFormed =
    leaderOutcome.groupFormed && memberOutcomes.every((o) => o.groupFormed);
  const lootShared =
    leaderOutcome.tradeResults.some((t) => t.completed) ||
    memberOutcomes.some((o) => o.tradeResults.some((t) => t.completed));

  summary.extra = {
    leaderId: `0x${leaderId.toString(16)}`,
    members: memberIds.map((id) => `0x${id.toString(16)}`),
    groupFormed: combinedGroupFormed,
    huntingGroundCoords: { x: script.huntX, z: script.huntZ },
    bossTargetId: leaderOutcome.bossTargetId,
    bossKilled: leaderOutcome.bossKilled,
    lootShared,
    creditsPerMember: leaderOutcome.creditsPerMember,
    leaderTradeResults: leaderOutcome.tradeResults,
    memberTradeResults: memberOutcomes.map((o) => o.tradeResults),
    notes: [leaderOutcome.notes, ...memberOutcomes.map((o) => o.notes)].flat(),
  };
  process.stdout.write(formatJson(summary, args.pretty));
  return summary.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
