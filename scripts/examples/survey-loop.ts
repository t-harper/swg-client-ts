#!/usr/bin/env node --import tsx
/**
 * survey-loop.ts — repeatedly survey at the current location for one
 * resource class. Accumulates a histogram of best-found efficiencies.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/survey-loop.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --resource=inorganic_mineral --interval-ms=4000 --minutes=5
 */

import type { ScenarioFn, SurveyPoint } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/survey-loop.ts';

interface ScriptArgs {
  resource: string;
  intervalMs: number;
  timeoutMs: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    resource: extra.get('resource') ?? 'inorganic_mineral',
    intervalMs: Number.parseInt(extra.get('interval-ms') ?? '4000', 10),
    timeoutMs: Number.parseInt(extra.get('timeout-ms') ?? '8000', 10),
  };
}

function bestEfficiency(points: SurveyPoint[]): number {
  let best = 0;
  for (const p of points) if (p.efficiency > best) best = p.efficiency;
  return best;
}

function buildScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  stats: {
    iters: number;
    timeouts: number;
    bestEver: number;
    samples: number;
    bestPerIter: number[];
  },
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('surv', verbose);
    log(`survey-loop resource=${args.resource} every ${args.intervalMs}ms`);

    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline) {
      ctx.survey(args.resource);
      try {
        const r = await ctx.waitForSurvey({ timeoutMs: args.timeoutMs });
        const best = bestEfficiency(r.points);
        stats.iters++;
        stats.samples += r.points.length;
        stats.bestPerIter.push(best);
        if (best > stats.bestEver) stats.bestEver = best;
        log(`iter ${stats.iters} best=${best.toFixed(3)} samples=${r.points.length}`);
      } catch {
        stats.timeouts++;
        log(`iter ${stats.iters} timed out`);
      }
      await ctx.wait(args.intervalMs);
    }
    log(
      `survey-loop done: ${stats.iters} surveys, ${stats.timeouts} timeouts, best=${stats.bestEver.toFixed(3)}`,
    );
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Survey current spot for a resource class on a loop.', [
      '  --resource=NAME          resource class (default inorganic_mineral)',
      '  --interval-ms=N          ms between surveys (default 4000)',
      '  --timeout-ms=N           survey response timeout (default 8000)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const stats = { iters: 0, timeouts: 0, bestEver: 0, samples: 0, bestPerIter: [] as number[] };
  const scenario = buildScenario(script, totalMs, args.verbose, stats);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    ...script,
    surveys: stats.iters,
    timeouts: stats.timeouts,
    samplesTotal: stats.samples,
    bestEverEfficiency: stats.bestEver,
    bestPerIterTail: stats.bestPerIter.slice(-10),
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
