#!/usr/bin/env node --import tsx
/**
 * multi-resource-survey.ts — cycle through K different resource classes at
 * the current spot. Useful for canvassing what a single location offers.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/multi-resource-survey.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --resources=inorganic_mineral,inorganic_chemical,flora --minutes=3
 */

import type { ScenarioFn, SurveyPoint } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/multi-resource-survey.ts';

interface ScriptArgs {
  resources: string[];
  intervalMs: number;
  timeoutMs: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('resources') ?? 'inorganic_mineral,inorganic_chemical,flora';
  const resources = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    resources,
    intervalMs: Number.parseInt(extra.get('interval-ms') ?? '3000', 10),
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
  byResource: Map<string, { surveys: number; bestEver: number; totalSamples: number }>,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('multi', verbose);
    log(`multi-resource: ${args.resources.length} classes, every ${args.intervalMs}ms`);
    for (const r of args.resources) byResource.set(r, { surveys: 0, bestEver: 0, totalSamples: 0 });

    const deadline = Date.now() + totalMs;
    let n = 0;
    while (Date.now() < deadline) {
      const resource = args.resources[n % args.resources.length];
      if (resource === undefined) break;
      ctx.survey(resource);
      try {
        const r = await ctx.waitForSurvey({ timeoutMs: args.timeoutMs });
        const stat = byResource.get(resource);
        if (stat !== undefined) {
          stat.surveys++;
          stat.totalSamples += r.points.length;
          const best = bestEfficiency(r.points);
          if (best > stat.bestEver) stat.bestEver = best;
        }
        log(`${resource} best=${bestEfficiency(r.points).toFixed(3)}`);
      } catch {
        log(`${resource} timeout`);
      }
      n++;
      await ctx.wait(args.intervalMs);
    }
    log('multi-resource done');
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Cycle through resource classes, surveying the current spot.', [
      '  --resources=A,B,C        comma-separated resource classes',
      '  --interval-ms=N          ms between surveys (default 3000)',
      '  --timeout-ms=N           survey response timeout (default 8000)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const byResource = new Map<string, { surveys: number; bestEver: number; totalSamples: number }>();
  const scenario = buildScenario(script, totalMs, args.verbose, byResource);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    intervalMs: script.intervalMs,
    perResource: Object.fromEntries(byResource),
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
