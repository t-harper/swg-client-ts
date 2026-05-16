#!/usr/bin/env node --import tsx
/**
 * parade.ts — Fleet of N characters walk in a line behind a leader; each
 * follower targets the previous walker's position with a stagger.
 *
 * The leader walks a long zig-zag pattern around the spawn. Each follower's
 * scenario is configured with a `--lead-distance` offset behind it in the
 * direction of the leader's walk. Since they're independent clients with no
 * cross-talk, the follow is purely positional + time-staggered.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/parade.ts \
 *     --host=10.254.0.253 --count=5 --minutes=1 --user=parade-base
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

const SCRIPT = 'scripts/examples/parade.ts';

interface ScriptArgs {
  count: number;
  prefix: string;
  legLength: number;
  legPauseMs: number;
  leadDistance: number;
  staggerMs: number;
  legsTotal: number;
  speed: number;
}

function parseScriptArgs(extra: Map<string, string>, defaultPrefix: string): ScriptArgs {
  return {
    count: Number.parseInt(extra.get('count') ?? '4', 10),
    prefix: extra.get('prefix') ?? defaultPrefix,
    legLength: Number.parseFloat(extra.get('leg-length') ?? '20'),
    legPauseMs: Number.parseInt(extra.get('leg-pause-ms') ?? '700', 10),
    leadDistance: Number.parseFloat(extra.get('lead-distance') ?? '3'),
    staggerMs: Number.parseInt(extra.get('stagger-ms') ?? '500', 10),
    legsTotal: Number.parseInt(extra.get('legs') ?? '20', 10),
    speed: Number.parseFloat(extra.get('speed') ?? '5'),
  };
}

/** Zig-zag legs around the spawn: alternating +/- x with constant z step. */
function makeLegs(legLength: number, count: number): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < count; i++) {
    const sign = i % 2 === 0 ? 1 : -1;
    out.push({ x: sign * legLength, z: i * legLength * 0.4 });
  }
  return out;
}

function makeFollowerScenario(
  args: ScriptArgs,
  followerIndex: number,
  totalMs: number,
  verbose: boolean,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger(`pf${followerIndex}`, verbose);
    const spawn = ctx.sceneStart.startPosition;
    const legs = makeLegs(args.legLength, args.legsTotal);
    // Stagger: follower `i` lags by `(i+1) * staggerMs` so the line ramps.
    const lagMs = (followerIndex + 1) * args.staggerMs;
    log(`waiting ${lagMs}ms lag before first leg`);
    await ctx.wait(lagMs);

    const deadline = Date.now() + totalMs;
    let last: { x: number; z: number } = { x: 0, z: 0 };
    void spawn.y;
    for (const leg of legs) {
      if (Date.now() >= deadline) break;
      // Offset target by `leadDistance * (followerIndex+1)` in the opposite
      // direction of travel so the follower trails the line.
      const dx = leg.x - last.x;
      const dz = leg.z - last.z;
      const dist = Math.hypot(dx, dz);
      const k = dist === 0 ? 0 : (args.leadDistance * (followerIndex + 1)) / dist;
      const target = {
        x: spawn.x + leg.x - dx * k,
        z: spawn.z + leg.z - dz * k,
      };
      log(`leg → (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`);
      await ctx.walkTo(target, { speed: args.speed });
      await ctx.wait(args.legPauseMs);
      last = leg;
    }
    log('follower done');
  };
}

function makeLeaderScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('lead', verbose);
    const spawn = ctx.sceneStart.startPosition;
    const legs = makeLegs(args.legLength, args.legsTotal);
    log(`leader marching ${legs.length} legs`);
    const deadline = Date.now() + totalMs;
    for (const leg of legs) {
      if (Date.now() >= deadline) break;
      const target = { x: spawn.x + leg.x, z: spawn.z + leg.z };
      await ctx.walkTo(target, { speed: args.speed });
      await ctx.wait(args.legPauseMs);
    }
    log('leader done');
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
    const characterName = `Parade${runTag}${i}`;
    cfgs.push({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script:
        i === 0
          ? makeLeaderScenario(args, totalMs, verbose)
          : makeFollowerScenario(args, i - 1, totalMs, verbose),
    });
  }
  return cfgs;
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2), { minutes: 1 });
  if (args.help) {
    usage(SCRIPT, 'Fleet parade — leader walks zig-zag, followers trail behind.', [
      '  --count=N                total characters incl. leader (default 4)',
      '  --prefix=STR             account prefix (default "parade")',
      '  --leg-length=N           leg length in m (default 20)',
      '  --leg-pause-ms=N         pause between legs in ms (default 700)',
      '  --lead-distance=N        per-follower offset behind leader in m (default 3)',
      '  --stagger-ms=N           per-follower startup lag in ms (default 500)',
      '  --legs=N                 total legs (default 20)',
      '  --speed=N                walk speed (default 5)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra, 'parade');
  const totalMs = durationMs(args.minutes);
  const runTag = (Date.now() % 1_000_000).toString(36);
  const configs = buildConfigs(script, runTag, totalMs, args.verbose);
  const { summary } = await runFleet(args, configs, { staggerMs: 250 });
  summary.extra = {
    count: script.count,
    runTag,
    leaderAccount: configs[0]?.account,
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
