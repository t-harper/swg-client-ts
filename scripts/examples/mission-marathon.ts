#!/usr/bin/env node --import tsx
/**
 * mission-marathon.ts — end-to-end multi-mission completion soak.
 *
 * Solo character finds a mission terminal, accepts up to N missions, navigates
 * to each waypoint, drives the appropriate completion path (combat for destroy
 * / bounty / hunting; radial-Use for delivery/recon/survey), records per-
 * mission outcomes plus total credits + XP earned, then logs out.
 *
 * Demonstrates `ctx.missions` + `ctx.requestMissionList` + `ctx.acceptMission`
 * + `ctx.navigate` + `ctx.combat.attackingNearest` chained against the live
 * server. Useful as a high-level "does the mission system still work end-to-
 * end" smoke under wire-format drift.
 *
 * The script tolerates "no terminal in range" and "no missions offered" as
 * normal outcomes — it records them in the JSON summary and exits cleanly
 * (the cluster may have no mission terminals near the spawn for a fresh
 * `mos_eisley` character, or the spawner pool may be empty).
 *
 * Example:
 *   pnpm exec tsx scripts/examples/mission-marathon.ts \
 *     --host=10.254.0.253 --user=tslive03 --character=ExMissionRunner \
 *     --max-missions=3 --per-mission-timeout-s=60 --minutes=10
 */

import {
  type Mission,
  type NetworkId,
  ObjectMenuSelectMessage,
  ObjectTypeTags,
  RadialMenuTypes,
  type ScenarioFn,
  type ScriptContext,
  type WorldObject,
} from '../../src/index.js';
import {
  dist2,
  durationMs,
  findNearestByTemplate,
  formatJson,
  makeLogger,
  parseCommonArgs,
  runScenario,
  usage,
} from './_lib.js';

const SCRIPT = 'scripts/examples/mission-marathon.ts';

interface ScriptArgs {
  maxMissions: number;
  perMissionTimeoutSec: number;
  terminalSearchRadiusM: number;
  fallbackWalkRadiusM: number;
  waypointArrivalRadiusM: number;
  pickStrategy: 'payout' | 'distance';
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const pickRaw = extra.get('pick') ?? 'payout';
  if (pickRaw !== 'payout' && pickRaw !== 'distance') {
    throw new Error(`--pick must be one of: payout, distance (got "${pickRaw}")`);
  }
  return {
    maxMissions: Number.parseInt(extra.get('max-missions') ?? '3', 10),
    perMissionTimeoutSec: Number.parseFloat(extra.get('per-mission-timeout-s') ?? '60'),
    terminalSearchRadiusM: Number.parseFloat(extra.get('terminal-radius') ?? '120'),
    fallbackWalkRadiusM: Number.parseFloat(extra.get('fallback-walk-radius') ?? '250'),
    waypointArrivalRadiusM: Number.parseFloat(extra.get('arrival-radius') ?? '12'),
    pickStrategy: pickRaw,
  };
}

const MISSION_TERMINAL_RE = /terminal_mission|mission_terminal/i;
const FALLBACK_LANDMARK_RE = /starport|cantina|terminal_travel|hotel/i;
const COMBAT_MISSION_RE = /destroy|bounty|hunting|assassinat/i;

interface PerMissionStat {
  missionId: string;
  type: string;
  payout: number;
  waypoint: { x: number; z: number };
  distanceM: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  outcome: 'completed' | 'aborted' | 'navigation-failed' | 'engaged-timeout';
  reason?: string;
  killsObserved: number;
}

interface MarathonStats {
  spawnPosition: { x: number; z: number };
  planet: string;
  terminalsScannedInWorld: number;
  terminalUsed: string | null;
  missionsAccepted: number;
  missionsCompleted: number;
  missionsAborted: number;
  startingBank: number;
  startingCash: number;
  finalBank: number;
  finalCash: number;
  creditsDelta: number;
  startingXp: Record<string, number>;
  finalXp: Record<string, number>;
  xpDeltaByType: Record<string, number>;
  totalElapsedMs: number;
  perMissionStats: PerMissionStat[];
  bailReason: string | null;
}

function xpMapToObject(m: ReadonlyMap<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of m.entries()) out[k] = v;
  return out;
}

function diffXp(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const delta = (after[k] ?? 0) - (before[k] ?? 0);
    if (delta !== 0) out[k] = delta;
  }
  return out;
}

function findNearestMissionTerminal(ctx: ScriptContext, radiusM: number): WorldObject | undefined {
  return findNearestByTemplate(ctx, MISSION_TERMINAL_RE, {
    typeTag: ObjectTypeTags.TANO,
    maxRadiusM: radiusM,
  });
}

/**
 * Walk toward a nearby landmark (starport / cantina / travel terminal / hotel)
 * to try to bring a mission terminal into baseline range. Returns true if we
 * found and walked toward one. Best-effort — gives up cleanly if nothing
 * obvious is nearby.
 */
async function nudgeTowardLandmark(
  ctx: ScriptContext,
  args: ScriptArgs,
  log: (msg: string) => void,
): Promise<boolean> {
  const here = ctx.position();
  const maxR2 = args.fallbackWalkRadiusM * args.fallbackWalkRadiusM;
  let best: WorldObject | undefined;
  let bestD2 = Number.POSITIVE_INFINITY;
  for (const o of [
    ...ctx.world.byType(ObjectTypeTags.BUIO),
    ...ctx.world.byType(ObjectTypeTags.TANO),
  ]) {
    if (o.templateName === undefined) continue;
    if (!FALLBACK_LANDMARK_RE.test(o.templateName)) continue;
    const d2 = dist2(o.position, here);
    if (d2 > maxR2) continue;
    if (d2 < bestD2) {
      best = o;
      bestD2 = d2;
    }
  }
  if (best === undefined) {
    log('no fallback landmark found in baseline range');
    return false;
  }
  log(
    `nudging toward ${best.templateName} (~${Math.sqrt(bestD2).toFixed(1)}m away) to surface a mission terminal`,
  );
  try {
    await ctx.navigate({ x: best.position.x, z: best.position.z }, { useMount: 'never' });
    return true;
  } catch (err) {
    log(`navigate to landmark failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Order the offered missions for acceptance. `payout` picks highest credits
 * first; `distance` picks shortest waypoint first.
 */
function rankMissions(
  active: Mission[],
  here: { x: number; z: number },
  strategy: ScriptArgs['pickStrategy'],
): Mission[] {
  const copy = active.slice();
  if (strategy === 'payout') {
    copy.sort((a, b) => b.payout - a.payout);
  } else {
    copy.sort((a, b) => dist2(a.location, here) - dist2(b.location, here));
  }
  return copy;
}

/**
 * Drive completion of a single accepted mission:
 *   1. Navigate to its waypoint
 *   2. If combat-type, attack the nearest hostile in arrival radius until it
 *      dies or our per-mission budget elapses
 *   3. Otherwise (delivery/recon/survey) fire an `ITEM_USE` radial on the
 *      most-promising nearby object — for many delivery / recon missions the
 *      server completes the mission as soon as the player lands inside the
 *      destination's trigger volume; the radial-Use is a defensive belt-and-
 *      braces for delivery targets
 *   4. Poll `ctx.missions.active` for ~ the per-mission budget; the mission
 *      drops out of the cache when the server fires its completion
 *      SceneDestroyObject. If it doesn't, abort and move on.
 */
async function runMission(
  ctx: ScriptContext,
  m: Mission,
  args: ScriptArgs,
  log: (msg: string) => void,
): Promise<PerMissionStat> {
  const start = Date.now();
  const here = ctx.position();
  const distanceM = Math.sqrt(dist2(m.location, here));
  const waypoint = { x: m.location.x, z: m.location.z };
  const stat: PerMissionStat = {
    missionId: `0x${m.id.toString(16)}`,
    type: m.type,
    payout: m.payout,
    waypoint,
    distanceM,
    startedAt: start,
    endedAt: 0,
    durationMs: 0,
    outcome: 'engaged-timeout',
    killsObserved: 0,
  };

  // Snapshot kills (SceneDestroyObject on CREO we attacked) so we can attribute
  // any combat that happens during this mission window for diagnostics.
  const killsBefore = ctx.combat.damagedSet().size;

  try {
    log(
      `mission 0x${m.id.toString(16)} type=${m.type} payout=${m.payout} → walking to (${waypoint.x.toFixed(1)}, ${waypoint.z.toFixed(1)}) (~${distanceM.toFixed(1)}m)`,
    );
    await ctx.navigate(waypoint, { useMount: 'auto' });
  } catch (err) {
    stat.outcome = 'navigation-failed';
    stat.reason = err instanceof Error ? err.message : String(err);
    stat.endedAt = Date.now();
    stat.durationMs = stat.endedAt - stat.startedAt;
    log(`mission 0x${m.id.toString(16)} navigation failed: ${stat.reason}`);
    // Best-effort abort so it doesn't linger in the mission bag.
    try {
      ctx.abortMission(m.id);
    } catch {
      // ignore — abort is fire-and-forget
    }
    return stat;
  }

  const isCombat = COMBAT_MISSION_RE.test(m.type);
  const deadline = start + args.perMissionTimeoutSec * 1_000;
  ctx.combat.autoLoot = true;

  if (isCombat) {
    // Attack the nearest hostile until the mission falls out of the cache
    // (server's `MissionObject` cleanup on completion) or budget expires.
    while (Date.now() < deadline) {
      if (!ctx.missions.active.some((x) => x.id === m.id)) {
        stat.outcome = 'completed';
        break;
      }
      const slice = Math.min(15_000, Math.max(2_000, deadline - Date.now()));
      await ctx.combat.attackingNearest({
        maxRadiusM: Math.max(args.waypointArrivalRadiusM, 20),
        ability: 'attack',
        tickMs: 1500,
        timeoutMs: slice,
      });
      // Re-check completion before next round.
      if (!ctx.missions.active.some((x) => x.id === m.id)) {
        stat.outcome = 'completed';
        break;
      }
    }
  } else {
    // Delivery / recon / survey / escort path. Try a few useful radial Uses
    // on the closest object near the waypoint; for many such missions
    // arrival itself completes the mission server-side. Poll the cache.
    const closeObj = pickInteractableNearWaypoint(ctx, waypoint, args.waypointArrivalRadiusM);
    if (closeObj !== undefined) {
      log(
        `mission 0x${m.id.toString(16)} radial-Use on 0x${closeObj.id.toString(16)} (${closeObj.templateName ?? 'unknown'})`,
      );
      try {
        ctx.send(new ObjectMenuSelectMessage(closeObj.id, RadialMenuTypes.ITEM_USE));
      } catch (err) {
        log(`radial-Use send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    while (Date.now() < deadline) {
      if (!ctx.missions.active.some((x) => x.id === m.id)) {
        stat.outcome = 'completed';
        break;
      }
      await ctx.wait(Math.min(2_000, Math.max(0, deadline - Date.now())));
    }
  }

  stat.killsObserved = Math.max(0, ctx.combat.damagedSet().size - killsBefore);

  if (stat.outcome !== 'completed') {
    log(`mission 0x${m.id.toString(16)} timed out; aborting`);
    try {
      ctx.abortMission(m.id);
    } catch {
      // ignore
    }
    stat.outcome = 'aborted';
  }

  stat.endedAt = Date.now();
  stat.durationMs = stat.endedAt - stat.startedAt;
  return stat;
}

/**
 * Within `radiusM` of the waypoint, return the most-interesting interactable
 * — preferring tangible objects with a templateName so the server can route
 * an `OnObjectMenuSelect` script trigger. Falls back to any CREO if no TANO
 * is found (some delivery targets are NPC creatures).
 */
function pickInteractableNearWaypoint(
  ctx: ScriptContext,
  waypoint: { x: number; z: number },
  radiusM: number,
): WorldObject | undefined {
  const maxR2 = radiusM * radiusM;
  const candidates: Array<{ o: WorldObject; d2: number }> = [];
  for (const o of ctx.world.byType(ObjectTypeTags.TANO)) {
    if (o.templateName === undefined) continue;
    const d2 = dist2(o.position, waypoint);
    if (d2 > maxR2) continue;
    candidates.push({ o, d2 });
  }
  if (candidates.length === 0) {
    for (const o of ctx.world.byType(ObjectTypeTags.CREO)) {
      if (o.id === ctx.sceneStart.playerNetworkId) continue;
      const d2 = dist2(o.position, waypoint);
      if (d2 > maxR2) continue;
      candidates.push({ o, d2 });
    }
  }
  candidates.sort((a, b) => a.d2 - b.d2);
  return candidates[0]?.o;
}

function buildScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  stats: MarathonStats,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('mm', verbose);
    const wallStart = Date.now();
    const deadline = wallStart + totalMs;

    // Wait for the initial baselines so character + world are populated.
    const characterReady = Date.now() + 5_000;
    while (!ctx.character.ready && Date.now() < characterReady) {
      await ctx.wait(100);
    }

    stats.planet = ctx.sceneStart.sceneName;
    const spawn = ctx.position();
    stats.spawnPosition = { x: spawn.x, z: spawn.z };
    stats.startingBank = ctx.character.bankBalance;
    stats.startingCash = ctx.character.cashBalance;
    stats.startingXp = xpMapToObject(ctx.character.xp);
    log(
      `ready on ${stats.planet} at (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}) — bank=${stats.startingBank} cash=${stats.startingCash}`,
    );

    // === FIND A TERMINAL =================================================
    let terminal = findNearestMissionTerminal(ctx, args.terminalSearchRadiusM);
    if (terminal === undefined) {
      log(
        `no mission terminal within ${args.terminalSearchRadiusM}m of spawn; trying a landmark nudge`,
      );
      const nudged = await nudgeTowardLandmark(ctx, args, log);
      if (nudged) {
        // After nudging, the WorldModel will absorb new baselines as we move;
        // give them a short settle before rescanning.
        await ctx.wait(2_000);
        terminal = findNearestMissionTerminal(ctx, args.terminalSearchRadiusM);
      }
    }
    stats.terminalsScannedInWorld = ctx.world
      .byType(ObjectTypeTags.TANO)
      .filter(
        (o) => o.templateName !== undefined && MISSION_TERMINAL_RE.test(o.templateName),
      ).length;
    if (terminal === undefined) {
      stats.bailReason = 'no mission terminal in baseline range after landmark nudge';
      log(stats.bailReason);
      stats.finalBank = ctx.character.bankBalance;
      stats.finalCash = ctx.character.cashBalance;
      stats.finalXp = xpMapToObject(ctx.character.xp);
      stats.creditsDelta =
        stats.finalBank + stats.finalCash - (stats.startingBank + stats.startingCash);
      stats.xpDeltaByType = diffXp(stats.startingXp, stats.finalXp);
      stats.totalElapsedMs = Date.now() - wallStart;
      await ctx.logout();
      return;
    }
    stats.terminalUsed = `0x${terminal.id.toString(16)}`;
    log(
      `using terminal ${stats.terminalUsed} (${terminal.templateName ?? '<unknown>'}) at (${terminal.position.x.toFixed(1)}, ${terminal.position.z.toFixed(1)})`,
    );

    // Walk up to the terminal (server requires presence proximity to surface
    // mission options) and request the browser.
    try {
      await ctx.navigate({ x: terminal.position.x, z: terminal.position.z }, { useMount: 'never' });
    } catch (err) {
      log(`approach navigate failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const beforeBrowse = new Set(ctx.missions.active.map((x) => x.id.toString()));
    ctx.requestMissionList(terminal.id, { flags: 0 });
    // PopulateMissionBrowserMessage typically lands within 1-2s; give it 5s
    // and additionally wait for SHARED baselines for the offered missions
    // to populate the cache.
    const browseDeadline = Date.now() + 5_000;
    while (Date.now() < browseDeadline) {
      const offered = ctx.missions.active.filter((x) => !beforeBrowse.has(x.id.toString()));
      if (offered.length > 0) break;
      await ctx.wait(250);
    }
    const offered = ctx.missions.active.filter((x) => !beforeBrowse.has(x.id.toString()));
    log(
      `browser returned ${offered.length} offered missions (cache total=${ctx.missions.active.length})`,
    );
    if (offered.length === 0) {
      stats.bailReason = 'mission terminal returned no new missions';
      log(stats.bailReason);
      stats.finalBank = ctx.character.bankBalance;
      stats.finalCash = ctx.character.cashBalance;
      stats.finalXp = xpMapToObject(ctx.character.xp);
      stats.creditsDelta =
        stats.finalBank + stats.finalCash - (stats.startingBank + stats.startingCash);
      stats.xpDeltaByType = diffXp(stats.startingXp, stats.finalXp);
      stats.totalElapsedMs = Date.now() - wallStart;
      await ctx.logout();
      return;
    }

    // === ACCEPT MISSIONS =================================================
    const here = ctx.position();
    const ranked = rankMissions(offered, here, args.pickStrategy);
    const pickCount = Math.min(args.maxMissions, ranked.length);
    const accepted: Mission[] = [];
    for (let i = 0; i < pickCount; i++) {
      const m = ranked[i];
      if (m === undefined) break;
      try {
        ctx.acceptMission(m.id, terminal.id);
        accepted.push(m);
        log(
          `accepted 0x${m.id.toString(16)} type=${m.type} payout=${m.payout} → (${m.location.x.toFixed(1)}, ${m.location.z.toFixed(1)})`,
        );
        await ctx.wait(500);
      } catch (err) {
        log(
          `accept 0x${m.id.toString(16)} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    stats.missionsAccepted = accepted.length;
    if (accepted.length === 0) {
      stats.bailReason = 'no missions accepted (all failed)';
      log(stats.bailReason);
    }

    // === RUN EACH MISSION ================================================
    for (const m of accepted) {
      if (Date.now() >= deadline) {
        log('overall budget exhausted; aborting remaining missions');
        try {
          ctx.abortMission(m.id);
        } catch {
          // ignore
        }
        stats.perMissionStats.push({
          missionId: `0x${m.id.toString(16)}`,
          type: m.type,
          payout: m.payout,
          waypoint: { x: m.location.x, z: m.location.z },
          distanceM: Math.sqrt(dist2(m.location, ctx.position())),
          startedAt: Date.now(),
          endedAt: Date.now(),
          durationMs: 0,
          outcome: 'aborted',
          reason: 'budget-exhausted',
          killsObserved: 0,
        });
        stats.missionsAborted++;
        continue;
      }
      const result = await runMission(ctx, m, args, log);
      stats.perMissionStats.push(result);
      if (result.outcome === 'completed') stats.missionsCompleted++;
      else stats.missionsAborted++;
    }

    // Best-effort: return to the original terminal so the server credits any
    // completions immediately (it usually does so on completion, but a return
    // trip is the canonical close-out path the real client follows).
    if (Date.now() < deadline && accepted.length > 0) {
      try {
        log(`returning to terminal ${stats.terminalUsed} to close out`);
        await ctx.navigate(
          { x: terminal.position.x, z: terminal.position.z },
          { useMount: 'auto' },
        );
      } catch (err) {
        log(`return navigate failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // === SNAPSHOT FINAL STATE ============================================
    stats.finalBank = ctx.character.bankBalance;
    stats.finalCash = ctx.character.cashBalance;
    stats.finalXp = xpMapToObject(ctx.character.xp);
    stats.creditsDelta =
      stats.finalBank + stats.finalCash - (stats.startingBank + stats.startingCash);
    stats.xpDeltaByType = diffXp(stats.startingXp, stats.finalXp);
    stats.totalElapsedMs = Date.now() - wallStart;
    log(
      `marathon done: accepted=${stats.missionsAccepted} completed=${stats.missionsCompleted} aborted=${stats.missionsAborted} creditsDelta=${stats.creditsDelta} xpKeys=${Object.keys(stats.xpDeltaByType).join(',')}`,
    );
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(
      SCRIPT,
      'Find a mission terminal, accept N missions, navigate + complete each, log credits + XP earned.',
      [
        '  --max-missions=N          max missions to accept this run (default 3)',
        '  --per-mission-timeout-s=N seconds per mission before aborting (default 60)',
        '  --terminal-radius=N       baseline-range radius for terminal scan in m (default 120)',
        '  --fallback-walk-radius=N  radius to scan for a landmark when no terminal in range (default 250)',
        '  --arrival-radius=N        radius around the waypoint for completion-target scan (default 12)',
        '  --pick=STRATEGY           payout (default) | distance',
      ],
    );
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const stats: MarathonStats = {
    spawnPosition: { x: 0, z: 0 },
    planet: '?',
    terminalsScannedInWorld: 0,
    terminalUsed: null,
    missionsAccepted: 0,
    missionsCompleted: 0,
    missionsAborted: 0,
    startingBank: 0,
    startingCash: 0,
    finalBank: 0,
    finalCash: 0,
    creditsDelta: 0,
    startingXp: {},
    finalXp: {},
    xpDeltaByType: {},
    totalElapsedMs: 0,
    perMissionStats: [],
    bailReason: null,
  };
  const scenario = buildScenario(script, totalMs, args.verbose, stats);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    maxMissions: script.maxMissions,
    perMissionTimeoutSec: script.perMissionTimeoutSec,
    pickStrategy: script.pickStrategy,
    terminalSearchRadiusM: script.terminalSearchRadiusM,
    ...stats,
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
