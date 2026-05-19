/**
 * `BuildingKBImpl` — lazy, process-wide cache of building-related lookups
 * that the navigate path needs to walk a player into a named cell.
 *
 * Three caches live here, all coalescing concurrent loads and evicting on
 * failure (so a transient missing-asset error doesn't poison subsequent
 * calls):
 *
 *   - `portalLayoutFor(portalLayoutFilename)` — resolves a `.pob` file
 *     (e.g. `'appearance/thm_tato_cantina.pob'`) to a parsed `PortalLayout`.
 *   - `templateInfoFor(templateName)` — resolves a building template name
 *     (e.g. `'object/building/tatooine/shared_cantina_tatooine.iff'`) to a
 *     tiny `BuildingTemplateInfo` struct carrying `portalLayoutFilename`
 *     and `appearanceFilename`.
 *   - `templateNameForCrc(crc)` — reverse lookup from `templateCrc`
 *     (carried on `SceneCreateObjectByCrc`) to the template path string.
 *     Used by `navigate.ts` when a building's `WorldObject.templateName`
 *     is undefined (the common case for buildout objects). The underlying
 *     `CrcStringTable` is loaded once per process and shared by every
 *     lookup.
 *
 * # Cache shape (mirrors `StringKBImpl`)
 *
 *   - One `Map<filename, Promise<PortalLayout>>` and one
 *     `Map<templateName, Promise<BuildingTemplateInfo>>` per instance,
 *     plus a single `Promise<CrcStringTable> | null` for the CRC reverse
 *     lookup (lazy, process-wide).
 *   - Concurrent calls for the same key share the same in-flight promise.
 *   - Failed loads are NOT cached — a transient asset-resolution failure
 *     shouldn't poison the cache for every other client. The next call
 *     retries.
 *   - `evict(file)` / `clear()` / `size()` are read-side maintenance ops
 *     for tests and admin tools.
 *
 * # Default loaders
 *
 * The default `loadPortalLayout`, `loadBuildingTemplateInfo`, and
 * `loadCrcStringTable` resolve bytes via the same priority chain as
 * terrain + strings (extracted on disk first, then TRE archive). Tests
 * inject their own loaders via `BuildingKBOptions` to stay
 * filesystem-free.
 */

import {
  type CrcStringTable,
  loadCrcStringTable as defaultLoadCrcStringTable,
} from '../iff/crc-string-table-reader.js';
import {
  type BuildingTemplateInfo,
  loadBuildingTemplateInfo as defaultLoadBuildingTemplateInfo,
} from '../iff/object-template-reader.js';
import {
  type PortalLayout,
  loadPortalLayout as defaultLoadPortalLayout,
} from '../iff/portal-layout-reader.js';

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Lazy-loaded view onto building static data — portal layouts and (in
 * Track B) template metadata. One instance lives on `Knowledge.buildings`;
 * every `ScriptContext` reads through it.
 *
 * Read-side from the script perspective (no `set`, no `register`); the
 * single mutation surface is `evict` / `clear` for tests.
 */
export interface BuildingKB {
  /**
   * Resolve a `.pob` filename to a parsed `PortalLayout`. Returns the
   * pending promise on a cache hit; coalesces concurrent calls for the
   * same file into one in-flight load.
   *
   * Rejects (and removes the cache entry) when the asset is missing or
   * the bytes are malformed. Callers should `try/await/catch` and fall
   * back to whatever they want — the navigate path falls back to today's
   * outdoor-anchor walk.
   *
   * `portalLayoutFilename` examples:
   *   - `'appearance/thm_tato_cantina.pob'`
   *   - `'appearance/object/building/tatooine/cantina_tatooine.pob'`
   *     (the path varies by mod; we accept whatever the caller passes
   *     and don't try to normalize it).
   */
  portalLayoutFor(portalLayoutFilename: string): Promise<PortalLayout>;

  /**
   * Resolve a building template name to its `BuildingTemplateInfo`
   * (`portalLayoutFilename`, `appearanceFilename`). Coalesces concurrent
   * calls for the same template; evicts on load failure so a transient
   * asset-miss doesn't poison the cache.
   *
   * Rejects (and removes the cache entry) when the underlying object
   * template `.iff` can't be loaded or parsed. The navigate path falls
   * back to the BUIO baseline's `appearance` field for templates that
   * fail this lookup.
   *
   * `templateName` example:
   *   - `'object/building/tatooine/shared_cantina_tatooine.iff'`
   */
  templateInfoFor(templateName: string): Promise<BuildingTemplateInfo>;

  /**
   * Reverse-lookup a template name from its 32-bit CRC. The cantina (and
   * most other buildout objects) arrive via `SceneCreateObjectByCrc` with
   * NO `templateName` on the wire — only the `templateCrc`. This method
   * resolves the CRC to the template path string, which can then feed
   * `templateInfoFor(name)` to recover the `.pob` / appearance fields.
   *
   * Lazy: the underlying `object_template_crc_string_table.iff` (~30k
   * entries, ~2 MB) is loaded once per process on the first call and
   * shared by every subsequent lookup. Returns `null` when the CRC
   * isn't in the table OR the table itself can't be loaded — the navigate
   * path falls through to the legacy outdoor-anchor walk in either case.
   *
   * A transient load failure does NOT poison the cache; the next call
   * retries. A genuine "this CRC isn't known" result IS cached (it's just
   * `null`, which is the same value the table itself returns).
   */
  templateNameForCrc(crc: number): Promise<string | null>;

  /** Maintenance: drop a single portal layout from cache. */
  evict(portalLayoutFilename: string): void;

  /**
   * Maintenance: drop every cached entry — portal layouts, template info,
   * AND the loaded CRC string table.
   */
  clear(): void;

  /**
   * Diagnostic: how many entries are currently cached (portal layouts +
   * template info; the loaded CRC string table counts as +1 once loaded).
   */
  size(): number;
}

// Re-export `BuildingTemplateInfo` from its canonical home in
// `object-template-reader.ts` so existing callers that import it from
// `building-kb.ts` keep working without an extra import line.
export type { BuildingTemplateInfo } from '../iff/object-template-reader.js';

export interface BuildingKBOptions {
  /**
   * Loader override for tests. Defaults to `loadPortalLayout` from
   * `src/iff/portal-layout-reader.ts`. Test signatures take just the
   * filename — language doesn't apply here (`.pob` files aren't localized).
   */
  loadPortalLayout?: (portalLayoutFilename: string) => Promise<PortalLayout>;
  /**
   * Loader override for `templateInfoFor`. Defaults to
   * `loadBuildingTemplateInfo` from `src/iff/object-template-reader.ts`,
   * which walks the same asset-resolution chain as the portal-layout
   * loader (extracted on disk → sibling `swg-main` data tree → TRE
   * archive). Tests inject a synthetic loader to stay filesystem-free.
   */
  loadBuildingTemplateInfo?: (templateName: string) => Promise<BuildingTemplateInfo>;
  /**
   * Loader override for `templateNameForCrc`. Defaults to
   * `loadCrcStringTable('misc/object_template_crc_string_table.iff')`
   * from `src/iff/crc-string-table-reader.ts`, which walks the same
   * asset-resolution chain as the other loaders. Tests pass a synthetic
   * table-loader to stay filesystem-free.
   */
  loadCrcStringTable?: () => Promise<CrcStringTable>;
}

// ─── Implementation ───────────────────────────────────────────────────────

/**
 * Canonical filename of the CRC → template-name table that ships with the
 * SWG client. Used by the default `loadCrcStringTable` thunk and the
 * `clear()` / `size()` accounting.
 */
const CRC_STRING_TABLE_FILENAME = 'misc/object_template_crc_string_table.iff';

export class BuildingKBImpl implements BuildingKB {
  private readonly portalCache = new Map<string, Promise<PortalLayout>>();
  private readonly templateCache = new Map<string, Promise<BuildingTemplateInfo>>();
  /**
   * One-shot promise for the loaded CRC string table. `null` until the
   * first `templateNameForCrc` call kicks off a load. Failed loads reset
   * back to `null` so the next call retries.
   */
  private crcTablePromise: Promise<CrcStringTable> | null = null;
  private readonly loadPortalLayout: (portalLayoutFilename: string) => Promise<PortalLayout>;
  private readonly loadBuildingTemplateInfo: (
    templateName: string,
  ) => Promise<BuildingTemplateInfo>;
  private readonly loadCrcStringTable: () => Promise<CrcStringTable>;

  constructor(opts: BuildingKBOptions = {}) {
    this.loadPortalLayout = opts.loadPortalLayout ?? defaultLoadPortalLayout;
    this.loadBuildingTemplateInfo =
      opts.loadBuildingTemplateInfo ?? defaultLoadBuildingTemplateInfo;
    this.loadCrcStringTable =
      opts.loadCrcStringTable ?? (() => defaultLoadCrcStringTable(CRC_STRING_TABLE_FILENAME));
  }

  portalLayoutFor(portalLayoutFilename: string): Promise<PortalLayout> {
    const existing = this.portalCache.get(portalLayoutFilename);
    if (existing !== undefined) return existing;
    const pending = this.loadPortalLayout(portalLayoutFilename);
    // Don't cache failures — match StringKBImpl's eviction behavior so a
    // transient missing-asset error doesn't poison subsequent loads. Only
    // evict if the cache still points at THIS pending promise (a concurrent
    // successful retry could have replaced it).
    pending.catch(() => {
      if (this.portalCache.get(portalLayoutFilename) === pending) {
        this.portalCache.delete(portalLayoutFilename);
      }
    });
    this.portalCache.set(portalLayoutFilename, pending);
    return pending;
  }

  templateInfoFor(templateName: string): Promise<BuildingTemplateInfo> {
    const existing = this.templateCache.get(templateName);
    if (existing !== undefined) return existing;
    const pending = this.loadBuildingTemplateInfo(templateName);
    // Mirror the portal-layout eviction: a failed load gets removed from
    // the cache so the next call retries instead of refusing forever.
    pending.catch(() => {
      if (this.templateCache.get(templateName) === pending) {
        this.templateCache.delete(templateName);
      }
    });
    this.templateCache.set(templateName, pending);
    return pending;
  }

  async templateNameForCrc(crc: number): Promise<string | null> {
    // Force a fresh load on every retry path: on a transient failure
    // (e.g. asset missing) we want the NEXT call to re-attempt the load,
    // not silently keep returning the cached rejected promise.
    if (this.crcTablePromise === null) {
      const pending = this.loadCrcStringTable();
      pending.catch(() => {
        // Same eviction discipline as the other caches: only nullify if
        // we still hold THIS promise (a concurrent successful retry could
        // have already replaced it).
        if (this.crcTablePromise === pending) {
          this.crcTablePromise = null;
        }
      });
      this.crcTablePromise = pending;
    }
    let table: CrcStringTable;
    try {
      table = await this.crcTablePromise;
    } catch {
      // Load failed — the catch handler above has already reset
      // `crcTablePromise` to null. Surface as "unknown CRC" so the
      // navigate path's fallback chain runs.
      return null;
    }
    return table.lookup(crc);
  }

  evict(portalLayoutFilename: string): void {
    this.portalCache.delete(portalLayoutFilename);
  }

  clear(): void {
    this.portalCache.clear();
    this.templateCache.clear();
    this.crcTablePromise = null;
  }

  size(): number {
    // Loaded CRC table counts as +1. A pending (not-yet-resolved) load is
    // still counted — `templateNameForCrc` callers awaiting it will see the
    // resolved table, so it's a live cache entry from the script's POV.
    return (
      this.portalCache.size + this.templateCache.size + (this.crcTablePromise === null ? 0 : 1)
    );
  }
}
