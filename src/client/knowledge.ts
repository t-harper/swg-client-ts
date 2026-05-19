/**
 * Knowledge — process-wide shared in-memory index of "what does this byte
 * mean" data the real Windows SWG client gets from local game assets.
 *
 * Today the client treats each piece of wire data atomically (template CRC,
 * STF token, schematic id, etc.) and re-loads any offline lookup it needs
 * per ScriptContext. That's wasteful when a Fleet runs 30 clients —
 * `naboo.trn` gets parsed 30×, the chunk caches don't share, and STF
 * resolution would multiply the same per-client cost across every lens we
 * add (object templates, schematics, command tables, ...).
 *
 * `Knowledge` is the single shared owner of those lazy-loaded indexes. One
 * `Knowledge` instance per process (the module-level `defaultKnowledge` is
 * the canonical one); every `SwgClient` / `ScriptContext` reads through it,
 * so two clients asking for the same planet's terrain or the same STF file
 * share the same `Promise` and the same resolved data.
 *
 * Design rules:
 *  - The KB is read-only from the script side. Views (`ctx.terrain`,
 *    `ctx.strings`, etc.) expose lookup methods only. Maintenance ops
 *    (`evict`, `clear`) live on the KB itself, NOT on the views.
 *  - Failed loads are NOT cached — transient asset-resolution errors must
 *    not poison the shared cache for every other client.
 *  - Tests construct their own `new Knowledge()` for isolation. The default
 *    singleton is for production / CLI / Fleet runs.
 *  - Adding a new lens = add a new `KB` sub-interface here, implement it
 *    next to the existing impls in this file, slot it onto `Knowledge`.
 *
 * Sequencing: this file is the architectural seam — the 3 parallel-agent
 * tracks each implement one slice against the interfaces below.
 */

import {
  ProceduralTerrainAppearance,
  type ProceduralTerrainTemplate,
  loadPlanetTrnTemplate,
} from '../terrain/sim/index.js';
import { StringKBImpl } from './string-kb.js';

// ──────────────────────────────────────────────────────────────────────
// TerrainKB — per-planet ProceduralTerrainAppearance cache.
// ──────────────────────────────────────────────────────────────────────

export interface TerrainKB {
  /**
   * Get (or lazy-load) the procedural terrain appearance for `planet`.
   * Concurrent calls for the same planet return the same in-flight promise.
   * Failed loads are removed from the cache so retries can succeed.
   */
  appearanceFor(planet: string): Promise<ProceduralTerrainAppearance>;

  /** Maintenance: drop a planet from the cache (e.g. for tests). */
  evict(planet: string): void;

  /** Maintenance: drop every cached planet. */
  clear(): void;

  /** Diagnostic: how many planets are currently cached. */
  size(): number;
}

export interface TerrainKBOptions {
  /**
   * Loader override for tests. Defaults to `loadPlanetTrnTemplate` from
   * `src/terrain/sim/proc-terrain-template.ts`.
   */
  loadTemplate?: (planet: string) => Promise<ProceduralTerrainTemplate>;
  /**
   * Appearance constructor override for tests. Defaults to
   * `new ProceduralTerrainAppearance(template)`.
   */
  buildAppearance?: (template: ProceduralTerrainTemplate) => ProceduralTerrainAppearance;
}

// ──────────────────────────────────────────────────────────────────────
// StringKB — STF (string-table) token → localized string resolution.
//
// SWG ships localized text as IFF "string table" files under
// `string/<lang>/<file>.stf`. Wire messages refer to entries by
// `(file, key)` pairs (e.g. chat oob fields, system messages, dialog).
// The real client loads the table once and resolves on demand.
//
// See agent-B prompt for the C++ ground truth file paths.
// ──────────────────────────────────────────────────────────────────────

export interface StringKB {
  /**
   * Resolve `(file, key)` to the localized string. Returns `null` when the
   * file or the key is missing.
   *
   * `file` examples: `'city/city'`, `'cmd_err'`, `'survey/survey'`. May be
   * prefixed with `'@'` (the in-game token form, e.g. `'@city/city:declared'`);
   * the leading `@` is stripped and the `:` split is honored if `key` is
   * undefined.
   */
  resolve(file: string, key: string): Promise<string | null>;

  /**
   * Resolve a full STF file as a `Map<key, string>` (loads + caches the
   * file's table). Returns `null` if the file isn't available.
   */
  resolveFile(file: string): Promise<ReadonlyMap<string, string> | null>;

  /** Maintenance: drop a single STF file from cache. */
  evict(file: string): void;

  /** Maintenance: drop every cached file. */
  clear(): void;

  /** Diagnostic: how many STF files are currently cached. */
  size(): number;
}

export interface StringKBOptions {
  /**
   * Language directory under `string/`. Defaults to `'en'`. STF files
   * resolve as `string/<lang>/<file>.stf` via the same asset-loader
   * lookup chain as terrain (extracted assets first, then TRE archives).
   */
  language?: string;
  /**
   * Loader override for tests. Defaults to reading from
   * `string/<lang>/<file>.stf` via asset-loader.
   */
  loadFile?: (lang: string, file: string) => Promise<Uint8Array>;
}

// ──────────────────────────────────────────────────────────────────────
// Knowledge — root container. Stays small; each new lens adds a slot.
// ──────────────────────────────────────────────────────────────────────

export interface Knowledge {
  /** Procedural terrain appearances, keyed by planet. */
  readonly terrain: TerrainKB;

  /** STF token → localized string resolution. */
  readonly strings: StringKB;

  /**
   * Optional warmup so the first ScriptContext doesn't pay the full
   * cold-start cost. Fire-and-forget; loads happen in parallel.
   */
  preload(opts?: PreloadOptions): Promise<void>;

  /** Drop every cached lens (terrain + strings + ...). Mainly for tests. */
  clear(): void;
}

export interface PreloadOptions {
  /** Pre-load terrain templates for these planets. */
  planets?: readonly string[];
  /** Pre-load STF tables for these files. */
  strings?: readonly string[];
}

export interface KnowledgeOptions {
  terrain?: TerrainKBOptions;
  strings?: StringKBOptions;
}

// ──────────────────────────────────────────────────────────────────────
// TerrainKBImpl — process-wide per-planet ProceduralTerrainAppearance cache.
//
// One `Map<planet, Promise<...>>` per Knowledge instance. Concurrent calls
// for the same planet receive the same in-flight promise (coalescing). On
// failure the cache entry is removed so a retry can succeed.
// ──────────────────────────────────────────────────────────────────────

export class TerrainKBImpl implements TerrainKB {
  private readonly cache = new Map<string, Promise<ProceduralTerrainAppearance>>();
  private readonly loadTemplate: (planet: string) => Promise<ProceduralTerrainTemplate>;
  private readonly buildAppearance: (
    template: ProceduralTerrainTemplate,
  ) => ProceduralTerrainAppearance;

  constructor(opts: TerrainKBOptions = {}) {
    this.loadTemplate = opts.loadTemplate ?? loadPlanetTrnTemplate;
    this.buildAppearance =
      opts.buildAppearance ?? ((template) => new ProceduralTerrainAppearance(template));
  }

  appearanceFor(planet: string): Promise<ProceduralTerrainAppearance> {
    const existing = this.cache.get(planet);
    if (existing !== undefined) return existing;
    const pending = this.loadTemplate(planet).then(this.buildAppearance);
    // Don't cache failures — a transient missing-asset error shouldn't
    // poison every subsequent call. The unhandled-rejection branch here is
    // a no-op delete; callers still see the original rejection.
    pending.catch(() => {
      // Only evict if the cached entry is still this exact pending promise:
      // a concurrent successful retry could have replaced it already.
      if (this.cache.get(planet) === pending) this.cache.delete(planet);
    });
    this.cache.set(planet, pending);
    return pending;
  }

  evict(planet: string): void {
    this.cache.delete(planet);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// ──────────────────────────────────────────────────────────────────────
// KnowledgeImpl — root container.
// ──────────────────────────────────────────────────────────────────────

export class KnowledgeImpl implements Knowledge {
  readonly terrain: TerrainKBImpl;
  readonly strings: StringKB;

  constructor(opts: KnowledgeOptions = {}) {
    this.terrain = new TerrainKBImpl(opts.terrain);
    this.strings = new StringKBImpl(opts.strings);
  }

  async preload(opts: PreloadOptions = {}): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    if (opts.planets !== undefined) {
      for (const planet of opts.planets) {
        tasks.push(this.terrain.appearanceFor(planet));
      }
    }
    if (opts.strings !== undefined) {
      for (const file of opts.strings) {
        tasks.push(this.strings.resolveFile(file));
      }
    }
    await Promise.all(tasks);
  }

  clear(): void {
    this.terrain.clear();
    this.strings.clear();
  }
}

/**
 * Process-wide default. Most callers never touch this directly — they get
 * it through `ctx.terrain` / `ctx.strings`. Tests should construct a fresh
 * `new KnowledgeImpl()` and inject via `createScriptContext({ knowledge })`.
 */
export const defaultKnowledge: Knowledge = new KnowledgeImpl();
