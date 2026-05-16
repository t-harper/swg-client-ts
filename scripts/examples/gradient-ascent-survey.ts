#!/usr/bin/env node --import tsx
/**
 * gradient-ascent-survey.ts — survey at current position; walk toward the
 * sample point with the highest density; repeat. A toy concentration-finder.
 *
 * Each iteration:
 *   1. ctx.survey(resourceClass)
 *   2. waitForSurvey() — collect the radial sample (~25-49 points)
 *   3. find the brightest sample, walk to its (x, z)
 *   4. dwell `dwell-ms` and repeat
 *
 * The walk is clamped to `--max-step` so we don't try to teleport across the
 * map per sample if the densest sample is far out.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/gradient-ascent-survey.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --resource=inorganic_mineral --minutes=5 --dwell-ms=2000 --max-step=30
 */

import type { ScenarioFn } from '../../src/index.js';
import type { SurveyPoint } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/gradient-ascent-survey.ts';

interface ScriptArgs {
  resource: string;
  dwellMs: number;
  maxStep: number;
  timeoutMs: number;
  speed: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    resource: extra.get('resource') ?? 'inorganic_mineral',
    dwellMs: Number.parseInt(extra.get('dwell-ms') ?? '2000', 10),
    maxStep: Number.parseFloat(extra.get('max-step') ?? '30'),
    timeoutMs: Number.parseInt(extra.get('survey-timeout-ms') ?? '8000', 10),
    speed: Number.parseFloat(extra.get('speed') ?? '5'),
  };
}

function pickBest(points: SurveyPoint[]): SurveyPoint | null {
  let best: SurveyPoint | null = null;
  for (const p of points) {
    if (best === null || p.efficiency > best.efficiency) best = p;
  }
  return best;
}

function buildScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  trail: Array<{ iter: number; x: number; z: number; density: number; samples: number }>,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('grad', verbose);
    log(`gradient-ascent resource=${args.resource} max-step=${args.maxStep}`);

    const deadline = Date.now() + totalMs;
    let iter = 0;
    let failures = 0;
    while (Date.now() < deadline) {
      ctx.survey(args.resource);
      let result: { points: SurveyPoint[] };
      try {
        result = await ctx.waitForSurvey({ timeoutMs: args.timeoutMs });
      } catch (err) {
        failures++;
        log(`iter ${iter} survey timeout: ${(err as Error).message}`);
        await ctx.wait(args.dwellMs);
        iter++;
        continue;
      }
      const best = pickBest(result.points);
      if (best === null || best.efficiency === 0) {
        log(`iter ${iter} no resource (${result.points.length} samples)`);
        trail.push({
          iter,
          x: ctx.position().x,
          z: ctx.position().z,
          density: 0,
          samples: result.points.length,
        });
        await ctx.wait(args.dwellMs);
        iter++;
        continue;
      }
      const cur = ctx.position();
      const dx = best.location.x - cur.x;
      const dz = best.location.z - cur.z;
      const dist = Math.hypot(dx, dz);
      const step = Math.min(args.maxStep, dist);
      const k = dist === 0 ? 0 : step / dist;
      const target = { x: cur.x + dx * k, z: cur.z + dz * k };
      trail.push({
        iter,
        x: target.x,
        z: target.z,
        density: best.efficiency,
        samples: result.points.length,
      });
      log(
        `iter ${iter} best=${best.efficiency.toFixed(3)} → (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`,
      );
      await ctx.walkTo(target, { speed: args.speed });
      await ctx.wait(args.dwellMs);
      iter++;
    }
    log(`gradient-ascent done: ${iter} iterations, ${failures} survey timeouts`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Hill-climb toward the densest sample in each survey radial.', [
      '  --resource=NAME          resource class (default inorganic_mineral)',
      '  --dwell-ms=N             dwell after each walk (default 2000)',
      '  --max-step=N             max walk distance per iteration in m (default 30)',
      '  --survey-timeout-ms=N    survey response timeout (default 8000)',
      '  --speed=N                walk speed (default 5)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const trail: Array<{ iter: number; x: number; z: number; density: number; samples: number }> = [];
  const scenario = buildScenario(script, totalMs, args.verbose, trail);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    ...script,
    iterations: trail.length,
    bestDensity: trail.reduce((m, t) => Math.max(m, t.density), 0),
    trailTail: trail.slice(-10),
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
