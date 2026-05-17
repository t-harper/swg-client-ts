#!/usr/bin/env node --import tsx
/**
 * city-recon-surveyor.ts — solo scout walks a region, scoring candidate lots
 * for a future player city by combining offline terrain analysis with live
 * server placement probes.
 *
 * Pipeline:
 *   1. Zone in on the requested planet.
 *   2. Load the planet's TRN metadata (`loadPlanetTrn`). Soft-fail with a
 *      clear setup hint if the asset isn't staged.
 *   3. Generate a candidate grid (`generateCandidateGrid`) of concentric
 *      rings around (centerX, centerZ).
 *   4. Score every candidate offline (flatnessScore = synthetic proxy from
 *      radial position + map bounds + global water table).
 *   5. Walk to the top-N by score, drop a probe deed via `probeBuildable`,
 *      and record whether the server accepted placement.
 *   6. Rank: buildable first, then by flatnessScore.
 *   7. Emit a JSON summary on stdout.
 *
 * The offline flatness score is intentionally synthetic — we don't decode
 * the full terrain heightmap (that's thousands of lines of fractal/affector
 * port). Instead we use:
 *   - distance from search center (closer = preferred for compact cities)
 *   - clearance from map edge (within the `mapWidth/2` boundary)
 *   - clearance above the global water table (if defined)
 * The probe itself is the source of truth for buildability; the score just
 * orders which candidates to spend probe-time on first.
 *
 * Example:
 *   LIVE=1 pnpm tsx scripts/examples/city-recon-surveyor.ts \
 *     --host=10.254.0.253 --user=tslive04 --character=ExCityScout \
 *     --planet=naboo --centerX=0 --centerZ=0 \
 *     --max-radius=500 --rings=4 --angular-steps=6 --probes=10 \
 *     --minutes=10
 */

import type { FlatSpot, ScenarioFn, TrnMetadata } from '../../src/index.js';
import {
  generateCandidateGrid,
  loadPlanetTrn,
  parseTrnMetadata,
  probeBuildable,
} from '../../src/index.js';
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
  speed: number;
  settleMs: number;
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
    speed: Number.parseFloat(extra.get('speed') ?? '8'),
    settleMs: Number.parseInt(extra.get('settle-ms') ?? '4500', 10),
  };
}

interface ReconMeta {
  status: 'ok' | 'no-terrain-assets' | 'wrong-planet' | 'error';
  errorMessage: string | null;
  planet: string;
  trn: { mapWidth: number; chunkWidth: number; waterHeight: number | null } | null;
  candidatesGenerated: number;
  candidatesScanned: number;
  candidatesBuildable: number;
  top5: CandidateScore[];
  results: CandidateScore[];
}

interface CandidateScore {
  x: number;
  z: number;
  flatnessScore: number;
  isBuildable: boolean | null;
  terrainHeight: number | null;
  probeNotes: string;
}

interface ScoredCandidate {
  spot: FlatSpot;
  flatnessScore: number;
}

function tryLoadPlanetMetadata(planet: string): { trn: TrnMetadata | null; error: string | null } {
  try {
    const bytes = loadPlanetTrn(planet);
    return { trn: parseTrnMetadata(bytes), error: null };
  } catch (err) {
    return { trn: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function scoreCandidates(
  spots: readonly FlatSpot[],
  trn: TrnMetadata | null,
  centerX: number,
  centerZ: number,
  maxRadius: number,
): ScoredCandidate[] {
  const halfMap = trn !== null ? trn.mapWidth / 2 : Number.POSITIVE_INFINITY;
  const out: ScoredCandidate[] = [];
  for (const spot of spots) {
    const dx = spot.x - centerX;
    const dz = spot.z - centerZ;
    const radialDist = Math.sqrt(dx * dx + dz * dz);
    const radialFactor = maxRadius <= 0 ? 1 : 1 - radialDist / maxRadius;
    const edgeMargin = Math.min(halfMap - Math.abs(spot.x), halfMap - Math.abs(spot.z));
    const edgeFactor =
      edgeMargin === Number.POSITIVE_INFINITY ? 1 : Math.max(0, Math.min(1, edgeMargin / 500));
    const flatnessScore = Math.max(0, radialFactor * 0.6 + edgeFactor * 0.4);
    out.push({ spot, flatnessScore });
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

    const { trn, error } = tryLoadPlanetMetadata(planet);
    if (trn === null) {
      meta.status = 'no-terrain-assets';
      meta.errorMessage =
        `Could not load TRN metadata for '${planet}': ${error ?? 'unknown'}. ` +
        `Stage assets/terrain/${planet}.trn (see assets/README.md) or set SWG_TRE_PATH.`;
      log(meta.errorMessage);
      await ctx.logout();
      return;
    }
    meta.trn = {
      mapWidth: trn.mapWidth,
      chunkWidth: trn.chunkWidth,
      waterHeight: trn.globalWaterHeight,
    };
    log(
      `${planet}: mapWidth=${trn.mapWidth}m chunkWidth=${trn.chunkWidth}m water=${
        trn.globalWaterHeight ?? 'none'
      }`,
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

    const scored = scoreCandidates(candidates, trn, args.centerX, args.centerZ, args.maxRadius);
    scored.sort((a, b) => b.flatnessScore - a.flatnessScore);

    const chosen: FlatSpot[] = [];
    const toProbe: ScoredCandidate[] = [];
    for (const cand of scored) {
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
      const { spot, flatnessScore } = cand;

      try {
        await ctx.walkTo({ x: spot.x, z: spot.z }, { speed: args.speed });
      } catch (err) {
        log(`walk to (${spot.x.toFixed(1)}, ${spot.z.toFixed(1)}) failed: ${err}`);
      }
      const terrainHeight = ctx.position().y;

      log(
        `probe ${i + 1}/${toProbe.length}: (${spot.x.toFixed(1)}, ${spot.z.toFixed(1)}) y=${terrainHeight.toFixed(2)} score=${flatnessScore.toFixed(3)}`,
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
      '  --speed=N                walk speed in m/s (default 8)',
      '  --settle-ms=N            ms to wait for probe rejection chat (default 4500)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const meta: ReconMeta = {
    status: 'error',
    errorMessage: null,
    planet: script.planet,
    trn: null,
    candidatesGenerated: 0,
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
