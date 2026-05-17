#!/usr/bin/env node --import tsx
/**
 * multi-resource-survey.ts — cycle through K different resource classes at
 * the current spot. Useful for canvassing what a single location offers.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/multi-resource-survey.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --resources=mineral,inorganic_chemical,flora_resources --minutes=3
 *
 * Each class is mapped to an in-inventory survey tool. For each class we
 * fetch the available spawned resource type names ONCE (they don't change
 * during a session) and then round-robin survey each type until the
 * duration elapses.
 */

import type { NetworkId, ScenarioFn, SurveyPoint } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';
import { fetchTypeNamesForClass, findSurveyTools, pickToolForClass } from './_lib-survey.js';

const SCRIPT = 'scripts/examples/multi-resource-survey.ts';

interface ScriptArgs {
  resources: string[];
  intervalMs: number;
  timeoutMs: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('resources') ?? 'mineral,inorganic_chemical,flora_resources';
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

interface ClassPlan {
  cls: string;
  toolId: NetworkId | undefined;
  typeNames: string[];
  nextType: number;
  status: 'ok' | 'no-tool' | 'no-types';
}

function buildScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  byResource: Map<string, { surveys: number; bestEver: number; totalSamples: number; status: string }>,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('multi', verbose);
    log(`multi-resource: ${args.resources.length} classes, every ${args.intervalMs}ms`);

    await ctx.wait(2_000);
    const tools = findSurveyTools(ctx);
    log(`found ${tools.size} survey tool(s) in inventory`);

    // Resolve tool + resource type list per class up front.
    const plans: ClassPlan[] = [];
    for (const cls of args.resources) {
      const toolId = pickToolForClass(tools, cls);
      if (toolId === undefined) {
        byResource.set(cls, { surveys: 0, bestEver: 0, totalSamples: 0, status: 'no-tool' });
        plans.push({ cls, toolId: undefined, typeNames: [], nextType: 0, status: 'no-tool' });
        log(`${cls}: no tool`);
        continue;
      }
      const types = await fetchTypeNamesForClass(ctx, tools, cls, { timeoutMs: args.timeoutMs });
      if (types === null || types.length === 0) {
        byResource.set(cls, { surveys: 0, bestEver: 0, totalSamples: 0, status: 'no-types' });
        plans.push({ cls, toolId, typeNames: [], nextType: 0, status: 'no-types' });
        log(`${cls}: no resources spawned`);
        continue;
      }
      byResource.set(cls, { surveys: 0, bestEver: 0, totalSamples: 0, status: 'ok' });
      plans.push({
        cls,
        toolId,
        typeNames: types.map((t) => t.resourceName),
        nextType: 0,
        status: 'ok',
      });
      log(`${cls}: ${types.length} type(s) (${types.slice(0, 3).map((t) => t.resourceName).join(', ')}...)`);
    }

    // Round-robin classes; within each class, round-robin its types.
    const eligible = plans.filter((p) => p.status === 'ok' && p.toolId !== undefined);
    if (eligible.length === 0) {
      log('no eligible classes to survey — bailing');
      await ctx.logout();
      return;
    }

    const deadline = Date.now() + totalMs;
    let n = 0;
    while (Date.now() < deadline) {
      const plan = eligible[n % eligible.length];
      if (plan === undefined) break;
      const type = plan.typeNames[plan.nextType % plan.typeNames.length];
      plan.nextType++;
      if (type === undefined) {
        n++;
        continue;
      }
      const toolId = plan.toolId;
      if (toolId === undefined) {
        n++;
        continue;
      }
      ctx.survey(toolId, type);
      try {
        const r = await ctx.waitForSurvey({ timeoutMs: args.timeoutMs });
        const stat = byResource.get(plan.cls);
        if (stat !== undefined) {
          stat.surveys++;
          stat.totalSamples += r.points.length;
          const best = bestEfficiency(r.points);
          if (best > stat.bestEver) stat.bestEver = best;
        }
        log(`${plan.cls}/${type} best=${bestEfficiency(r.points).toFixed(3)}`);
      } catch {
        log(`${plan.cls}/${type} timeout`);
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
      '  --resources=A,B,C        comma-separated resource classes (default mineral,inorganic_chemical,flora_resources)',
      '  --interval-ms=N          ms between surveys (default 3000)',
      '  --timeout-ms=N           survey response timeout (default 8000)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const byResource = new Map<
    string,
    { surveys: number; bestEver: number; totalSamples: number; status: string }
  >();
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
