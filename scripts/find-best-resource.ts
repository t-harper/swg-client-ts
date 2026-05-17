#!/usr/bin/env node --import tsx
/**
 * find-best-resource.ts — resource-prospecting standalone script.
 *
 * One (or N) character logs in, walks a row-major grid across the planet
 * around its spawn, surveying for the requested resource class at each
 * grid cell. Records the highest density % seen so far, along with the
 * position. Stops on target hit, max-samples exhausted, time budget, or
 * abort.
 *
 * Run with:
 *   pnpm exec tsx scripts/find-best-resource.ts --host=10.254.0.253 \
 *       --user=<account> --character=<name> --resource=mineral \
 *       [--target-pct=80] [--max-samples=50] [--max-minutes=5] \
 *       [--grid-step=100] [--bots=1] [--verbose]
 *
 * The script is resilient to missing data — if the character has no
 * survey tool, `SurveyMessage` never arrives, we log a warning per
 * timed-out cell, and the final report shows `"best": null,
 * samplesCollected: 0`. Exit code is still 0 in that case (the script
 * itself ran end-to-end). Exit code 1 only on fatal lifecycle errors.
 *
 * Multi-bot mode (`--bots > 1`) partitions the grid by quadrant:
 *   bots=1 → 1 bot covers the whole grid
 *   bots=2 → 2 bots split left/right (x < 0 vs x >= 0 relative to spawn)
 *   bots=4 → 4 bots cover NE/NW/SE/SW quadrants relative to spawn
 *   bots>4 → grid is partitioned into approximately equal row-major slices
 *
 * JSON output (pretty by default; `--no-pretty` for single-line):
 *   {
 *     "resource":           "mineral",
 *     "samplesCollected":   47,
 *     "highestPct":         73.4,
 *     "highestAt":          { "x": 1234.5, "z": -567.8 },
 *     "highestResourceName": "Tatooinian Iron",   // or null if unknowable
 *     "elapsedMs":          184321,
 *     "perBot":             [ { "bot": 0, "samples": 24, "best": 73.4 }, ... ],
 *     "histogram":          { "0-10%": 12, "10-25%": 15, ... }
 *   }
 *
 * The "resource name" hint comes from the `ResourceListForSurveyMessage`
 * the server sends when the survey tool is activated — we listen for it
 * opportunistically and tag samples with the first resource of the
 * matching `parentClassName`. If no list ever arrives (character lacks
 * a tool, or sent the message before our listener was wired up), the
 * field is null.
 */

import {
  buildContainerIndex,
  Fleet,
  type FleetClientConfig,
  type NetworkId,
  ResourceListForSurveyMessage,
  type ScenarioFn,
  type ScriptContext,
  type SurveyPoint,
  type TranscriptEvent,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Inline survey-tool helpers (same logic as scripts/examples/_lib-survey.ts;
// duplicated here so this script has no cross-directory imports).
// ---------------------------------------------------------------------------

const TOOL_TEMPLATE_TO_CLASSES: Array<{ pattern: RegExp; classes: string[] }> = [
  { pattern: /survey_tool_all\b/, classes: ['*'] },
  { pattern: /survey_tool_mineral/, classes: ['mineral'] },
  { pattern: /survey_tool_inorganic/, classes: ['inorganic_chemical'] },
  { pattern: /survey_tool_organic/, classes: ['organic_chemical'] },
  { pattern: /survey_tool_lumber/, classes: ['flora_resources'] },
  { pattern: /survey_tool_gas/, classes: ['gas'] },
  { pattern: /survey_tool_liquid/, classes: ['water'] },
  { pattern: /survey_tool_moisture/, classes: ['water'] },
  { pattern: /survey_tool_geo/, classes: ['geothermal_energy'] },
  { pattern: /survey_tool_solar/, classes: ['solar_energy'] },
  { pattern: /survey_tool_wind/, classes: ['wind_energy'] },
];

function findSurveyTools(ctx: ScriptContext): Map<string, NetworkId> {
  const result = new Map<string, NetworkId>();
  const transcriptRef = { transcript: ctx.dispatcher.transcript };
  const index = buildContainerIndex(transcriptRef as { transcript: TranscriptEvent[] });
  const visited = new Set<string>();
  const queue: NetworkId[] = [ctx.sceneStart.playerNetworkId];
  while (queue.length > 0) {
    const parent = queue.shift();
    if (parent === undefined) continue;
    const key = parent.toString();
    if (visited.has(key)) continue;
    visited.add(key);
    const children = index.get(parent) ?? [];
    for (const child of children) {
      const candidates = [child.templateName ?? '', child.name ?? ''];
      for (const text of candidates) {
        if (text === '') continue;
        let matched = false;
        for (const { pattern, classes } of TOOL_TEMPLATE_TO_CLASSES) {
          if (pattern.test(text)) {
            for (const cls of classes) {
              if (!result.has(cls)) result.set(cls, child.networkId);
            }
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      queue.push(child.networkId);
    }
  }
  return result;
}

function normalizeClass(cls: string): string {
  switch (cls) {
    case 'inorganic_mineral':
    case 'mineral':
      return 'mineral';
    case 'inorganic_chemical':
    case 'chemical':
      return 'inorganic_chemical';
    case 'organic_chemical':
      return 'organic_chemical';
    case 'flora':
    case 'flora_resources':
    case 'lumber':
      return 'flora_resources';
    case 'gas':
      return 'gas';
    case 'water':
    case 'liquid':
    case 'moisture':
      return 'water';
    case 'geothermal':
    case 'geothermal_energy':
      return 'geothermal_energy';
    case 'solar':
    case 'solar_energy':
      return 'solar_energy';
    case 'wind':
    case 'wind_energy':
      return 'wind_energy';
    default:
      return cls;
  }
}

function pickToolForClass(
  tools: Map<string, NetworkId>,
  resourceClass: string,
): NetworkId | undefined {
  const cls = normalizeClass(resourceClass);
  return tools.get(cls) ?? tools.get('*');
}

interface Args {
  host: string;
  port: number;
  user: string;
  character: string;
  resource: string;
  targetPct: number;
  maxSamples: number;
  maxMinutes: number;
  gridStep: number;
  bots: number;
  verbose: boolean;
  pretty: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    host: '10.254.0.253',
    port: 44453,
    user: '',
    character: '',
    resource: '',
    targetPct: 80,
    maxSamples: 50,
    maxMinutes: 5,
    gridStep: 100,
    bots: 1,
    verbose: false,
    pretty: true,
  };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const val = eq < 0 ? 'true' : arg.slice(eq + 1);
    switch (key) {
      case 'host':         a.host = val; break;
      case 'port':         a.port = Number.parseInt(val, 10); break;
      case 'user':         a.user = val; break;
      case 'character':    a.character = val; break;
      case 'resource':     a.resource = val; break;
      case 'target-pct':   a.targetPct = Number.parseFloat(val); break;
      case 'max-samples':  a.maxSamples = Number.parseInt(val, 10); break;
      case 'max-minutes':  a.maxMinutes = Number.parseFloat(val); break;
      case 'grid-step':    a.gridStep = Number.parseFloat(val); break;
      case 'bots':         a.bots = Number.parseInt(val, 10); break;
      case 'verbose':      a.verbose = val === 'true' || val === ''; break;
      case 'no-pretty':    a.pretty = !(val === 'true' || val === ''); break;
      case 'pretty':       a.pretty = val === 'true' || val === ''; break;
      default:
        process.stderr.write(`Unknown flag: --${key}\n`);
        process.exit(2);
    }
  }
  if (a.user === '') {
    process.stderr.write('--user=<account> is required\n');
    process.exit(2);
  }
  if (a.character === '') {
    process.stderr.write('--character=<name> is required\n');
    process.exit(2);
  }
  if (a.resource === '') {
    process.stderr.write('--resource=<class> is required (e.g. --resource=mineral)\n');
    process.exit(2);
  }
  if (a.bots < 1) {
    process.stderr.write('--bots must be >= 1\n');
    process.exit(2);
  }
  return a;
}

interface SampleRecord {
  /** Bot index that produced this sample (0..bots-1). */
  bot: number;
  /** Grid cell origin (the point we walked to before surveying). */
  cell: { x: number; z: number };
  /** Best efficiency (0..1) across all points in this cell's survey. */
  bestEfficiency: number;
  /** Position of the best point (within the survey radial). */
  bestAt: { x: number; y: number; z: number };
  /** The full radial response (count + summary). */
  pointCount: number;
}

/**
 * Build the cell sequence each bot will walk. Row-major sweep outward from
 * spawn — cells alternate sign so we don't always walk the same direction
 * first.
 *
 * Total cells generated ≈ ceil(sqrt(maxSamples)) ** 2 around the spawn,
 * partitioned into `bots` contiguous slices.
 */
function generateGridSlices(opts: {
  bots: number;
  maxSamples: number;
  gridStep: number;
}): Array<Array<{ x: number; z: number }>> {
  // Enough cells per bot so even if many cells time out we still have work.
  const cellsPerBot = Math.max(1, opts.maxSamples);
  const totalCells = cellsPerBot * opts.bots;
  // Build a square-ish grid wide enough to host totalCells.
  const side = Math.ceil(Math.sqrt(totalCells));
  // Generate row-major coords centred on origin (relative to spawn).
  const half = Math.floor(side / 2);
  const cells: Array<{ x: number; z: number }> = [];
  for (let row = -half; row < side - half; row++) {
    for (let col = -half; col < side - half; col++) {
      cells.push({ x: col * opts.gridStep, z: row * opts.gridStep });
    }
  }

  // Partition into per-bot slices. For bots=2 or bots=4 use spatial
  // quadrants so concurrent bots don't walk over each other; for other
  // bot counts fall back to a simple interleaved split.
  if (opts.bots === 1) return [cells];

  if (opts.bots === 2) {
    const left = cells.filter((c) => c.x < 0);
    const right = cells.filter((c) => c.x >= 0);
    return [left, right];
  }
  if (opts.bots === 4) {
    return [
      cells.filter((c) => c.x < 0 && c.z >= 0), // NW
      cells.filter((c) => c.x >= 0 && c.z >= 0), // NE
      cells.filter((c) => c.x < 0 && c.z < 0), // SW
      cells.filter((c) => c.x >= 0 && c.z < 0), // SE
    ];
  }
  // Generic case: round-robin assignment.
  const slices: Array<Array<{ x: number; z: number }>> = [];
  for (let i = 0; i < opts.bots; i++) slices.push([]);
  cells.forEach((c, i) => {
    const slice = slices[i % opts.bots];
    if (slice !== undefined) slice.push(c);
  });
  return slices;
}

/**
 * Run a survey at the script context's current position. Returns the raw
 * sample points the server emitted, or `null` if the survey response timed
 * out (typically: the character lacks a survey tool of the matching type).
 *
 * `toolId` is the survey-tool NetworkId discovered via `findSurveyTools()`,
 * and `resourceTypeName` is a SPECIFIC spawned resource name (e.g.
 * "Resotine") from `ctx.fetchSurveyResources(toolId)`.
 */
async function surveyHere(
  ctx: ScriptContext,
  toolId: NetworkId,
  resourceTypeName: string,
  timeoutMs: number,
): Promise<SurveyPoint[] | null> {
  ctx.survey(toolId, resourceTypeName);
  try {
    const res = await ctx.waitForSurvey({ timeoutMs });
    return res.points;
  } catch {
    // waitForSurvey rejects on timeout; treat that as "no data here".
    return null;
  }
}

/**
 * Per-bot scenario: walk the assigned cells, survey at each one, push
 * results into the shared `samples` array. Respects a global deadline
 * (wall-clock ms) and a max-sample cap (shared via the captured
 * `state` object so all bots stop together).
 */
function makeProspectScenario(opts: {
  bot: number;
  cells: Array<{ x: number; z: number }>;
  resourceClass: string;
  targetEfficiency: number;
  maxSamples: number;
  deadlineMs: number;
  state: ProspectState;
  verbose: boolean;
  log: (msg: string) => void;
}): ScenarioFn {
  return async (ctx) => {
    // Subscribe to ResourceListForSurveyMessage to learn the tool's
    // surveyed resource list — gives us a chance to name the best
    // resource at the end.
    ctx.dispatcher.onMessage(ResourceListForSurveyMessage, (msg) => {
      opts.state.resourceList.push(msg);
    });

    // Small stagger so launches don't all hit the server at the same ms.
    await ctx.wait(500);
    ctx.changePosture('standing');

    // Discover the survey tool for this bot's class. The character must
    // already hold the appropriate survey tool — we do NOT craft one.
    const tools = findSurveyTools(ctx);
    const toolId = pickToolForClass(tools, opts.resourceClass);
    if (toolId === undefined) {
      opts.log(`no survey tool for class ${opts.resourceClass} (have: ${[...tools.keys()].join(',')}) — bot ${opts.bot} bailing`);
      return;
    }
    opts.log(`tool ${toolId} for class ${opts.resourceClass}`);

    // Fetch the spawned resource type names ONCE; they don't change in a session.
    // Round-robin through them per survey so we sample every resource available.
    let resourceTypeNames: string[];
    try {
      const list = await ctx.fetchSurveyResources(toolId, { timeoutMs: 8_000 });
      resourceTypeNames = list.map((r) => r.resourceName);
    } catch {
      opts.log(`fetchSurveyResources timeout (tool may lack VAR_SURVEY_CLASS) — bot ${opts.bot} bailing`);
      return;
    }
    if (resourceTypeNames.length === 0) {
      opts.log(`no resources spawned for ${opts.resourceClass} — bot ${opts.bot} bailing`);
      return;
    }
    opts.log(`${resourceTypeNames.length} resource type(s): ${resourceTypeNames.slice(0, 3).join(', ')}...`);
    let typeIdx = 0;

    const spawn = ctx.sceneStart.startPosition;

    for (const cell of opts.cells) {
      if (Date.now() >= opts.deadlineMs) {
        opts.log(`deadline reached, stopping (bot=${opts.bot})`);
        return;
      }
      if (opts.state.totalSamples >= opts.maxSamples) {
        opts.log(`max-samples hit, stopping (bot=${opts.bot})`);
        return;
      }
      if (opts.state.targetHit) {
        opts.log(`target hit elsewhere, stopping (bot=${opts.bot})`);
        return;
      }

      const targetX = spawn.x + cell.x;
      const targetZ = spawn.z + cell.z;
      // Don't bother with a true zero-length walk — at least send one
      // transform so the server sees us.
      const dx = targetX - ctx.position().x;
      const dz = targetZ - ctx.position().z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.5) {
        opts.log(
          `walking to (${targetX.toFixed(1)}, ${targetZ.toFixed(1)}) — ${dist.toFixed(1)}m`,
        );
        try {
          // Use 10 m/s for faster grid coverage; server still tolerates this.
          await ctx.walkTo({ x: targetX, z: targetZ }, { speed: 10 });
        } catch (err) {
          // If walking aborts (signal), bail.
          opts.log(`walk aborted: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }

      // Brief settle so the server registers our position before survey.
      await ctx.wait(250);
      const resourceTypeName = resourceTypeNames[typeIdx % resourceTypeNames.length] ?? resourceTypeNames[0];
      typeIdx++;
      if (resourceTypeName === undefined) continue;
      opts.log(`survey at (${targetX.toFixed(1)}, ${targetZ.toFixed(1)}) type=${resourceTypeName}`);

      const points = await surveyHere(ctx, toolId, resourceTypeName, 5_000);
      if (points === null) {
        opts.log(`  no survey response (tool missing?)`);
        // Mark a missed-sample event but don't push a record.
        opts.state.missedCells++;
        // If we've gone many cells with no response, give up early on
        // this bot — there's likely no survey tool ever coming.
        if (opts.state.missedCells >= 3 && opts.state.totalSamples === 0) {
          opts.log(`3 consecutive misses with no samples — bot ${opts.bot} bailing`);
          return;
        }
        continue;
      }

      // Got a radial. Find the max efficiency point.
      if (points.length === 0) {
        // Empty radial is valid (no resource here) — still counts as a sample.
        const rec: SampleRecord = {
          bot: opts.bot,
          cell: { x: targetX, z: targetZ },
          bestEfficiency: 0,
          bestAt: { x: targetX, y: spawn.y, z: targetZ },
          pointCount: 0,
        };
        opts.state.samples.push(rec);
        opts.state.totalSamples++;
        opts.log(`  empty radial`);
        continue;
      }

      let best = points[0];
      if (best === undefined) continue; // unreachable but appeases TS
      for (const p of points) {
        if (p.efficiency > best.efficiency) best = p;
      }
      const rec: SampleRecord = {
        bot: opts.bot,
        cell: { x: targetX, z: targetZ },
        bestEfficiency: best.efficiency,
        bestAt: { x: best.location.x, y: best.location.y, z: best.location.z },
        pointCount: points.length,
      };
      opts.state.samples.push(rec);
      opts.state.totalSamples++;
      opts.log(
        `  ${points.length} points, best=${(best.efficiency * 100).toFixed(1)}%`,
      );

      if (best.efficiency * 100 >= opts.targetEfficiency) {
        opts.log(
          `  *** target ${opts.targetEfficiency}% hit (${(best.efficiency * 100).toFixed(1)}%) — stopping ***`,
        );
        opts.state.targetHit = true;
        return;
      }
    }

    opts.log(`bot ${opts.bot} finished all assigned cells`);
  };
}

/** Mutable state shared across all bot scenarios in a single run. */
interface ProspectState {
  samples: SampleRecord[];
  totalSamples: number;
  missedCells: number;
  resourceList: ResourceListForSurveyMessage[];
  targetHit: boolean;
}

/**
 * Compute the histogram of sample efficiency buckets.
 */
function histogram(samples: SampleRecord[]): Record<string, number> {
  const buckets: Record<string, number> = {
    '0-10%': 0,
    '10-25%': 0,
    '25-50%': 0,
    '50-75%': 0,
    '75-100%': 0,
  };
  for (const s of samples) {
    const pct = s.bestEfficiency * 100;
    if (pct < 10) buckets['0-10%']!++;
    else if (pct < 25) buckets['10-25%']!++;
    else if (pct < 50) buckets['25-50%']!++;
    else if (pct < 75) buckets['50-75%']!++;
    else buckets['75-100%']!++;
  }
  return buckets;
}

/**
 * From the collected ResourceListForSurveyMessage(s), find the first
 * resource whose `parentClassName` matches the requested class (or
 * starts with it as a prefix — the wire `parentClassName` is e.g.
 * `iron_class_3` for an `mineral` survey, so we can also check the
 * surveyType field on the parent message).
 */
function pickResourceName(
  resourceLists: ResourceListForSurveyMessage[],
  resourceClass: string,
  bestAt: { x: number; z: number } | null,
): string | null {
  // First pass: prefer a list whose surveyType exactly equals the
  // requested resource class (the typical case).
  let candidates: ResourceListForSurveyMessage['data'] = [];
  for (const msg of resourceLists) {
    if (msg.surveyType === resourceClass || msg.surveyType.startsWith(resourceClass)) {
      candidates = candidates.concat(msg.data);
    }
  }
  // Fallback to all lists if none match the requested class.
  if (candidates.length === 0) {
    for (const msg of resourceLists) {
      candidates = candidates.concat(msg.data);
    }
  }
  if (candidates.length === 0) return null;
  // Without a per-point resource ID in the survey radial, we can't be
  // certain which resource the best sample is — return the first
  // candidate's name as a best-effort label. The `bestAt` arg is
  // accepted for future use (e.g. tie-breaking) but not currently used.
  void bestAt;
  return candidates[0]?.resourceName ?? null;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const deadlineMs = startedAt + args.maxMinutes * 60_000;

  const log = args.verbose
    ? (m: string) => process.stderr.write(`[find-best-resource] ${m}\n`)
    : (_: string) => {};

  log(
    `host=${args.host} resource=${args.resource} bots=${args.bots} ` +
      `gridStep=${args.gridStep}m maxSamples=${args.maxSamples} ` +
      `targetPct=${args.targetPct}% maxMinutes=${args.maxMinutes}`,
  );

  const slices = generateGridSlices({
    bots: args.bots,
    maxSamples: args.maxSamples,
    gridStep: args.gridStep,
  });
  log(`grid: ${slices.map((s, i) => `bot${i}=${s.length}`).join(' ')} cells`);

  const state: ProspectState = {
    samples: [],
    totalSamples: 0,
    missedCells: 0,
    resourceList: [],
    targetHit: false,
  };

  const fleet = new Fleet({
    loginServer: { host: args.host, port: args.port },
  });

  const configs: FleetClientConfig[] = [];
  for (let i = 0; i < args.bots; i++) {
    // For single-bot mode use the supplied user/character verbatim. For
    // multi-bot mode the user is responsible for ensuring each bot has
    // a separately-credentialed account (the server allows only one
    // session per account). We suffix the account+character with the
    // bot index as a hint, but the script DOES NOT create accounts —
    // the caller must have pre-registered them.
    const account = args.bots === 1 ? args.user : `${args.user}${i}`.slice(0, 15);
    const characterName = args.bots === 1 ? args.character : `${args.character}${i}`;
    const cells = slices[i] ?? [];
    configs.push({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: makeProspectScenario({
        bot: i,
        cells,
        resourceClass: args.resource,
        targetEfficiency: args.targetPct,
        maxSamples: args.maxSamples,
        deadlineMs,
        state,
        verbose: args.verbose,
        log: args.verbose
          ? (m) => process.stderr.write(`[bot${i}] ${m}\n`)
          : () => {},
      }),
    });
  }

  const result = await fleet.run(configs, {
    staggerMs: args.bots > 1 ? 100 : 0,
  });

  const elapsedMs = Date.now() - startedAt;

  // Compute per-bot stats.
  const perBot: Array<{ bot: number; samples: number; best: number | null }> = [];
  for (let i = 0; i < args.bots; i++) {
    const mine = state.samples.filter((s) => s.bot === i);
    const best = mine.length > 0
      ? Math.max(...mine.map((s) => s.bestEfficiency)) * 100
      : null;
    perBot.push({ bot: i, samples: mine.length, best: best === null ? null : roundPct(best) });
  }

  // Find the overall best.
  let highest: SampleRecord | null = null;
  for (const s of state.samples) {
    if (highest === null || s.bestEfficiency > highest.bestEfficiency) highest = s;
  }

  const report = {
    resource: args.resource,
    samplesCollected: state.totalSamples,
    highestPct: highest === null ? null : roundPct(highest.bestEfficiency * 100),
    highestAt: highest === null
      ? null
      : { x: roundPos(highest.bestAt.x), z: roundPos(highest.bestAt.z) },
    highestResourceName: highest === null
      ? null
      : pickResourceName(state.resourceList, args.resource, highest.bestAt),
    elapsedMs,
    perBot,
    histogram: histogram(state.samples),
    // Diagnostic context (kept compact).
    diagnostics: {
      botsFailed: result.summary.failed,
      botsSucceeded: result.summary.succeeded,
      missedSurveyCells: state.missedCells,
      receivedResourceLists: state.resourceList.length,
      botErrors: result.summary.errorMessages,
    },
  };

  const json = args.pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report);
  process.stdout.write(`${json}\n`);

  if (state.totalSamples === 0) {
    process.stderr.write(
      `[find-best-resource] no survey samples received — character may lack a survey tool of class '${args.resource}'\n`,
    );
  }

  // Lifecycle errors are fatal (exit 1); zero-samples-but-ran-cleanly is success (exit 0).
  return result.summary.failed === 0 ? 0 : 1;
}

function roundPct(v: number): number {
  return Math.round(v * 10) / 10;
}

function roundPos(v: number): number {
  return Math.round(v * 10) / 10;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
