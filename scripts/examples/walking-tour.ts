#!/usr/bin/env node --import tsx
/**
 * walking-tour.ts — visit a series of hand-coded landmark coordinates around
 * the spawn, dwelling at each.
 *
 * Useful for: exercising movement under sustained walk plus settle cycles,
 * generating long transcripts for capture/replay baselines, and verifying
 * server reaction to position changes that cross object-cell boundaries.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/walking-tour.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --dwell-ms=4000 --speed=5 --minutes=10
 *
 * JSON output shape (stdout):
 *   { ok, host, account, character, durationMs, ... ,
 *     extra: { stops: [{x, z, dwellMs}], stopsVisited, loops } }
 */

import type { ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/walking-tour.ts';

interface ScriptArgs {
  dwellMs: number;
  speed: number;
  radius: number;
  stops: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    dwellMs: Number.parseInt(extra.get('dwell-ms') ?? '3000', 10),
    speed: Number.parseFloat(extra.get('speed') ?? '5'),
    radius: Number.parseFloat(extra.get('radius') ?? '30'),
    stops: Number.parseInt(extra.get('stops') ?? '6', 10),
  };
}

/** Generate `stops` landmark coordinates around the spawn on a wide ring. */
function landmarkStops(radius: number, count: number): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * 2 * Math.PI;
    out.push({
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
    });
  }
  return out;
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('tour', verbose);
    const spawn = ctx.sceneStart.startPosition;
    const stops = landmarkStops(args.radius, args.stops);
    log(
      `spawn=(${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}) radius=${args.radius} stops=${args.stops}`,
    );

    const deadline = Date.now() + totalMs;
    let loop = 0;
    let visited = 0;
    while (Date.now() < deadline) {
      for (const stop of stops) {
        if (Date.now() >= deadline) break;
        const target = { x: spawn.x + stop.x, z: spawn.z + stop.z };
        log(`loop ${loop} → (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`);
        await ctx.walkTo(target, { speed: args.speed });
        await ctx.wait(args.dwellMs);
        visited++;
      }
      loop++;
    }
    log(`tour finished: ${visited} stops over ${loop} loops`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Walk a loop of landmark coordinates around the spawn.', [
      '  --dwell-ms=N             ms to stand still at each stop (default 3000)',
      '  --speed=N                walk speed in m/s (default 5)',
      '  --radius=N               ring radius in metres (default 30)',
      '  --stops=N                number of landmarks on the ring (default 6)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const scenario = buildScenario(script, totalMs, args.verbose);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    stops: landmarkStops(script.radius, script.stops),
    dwellMs: script.dwellMs,
    speed: script.speed,
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
