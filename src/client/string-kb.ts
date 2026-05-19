/**
 * `StringKBImpl` — lazy, process-wide cache of `.stf` (localized string
 * table) files. Implements the `StringKB` interface from `./knowledge.ts`.
 *
 * # Why
 *
 * Wire fields that carry server-side strings (chat `outOfBand`, system
 * messages, dialog responses, error notifications) ship as `(file, key)`
 * pairs like `('city/city', 'declared_residence')`. The real Windows
 * client resolves those against local `string/<lang>/<file>.stf` assets.
 * `StringKBImpl` is the bot framework's equivalent — one entry per file,
 * promise-coalesced, shared by every `ScriptContext` in the process.
 *
 * # Cache shape (mirrors `TerrainKBImpl`)
 *
 *   - One `Map<file, Promise<StfTable>>` per instance.
 *   - Concurrent calls for the same file share the same in-flight promise.
 *   - Failed loads are NOT cached — a transient asset-resolution failure
 *     shouldn't poison the cache for every other client. The next call
 *     retries.
 *   - `evict(file)` / `clear()` / `size()` are read-side maintenance ops
 *     for tests and admin tools.
 *
 * # Default loader
 *
 * The default `loadFile(lang, file)` resolves bytes via the same
 * priority chain as terrain:
 *   1. `<cwd>/assets/string/<lang>/<file>.stf`
 *   2. `<cwd>/../swg-main/serverdata/string/<lang>/<file>.stf`
 *   3. The configured TRE archive entry `string/<lang>/<file>.stf`
 * (1) and (2) are filesystem-extracted assets — the common dev path. (3) is
 * the production path when running against bundled assets.
 *
 * Tests inject their own `loadFile` via `StringKBOptions.loadFile`, which
 * keeps the unit suite filesystem-free.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type StfTable, parseStf } from '../iff/stf-reader.js';
import { getTreReader, resolveDefaultTrePath } from '../terrain/asset-loader.js';
import type { StringKB, StringKBOptions } from './knowledge.js';

type LoadFn = (lang: string, file: string) => Promise<Uint8Array>;

/**
 * Default filesystem loader. Walks the same priority list as
 * `loadPlanetTrn` in `src/terrain/asset-loader.ts`:
 *   1. extracted-on-disk under `<cwd>/assets/`
 *   2. extracted-on-disk under the sibling `swg-main` server-data tree
 *   3. the TRE archive entry `string/<lang>/<file>.stf`
 *
 * Throws if no source has the file — the caller (`StringKBImpl.resolveFile`)
 * turns the throw into a `null` return so missing files don't poison the
 * cache.
 */
async function defaultLoadFile(lang: string, file: string): Promise<Uint8Array> {
  const relativePath = `string/${lang}/${file}.stf`;

  const localAsset = join(process.cwd(), 'assets', relativePath);
  if (existsSync(localAsset)) return readFileSync(localAsset);

  const siblingExtract = join(process.cwd(), '..', 'swg-main', 'serverdata', relativePath);
  if (existsSync(siblingExtract)) return readFileSync(siblingExtract);

  // TRE archive fallback. Only attempt this if a TRE is configured —
  // `resolveDefaultTrePath` throws when nothing is found, and we want that
  // to surface as "file missing" rather than "no TRE archive" when both
  // would be true (a missing asset is the common case, no-archive is the
  // unusual one).
  try {
    const trePath = resolveDefaultTrePath();
    const reader = getTreReader(trePath);
    if (reader.exists(relativePath)) {
      return reader.read(relativePath);
    }
  } catch {
    // No TRE configured. Fall through to the throw below.
  }

  throw new Error(`StringKB: no asset found for '${relativePath}'`);
}

export class StringKBImpl implements StringKB {
  private readonly cache = new Map<string, Promise<StfTable>>();
  private readonly language: string;
  private readonly loadFile: LoadFn;

  constructor(opts: StringKBOptions = {}) {
    this.language = opts.language ?? 'en';
    this.loadFile = opts.loadFile ?? defaultLoadFile;
  }

  async resolve(file: string, key: string): Promise<string | null> {
    const { file: parsedFile, key: parsedKey } = parseFileAndKey(file, key);
    if (parsedFile === '') return null;
    const table = await this.resolveFile(parsedFile);
    if (table === null) return null;
    return table.get(parsedKey) ?? null;
  }

  async resolveFile(file: string): Promise<ReadonlyMap<string, string> | null> {
    // Normalize so `@city/city` and `city/city` collapse onto the same
    // cache key. We also strip an in-line `:key` if present so callers can
    // pass `resolveFile('@city/city:declared')` without surprises.
    const normalized = normalizeFilePart(file);
    if (normalized === '') return null;

    const existing = this.cache.get(normalized);
    if (existing !== undefined) {
      try {
        const table = await existing;
        return table.entries;
      } catch {
        return null;
      }
    }

    const pending = this.loadFile(this.language, normalized).then((bytes) => {
      const table = parseStf(bytes);
      // The file format doesn't carry the language code; we know it from
      // the loader call, so stamp it here for any caller that wants to
      // round-trip the table.
      return { language: this.language, entries: table.entries };
    });

    // Don't cache failures — match TerrainKBImpl's eviction behavior so a
    // transient missing-asset error doesn't poison subsequent loads. Only
    // evict if the cache still points at THIS pending promise (a concurrent
    // successful retry could have replaced it).
    pending.catch(() => {
      if (this.cache.get(normalized) === pending) this.cache.delete(normalized);
    });
    this.cache.set(normalized, pending);

    try {
      const table = await pending;
      return table.entries;
    } catch {
      return null;
    }
  }

  evict(file: string): void {
    this.cache.delete(normalizeFilePart(file));
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

/**
 * Resolve the `(file, key)` pair from raw `resolve()` arguments. Handles:
 *   - `@file/path:key` — leading `@` stripped, `:` splits file/key.
 *     If `key` arg is non-empty it wins over the in-string `:key` part.
 *   - `file/path` + `key` — plain.
 *   - `@file/path` + `key` — leading `@` stripped, key from arg.
 */
function parseFileAndKey(file: string, key: string): { file: string; key: string } {
  let f = file;
  if (f.startsWith('@')) f = f.slice(1);
  const colon = f.indexOf(':');
  if (colon === -1) {
    return { file: f, key };
  }
  const filePart = f.slice(0, colon);
  const keyPart = f.slice(colon + 1);
  // Caller-supplied key wins over the in-string :key part (per the
  // interface JSDoc: "if called with both args set, `key` arg wins").
  return { file: filePart, key: key !== '' ? key : keyPart };
}

/**
 * Strip an in-string `@` prefix and any `:key` suffix to derive the cache
 * key. Returns the empty string for pathological inputs (leading colon,
 * empty file part) so callers can short-circuit to `null`.
 */
function normalizeFilePart(file: string): string {
  let f = file;
  if (f.startsWith('@')) f = f.slice(1);
  const colon = f.indexOf(':');
  if (colon !== -1) f = f.slice(0, colon);
  return f;
}
