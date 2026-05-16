#!/usr/bin/env node --import tsx
/**
 * target-acquisition.ts — sweep a list of NetworkIds, attempt attack on each
 * in turn, log responses.
 *
 * Iterates `--targets` (comma-separated NetworkIds) and queues `attack`
 * against each, holding for `--dwell-ms`. Useful for probing which baselined
 * objects are valid combat targets.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/target-acquisition.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --targets=0x111,0x222,0x333 --dwell-ms=3000 --minutes=5
 */

import type { NetworkId, ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/target-acquisition.ts';

interface ScriptArgs {
  targets: NetworkId[];
  dwellMs: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('targets') ?? '';
  const targets = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => BigInt(s) as NetworkId);
  return {
    targets,
    dwellMs: Number.parseInt(extra.get('dwell-ms') ?? '3000', 10),
  };
}

function buildScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  sweep: Array<{ idx: number; targetId: string; cycle: number; seq: number }>,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('targ', verbose);
    if (args.targets.length === 0)
      throw new Error('--targets is required (comma-separated NetworkIds)');
    log(`sweeping ${args.targets.length} targets, dwell=${args.dwellMs}ms`);

    const deadline = Date.now() + totalMs;
    let cycle = 0;
    let i = 0;
    while (Date.now() < deadline) {
      for (const t of args.targets) {
        if (Date.now() >= deadline) break;
        const seq = ctx.attackTarget(t);
        sweep.push({ idx: i, targetId: `0x${t.toString(16)}`, cycle, seq });
        log(`cycle ${cycle} target ${i} (0x${t.toString(16)}) seq=${seq}`);
        i++;
        await ctx.wait(args.dwellMs);
      }
      cycle++;
    }
    log(`sweep done: ${i} attacks across ${cycle} cycles`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Sweep a list of NetworkIds, attempting to attack each.', [
      '  --targets=A,B,C          comma-separated target NetworkIds (required)',
      '  --dwell-ms=N             ms between attacks (default 3000)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const sweep: Array<{ idx: number; targetId: string; cycle: number; seq: number }> = [];
  const scenario = buildScenario(script, totalMs, args.verbose, sweep);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    targetCount: script.targets.length,
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
