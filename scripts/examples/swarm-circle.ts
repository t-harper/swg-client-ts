#!/usr/bin/env node --import tsx
/**
 * swarm-circle.ts — Fleet of N characters all walk a shared circle in unison.
 *
 * Each character is given a phase offset on the same circle so they spread
 * around the perimeter. They then walk the full circle for `--minutes`.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/swarm-circle.ts \
 *     --host=10.254.0.253 --count=6 --radius=10 --minutes=1
 */

import type { FleetClientConfig, ScenarioFn } from '../../src/index.js';
import {
  durationMs,
  formatJson,
  makeLogger,
  parseCommonArgs,
  runFleet,
  unique15,
  usage,
} from './_lib.js';

const SCRIPT = 'scripts/examples/swarm-circle.ts';

interface ScriptArgs {
  count: number;
  prefix: string;
  radius: number;
  loopSeconds: number;
  staggerMs: number;
}

function parseScriptArgs(extra: Map<string, string>, defaultPrefix: string): ScriptArgs {
  return {
    count: Number.parseInt(extra.get('count') ?? '6', 10),
    prefix: extra.get('prefix') ?? defaultPrefix,
    radius: Number.parseFloat(extra.get('radius') ?? '10'),
    loopSeconds: Number.parseFloat(extra.get('loop-seconds') ?? '15'),
    staggerMs: Number.parseInt(extra.get('stagger-ms') ?? '250', 10),
  };
}

function makeScenario(
  args: ScriptArgs,
  index: number,
  totalMs: number,
  verbose: boolean,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger(`sw${index}`, verbose);
    const spawn = ctx.sceneStart.startPosition;
    const phaseOffset = (index / args.count) * 2 * Math.PI;
    log(`phase ${phaseOffset.toFixed(2)} rad`);

    const deadline = Date.now() + totalMs;
    const loopMs = args.loopSeconds * 1000;
    // Walk to the starting phase first
    const startX = spawn.x + Math.cos(phaseOffset) * args.radius;
    const startZ = spawn.z + Math.sin(phaseOffset) * args.radius;
    await ctx.walkTo({ x: startX, z: startZ }, { speed: 6 });

    while (Date.now() < deadline) {
      const remaining = Math.min(loopMs, deadline - Date.now());
      await ctx.walkCircle({
        centerX: spawn.x,
        centerZ: spawn.z,
        radius: args.radius,
        durationMs: remaining,
        speed: 5,
        direction: 1,
      });
    }
    log('swarm done');
  };
}

function buildConfigs(
  args: ScriptArgs,
  runTag: string,
  totalMs: number,
  verbose: boolean,
): FleetClientConfig[] {
  const cfgs: FleetClientConfig[] = [];
  for (let i = 0; i < args.count; i++) {
    const account = unique15(`${args.prefix}${runTag}`, i);
    const characterName = `Swrm${runTag}${i}`;
    cfgs.push({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: makeScenario(args, i, totalMs, verbose),
    });
  }
  return cfgs;
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2), { minutes: 1 });
  if (args.help) {
    usage(SCRIPT, 'Fleet swarm — N characters walk a shared circle.', [
      '  --count=N                characters (default 6)',
      '  --prefix=STR             account prefix (default "swrm")',
      '  --radius=N               circle radius in m (default 10)',
      '  --loop-seconds=N         seconds per revolution (default 15)',
      '  --stagger-ms=N           launch stagger between clients (default 250)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra, 'swrm');
  const totalMs = durationMs(args.minutes);
  const runTag = (Date.now() % 1_000_000).toString(36);
  const configs = buildConfigs(script, runTag, totalMs, args.verbose);
  const { summary } = await runFleet(args, configs, { staggerMs: script.staggerMs });
  summary.extra = {
    count: script.count,
    radius: script.radius,
    loopSeconds: script.loopSeconds,
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
