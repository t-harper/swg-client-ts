#!/usr/bin/env node --import tsx
/**
 * city-recon-surveyor.ts — solo scout walks a region, scoring candidate lots
 * for a future player city by combining offline terrain analysis with live
 * server placement probes.
 *
 * Pipeline:
 *   1. Zone in on the requested planet.
 *   2. Load the planet's procedural terrain via `ctx.terrain.appearanceFor`.
 *      Soft-fail with a clear setup hint if the asset isn't staged.
 *   3. Generate a candidate grid (`generateCandidateGrid`) of concentric
 *      rings around (centerX, centerZ).
 *   4. Score every candidate by sampling real terrain heights in a
 *      configurable window around each spot via `appearance.scanHeights`.
 *      Smaller `max - min` height range = flatter = higher score. Hard-
 *      filter underwater spots (median below the global water table) and
 *      cells that sit mostly on baked roads/rivers (NaN heights).
 *   5. Walk to the top-N by score, drop a probe deed via `probeBuildable`,
 *      and record whether the server accepted placement.
 *   6. Rank: buildable first, then by flatnessScore.
 *   7. Emit a JSON summary on stdout.
 *
 * The flatness score is a real procedural-terrain measurement: `ctx.terrain`
 * uses the bit-exact TS port of the C++ `sharedTerrain` + `sharedFractal`
 * libraries at `src/terrain/sim/`, so the offline ranking matches what the
 * live server's placement validator sees (modulo dynamic objects). The
 * live probe remains the source of truth for buildability — the score just
 * picks which candidates are worth spending probe-time on first.
 *
 * Example:
 *   LIVE=1 pnpm tsx scripts/examples/city-recon-surveyor.ts \
 *     --host=10.254.0.253 --user=tslive04 --character=ExCityScout \
 *     --planet=naboo --centerX=0 --centerZ=0 \
 *     --max-radius=500 --rings=4 --angular-steps=6 --probes=10 \
 *     --minutes=10
 */

import type {
  FlatSpot,
  ProceduralTerrainAppearance,
  ScenarioFn,
  ScriptContext,
} from '../../src/index.js';
import { generateCandidateGrid, probeBuildable } from '../../src/index.js';
import { resolveInventoryOid } from '../build-city/place.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/city-recon-surveyor.ts';

interface ScriptArgs {
  planet: string;
  centerX: number;
  centerZ: number;
  maxRadius: number;
  rings: number;
  angularSteps: number;
  probes: number;
  minSpacing: number;
  settleMs: number;
  flatnessWindowM: number;
  flatnessGridM: number;
  maxHeightRangeM: number;
  maxNanFraction: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    planet: extra.get('planet') ?? '',
    centerX: Number.parseFloat(extra.get('centerX') ?? '0'),
    centerZ: Number.parseFloat(extra.get('centerZ') ?? '0'),
    maxRadius: Number.parseFloat(extra.get('max-radius') ?? '500'),
    rings: Number.parseInt(extra.get('rings') ?? '4', 10),
    angularSteps: Number.parseInt(extra.get('angular-steps') ?? '6', 10),
    probes: Number.parseInt(extra.get('probes') ?? '10', 10),
    minSpacing: Number.parseFloat(extra.get('min-spacing') ?? '60'),
    settleMs: Number.parseInt(extra.get('settle-ms') ?? '4500', 10),
    flatnessWindowM: Number.parseFloat(extra.get('flatness-window') ?? '30'),
    flatnessGridM: Number.parseFloat(extra.get('flatness-grid') ?? '2'),
    maxHeightRangeM: Number.parseFloat(extra.get('max-height-range') ?? '5'),
    maxNanFraction: Number.parseFloat(extra.get('max-nan-fraction') ?? '0.3'),
  };
}

interface ReconMeta {
  status: 'ok' | 'no-terrain-assets' | 'wrong-planet' | 'error';
  errorMessage: string | null;
  planet: string;
  terrain: { mapWidth: number; chunkWidth: number; waterHeight: number | null } | null;
  candidatesGenerated: number;
  candidatesFiltered: number;
  candidatesScanned: number;
  candidatesBuildable: number;
  top5: CandidateScore[];
  results: CandidateScore[];
}

interface CandidateScore {
  x: number;
  z: number;
  flatnessScore: number;
  heightRange: number | null;
  medianHeight: number | null;
  nanFraction: number;
  isBuildable: boolean | null;
  terrainHeight: number | null;
  probeNotes: string;
}

interface ScoredCandidate {
  spot: FlatSpot;
  flatnessScore: number;
  heightRange: number | null;
  medianHeight: number | null;
  nanFraction: number;
}

/**
 * Score every candidate by sampling real terrain heights in a window around
 * each spot. Hard-filters underwater + heavily-NaN (road/river) candidates
 * to zero. Combines flatness (primary) with the existing radial + edge
 * preferences as secondary tiebreakers.
 */
async function scoreCandidatesWithTerrain(
  spots: readonly FlatSpot[],
  ctx: ScriptContext,
  args: ScriptArgs,
  mapWidth: number,
  waterHeight: number | null,
): Promise<ScoredCandidate[]> {
  const appearance = await ctx.terrain.appearance();
  const halfMap = mapWidth / 2;
  const cellsPerSide = Math.max(2, Math.ceil(args.flatnessWindowM / args.flatnessGridM));
  const cellSize = args.flatnessGridM;

  const out: ScoredCandidate[] = [];
  for (const spot of spots) {
    const originX = spot.x - (cellsPerSide * cellSize) / 2;
    const originZ = spot.z - (cellsPerSide * cellSize) / 2;
    const heights = appearance.scanHeights(originX, originZ, cellsPerSide, cellsPerSide, cellSize);

    const nonNan: number[] = [];
    for (let i = 0; i < heights.length; ++i) {
      const h = heights[i] as number;
      if (Number.isNaN(h)) continue;
      nonNan.push(h);
    }
    const nanFraction = 1 - nonNan.length / heights.length;
    let heightRange: number | null = null;
    let medianHeight: number | null = null;
    if (nonNan.length > 0) {
      nonNan.sort((a, b) => a - b);
      const first = nonNan[0];
      const last = nonNan[nonNan.length - 1];
      const mid = nonNan[Math.floor(nonNan.length / 2)];
      if (first !== undefined && last !== undefined && mid !== undefined) {
        heightRange = last - first;
        medianHeight = mid;
      }
    }

    const dx = spot.x - args.centerX;
    const dz = spot.z - args.centerZ;
    const radialDist = Math.sqrt(dx * dx + dz * dz);
    const radialFactor = args.maxRadius <= 0 ? 1 : Math.max(0, 1 - radialDist / args.maxRadius);
    const edgeMargin = Math.min(halfMap - Math.abs(spot.x), halfMap - Math.abs(spot.z));
    const edgeFactor = Math.max(0, Math.min(1, edgeMargin / 500));

    let flatnessScore = 0;
    const underwater = waterHeight !== null && medianHeight !== null && medianHeight <= waterHeight;
    const passesFilters =
      heightRange !== null &&
      heightRange <= args.maxHeightRangeM &&
      nanFraction <= args.maxNanFraction &&
      !underwater;
    if (passesFilters && heightRange !== null) {
      // Smaller range → flatter → higher score. 0 m → 1.0, 1 m → 0.5,
      // 5 m → 0.17, 10 m → 0.09. Combined with secondary preferences.
      const flatnessFactor = 1 / (1 + heightRange);
      flatnessScore =
        flatnessFactor * 0.6 + (1 - nanFraction) * 0.2 + radialFactor * 0.15 + edgeFactor * 0.05;
    }

    out.push({ spot, flatnessScore, heightRange, medianHeight, nanFraction });
  }
  return out;
}

function tooClose(spot: FlatSpot, chosen: readonly FlatSpot[], minSpacing: number): boolean {
  if (minSpacing <= 0) return false;
  const minSq = minSpacing * minSpacing;
  for (const c of chosen) {
    const dx = spot.x - c.x;
    const dz = spot.z - c.z;
    if (dx * dx + dz * dz < minSq) return true;
  }
  return false;
}

function buildScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  meta: ReconMeta,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('recon', verbose);
    const deadline = Date.now() + totalMs;

    const sceneName = ctx.sceneStart.sceneName;
    const scenePlanet = sceneName.match(/(?:^|\/)([a-z0-9_]+)(?:\.trn)?$/i)?.[1] ?? sceneName;
    const planet = args.planet === '' ? scenePlanet : args.planet;
    meta.planet = planet;
    if (planet !== scenePlanet && scenePlanet !== '') {
      meta.status = 'wrong-planet';
      meta.errorMessage = `Zoned into '${scenePlanet}' but --planet=${planet}; pass --planet=${scenePlanet} or create the character on ${planet}`;
      log(meta.errorMessage);
      await ctx.logout();
      return;
    }

    let appearance: ProceduralTerrainAppearance;
    try {
      appearance = await ctx.terrain.appearanceFor(planet);
    } catch (err) {
      meta.status = 'no-terrain-assets';
      meta.errorMessage =
        `Could not load TRN for '${planet}': ${err instanceof Error ? err.message : String(err)}. ` +
        `Stage assets/terrain/${planet}.trn (see assets/README.md) or set SWG_TRE_PATH.`;
      log(meta.errorMessage);
      await ctx.logout();
      return;
    }
    const { mapWidth, chunkWidth, globalWaterHeight } = appearance.template;
    meta.terrain = { mapWidth, chunkWidth, waterHeight: globalWaterHeight };
    log(
      `${planet}: mapWidth=${mapWidth}m chunkWidth=${chunkWidth}m water=${globalWaterHeight ?? 'none'}`,
    );

    const candidates = generateCandidateGrid({
      centerX: args.centerX,
      centerZ: args.centerZ,
      maxRadius: args.maxRadius,
      rings: args.rings,
      angularSteps: args.angularSteps,
    });
    meta.candidatesGenerated = candidates.length;
    log(`generated ${candidates.length} candidates (rings=${args.rings}×${args.angularSteps})`);

    const scored = await scoreCandidatesWithTerrain(
      candidates,
      ctx,
      args,
      mapWidth,
      globalWaterHeight,
    );
    const acceptable = scored.filter((c) => c.flatnessScore > 0);
    meta.candidatesFiltered = scored.length - acceptable.length;
    log(
      `terrain-filtered ${meta.candidatesFiltered}/${scored.length} candidates (range>${args.maxHeightRangeM}m, nan>${args.maxNanFraction}, or underwater); ${acceptable.length} acceptable`,
    );
    acceptable.sort((a, b) => b.flatnessScore - a.flatnessScore);

    const chosen: FlatSpot[] = [];
    const toProbe: ScoredCandidate[] = [];
    for (const cand of acceptable) {
      if (toProbe.length >= args.probes) break;
      if (tooClose(cand.spot, chosen, args.minSpacing)) continue;
      chosen.push(cand.spot);
      toProbe.push(cand);
    }
    log(`probing top ${toProbe.length} candidates (min-spacing=${args.minSpacing}m)`);

    const inventoryOid = await resolveInventoryOid(ctx);

    const results: CandidateScore[] = [];
    for (let i = 0; i < toProbe.length; ++i) {
      if (Date.now() >= deadline) {
        log(`deadline reached after ${i}/${toProbe.length} probes`);
        break;
      }
      const cand = toProbe[i];
      if (cand === undefined) continue;
      const { spot, flatnessScore, heightRange, medianHeight, nanFraction } = cand;

      try {
        await ctx.walkTo({ x: spot.x, z: spot.z });
      } catch (err) {
        log(`walk to (${spot.x.toFixed(1)}, ${spot.z.toFixed(1)}) failed: ${err}`);
      }
      const terrainHeight = ctx.position().y;

      log(
        `probe ${i + 1}/${toProbe.length}: (${spot.x.toFixed(1)}, ${spot.z.toFixed(1)}) y=${terrainHeight.toFixed(2)} range=${heightRange?.toFixed(2) ?? 'n/a'}m nan=${(nanFraction * 100).toFixed(0)}% score=${flatnessScore.toFixed(3)}`,
      );

      let isBuildable: boolean | null = null;
      let probeNotes = '';
      try {
        const result = await probeBuildable(ctx, inventoryOid, spot.x, spot.z, {
          settleMs: args.settleMs,
          teleportToCoord: false,
        });
        isBuildable = result.buildable;
        probeNotes = result.chatOob;
      } catch (err) {
        probeNotes = `probe-error: ${err instanceof Error ? err.message : String(err)}`;
      }

      results.push({
        x: spot.x,
        z: spot.z,
        flatnessScore,
        heightRange,
        medianHeight,
        nanFraction,
        isBuildable,
        terrainHeight,
        probeNotes,
      });

      log(
        `  → buildable=${isBuildable ?? 'unknown'} ${probeNotes.length > 0 ? `(${probeNotes.slice(0, 120)})` : ''}`,
      );
    }

    results.sort((a, b) => {
      const ba = a.isBuildable === true ? 1 : 0;
      const bb = b.isBuildable === true ? 1 : 0;
      if (ba !== bb) return bb - ba;
      return b.flatnessScore - a.flatnessScore;
    });

    meta.candidatesScanned = results.length;
    meta.candidatesBuildable = results.filter((r) => r.isBuildable === true).length;
    meta.top5 = results.slice(0, 5);
    meta.results = results;
    meta.status = 'ok';
    log(
      `recon done: scanned=${meta.candidatesScanned} buildable=${meta.candidatesBuildable} top=${meta.top5.length}`,
    );

    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Scout candidate lots for a player city via terrain + live probe.', [
      '  --planet=NAME            planet to recon (default: the planet the character zones into)',
      '  --centerX=N              center X of the search area (default 0)',
      '  --centerZ=N              center Z of the search area (default 0)',
      '  --max-radius=N           max radius in metres (default 500)',
      '  --rings=N                concentric rings to generate (default 4)',
      '  --angular-steps=N        candidates per ring (default 6)',
      '  --probes=N               top-N to probe via live server (default 10)',
      '  --min-spacing=N          min metres between probed spots (default 60)',
      '  --settle-ms=N            ms to wait for probe rejection chat (default 4500)',
      '  --flatness-window=N      side length (m) of the offline height sample window (default 30)',
      '  --flatness-grid=N        sample spacing (m) inside the window (default 2 → 16×16 samples)',
      '  --max-height-range=N     hard reject candidates whose window range exceeds this (m, default 5)',
      '  --max-nan-fraction=N     hard reject candidates whose window is >N fraction NaN (default 0.3)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const meta: ReconMeta = {
    status: 'error',
    errorMessage: null,
    planet: script.planet,
    terrain: null,
    candidatesGenerated: 0,
    candidatesFiltered: 0,
    candidatesScanned: 0,
    candidatesBuildable: 0,
    top5: [],
    results: [],
  };
  const scenario = buildScenario(script, totalMs, args.verbose, meta);
  const { summary } = await runScenario(args, scenario);
  summary.extra = { args: script, recon: meta };
  process.stdout.write(formatJson(summary, args.pretty));
  return summary.ok && meta.status === 'ok' ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
