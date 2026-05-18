#!/usr/bin/env node --import tsx
/**
 * reactive-bodyguard-fleet.ts — a 2-character VIP-and-protector scenario.
 *
 * The VIP walks a circular perimeter circuit while the Bodyguard mirrors
 * their position from ~5m away, watches the live WorldModel for hostile
 * CREOs targeting the VIP, intercepts aggressors, and triggers an evac
 * (mount + ride to a hardcoded safe coord) if the VIP's HAM health drops
 * below threshold.
 *
 * Cross-character coordination uses the same pre-resolve pattern as the
 * `groupTradeScenario` (src/scenarios/group-trade.ts): a lookup Fleet pass
 * runs Stage 1+2 only (`skipGameStage:true`) to resolve each character's
 * NetworkId, then the real Fleet pass passes the OTHER side's id into the
 * per-role scenario closure.
 *
 * Example:
 *   LIVE=1 pnpm tsx scripts/examples/reactive-bodyguard-fleet.ts --minutes=4
 */

import {
  BaselinePackageIds,
  type CreatureObjectSharedNpBaseline,
  type FleetClientConfig,
  type NetworkId,
  ObjectTypeTags,
  type ScenarioFn,
  type WorldObject,
} from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runFleet, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/reactive-bodyguard-fleet.ts';

const VIP_ACCOUNT_DEFAULT = 'tslive05';
const BODYGUARD_ACCOUNT_DEFAULT = 'tslive06';
const VIP_CHARACTER_DEFAULT = 'ExVIP';
const BODYGUARD_CHARACTER_DEFAULT = 'ExBodyguard';

interface ScriptArgs {
  circuitRadius: number;
  followDistance: number;
  catchupDistance: number;
  scanRadius: number;
  evacHealthFraction: number;
  evacX: number;
  evacZ: number;
  vipAccount: string;
  bodyguardAccount: string;
  vipCharacter: string;
  bodyguardCharacter: string;
  vipSafetyFraction: number;
  bodyguardSafetyFraction: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    circuitRadius: Number.parseFloat(extra.get('circuit-radius') ?? '40'),
    followDistance: Number.parseFloat(extra.get('follow-distance') ?? '5'),
    catchupDistance: Number.parseFloat(extra.get('catchup-distance') ?? '8'),
    scanRadius: Number.parseFloat(extra.get('scan-radius') ?? '20'),
    evacHealthFraction: Number.parseFloat(extra.get('evac-health') ?? '0.5'),
    evacX: Number.parseFloat(extra.get('evac-x') ?? '0'),
    evacZ: Number.parseFloat(extra.get('evac-z') ?? '0'),
    vipAccount: extra.get('vip-account') ?? VIP_ACCOUNT_DEFAULT,
    bodyguardAccount: extra.get('bodyguard-account') ?? BODYGUARD_ACCOUNT_DEFAULT,
    vipCharacter: extra.get('vip-character') ?? VIP_CHARACTER_DEFAULT,
    bodyguardCharacter: extra.get('bodyguard-character') ?? BODYGUARD_CHARACTER_DEFAULT,
    vipSafetyFraction: Number.parseFloat(extra.get('vip-safety') ?? '0.2'),
    bodyguardSafetyFraction: Number.parseFloat(extra.get('bodyguard-safety') ?? '0.2'),
  };
}

interface VipStats {
  positionsVisited: number;
  minHealthSeen: number;
  helpCallsIssued: number;
  fledForSafety: boolean;
}

interface BodyguardStats {
  aggressorsIntercepted: number;
  attacksIssued: number;
  bodyguardKills: number;
  evacsTriggered: number;
  catchupWalks: number;
}

function readCreatureHam(obj: WorldObject): { current: number; max: number } | null {
  const np = obj.baselines.get(BaselinePackageIds.SHARED_NP) as
    | CreatureObjectSharedNpBaseline
    | undefined;
  if (np === undefined) return null;
  const cur = np.totalAttributes;
  const max = np.totalMaxAttributes;
  if (!Array.isArray(cur) || !Array.isArray(max)) return null;
  const c = cur[0];
  const m = max[0];
  if (typeof c !== 'number' || typeof m !== 'number') return null;
  return { current: c, max: m };
}

function readCreatureInCombat(obj: WorldObject): boolean {
  const np = obj.baselines.get(BaselinePackageIds.SHARED_NP) as
    | CreatureObjectSharedNpBaseline
    | undefined;
  return np?.inCombat === true;
}

function buildVipScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  stats: VipStats,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('vip', verbose);
    const spawn = ctx.sceneStart.startPosition;
    log(
      `circuit r=${args.circuitRadius}m around (${spawn.x.toFixed(1)},${spawn.z.toFixed(1)}) for ${totalMs}ms`,
    );

    ctx.safety.fleeWhenHealthBelow(args.vipSafetyFraction, {
      goTo: { x: args.evacX, z: args.evacZ },
      usePeace: true,
      useVehicle: true,
      onTrigger: (info) => {
        stats.fledForSafety = true;
        log(
          `VIP self-flee: ratio=${info.healthRatio.toFixed(2)} hp=${info.health}/${info.healthMax}`,
        );
      },
    });

    let lastHitCallOut = 0;
    let lastSampledPos: { x: number; z: number } | null = null;
    const onTickSample = (): void => {
      const p = ctx.position();
      if (
        lastSampledPos === null ||
        Math.hypot(p.x - lastSampledPos.x, p.z - lastSampledPos.z) > 2
      ) {
        stats.positionsVisited++;
        lastSampledPos = { x: p.x, z: p.z };
      }
      const h = ctx.character.health.current;
      if (h > 0 && (stats.minHealthSeen === 0 || h < stats.minHealthSeen)) {
        stats.minHealthSeen = h;
      }
      if (ctx.hitTimer.engaged) {
        const now = Date.now();
        if (now - lastHitCallOut > 8_000) {
          ctx.say('Help! Under attack!');
          stats.helpCallsIssued++;
          lastHitCallOut = now;
          log('shouting for help (hit detected)');
        }
      }
    };

    const sampler = setInterval(onTickSample, 750);
    sampler.unref?.();

    try {
      await ctx.walkCircle({
        centerX: spawn.x,
        centerZ: spawn.z,
        radius: args.circuitRadius,
        durationMs: totalMs,
      });
    } finally {
      clearInterval(sampler);
    }
    log(`circuit done; helpCalls=${stats.helpCallsIssued} fled=${stats.fledForSafety}`);
    await ctx.logout();
  };
}

function buildBodyguardScenario(
  args: ScriptArgs,
  vipId: NetworkId,
  totalMs: number,
  verbose: boolean,
  stats: BodyguardStats,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('bg', verbose);
    const selfId = ctx.sceneStart.playerNetworkId;
    log(`guarding VIP 0x${vipId.toString(16)} for ${totalMs}ms`);

    ctx.safety.fleeWhenHealthBelow(args.bodyguardSafetyFraction, {
      goTo: { x: args.evacX, z: args.evacZ },
      usePeace: true,
      useVehicle: true,
      onTrigger: (info) => {
        log(
          `bodyguard self-flee: ratio=${info.healthRatio.toFixed(2)} hp=${info.health}/${info.healthMax}`,
        );
      },
    });

    let activeAggressorId: NetworkId | null = null;
    let lastAttackAt = 0;
    let evacInFlight = false;
    const interceptedSet = new Set<string>();
    const killedSet = new Set<string>();

    const pickAggressor = (vip: WorldObject): WorldObject | null => {
      const here = ctx.position();
      const r2 = args.scanRadius * args.scanRadius;
      let best: { obj: WorldObject; d2: number } | null = null;
      for (const o of ctx.world.byType(ObjectTypeTags.CREO)) {
        if (o.id === selfId || o.id === vipId) continue;
        if (!readCreatureInCombat(o)) continue;
        const dx = o.position.x - here.x;
        const dz = o.position.z - here.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const vdx = o.position.x - vip.position.x;
        const vdz = o.position.z - vip.position.z;
        const vd2 = vdx * vdx + vdz * vdz;
        if (vd2 > r2) continue;
        if (best === null || d2 < best.d2) best = { obj: o, d2 };
      }
      return best === null ? null : best.obj;
    };

    const tryEvac = async (vip: WorldObject): Promise<boolean> => {
      const ham = readCreatureHam(vip);
      if (ham === null || ham.max <= 0) return false;
      if (ham.current / ham.max >= args.evacHealthFraction) return false;
      if (evacInFlight) return false;
      evacInFlight = true;
      stats.evacsTriggered++;
      log(
        `EVAC: VIP HAM ${ham.current}/${ham.max} (${((ham.current / ham.max) * 100).toFixed(0)}%) -> safe (${args.evacX},${args.evacZ})`,
      );
      const datapadVehicle = ctx.datapad.vehicles()[0];
      if (datapadVehicle !== undefined) {
        ctx.callVehicle(datapadVehicle.networkId);
        await ctx.wait(1_500);
        ctx.dismount();
        await ctx.wait(250);
        ctx.callVehicle(datapadVehicle.networkId);
        await ctx.wait(1_200);
        const freshVehicle = ctx.world
          .byType(ObjectTypeTags.CREO)
          .filter((c) => c.id !== selfId && c.id !== vipId)
          .sort((a, b) => b.firstSeenAt - a.firstSeenAt)[0];
        if (freshVehicle !== undefined) {
          ctx.mount(freshVehicle.id);
          await ctx.wait(400);
        }
      }
      await ctx.walkTo({ x: args.evacX, z: args.evacZ });
      return true;
    };

    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline && !ctx.signal.aborted) {
      const vip = ctx.world.get(vipId);
      if (vip === undefined) {
        await ctx.wait(750);
        continue;
      }

      if (await tryEvac(vip)) break;

      if (activeAggressorId !== null) {
        const target = ctx.world.get(activeAggressorId);
        const vipEngaged = readCreatureInCombat(vip);
        if (target === undefined) {
          killedSet.add(activeAggressorId.toString());
          activeAggressorId = null;
        } else if (!vipEngaged && !readCreatureInCombat(target)) {
          activeAggressorId = null;
        } else if (Date.now() - lastAttackAt > 1_500) {
          ctx.attackTarget(target.id);
          stats.attacksIssued++;
          lastAttackAt = Date.now();
        }
      }

      if (activeAggressorId === null) {
        const aggressor = pickAggressor(vip);
        if (aggressor !== null) {
          activeAggressorId = aggressor.id;
          if (!interceptedSet.has(aggressor.id.toString())) {
            interceptedSet.add(aggressor.id.toString());
            stats.aggressorsIntercepted++;
          }
          log(
            `intercepting 0x${aggressor.id.toString(16)} at (${aggressor.position.x.toFixed(1)},${aggressor.position.z.toFixed(1)})`,
          );
          ctx.attackTarget(aggressor.id);
          stats.attacksIssued++;
          lastAttackAt = Date.now();
        }
      }

      const me = ctx.position();
      const dx = vip.position.x - me.x;
      const dz = vip.position.z - me.z;
      const dist = Math.hypot(dx, dz);
      if (dist > args.catchupDistance) {
        const k = (dist - args.followDistance) / dist;
        const target = {
          x: me.x + dx * k,
          z: me.z + dz * k,
        };
        stats.catchupWalks++;
        await ctx.walkTo(target);
      } else {
        await ctx.wait(500);
      }
    }

    stats.bodyguardKills = killedSet.size;
    log(
      `guard done; intercepted=${stats.aggressorsIntercepted} attacks=${stats.attacksIssued} kills=${stats.bodyguardKills} evacs=${stats.evacsTriggered}`,
    );
    await ctx.logout();
  };
}

async function resolveNetworkIds(
  args: ReturnType<typeof parseCommonArgs>,
  script: ScriptArgs,
): Promise<{ vipId: NetworkId; bodyguardId: NetworkId }> {
  const lookupConfigs: FleetClientConfig[] = [
    {
      account: script.vipAccount,
      characterName: script.vipCharacter,
      planet: 'mos_eisley',
      skipGameStage: true,
    },
    {
      account: script.bodyguardAccount,
      characterName: script.bodyguardCharacter,
      planet: 'mos_eisley',
      skipGameStage: true,
    },
  ];
  const { result } = await runFleet(args, lookupConfigs, { staggerMs: 100 });
  const vipId = result.outcomes[0]?.lifecycleResult?.character.networkId;
  const bodyguardId = result.outcomes[1]?.lifecycleResult?.character.networkId;
  if (vipId === undefined || bodyguardId === undefined) {
    const errs = result.summary.errorMessages.join(' | ');
    throw new Error(`failed to resolve NetworkIds during lookup phase: ${errs}`);
  }
  return { vipId, bodyguardId };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2), { minutes: 4 });
  if (args.help) {
    usage(SCRIPT, 'Reactive Bodyguard — VIP walks a circuit; Bodyguard mirrors and intercepts.', [
      '  --circuit-radius=N       VIP circuit radius in m (default 40)',
      '  --follow-distance=N      bodyguard ideal trail distance in m (default 5)',
      '  --catchup-distance=N     bodyguard catchup threshold in m (default 8)',
      '  --scan-radius=N          bodyguard hostile scan radius in m (default 20)',
      '  --evac-health=F          VIP HAM ratio that triggers evac (default 0.5)',
      '  --evac-x=N               evac destination X (default 0)',
      '  --evac-z=N               evac destination Z (default 0)',
      '  --vip-account=NAME       account name for VIP (default tslive05)',
      '  --bodyguard-account=NAME account name for bodyguard (default tslive06)',
      '  --vip-character=NAME     VIP character name (default ExVIP)',
      '  --bodyguard-character=N  bodyguard character name (default ExBodyguard)',
      '  --vip-safety=F           VIP self-flee HAM ratio (default 0.2)',
      '  --bodyguard-safety=F     bodyguard self-flee HAM ratio (default 0.2)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);

  const { vipId, bodyguardId } = await resolveNetworkIds(args, script);

  const vipStats: VipStats = {
    positionsVisited: 0,
    minHealthSeen: 0,
    helpCallsIssued: 0,
    fledForSafety: false,
  };
  const bodyguardStats: BodyguardStats = {
    aggressorsIntercepted: 0,
    attacksIssued: 0,
    bodyguardKills: 0,
    evacsTriggered: 0,
    catchupWalks: 0,
  };

  const configs: FleetClientConfig[] = [
    {
      account: script.vipAccount,
      characterName: script.vipCharacter,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: buildVipScenario(script, totalMs, args.verbose, vipStats),
    },
    {
      account: script.bodyguardAccount,
      characterName: script.bodyguardCharacter,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: buildBodyguardScenario(script, vipId, totalMs, args.verbose, bodyguardStats),
    },
  ];

  const { summary } = await runFleet(args, configs, { staggerMs: 250 });
  summary.extra = {
    vipId: `0x${vipId.toString(16)}`,
    bodyguardId: `0x${bodyguardId.toString(16)}`,
    circuitRadius: script.circuitRadius,
    evacHealthFraction: script.evacHealthFraction,
    vipPositionsVisited: vipStats.positionsVisited,
    vipMinHealthSeen: vipStats.minHealthSeen,
    vipHelpCallsIssued: vipStats.helpCallsIssued,
    vipFledForSafety: vipStats.fledForSafety,
    aggressorsIntercepted: bodyguardStats.aggressorsIntercepted,
    attacksIssued: bodyguardStats.attacksIssued,
    bodyguardKills: bodyguardStats.bodyguardKills,
    evacsTriggered: bodyguardStats.evacsTriggered,
    bodyguardCatchupWalks: bodyguardStats.catchupWalks,
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
