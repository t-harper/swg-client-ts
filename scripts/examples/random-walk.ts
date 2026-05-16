#!/usr/bin/env node --import tsx
/**
 * random-walk.ts — pick a random direction every K seconds and walk a short
 * distance for total duration. The character meanders around the spawn within
 * a bounded distance to avoid leaving the loaded cell.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/random-walk.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --leg-seconds=4 --leg-distance=15 --max-radius=80 --minutes=5
 */

import type { ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/random-walk.ts';

interface ScriptArgs {
  legSeconds: number;
  legDistance: number;
  maxRadius: number;
  speed: number;
  seed: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    legSeconds: Number.parseFloat(extra.get('leg-seconds') ?? '4'),
    legDistance: Number.parseFloat(extra.get('leg-distance') ?? '12'),
    maxRadius: Number.parseFloat(extra.get('max-radius') ?? '60'),
    speed: Number.parseFloat(extra.get('speed') ?? '5'),
    seed: Number.parseInt(extra.get('seed') ?? `${Date.now() & 0xffff}`, 10),
  };
}

/** Mulberry32 PRNG — deterministic and tiny. */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('walk', verbose);
    const spawn = ctx.sceneStart.startPosition;
    const rand = rng(args.seed);
    log(`spawn=(${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}) seed=${args.seed}`);

    const deadline = Date.now() + totalMs;
    let legs = 0;
    let clamps = 0;
    while (Date.now() < deadline) {
      const cur = ctx.position();
      const angle = rand() * 2 * Math.PI;
      let tx = cur.x + Math.cos(angle) * args.legDistance;
      let tz = cur.z + Math.sin(angle) * args.legDistance;
      // Clamp back toward spawn if we drift too far.
      const dx = tx - spawn.x;
      const dz = tz - spawn.z;
      const dist = Math.hypot(dx, dz);
      if (dist > args.maxRadius) {
        const k = args.maxRadius / dist;
        tx = spawn.x + dx * k;
        tz = spawn.z + dz * k;
        clamps++;
      }
      log(`leg ${legs} → (${tx.toFixed(1)}, ${tz.toFixed(1)})`);
      await ctx.walkTo({ x: tx, z: tz }, { speed: args.speed });
      await ctx.wait(Math.max(0, args.legSeconds * 1_000));
      legs++;
    }
    log(`walked ${legs} legs (${clamps} clamps)`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Random-walk around spawn within a bounded radius.', [
      '  --leg-seconds=N          dwell ms after each walk leg (default 4)',
      '  --leg-distance=N         max walk distance per leg in m (default 12)',
      '  --max-radius=N           clamp position within N m of spawn (default 60)',
      '  --speed=N                walk speed in m/s (default 5)',
      '  --seed=N                 RNG seed (default time-based)',
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
