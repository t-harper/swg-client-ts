#!/usr/bin/env node --import tsx
/**
 * spiral-out.ts — outward Archimedean spiral centred on the spawn.
 *
 * Walks an Archimedean spiral r = a + b·θ in discrete segments. The spiral
 * grows by `step-radius` metres per revolution. After reaching `max-radius`
 * (or duration), it logs out.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/spiral-out.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --segments=24 --step-radius=2 --max-radius=60 --minutes=5
 */

import type { ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/spiral-out.ts';

interface ScriptArgs {
  segments: number;
  stepRadius: number;
  maxRadius: number;
  speed: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    segments: Number.parseInt(extra.get('segments') ?? '24', 10),
    stepRadius: Number.parseFloat(extra.get('step-radius') ?? '2'),
    maxRadius: Number.parseFloat(extra.get('max-radius') ?? '50'),
    speed: Number.parseFloat(extra.get('speed') ?? '5'),
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('spiral', verbose);
    const spawn = ctx.sceneStart.startPosition;
    const angleStep = (2 * Math.PI) / Math.max(2, args.segments);
    const radiusStep = args.stepRadius / Math.max(2, args.segments);
    log(`spiral spawn=(${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}) step=${args.stepRadius}m/rev`);

    const deadline = Date.now() + totalMs;
    let r = 0;
    let theta = 0;
    let segs = 0;
    while (Date.now() < deadline && r < args.maxRadius) {
      r += radiusStep;
      theta += angleStep;
      const x = spawn.x + Math.cos(theta) * r;
      const z = spawn.z + Math.sin(theta) * r;
      if (segs % args.segments === 0) log(`rev ${segs / args.segments}: r=${r.toFixed(1)}`);
      await ctx.walkTo({ x, z }, { speed: args.speed });
      segs++;
    }
    log(`spiral done: ${segs} segments, final r=${r.toFixed(1)}`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Walk an outward Archimedean spiral around the spawn.', [
      '  --segments=N             segments per revolution (default 24)',
      '  --step-radius=N          radius growth per revolution in m (default 2)',
      '  --max-radius=N           stop at this radius (default 50)',
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
