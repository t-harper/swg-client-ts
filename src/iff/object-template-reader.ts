/**
 * Object-template `.iff` reader — narrow extractor for the two filename
 * fields the navigate path needs (`portalLayoutFilename` and
 * `appearanceFilename`).
 *
 * # Why this exists
 *
 * The `BuildingObject` wire baselines (`BaselinesMessage` packages 3 + 6
 * in `building-object-baseline-{3,6}.ts`) do NOT carry the building's
 * `portalLayoutFilename`. That field lives in the SHARED object template
 * (`object/building/<planet>/shared_<thing>.iff`) which the SOE Windows
 * client reads at zone-in. For the bot framework to walk a player through
 * a building's portals (`ctx.navigate({ buildingId, cellName })`) we need
 * to extract the same field offline.
 *
 * # Scope
 *
 * Strictly a minimal extractor. A full SWG object-template parser would
 * cover several hundred fields across dozens of param types
 * (paletteColor / weightedList / dieRoll / vector / structParam / etc.).
 * Since the navigate path only cares about `portalLayoutFilename` and the
 * `appearanceFilename` fallback, that's all we implement. Everything
 * else is skipped via the IFF length field — we never need to understand
 * the per-param payload of any chunk whose name we don't know.
 *
 * # Wire format (verified against C++ ground truth)
 *
 * A SharedBuildingObjectTemplate `.iff` is a nested SOE IFF:
 *
 *     FORM SBOT (or STOT / SHOT, depending on the leaf class)
 *       FORM DERV               (optional) — chunk holding the base template
 *                                 path so the client resolves inheritance.
 *       FORM <version 0001..>   — version-specific FORM containing the
 *                                 param table for THIS class:
 *         CHUNK PCNT            — [int32 paramCount]
 *         CHUNK XXXX × paramCount — each is one param (see below).
 *       FORM <parent class>     (optional, nested) — the parent template
 *                                 class FORM. Recurses through the
 *                                 SBOT → STOT → SHOT chain until we hit
 *                                 the class we know how to read.
 *
 * Each XXXX chunk body is:
 *     [paramName NUL-terminated cstring]
 *     [int8 dataType]               — 0=NONE, 1=SINGLE, 2=WEIGHTED_LIST,
 *                                     3=RANGE, 4=DIE_ROLL
 *     [...]                         — dataType-specific payload; for
 *                                     SINGLE/string this is a single
 *                                     NUL-terminated cstring.
 *
 * `portalLayoutFilename` and `appearanceFilename` are both `StringParam`s,
 * declared in `SharedObjectTemplate.cpp:2202-2205`, so they live in the
 * **SHOT** FORM. We walk the FORM tree depth-first and harvest both
 * names from any version-FORM PCNT+XXXX block we find — the names are
 * unique within an object template so there is no ambiguity.
 *
 * # C++ ground truth
 *
 *   - `~/code/swg-main/src/engine/shared/library/sharedGame/src/shared/objectTemplate/SharedObjectTemplate.cpp`
 *     — `SharedObjectTemplate::load` (line ~2140) — string-param dispatch
 *       lives here. `m_portalLayoutFilename.loadFromIff(file)` (line 2205).
 *   - `~/code/swg-main/src/engine/shared/library/sharedUtility/src/shared/TemplateParameter.cpp`
 *     — `StringParam::loadFromIff` (line ~436) — reads `[int8 dataType]`
 *       then for `SINGLE` a NUL-terminated cstring.
 *   - `~/code/swg-main/src/engine/shared/library/sharedTemplate/src/shared/template/SharedBuildingObjectTemplate.cpp`
 *     — `SharedBuildingObjectTemplate::load` (line ~206) — calls
 *       `SharedTangibleObjectTemplate::load(file)` at the end which in
 *       turn calls `SharedObjectTemplate::load`. The nesting in the .iff
 *       (SBOT → STOT → SHOT) mirrors that call chain.
 *
 * # Public API
 *
 *   - `parseBuildingTemplateInfo(bytes, templateName)` — pure, synchronous.
 *   - `loadBuildingTemplateInfo(templateName)` — async loader that resolves
 *     bytes through the same asset-loader chain as `loadPortalLayout`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Iff } from './iff.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Two-field projection of a SWG SharedObjectTemplate `.iff`. Both fields
 * are `null` when the template does not set them in its own SHOT chunk
 * (the parent template may set them via DERV inheritance — we don't
 * traverse DERV chains here; callers that need the inherited value should
 * fall back via the BUIO baseline's `appearance` field or follow up with
 * a second load of the base template).
 *
 * `templateName` is echoed back as-is for diagnostic / cache-key clarity.
 */
export interface BuildingTemplateInfo {
  /** The caller-supplied template path (e.g. `'object/building/tatooine/shared_cantina_tatooine.iff'`). */
  templateName: string;
  /** Portal-layout `.pob` filename set by this template, or `null`. Empty strings normalize to `null`. */
  portalLayoutFilename: string | null;
  /** Appearance `.msh` / `.apt` filename set by this template, or `null`. Empty strings normalize to `null`. */
  appearanceFilename: string | null;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Parse a SWG SharedObjectTemplate `.iff` and return its
 * `portalLayoutFilename` + `appearanceFilename` fields. Pure; no I/O.
 *
 * Throws if the bytes aren't a SWG object template (e.g. not an IFF, or
 * the outer FORM isn't a known template-class tag). Returns `null` fields
 * for templates that simply don't set the value — that's NOT an error.
 *
 * `templateName` is stamped onto the returned struct for caller diagnostics
 * and (in `BuildingKB`) doubles as the cache key.
 */
export function parseBuildingTemplateInfo(
  bytes: Uint8Array,
  templateName: string,
): BuildingTemplateInfo {
  const iff = Iff.fromBytes(bytes, templateName);
  if (iff.atEndOfForm()) {
    throw new Error(`parseBuildingTemplateInfo[${templateName}]: empty file`);
  }
  if (!iff.isCurrentForm()) {
    throw new Error(
      `parseBuildingTemplateInfo[${templateName}]: top-level block is not a FORM (got chunk '${iff.getCurrentName()}')`,
    );
  }

  const harvested = {
    portalLayoutFilename: null as string | null,
    appearanceFilename: null as string | null,
  };
  // Pass the harvest collector down through the depth-first FORM walk. We
  // accept ANY outer template-class tag (SBOT / STOT / SHOT / etc.) — the
  // walker descends until it finds the SHOT-level PCNT+XXXX block that
  // carries our two fields of interest.
  walkTemplate(iff, harvested, templateName);

  return {
    templateName,
    portalLayoutFilename: normalizeFilename(harvested.portalLayoutFilename),
    appearanceFilename: normalizeFilename(harvested.appearanceFilename),
  };
}

/**
 * Async loader: resolve a `templateName` (e.g.
 * `'object/building/tatooine/shared_cantina_tatooine.iff'`) to a parsed
 * `BuildingTemplateInfo` using the same priority chain as `loadPortalLayout`:
 *
 *   1. `<cwd>/assets/<templateName>`
 *   2. `<cwd>/../swg-main/data/sku.0/sys.shared/compiled/game/<templateName>`
 *   3. The configured TRE archive entry `<templateName>`
 *
 * Throws (or returns a rejecting promise) on file-not-found or malformed
 * bytes. The `BuildingKB` cache evicts the failed promise so a retry can
 * succeed.
 */
export async function loadBuildingTemplateInfo(
  templateName: string,
): Promise<BuildingTemplateInfo> {
  const bytes = await defaultLoadFile(templateName);
  return parseBuildingTemplateInfo(bytes, templateName);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * `StringParam::DataTypeId` from `TemplateParameter.h:73-80`. We only act
 * on `SINGLE` (the common case for filenames); `NONE` means "not set" and
 * leaves the field at its inherited / default value; the other three are
 * legal for numeric / weighted params but never appear for string fields.
 *
 * Modelled as a numeric union rather than a `const enum` so the project's
 * `isolatedModules` mode is happy.
 */
const DATA_TYPE_SINGLE = 1;

/** Param names this reader extracts. Anything else is skipped. */
const PARAM_PORTAL_LAYOUT = 'portalLayoutFilename';
const PARAM_APPEARANCE = 'appearanceFilename';

/**
 * Depth-first walk over the template's FORM tree, harvesting our two
 * string params from any PCNT+XXXX param-table form we find.
 *
 * The cursor must be positioned at a FORM block on entry. On exit the
 * cursor sits just past that FORM (its parent's `used` is advanced).
 */
function walkTemplate(
  iff: Iff,
  out: { portalLayoutFilename: string | null; appearanceFilename: string | null },
  sourceName: string,
): void {
  const outerName = iff.enterAnyForm();

  // DERV holds the base-template path — a single chunk we don't need.
  // Skip it wholesale; any nested DERV at deeper levels is treated the
  // same way by the generic FORM walker below.
  // Param-table forms have tags that are 4-digit version strings ("0001",
  // "0010", etc.). The C++ parser identifies them by the leaf class
  // calling `enterForm()` then reading PCNT — we identify them the same
  // way: try to enter the next FORM, see if it carries a PCNT chunk.
  while (!iff.atEndOfForm()) {
    if (!iff.isCurrentForm()) {
      // A chunk at this level isn't part of any template-class form we
      // know how to interpret. Skip it (read into and out of the chunk
      // so the cursor advances).
      const chunkTag = iff.getCurrentName();
      iff.enterChunk(chunkTag);
      iff.exitChunk(chunkTag);
      continue;
    }

    const innerName = iff.enterAnyForm();
    if (innerName === 'DERV') {
      // DERV always wraps a single XXXX chunk with the base template
      // path; we don't need it for this extractor. Drain whatever is
      // inside the DERV form.
      drainCurrentForm(iff);
      iff.exitForm('DERV');
      continue;
    }

    if (isVersionTag(innerName)) {
      // A param-table form (PCNT + XXXX chunks). Process every chunk.
      processParamTable(iff, out, sourceName);
      iff.exitForm(innerName);
      continue;
    }

    // Some other template-class FORM (STOT, SHOT, etc.) — recurse into
    // its inner content. We've already entered it; the recursive call
    // will descend further. To re-use `walkTemplate` we need to NOT
    // re-enter; instead inline the walk over its body and exit when
    // done. Simpler: just keep walking the body of this inner form
    // (same loop, same logic) by recursing on the iff state.
    walkInnerFormBody(iff, out, sourceName);
    iff.exitForm(innerName);
  }

  iff.exitForm(outerName);
}

/**
 * Walk the body of a nested FORM (DERV-or-version-or-class-FORM child
 * of an outer template class FORM). Mirrors the body of `walkTemplate`
 * minus the outer enter/exit pair, since the caller has already entered.
 */
function walkInnerFormBody(
  iff: Iff,
  out: { portalLayoutFilename: string | null; appearanceFilename: string | null },
  sourceName: string,
): void {
  while (!iff.atEndOfForm()) {
    if (!iff.isCurrentForm()) {
      const chunkTag = iff.getCurrentName();
      iff.enterChunk(chunkTag);
      iff.exitChunk(chunkTag);
      continue;
    }
    const innerName = iff.enterAnyForm();
    if (innerName === 'DERV') {
      drainCurrentForm(iff);
      iff.exitForm('DERV');
    } else if (isVersionTag(innerName)) {
      processParamTable(iff, out, sourceName);
      iff.exitForm(innerName);
    } else {
      walkInnerFormBody(iff, out, sourceName);
      iff.exitForm(innerName);
    }
  }
}

/**
 * Drain every block under the active form (skipping past them without
 * interpreting their contents). Used to no-op past DERV bodies and to
 * tolerate unknown forms we don't care about.
 */
function drainCurrentForm(iff: Iff): void {
  while (!iff.atEndOfForm()) {
    if (iff.isCurrentForm()) {
      const tag = iff.enterAnyForm();
      drainCurrentForm(iff);
      iff.exitForm(tag);
    } else {
      const tag = iff.getCurrentName();
      iff.enterChunk(tag);
      iff.exitChunk(tag);
    }
  }
}

/**
 * Process a param-table form: PCNT chunk (declares the param count) + N
 * XXXX chunks (one per param). For each XXXX chunk, read the param name;
 * if it's one of our two interesting params, harvest the value.
 *
 * Cursor must be positioned inside the version FORM on entry; on exit
 * the cursor sits at the version FORM's end (`atEndOfForm() === true`).
 */
function processParamTable(
  iff: Iff,
  out: { portalLayoutFilename: string | null; appearanceFilename: string | null },
  sourceName: string,
): void {
  // PCNT carries the declared param count. We don't strictly need it
  // since we loop until `atEndOfForm`, but reading it advances the
  // cursor past the chunk and lets us sanity-check.
  if (iff.atEndOfForm() || !iff.isCurrentChunk()) return;
  const firstTag = iff.getCurrentName();
  if (firstTag !== 'PCNT') {
    // Some param-table forms might use a different first chunk; skip and
    // process the rest as best we can rather than throwing.
    return;
  }
  iff.enterChunk('PCNT');
  // `paramCount` is informational here — we trust the form-length framing.
  void iff.readI32();
  iff.exitChunk('PCNT');

  while (!iff.atEndOfForm()) {
    if (iff.isCurrentForm()) {
      // Unexpected — param tables are flat chunks. Skip the form.
      const tag = iff.enterAnyForm();
      drainCurrentForm(iff);
      iff.exitForm(tag);
      continue;
    }
    const chunkTag = iff.getCurrentName();
    // C++ writes every param as an XXXX chunk; tolerate other names by
    // skipping them rather than crashing.
    iff.enterChunk(chunkTag);
    if (chunkTag === 'XXXX') {
      readOneParam(iff, out, sourceName);
    }
    // `exitChunk(tag, true)` style — drain whatever the param-reader
    // didn't consume so we always leave the chunk cleanly.
    iff.exitChunk(chunkTag);
  }
}

/**
 * Read one XXXX param chunk. Cursor is INSIDE the chunk on entry; on
 * exit may have unconsumed bytes (caller's `exitChunk` handles that).
 *
 * Layout:
 *   [paramName NUL-cstring]
 *   [int8 dataType]
 *   [dataType-specific payload — for SINGLE/string, one NUL-cstring]
 */
function readOneParam(
  iff: Iff,
  out: { portalLayoutFilename: string | null; appearanceFilename: string | null },
  sourceName: string,
): void {
  const paramName = iff.readString();
  if (paramName !== PARAM_PORTAL_LAYOUT && paramName !== PARAM_APPEARANCE) {
    // Not one of ours; don't try to interpret the rest of the chunk —
    // the param type might be anything. Just bail; the outer `exitChunk`
    // drains the rest.
    return;
  }
  // For the two filename params we know they're StringParams, so the
  // payload is `[int8 dataType][cstring? value]`.
  if (iff.getChunkLengthLeft() < 1) {
    // Truncated — defensively return rather than throw so a malformed
    // template doesn't poison the entire navigate path.
    return;
  }
  const dataType = iff.readU8();
  if (dataType !== DATA_TYPE_SINGLE) {
    // NONE (=0) → unset. Anything else would be unusual for a filename
    // field and we deliberately don't try to interpret it.
    return;
  }
  // The remaining bytes are a NUL-terminated cstring — `readString`
  // reads to the next NUL. The reader's `readString` is permissive about
  // EOF (throws), so make sure we have at least 1 byte (the NUL).
  if (iff.getChunkLengthLeft() < 1) {
    throw new Error(
      `parseBuildingTemplateInfo[${sourceName}]: truncated string for param '${paramName}'`,
    );
  }
  const value = iff.readString();
  if (paramName === PARAM_PORTAL_LAYOUT) {
    out.portalLayoutFilename = value;
  } else {
    out.appearanceFilename = value;
  }
}

/**
 * True for FORM tags that are param-table version markers (`'0001'`,
 * `'0010'`, etc.). These are 4-char strings of ASCII digits.
 */
function isVersionTag(tag: string): boolean {
  if (tag.length !== 4) return false;
  for (let i = 0; i < 4; ++i) {
    const c = tag.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

/** Empty filenames normalize to `null` so callers can use `?? fallback`. */
function normalizeFilename(s: string | null): string | null {
  if (s === null) return null;
  if (s.length === 0) return null;
  return s;
}

/**
 * Default asset loader for object-template `.iff` files. Walks the same
 * priority list as `loadPortalLayout`:
 *
 *   1. extracted-on-disk under `<cwd>/assets/<templateName>`
 *   2. extracted-on-disk under
 *      `<cwd>/../swg-main/data/sku.0/sys.shared/compiled/game/<templateName>`
 *      (the standard SOE shared-data tree the swg-main repo ships with)
 *   3. the TRE archive entry — best effort; if no TRE is configured we
 *      throw "asset missing" rather than "TRE missing".
 *
 * Lazy-imports TRE bits so the parser stays usable without an archive
 * configured (tests + offline tooling).
 */
async function defaultLoadFile(templateName: string): Promise<Uint8Array> {
  const localAsset = join(process.cwd(), 'assets', templateName);
  if (existsSync(localAsset)) return readFileSync(localAsset);

  const siblingExtract = join(
    process.cwd(),
    '..',
    'swg-main',
    'data',
    'sku.0',
    'sys.shared',
    'compiled',
    'game',
    templateName,
  );
  if (existsSync(siblingExtract)) return readFileSync(siblingExtract);

  try {
    const { getTreReader, resolveDefaultTrePath } = await import('../terrain/asset-loader.js');
    const trePath = resolveDefaultTrePath();
    const reader = getTreReader(trePath);
    if (reader.exists(templateName)) {
      return reader.read(templateName);
    }
  } catch {
    // No TRE configured. Fall through to the throw below.
  }

  throw new Error(`loadBuildingTemplateInfo: no asset found for '${templateName}'`);
}
