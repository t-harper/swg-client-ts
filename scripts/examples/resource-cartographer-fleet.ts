#!/usr/bin/env node --import tsx
/**
 * resource-cartographer-fleet.ts — 10-character distributed planet survey
 * producing a single resource concentration heatmap.
 *
 * Ten characters zone in, spread across a grid covering a region of the
 * starting planet (default ~3km x 3km around mos_eisley), walk to their
 * assigned cell centre, survey the requested resource CLASS at that spot,
 * and stream their findings back. The driver aggregates every point each
 * character collected into a single NDJSON heatmap (one row per sample).
 *
 * Example:
 *   LIVE=1 pnpm exec tsx scripts/examples/resource-cartographer-fleet.ts \
 *     --host=10.254.0.253 --resource=mineral \
 *     --centerX=3500 --centerZ=-4800 --cellSize=1000 \
 *     --minutes=8 --output-ndjson=/tmp/cart.ndjson
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  FleetClientConfig,
  NetworkId,
  ResourceListItem,
  ScenarioFn,
  ScriptContext,
  SurveyPoint,
} from '../../src/index.js';
import { findSurveyTools, pickToolForClass } from './_lib-survey.js';
import { formatJson, makeLogger, parseCommonArgs, runFleet, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/resource-cartographer-fleet.ts';

const LIVE_ACCOUNTS = [
  'tslive11',
  'tslive12',
  'tslive13',
  'tslive14',
  'tslive15',
  'tslive16',
  'tslive17',
  'tslive18',
  'tslive19',
  'tslive20',
];

const LIVE_CHARACTERS = [
  'ExCartog01',
  'ExCartog02',
  'ExCartog03',
  'ExCartog04',
  'ExCartog05',
  'ExCartog06',
  'ExCartog07',
  'ExCartog08',
  'ExCartog09',
  'ExCartog10',
];

interface ScriptArgs {
  resource: string;
  centerX: number;
  centerZ: number;
  cellSize: number;
  cols: number;
  rows: number;
  maxTypesPerCell: number;
  surveyTimeoutMs: number;
  walkSpeed: number;
  staggerMs: number;
  planet: string;
  outputNdjson: string;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const cols = Number.parseInt(extra.get('cols') ?? '4', 10);
  const rows = Number.parseInt(extra.get('rows') ?? '3', 10);
  if (cols * rows < 10) {
    throw new Error(`--cols * --rows must be >= 10 (got ${cols}x${rows} = ${cols * rows})`);
  }
  const defaultPath = `/tmp/cartography-${Date.now()}.ndjson`;
  return {
    resource: extra.get('resource') ?? 'mineral',
    centerX: Number.parseFloat(extra.get('centerX') ?? '3500'),
    centerZ: Number.parseFloat(extra.get('centerZ') ?? '-4800'),
    cellSize: Number.parseFloat(extra.get('cellSize') ?? '750'),
    cols,
    rows,
    maxTypesPerCell: Number.parseInt(extra.get('max-types') ?? '3', 10),
    surveyTimeoutMs: Number.parseInt(extra.get('survey-timeout-ms') ?? '8000', 10),
    walkSpeed: Number.parseFloat(extra.get('walk-speed') ?? '12'),
    staggerMs: Number.parseInt(extra.get('stagger-ms') ?? '750', 10),
    planet: extra.get('planet') ?? 'mos_eisley',
    outputNdjson: extra.get('output-ndjson') ?? defaultPath,
  };
}

interface CellAssignment {
  cellIndex: number;
  col: number;
  row: number;
  centerX: number;
  centerZ: number;
}

function planGrid(args: ScriptArgs): CellAssignment[] {
  const cells: CellAssignment[] = [];
  // Centre the grid on (centerX, centerZ); cell (col, row) at index col + row*cols.
  const halfCols = (args.cols - 1) / 2;
  const halfRows = (args.rows - 1) / 2;
  let cellIndex = 0;
  for (let row = 0; row < args.rows; row++) {
    for (let col = 0; col < args.cols; col++) {
      if (cellIndex >= 10) break;
      cells.push({
        cellIndex,
        col,
        row,
        centerX: args.centerX + (col - halfCols) * args.cellSize,
        centerZ: args.centerZ + (row - halfRows) * args.cellSize,
      });
      cellIndex++;
    }
    if (cellIndex >= 10) break;
  }
  return cells;
}

interface CellSurvey {
  cellIndex: number;
  col: number;
  row: number;
  character: string;
  account: string;
  resourceName: string;
  centerAt: { x: number; z: number };
  surveyedAt: { x: number; y: number; z: number };
  points: SurveyPoint[];
}

interface CellStatus {
  cellIndex: number;
  character: string;
  status: 'ok' | 'no-tool' | 'no-types' | 'walk-failed' | 'error';
  reason?: string;
  typesSurveyed: number;
  pointsCollected: number;
}

interface SharedResults {
  allSurveys: CellSurvey[];
  statuses: CellStatus[];
}

function makeScenario(
  cell: CellAssignment,
  characterName: string,
  account: string,
  args: ScriptArgs,
  shared: SharedResults,
  verbose: boolean,
): ScenarioFn {
  return async (ctx: ScriptContext) => {
    const log = makeLogger(`cart${cell.cellIndex}`, verbose);
    const status: CellStatus = {
      cellIndex: cell.cellIndex,
      character: characterName,
      status: 'ok',
      typesSurveyed: 0,
      pointsCollected: 0,
    };

    try {
      // Let baselines + containment messages settle before scanning inventory.
      await ctx.wait(2_500);

      const tools = findSurveyTools(ctx);
      const toolId: NetworkId | undefined = pickToolForClass(tools, args.resource);
      if (toolId === undefined) {
        status.status = 'no-tool';
        status.reason = `no /${args.resource}|universal/ survey tool in inventory`;
        log(`no tool for ${args.resource} — bailing`);
        shared.statuses.push(status);
        await ctx.logout();
        return;
      }
      log(
        `tool ${toolId} found; walking to (${cell.centerX.toFixed(0)}, ${cell.centerZ.toFixed(0)})`,
      );

      // Some assigned cells may be hundreds of metres from the spawn — use a
      // generous walk speed so we don't burn most of --minutes just walking.
      try {
        await ctx.walkTo({ x: cell.centerX, z: cell.centerZ }, { speed: args.walkSpeed });
      } catch (err) {
        status.status = 'walk-failed';
        status.reason = err instanceof Error ? err.message : String(err);
        log(`walkTo failed: ${status.reason}`);
        shared.statuses.push(status);
        await ctx.logout();
        return;
      }
      await ctx.wait(1_200);
      const pos = ctx.position();
      log(`at (${pos.x.toFixed(0)}, ${pos.z.toFixed(0)}); fetching resource list`);

      let resourceList: ResourceListItem[];
      try {
        resourceList = await ctx.fetchSurveyResources(toolId, {
          timeoutMs: args.surveyTimeoutMs,
        });
      } catch (err) {
        status.status = 'no-types';
        status.reason = `fetchSurveyResources: ${err instanceof Error ? err.message : String(err)}`;
        log(status.reason);
        shared.statuses.push(status);
        await ctx.logout();
        return;
      }
      if (resourceList.length === 0) {
        status.status = 'no-types';
        status.reason = 'server returned empty resource list';
        log(status.reason);
        shared.statuses.push(status);
        await ctx.logout();
        return;
      }

      const toScan = resourceList.slice(0, args.maxTypesPerCell);
      log(
        `scanning ${toScan.length}/${resourceList.length} types: ${toScan.map((t) => t.resourceName).join(', ')}`,
      );

      for (const type of toScan) {
        ctx.survey(toolId, type.resourceName);
        try {
          const result = await ctx.waitForSurvey({ timeoutMs: args.surveyTimeoutMs });
          shared.allSurveys.push({
            cellIndex: cell.cellIndex,
            col: cell.col,
            row: cell.row,
            character: characterName,
            account,
            resourceName: type.resourceName,
            centerAt: { x: cell.centerX, z: cell.centerZ },
            surveyedAt: { x: pos.x, y: pos.y, z: pos.z },
            points: result.points,
          });
          status.typesSurveyed++;
          status.pointsCollected += result.points.length;
          const peak = result.points.reduce((m, p) => (p.efficiency > m ? p.efficiency : m), 0);
          log(`${type.resourceName}: ${result.points.length} points, peak=${peak.toFixed(3)}`);
        } catch (err) {
          log(`${type.resourceName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      shared.statuses.push(status);
      log(`done: ${status.typesSurveyed} surveys, ${status.pointsCollected} points`);
    } catch (err) {
      status.status = 'error';
      status.reason = err instanceof Error ? err.message : String(err);
      shared.statuses.push(status);
      log(`fatal: ${status.reason}`);
    }
    await ctx.logout();
  };
}

function buildConfigs(
  cells: CellAssignment[],
  accounts: string[],
  characters: string[],
  args: ScriptArgs,
  shared: SharedResults,
  verbose: boolean,
): FleetClientConfig[] {
  const configs: FleetClientConfig[] = [];
  for (const cell of cells) {
    const account = accounts[cell.cellIndex];
    const characterName = characters[cell.cellIndex];
    if (account === undefined || characterName === undefined) {
      throw new Error(`missing account/character for cell ${cell.cellIndex}`);
    }
    configs.push({
      account,
      characterName,
      planet: args.planet,
      holdZonedInMs: 0,
      script: makeScenario(cell, characterName, account, args, shared, verbose),
    });
  }
  return configs;
}

interface HeatmapRow {
  cellIndex: number;
  col: number;
  row: number;
  character: string;
  resource: string;
  x: number;
  y: number;
  z: number;
  concentration: number;
}

async function writeHeatmap(surveys: CellSurvey[], outputPath: string): Promise<number> {
  await mkdir(dirname(outputPath), { recursive: true });
  const lines: string[] = [];
  let totalPoints = 0;
  for (const s of surveys) {
    for (const p of s.points) {
      const row: HeatmapRow = {
        cellIndex: s.cellIndex,
        col: s.col,
        row: s.row,
        character: s.character,
        resource: s.resourceName,
        x: p.location.x,
        y: p.location.y,
        z: p.location.z,
        concentration: p.efficiency,
      };
      lines.push(JSON.stringify(row));
      totalPoints++;
    }
  }
  await writeFile(outputPath, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
  return totalPoints;
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2), { minutes: 8 });
  if (args.help) {
    usage(SCRIPT, 'Distributed 10-character survey producing a resource heatmap NDJSON.', [
      '  --resource=CLASS         resource class (default mineral)',
      '  --centerX=N              grid centre X in world meters (default 3500)',
      '  --centerZ=N              grid centre Z in world meters (default -4800)',
      '  --cellSize=N             distance between cell centres in m (default 750)',
      '  --cols=N                 grid columns (default 4)',
      '  --rows=N                 grid rows (default 3)',
      '  --max-types=N            cap resource types surveyed per cell (default 3)',
      '  --survey-timeout-ms=N    per-survey response timeout (default 8000)',
      '  --walk-speed=N           m/s for walkTo (default 12)',
      '  --stagger-ms=N           ms between successive client launches (default 750)',
      '  --planet=CITY            starting_locations.iff key (default mos_eisley)',
      '  --output-ndjson=PATH     heatmap output file (default /tmp/cartography-<ts>.ndjson)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const cells = planGrid(script);
  if (cells.length < 10) {
    process.stderr.write(`grid only produced ${cells.length} cells; need 10\n`);
    return 2;
  }
  const shared: SharedResults = { allSurveys: [], statuses: [] };
  const configs = buildConfigs(cells, LIVE_ACCOUNTS, LIVE_CHARACTERS, script, shared, args.verbose);
  const { summary, result } = await runFleet(args, configs, { staggerMs: script.staggerMs });

  const totalPoints = await writeHeatmap(shared.allSurveys, script.outputNdjson);
  let peakConcentration = 0;
  let peakLocation: {
    x: number;
    y: number;
    z: number;
    resource: string;
    cellIndex: number;
  } | null = null;
  for (const s of shared.allSurveys) {
    for (const p of s.points) {
      if (p.efficiency > peakConcentration) {
        peakConcentration = p.efficiency;
        peakLocation = {
          x: p.location.x,
          y: p.location.y,
          z: p.location.z,
          resource: s.resourceName,
          cellIndex: s.cellIndex,
        };
      }
    }
  }

  const charsCompleted = result.outcomes.filter((o) => o.error === undefined).length;
  summary.extra = {
    resource: script.resource,
    planet: script.planet,
    grid: {
      cols: script.cols,
      rows: script.rows,
      cellSize: script.cellSize,
      centerX: script.centerX,
      centerZ: script.centerZ,
    },
    cells: cells.map((c) => ({
      cellIndex: c.cellIndex,
      col: c.col,
      row: c.row,
      centerX: c.centerX,
      centerZ: c.centerZ,
    })),
    charsCompleted,
    totalSurveys: shared.allSurveys.length,
    totalPoints,
    peakConcentration: Math.round(peakConcentration * 10000) / 10000,
    peakLocation,
    perCellStatus: shared.statuses,
    outputPath: script.outputNdjson,
  };
  process.stdout.write(formatJson(summary, args.pretty));
  return summary.ok && totalPoints > 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
