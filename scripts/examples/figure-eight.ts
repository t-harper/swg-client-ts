#!/usr/bin/env node --import tsx
/**
 * figure-eight.ts — two interlocked circles tracing a figure-8 around the
 * spawn, repeated.
 *
 * Trace the left circle (centre at spawn + (-radius, 0)) one full revolution,
 * then the right circle (centre at spawn + (+radius, 0)) the opposite way.
 * Repeat until duration expires.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/figure-eight.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --radius=10 --loop-seconds=12 --minutes=5
 */

import type { ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/figure-eight.ts';

interface ScriptArgs {
  radius: number;
  loopSeconds: number;
  speed: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    radius: Number.parseFloat(extra.get('radius') ?? '8'),
    loopSeconds: Number.parseFloat(extra.get('loop-seconds') ?? '10'),
    speed: Number.parseFloat(extra.get('speed') ?? '5'),
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('fig8', verbose);
    const spawn = ctx.sceneStart.startPosition;
    const halfLoopMs = (args.loopSeconds / 2) * 1_000;
    log(`figure-eight radius=${args.radius} loop=${args.loopSeconds}s`);

    const deadline = Date.now() + totalMs;
    let loops = 0;
    while (Date.now() < deadline) {
      await ctx.walkCircle({
        centerX: spawn.x - args.radius,
        centerZ: spawn.z,
        radius: args.radius,
        durationMs: halfLoopMs,
        speed: args.speed,
        direction: 1,
      });
      if (Date.now() >= deadline) break;
      await ctx.walkCircle({
        centerX: spawn.x + args.radius,
        centerZ: spawn.z,
        radius: args.radius,
        durationMs: halfLoopMs,
        speed: args.speed,
        direction: -1,
      });
      loops++;
      log(`completed loop ${loops}`);
    }
    log(`figure-eight finished after ${loops} loops`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Trace a figure-eight pattern repeatedly around the spawn.', [
      '  --radius=N               radius of each circle in m (default 8)',
      '  --loop-seconds=N         seconds per full figure-8 (default 10)',
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
