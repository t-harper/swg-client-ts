#!/usr/bin/env node --import tsx
/**
 * target-acquisition.ts — world-aware combat-target acquisition loop.
 *
 * Picks targets dynamically from the live WorldModel each tick (via
 * `ctx.nearestHostile()` / `ctx.world.byType(CREO)`), then queues an
 * `attack` against each. Useful for soak-testing the combat command-queue
 * path against whatever happens to be in range — no need to paste hardcoded
 * NetworkIds.
 *
 * Modes (`--mode=`):
 *   - `hostile`        (default) only CREOs with `inCombat === true` in their
 *                      SHARED_NP baseline. Same filter as `ctx.nearestHostile()`.
 *   - `all-creatures`  any CREO within `--max-radius` (peaceful AND hostile).
 *                      Useful for "attack first, ask questions later" testing.
 *   - `list`           legacy back-compat: cycle the static `--targets=A,B,C`
 *                      list, ignoring world state. Auto-selected when
 *                      `--targets=` is provided without an explicit `--mode`.
 *
 * Examples:
 *   # hostile mode — auto-target whichever angry CREO is closest, re-query every dwell
 *   pnpm exec tsx scripts/examples/target-acquisition.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --mode=hostile --max-radius=40 --max-targets=5 --dwell-ms=3000 --minutes=5
 *
 *   # all-creatures mode — engage any CREO in range, hostile or not
 *   pnpm exec tsx scripts/examples/target-acquisition.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --mode=all-creatures --max-radius=25 --max-targets=3 --minutes=2
 *
 *   # legacy list mode — back-compat with the original signature
 *   pnpm exec tsx scripts/examples/target-acquisition.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --targets=0x111,0x222,0x333 --dwell-ms=3000 --minutes=5
 */

import {
  type NetworkId,
  ObjectTypeTags,
  type ScenarioFn,
  type WorldObject,
} from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/target-acquisition.ts';

type Mode = 'hostile' | 'all-creatures' | 'list';

interface ScriptArgs {
  mode: Mode;
  targets: NetworkId[];
  dwellMs: number;
  maxRadiusM: number;
  maxTargets: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('targets') ?? '';
  const targets = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => BigInt(s) as NetworkId);

  // If --targets= was supplied without an explicit --mode, default to 'list'
  // for back-compat with the original (pre-WorldModel) invocation. Otherwise
  // default to 'hostile' — the new dynamic-acquisition path.
  const explicitMode = extra.get('mode');
  const mode: Mode = (explicitMode ?? (targets.length > 0 ? 'list' : 'hostile')) as Mode;
  if (mode !== 'hostile' && mode !== 'all-creatures' && mode !== 'list') {
    throw new Error(`--mode must be one of: hostile, all-creatures, list (got "${mode}")`);
  }

  return {
    mode,
    targets,
    dwellMs: Number.parseInt(extra.get('dwell-ms') ?? '3000', 10),
    maxRadiusM: Number.parseFloat(extra.get('max-radius') ?? '40'),
    maxTargets: Number.parseInt(extra.get('max-targets') ?? '5', 10),
  };
}

interface SweepRow {
  cycle: number;
  idx: number;
  targetId: string;
  seq: number;
  source: Mode;
}

function buildScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  sweep: SweepRow[],
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('targ', verbose);
    if (args.mode === 'list' && args.targets.length === 0) {
      throw new Error('--targets is required when --mode=list (comma-separated NetworkIds)');
    }
    const tail = args.mode === 'list' ? ` targets=${args.targets.length}` : '';
    log(
      `mode=${args.mode} dwell=${args.dwellMs}ms maxRadius=${args.maxRadiusM}m maxTargets=${args.maxTargets}${tail}`,
    );

    const deadline = Date.now() + totalMs;
    let cycle = 0;
    let attemptIdx = 0;

    while (Date.now() < deadline) {
      const picks: NetworkId[] = acquireTargets(args, ctx);
      if (picks.length === 0) {
        log(`cycle ${cycle} no targets in range — waiting ${args.dwellMs}ms`);
        await ctx.wait(args.dwellMs);
        cycle++;
        continue;
      }
      for (const t of picks) {
        if (Date.now() >= deadline) break;
        const seq = ctx.attackTarget(t);
        sweep.push({
          cycle,
          idx: attemptIdx,
          targetId: `0x${t.toString(16)}`,
          seq,
          source: args.mode,
        });
        log(`cycle ${cycle} target ${attemptIdx} (0x${t.toString(16)}) seq=${seq}`);
        attemptIdx++;
        await ctx.wait(args.dwellMs);
      }
      cycle++;
    }
    log(`sweep done: ${attemptIdx} attacks across ${cycle} cycles`);
    await ctx.logout();
  };
}

/**
 * Pull the next batch of target NetworkIds. For `list` mode this returns the
 * static `--targets` array. For `hostile` / `all-creatures` we query the
 * live WorldModel each call, so the set is dynamic across cycles.
 */
function acquireTargets(args: ScriptArgs, ctx: Parameters<ScenarioFn>[0]): NetworkId[] {
  if (args.mode === 'list') {
    return args.targets.slice(0, args.maxTargets);
  }

  const here = ctx.position();
  const maxR2 = args.maxRadiusM * args.maxRadiusM;
  const candidates: Array<{ obj: WorldObject; d2: number }> = [];

  if (args.mode === 'hostile') {
    // Anchor on `nearestHostile` so the closest in-combat CREO is always
    // picked first, then top up with the next-nearest hostiles up to maxTargets.
    const first = ctx.nearestHostile({ maxRadiusM: args.maxRadiusM });
    if (first === undefined) return [];
    candidates.push({ obj: first, d2: dist2(first, here) });
  }

  for (const o of ctx.world.byType(ObjectTypeTags.CREO)) {
    if (o.id === ctx.sceneStart.playerNetworkId) continue;
    if (candidates.some((c) => c.obj.id === o.id)) continue;
    if (args.mode === 'hostile') {
      // SHARED_NP package id = 6 — same path `ctx.nearestHostile` walks.
      const sharedNp = o.baselines.get(6) as { inCombat?: boolean } | undefined;
      if (sharedNp?.inCombat !== true) continue;
    }
    const d2 = dist2(o, here);
    if (d2 > maxR2) continue;
    candidates.push({ obj: o, d2 });
  }

  candidates.sort((a, b) => a.d2 - b.d2);
  return candidates.slice(0, args.maxTargets).map((c) => c.obj.id);
}

function dist2(o: WorldObject, here: { x: number; z: number }): number {
  const dx = o.position.x - here.x;
  const dz = o.position.z - here.z;
  return dx * dx + dz * dz;
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Sweep dynamic combat targets pulled from the live WorldModel.', [
      '  --mode=MODE              hostile (default) | all-creatures | list',
      '  --targets=A,B,C          when --mode=list, comma-separated NetworkIds',
      '  --max-radius=N           meters — target search radius (default 40)',
      '  --max-targets=N          cap targets attacked per cycle (default 5)',
      '  --dwell-ms=N             ms between attacks (default 3000)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const sweep: SweepRow[] = [];
  const scenario = buildScenario(script, totalMs, args.verbose, sweep);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    mode: script.mode,
    targetCount: script.targets.length,
    maxRadiusM: script.maxRadiusM,
    maxTargets: script.maxTargets,
    attemptCount: sweep.length,
    sweepHead: sweep.slice(0, 10),
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
