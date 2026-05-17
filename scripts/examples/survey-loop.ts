#!/usr/bin/env node --import tsx
/**
 * survey-loop.ts — repeatedly survey at the current location for one
 * resource class. Accumulates a histogram of best-found efficiencies.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/survey-loop.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --resource=mineral --interval-ms=4000 --minutes=5
 *
 * The character must hold a survey tool whose VAR_SURVEY_CLASS objvar
 * matches the requested class (or the universal `survey_tool_all`). If
 * `--resource` doesn't map to any in-inventory tool the script exits with
 * `--no-tool--` in its summary.
 */

import type { ScenarioFn, SurveyPoint } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';
import { fetchTypeNamesForClass, findSurveyTools, pickToolForClass } from './_lib-survey.js';

const SCRIPT = 'scripts/examples/survey-loop.ts';

interface ScriptArgs {
  resource: string;
  intervalMs: number;
  timeoutMs: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    // `mineral` matches a `survey_tool_mineral_n` template. Use `--resource=*`
    // to pick whichever tool the character carries (the universal tool).
    resource: extra.get('resource') ?? 'mineral',
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
    status: string;
    resourceTypes: string[];
  },
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('surv', verbose);
    log(`survey-loop resource=${args.resource} every ${args.intervalMs}ms`);

    // Give the baselines a moment to land so the inventory is fully visible.
    await ctx.wait(2_000);
    const tools = findSurveyTools(ctx);
    log(`found ${tools.size} survey tool(s) in inventory`);
    const toolId = pickToolForClass(tools, args.resource);
    if (toolId === undefined) {
      stats.status = 'no-tool';
      log(`no survey tool for class ${args.resource} — bailing`);
      await ctx.logout();
      return;
    }
    // Resolve the list of spawned resource type names for this tool ONCE.
    // They don't change inside a session.
    const types = await fetchTypeNamesForClass(ctx, tools, args.resource, {
      timeoutMs: args.timeoutMs,
    });
    if (types === null || types.length === 0) {
      stats.status = 'no-types';
      log(`resource list empty (no spawned resources?) — bailing`);
      await ctx.logout();
      return;
    }
    stats.resourceTypes = types.map((t) => t.resourceName);
    log(`resource types available: ${stats.resourceTypes.slice(0, 3).join(', ')}...`);
    stats.status = 'ok';

    // Round-robin through the spawned types.
    const deadline = Date.now() + totalMs;
    let nextType = 0;
    while (Date.now() < deadline) {
      const type = types[nextType % types.length];
      if (type === undefined) break;
      nextType++;
      ctx.survey(toolId, type.resourceName);
      try {
        const r = await ctx.waitForSurvey({ timeoutMs: args.timeoutMs });
        const best = bestEfficiency(r.points);
        stats.iters++;
        stats.samples += r.points.length;
        stats.bestPerIter.push(best);
        if (best > stats.bestEver) stats.bestEver = best;
        log(`iter ${stats.iters} type=${type.resourceName} best=${best.toFixed(3)} samples=${r.points.length}`);
      } catch {
        stats.timeouts++;
        log(`iter ${stats.iters} type=${type.resourceName} timed out`);
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
      '  --resource=NAME          resource class (default mineral; also accepts inorganic_mineral etc)',
      '  --interval-ms=N          ms between surveys (default 4000)',
      '  --timeout-ms=N           survey response timeout (default 8000)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const stats = {
    iters: 0,
    timeouts: 0,
    bestEver: 0,
    samples: 0,
    bestPerIter: [] as number[],
    status: 'starting',
    resourceTypes: [] as string[],
  };
  const scenario = buildScenario(script, totalMs, args.verbose, stats);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    ...script,
    status: stats.status,
    surveys: stats.iters,
    timeouts: stats.timeouts,
    samplesTotal: stats.samples,
    bestEverEfficiency: stats.bestEver,
    bestPerIterTail: stats.bestPerIter.slice(-10),
    resourceTypesAvailable: stats.resourceTypes,
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
