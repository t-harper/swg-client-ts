#!/usr/bin/env node --import tsx
/**
 * crowd-density.ts — periodic crowd-density snapshots — useful for population
 * analytics, zone-load testing, AFK-population maps.
 *
 * Every `--interval-ms` (default 30000), emits one NDJSON record to stdout
 * summarizing what the live WorldModel can see from the player's vantage:
 *
 *   - players in view (total + within --radius + within 50m)
 *   - CREOs in view (total + currently inCombat per their SHARED_NP baseline)
 *   - total tracked world-model objects
 *   - the player's current position
 *
 * The script never moves the character — it just dwells and samples. Pair
 * with a Fleet or a walk-circle session running in parallel if you want
 * traffic at the sample point.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/crowd-density.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --minutes=10 --interval-ms=30000 --radius=20
 */

import {
  BaselinePackageIds,
  ObjectTypeTags,
  type ScenarioFn,
  type TangibleObjectSharedNpBaseline,
} from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/crowd-density.ts';

interface ScriptArgs {
  intervalMs: number;
  radiusM: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const intervalMs = Number.parseInt(extra.get('interval-ms') ?? '30000', 10);
  const radiusM = Number.parseFloat(extra.get('radius') ?? '20');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`--interval-ms must be a positive integer (got "${extra.get('interval-ms')}")`);
  }
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw new Error(`--radius must be a positive number (got "${extra.get('radius')}")`);
  }
  return { intervalMs, radiusM };
}

interface DensitySnapshot {
  at: string;
  playersTotal: number;
  playersInRange: number;
  playersInRange50: number;
  creosTotal: number;
  creosInCombat: number;
  worldSize: number;
  position: { x: number; y: number; z: number };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('crowd', verbose);
    log(
      `sampling every ${args.intervalMs}ms for ${(totalMs / 1000).toFixed(0)}s (radius=${args.radiusM}m)`,
    );

    const deadline = Date.now() + totalMs;
    let snapshots = 0;

    while (Date.now() < deadline && !ctx.signal.aborted) {
      // Aggregate the current snapshot. All queries are O(n) over the
      // WorldModel (low hundreds of objects in the typical view), so
      // this is cheap enough to run on a 30s interval without blocking.
      const playersTotal = ctx.world.byType(ObjectTypeTags.PLAY).length;
      const playersInRange = ctx.playersInRange(args.radiusM).length;
      const playersInRange50 = ctx.playersInRange(50).length;

      const creos = ctx.world.byType(ObjectTypeTags.CREO);
      let creosInCombat = 0;
      for (const o of creos) {
        // inCombat lives on the SHARED_NP (Tangible package 6) baseline —
        // same source `ctx.nearestHostile()` reads from. The baseline may
        // not have arrived yet for freshly-created objects, in which case
        // we count it as not-in-combat (no flag observed).
        const tanoNp = o.baselines.get(BaselinePackageIds.SHARED_NP) as
          | TangibleObjectSharedNpBaseline
          | undefined;
        if (tanoNp?.inCombat === true) creosInCombat++;
      }

      const pos = ctx.position();
      const snapshot: DensitySnapshot = {
        at: new Date().toISOString(),
        playersTotal,
        playersInRange,
        playersInRange50,
        creosTotal: creos.length,
        creosInCombat,
        worldSize: ctx.world.size(),
        position: { x: pos.x, y: pos.y, z: pos.z },
      };

      // One NDJSON line per snapshot. Compact form so downstream tools
      // (jq, dsq, duckdb) can stream cleanly.
      process.stdout.write(`${JSON.stringify(snapshot)}\n`);
      snapshots++;
      log(
        `#${snapshots} players=${playersTotal} (r${args.radiusM}=${playersInRange}, r50=${playersInRange50}) creos=${creos.length} combat=${creosInCombat} world=${snapshot.worldSize}`,
      );

      // Sleep until the next tick or until we run out of time. ctx.wait
      // respects the abort signal, so a Ctrl-C terminates promptly.
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await ctx.wait(Math.min(args.intervalMs, remaining));
    }

    log(`finished: ${snapshots} snapshots`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Periodic crowd-density snapshots (population analytics).', [
      '  --interval-ms=N          ms between samples (default 30000)',
      '  --radius=M               near-range radius in metres (default 20)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const scenario = buildScenario(script, totalMs, args.verbose);
  const { summary } = await runScenario(args, scenario);
  summary.extra = { ...script };
  // Trailing summary goes to stdout after the NDJSON stream; both share
  // stdout but the NDJSON records are one-line JSON objects and the
  // summary is the lifecycle wrapper, so a consumer can split on shape.
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
