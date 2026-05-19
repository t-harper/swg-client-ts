/**
 * `BuildingKBImpl` — lazy, process-wide cache of building-related lookups
 * that the navigate path needs to walk a player into a named cell.
 *
 * Two caches live here, both keyed by string filename, both behaving like
 * `StringKBImpl`:
 *
 *   - `portalLayoutFor(portalLayoutFilename)` — resolves a `.pob` file
 *     (e.g. `'appearance/thm_tato_cantina.pob'`) to a parsed `PortalLayout`.
 *     Track A (this file) implements it.
 *   - `templateInfoFor(templateName)` — resolves a building template name
 *     (e.g. `'object/building/tatooine/cantina_tatooine.iff'`) to a tiny
 *     `BuildingTemplateInfo` struct carrying `portalLayoutFilename`. Track B
 *     implements the body; Track A ships a placeholder that throws so the
 *     interface + tests are in place.
 *
 * # Cache shape (mirrors `StringKBImpl`)
 *
 *   - One `Map<filename, Promise<PortalLayout>>` per instance.
 *   - Concurrent calls for the same file share the same in-flight promise.
 *   - Failed loads are NOT cached — a transient asset-resolution failure
 *     shouldn't poison the cache for every other client. The next call
 *     retries.
 *   - `evict(file)` / `clear()` / `size()` are read-side maintenance ops
 *     for tests and admin tools.
 *
 * # Default loaders
 *
 * The default `loadPortalLayout` resolves bytes via the same priority chain
 * as terrain + strings (extracted on disk first, then TRE archive). Tests
 * inject their own `loadPortalLayout` via `BuildingKBOptions.loadPortalLayout`
 * to stay filesystem-free.
 */

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
   * (`portalLayoutFilename`, `appearanceFilename`, …). Track B (the
   * object-template extractor) implements this; Track A ships only the
   * interface + a placeholder.
   *
   * Callers should NOT depend on this method until Track B lands — until
   * then it throws synchronously (well, returns a rejecting promise) with
   * a clear sentinel message.
   *
   * `templateName` example:
   *   - `'object/building/tatooine/cantina_tatooine.iff'`
   */
  templateInfoFor(templateName: string): Promise<BuildingTemplateInfo>;

  /** Maintenance: drop a single portal layout from cache. */
  evict(portalLayoutFilename: string): void;

  /** Maintenance: drop every cached entry (portal layouts + template info). */
  clear(): void;

  /** Diagnostic: how many entries are currently cached (portal layouts + template info). */
  size(): number;
}

/**
 * Strongly-typed object-template metadata. Populated by Track B's
 * `loadBuildingTemplateInfo`. Kept here (not in `object-template-reader.ts`)
 * so the `BuildingKB` interface compiles without depending on a file
 * Track B introduces.
 */
export interface BuildingTemplateInfo {
  /** Echoed-back template name (e.g. `'object/building/tatooine/cantina_tatooine.iff'`). */
  templateName: string;
  /** `.pob` filename the template references, or null if there is none. */
  portalLayoutFilename: string | null;
  /** `.msh` / `.apt` appearance filename, or null. Often useful as a fallback. */
  appearanceFilename: string | null;
}

export interface BuildingKBOptions {
  /**
   * Loader override for tests. Defaults to `loadPortalLayout` from
   * `src/iff/portal-layout-reader.ts`. Test signatures take just the
   * filename — language doesn't apply here (`.pob` files aren't localized).
   */
  loadPortalLayout?: (portalLayoutFilename: string) => Promise<PortalLayout>;
  /**
   * Loader override for `templateInfoFor`. Set by Track B once the
   * object-template reader lands. When unset, `templateInfoFor` throws.
   */
  loadBuildingTemplateInfo?: (templateName: string) => Promise<BuildingTemplateInfo>;
}

// ─── Implementation ───────────────────────────────────────────────────────

const TRACK_B_PLACEHOLDER_MESSAGE = 'Track B not yet landed';

export class BuildingKBImpl implements BuildingKB {
  private readonly portalCache = new Map<string, Promise<PortalLayout>>();
  private readonly templateCache = new Map<string, Promise<BuildingTemplateInfo>>();
  private readonly loadPortalLayout: (portalLayoutFilename: string) => Promise<PortalLayout>;
  private readonly loadBuildingTemplateInfo?: (
    templateName: string,
  ) => Promise<BuildingTemplateInfo>;

  constructor(opts: BuildingKBOptions = {}) {
    this.loadPortalLayout = opts.loadPortalLayout ?? defaultLoadPortalLayout;
    this.loadBuildingTemplateInfo = opts.loadBuildingTemplateInfo;
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
    // Track B will replace this with the real loader. Until then we throw
    // the sentinel message so callers (and tests) can detect "not yet
    // implemented" cleanly without misleading errors.
    if (this.loadBuildingTemplateInfo === undefined) {
      return Promise.reject(new Error(TRACK_B_PLACEHOLDER_MESSAGE));
    }
    const existing = this.templateCache.get(templateName);
    if (existing !== undefined) return existing;
    const pending = this.loadBuildingTemplateInfo(templateName);
    pending.catch(() => {
      if (this.templateCache.get(templateName) === pending) {
        this.templateCache.delete(templateName);
      }
    });
    this.templateCache.set(templateName, pending);
    return pending;
  }

  evict(portalLayoutFilename: string): void {
    this.portalCache.delete(portalLayoutFilename);
  }

  clear(): void {
    this.portalCache.clear();
    this.templateCache.clear();
  }

  size(): number {
    return this.portalCache.size + this.templateCache.size;
  }
}
