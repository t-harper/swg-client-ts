#!/usr/bin/env node --import tsx
/**
 * square-patrol.ts — walk the perimeter of a square indefinitely.
 *
 * Behaviour: walk to the four corners of an `--edge`-metre square centred on
 * the spawn, in clockwise order, looping until the duration elapses.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/square-patrol.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --edge=30 --pause-ms=1000 --minutes=5
 */

import type { ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/square-patrol.ts';

interface ScriptArgs {
  edge: number;
  pauseMs: number;
  speed: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    edge: Number.parseFloat(extra.get('edge') ?? '20'),
    pauseMs: Number.parseInt(extra.get('pause-ms') ?? '800', 10),
    speed: Number.parseFloat(extra.get('speed') ?? '5'),
  };
}

function corners(edge: number): Array<{ x: number; z: number }> {
  const h = edge / 2;
  return [
    { x: h, z: h },
    { x: -h, z: h },
    { x: -h, z: -h },
    { x: h, z: -h },
  ];
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('square', verbose);
    const spawn = ctx.sceneStart.startPosition;
    const c = corners(args.edge);
    log(`patrolling ${args.edge}m square @ (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)})`);

    const deadline = Date.now() + totalMs;
    let laps = 0;
    let corners_visited = 0;
    while (Date.now() < deadline) {
      for (const corner of c) {
        if (Date.now() >= deadline) break;
        const target = { x: spawn.x + corner.x, z: spawn.z + corner.z };
        log(`corner ${corners_visited % 4}: (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`);
        await ctx.walkTo(target, { speed: args.speed });
        await ctx.wait(args.pauseMs);
        corners_visited++;
      }
      laps++;
    }
    log(`patrol finished: ${laps} laps`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Walk a square perimeter loop around the spawn.', [
      '  --edge=N                 square edge length in m (default 20)',
      '  --pause-ms=N             pause at each corner in ms (default 800)',
      '  --speed=N                walk speed (default 5)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const scenario = buildScenario(script, totalMs, args.verbose);
  const { summary } = await runScenario(args, scenario);
  summary.extra = { ...script };
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
