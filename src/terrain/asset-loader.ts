/**
 * Planet-general terrain asset loader.
 *
 * SWG ships terrain `.trn` files inside a SOE `.tre` archive. To make the
 * terrain helpers planet-agnostic — load any planet by name (`naboo`,
 * `tatooine`, `corellia`, …) without hard-coding paths — we resolve the
 * `.trn` from a `.tre` archive at runtime.
 *
 * Standard asset path (set via README setup step):
 *   `<repo>/assets/swgsource_3.0.tre` (or a custom path via
 *   `SWG_TRE_PATH` env var or a `treePath` argument).
 *
 * Standard in-archive path for each planet's terrain:
 *   `terrain/<planet>.trn` (e.g. `terrain/naboo.trn`).
 *
 * Once loaded, the `.trn` bytes are passed to `parseTrnMetadata()` from
 * `./trn-reader.js`, so existing callers using `readTrnMetadata(path)`
 * remain valid for on-disk extracted files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TreReader } from '../tre/tre-reader.js';
import { parseTrnMetadata, type TrnMetadata } from './trn-reader.js';

/**
 * Resolve the default SWG TRE archive path, in priority order:
 *   1. `SWG_TRE_PATH` environment variable, if set
 *   2. `<cwd>/assets/swgsource_3.0.tre`
 *   3. `<cwd>/../swg-main/dist/prebuilt/swgsource_3.0.tre` (sibling-repo fallback)
 *
 * Throws if none exists.
 */
export function resolveDefaultTrePath(): string {
  const envPath = process.env.SWG_TRE_PATH;
  if (envPath !== undefined && envPath !== '' && existsSync(envPath)) return envPath;

  const localAsset = join(process.cwd(), 'assets', 'swgsource_3.0.tre');
  if (existsSync(localAsset)) return localAsset;

  const siblingRepo = join(process.cwd(), '..', 'swg-main', 'dist', 'prebuilt', 'swgsource_3.0.tre');
  if (existsSync(siblingRepo)) return siblingRepo;

  throw new Error(
    'Could not find SWG TRE archive. Set SWG_TRE_PATH env var, or place the .tre file at ' +
      `${localAsset}. See README setup instructions.`,
  );
}

/**
 * Convert a planet name (`'naboo'`, `'tatooine'`, etc.) to its standard
 * in-archive .trn path.
 */
export function trnPathForPlanet(planet: string): string {
  return `terrain/${planet}.trn`;
}

/** A reusable cache so callers can re-query terrain without re-opening the TRE. */
const treCache = new Map<string, TreReader>();

/**
 * Get (and cache) a `TreReader` for the given archive path. Caching is
 * intra-process; if the file changes on disk, `clearTreCache()` invalidates.
 */
export function getTreReader(trePath?: string): TreReader {
  const path = trePath ?? resolveDefaultTrePath();
  let cached = treCache.get(path);
  if (cached === undefined) {
    cached = TreReader.fromFile(path);
    treCache.set(path, cached);
  }
  return cached;
}

/** Test/dev helper to drop the cache (e.g. when swapping archives in a test). */
export function clearTreCache(): void {
  treCache.clear();
}

/**
 * Standard on-disk extracted-terrain search paths, in priority order.
 * Used by `loadPlanetTrn` for the "already extracted on disk" common case
 * (SWG mod tooling typically keeps a flat `serverdata/terrain/<planet>.trn`).
 */
export function extractedTrnSearchPaths(planet: string): string[] {
  return [
    join(process.cwd(), 'assets', 'terrain', `${planet}.trn`),
    join(process.cwd(), '..', 'swg-main', 'serverdata', 'terrain', `${planet}.trn`),
  ];
}

/**
 * Load the raw `.trn` bytes for a planet from a TRE archive.
 * Throws if the planet's `.trn` is not in the archive.
 *
 * If your `.trn` files are already extracted on disk (common SWG mod setup),
 * prefer `loadPlanetTrn(planet)` which transparently checks both extracted
 * paths AND the TRE archive.
 */
export function loadTrnFromTre(planet: string, trePath?: string): Uint8Array {
  const reader = getTreReader(trePath);
  const inArchivePath = trnPathForPlanet(planet);
  if (!reader.exists(inArchivePath)) {
    throw new Error(
      `Planet '${planet}' not found in TRE archive (looked for ${inArchivePath}). ` +
        `Available planets in TRE: ${listPlanets(trePath).join(', ')}`,
    );
  }
  return reader.read(inArchivePath);
}

/**
 * **Recommended entry point.** Resolve a planet's `.trn` bytes from any
 * available source, in priority order:
 *
 *   1. `<cwd>/assets/terrain/<planet>.trn` (user-staged extracted file)
 *   2. `<cwd>/../swg-main/serverdata/terrain/<planet>.trn` (sibling-repo, common dev setup)
 *   3. The configured TRE archive (`SWG_TRE_PATH` env, `<cwd>/assets/*.tre`, sibling-repo prebuilt)
 *
 * This is what most callers should use — it works whether you've extracted
 * terrain to disk OR are loading direct from a `.tre` archive.
 */
export function loadPlanetTrn(planet: string, opts: { trePath?: string } = {}): Uint8Array {
  for (const candidate of extractedTrnSearchPaths(planet)) {
    if (existsSync(candidate)) return readFileSync(candidate);
  }
  return loadTrnFromTre(planet, opts.trePath);
}

/**
 * Convenience: load a planet's terrain metadata in one call.
 * Uses `loadPlanetTrn` so it works for both extracted-on-disk and TRE-archive setups.
 */
export function readTrnMetadataForPlanet(planet: string, trePath?: string): TrnMetadata {
  return parseTrnMetadata(loadPlanetTrn(planet, trePath !== undefined ? { trePath } : {}));
}

/**
 * List every planet for which a `terrain/<planet>.trn` exists in the
 * archive. Useful for build tooling that wants to enumerate available
 * worlds.
 */
export function listPlanets(trePath?: string): readonly string[] {
  const reader = getTreReader(trePath);
  const planets: string[] = [];
  for (const entry of reader.list()) {
    const match = entry.filename.match(/^terrain\/([a-z0-9_]+)\.trn$/i);
    if (match !== null && match[1] !== undefined) planets.push(match[1]);
  }
  return planets.sort();
}
