#!/usr/bin/env node --import tsx
/**
 * survey-walking-grid.ts — walk-and-survey grid sweep over a configurable
 * area. Simpler than the bundled `find-best-resource`: per-character only,
 * no multi-client coordination, just a single dense grid.
 *
 * For each cell of an `--grid` × `--grid` array:
 *   1. walkTo cell centre
 *   2. survey
 *   3. log best efficiency
 *
 * Example:
 *   pnpm exec tsx scripts/examples/survey-walking-grid.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --grid=5 --step=20 --resource=inorganic_mineral --minutes=5
 */

import type { ScenarioFn, SurveyPoint } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/survey-walking-grid.ts';

interface ScriptArgs {
  resource: string;
  grid: number;
  step: number;
  timeoutMs: number;
  dwellMs: number;
  speed: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    resource: extra.get('resource') ?? 'inorganic_mineral',
    grid: Number.parseInt(extra.get('grid') ?? '5', 10),
    step: Number.parseFloat(extra.get('step') ?? '20'),
    timeoutMs: Number.parseInt(extra.get('timeout-ms') ?? '8000', 10),
    dwellMs: Number.parseInt(extra.get('dwell-ms') ?? '500', 10),
    speed: Number.parseFloat(extra.get('speed') ?? '6'),
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
  cells: Array<{ ix: number; iz: number; x: number; z: number; best: number; samples: number }>,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('grid', verbose);
    const spawn = ctx.sceneStart.startPosition;
    const half = (args.grid - 1) / 2;
    log(`grid ${args.grid}x${args.grid} step=${args.step}m resource=${args.resource}`);

    const deadline = Date.now() + totalMs;
    outer: for (let iz = 0; iz < args.grid; iz++) {
      for (let ix = 0; ix < args.grid; ix++) {
        if (Date.now() >= deadline) break outer;
        const x = spawn.x + (ix - half) * args.step;
        const z = spawn.z + (iz - half) * args.step;
        await ctx.walkTo({ x, z }, { speed: args.speed });
        await ctx.wait(args.dwellMs);
        ctx.survey(args.resource);
        try {
          const r = await ctx.waitForSurvey({ timeoutMs: args.timeoutMs });
          const best = bestEfficiency(r.points);
          cells.push({ ix, iz, x, z, best, samples: r.points.length });
          log(`cell (${ix},${iz}) best=${best.toFixed(3)} samples=${r.points.length}`);
        } catch {
          cells.push({ ix, iz, x, z, best: -1, samples: 0 });
          log(`cell (${ix},${iz}) timeout`);
        }
      }
    }
    log(`grid done: ${cells.length} cells surveyed`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Walk a grid and survey at each cell.', [
      '  --resource=NAME          resource class (default inorganic_mineral)',
      '  --grid=N                 NxN grid of survey cells (default 5)',
      '  --step=N                 cell spacing in m (default 20)',
      '  --timeout-ms=N           survey response timeout (default 8000)',
      '  --dwell-ms=N             dwell before survey at each cell (default 500)',
      '  --speed=N                walk speed (default 6)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const cells: Array<{
    ix: number;
    iz: number;
    x: number;
    z: number;
    best: number;
    samples: number;
  }> = [];
  const scenario = buildScenario(script, totalMs, args.verbose, cells);
  const { summary } = await runScenario(args, scenario);
  const bestCell = cells.reduce((acc, c) => (c.best > acc.best ? c : acc), {
    ix: -1,
    iz: -1,
    x: 0,
    z: 0,
    best: -1,
    samples: 0,
  });
  summary.extra = {
    ...script,
    cellsSurveyed: cells.length,
    bestCell,
    cellsTail: cells.slice(-10),
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
