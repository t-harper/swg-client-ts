/**
 * `.pob` (portal-layout) IFF reader.
 *
 * # What this is
 *
 * A SWG portal-layout file describes the cell graph of an interior building:
 * which cells exist (cell 0 is always the exterior), which portals connect
 * them, the portal geometries (4-vertex quads in cell-local space), and the
 * door style + hardpoint for each portal. The runtime client uses this data
 * to portal-cull rendering and to resolve which cell a given world position
 * belongs to. For the bot framework we use it for the second purpose only:
 * the server requires `CM_netUpdateTransformWithParent` with a cell-local
 * position that is *inside* the cell's portal footprint, so we need to know
 * the door's cell-local coordinates to walk through it.
 *
 * # Wire format (verified against the C++ ground truth)
 *
 * The whole file is a SOE IFF (`src/iff/iff.ts`). The outer envelope is:
 *
 *   FORM PRTO
 *     FORM <version 0000|0001|0002|0003|0004>
 *       DATA chunk    [int32 numPortals][int32 numCells]
 *       FORM PRTS     portal geometries
 *         CHUNK PRTL  [int32 numVerts=4][float×3 × 4]    (v0000-0003)
 *         FORM IDTL   IndexedTriangleList                (v0004; not needed by us)
 *         ... (numPortals total)
 *       FORM CELS     numCells × FORM CELL
 *         FORM CELL
 *           FORM <cell version 0001..0005>
 *             DATA chunk (cell metadata; shape varies by version)
 *             (optional FORM EXTN collision extent — v0005 only)
 *             per-portal FORM PRTL nested data
 *             CHUNK LGHT (lights; skipped — we don't render)
 *       (optional FORM PGRF building path graph — skipped, we have BFS)
 *       (optional CHUNK CRC — versions 0001+; informational only)
 *
 * # C++ ground truth
 *
 *   - `~/code/swg-main/src/engine/shared/library/sharedObject/src/shared/portal/PortalPropertyTemplate.cpp`
 *     The canonical parser. We implement versions 0000..0003 of the outer
 *     PRTO (and 0000 has no CRC chunk; 0001+ does), plus cell versions
 *     0001..0005, plus portal versions 0001..0005. v0004 of the OUTER
 *     wraps each portal geometry in an `IndexedTriangleList(iff)` form
 *     instead of the simple `PRTL chunk(numVerts, verts)` quad — we don't
 *     handle that yet (no .pob in `~/code/swg-main/serverdata/appearance/`
 *     uses it, and our use case is interior buildings that ship as v0003).
 *   - `~/code/swg-main/src/engine/shared/library/sharedObject/src/shared/portal/PortalProperty.cpp`
 *     The runtime user — `findContainingCell` is what the server calls when
 *     handling `CM_netUpdateTransformWithParent`. Our `doorPosition` value
 *     has to be inside the target cell's floor extents for the server to
 *     accept the cell change; the .pob's quad center is the closest thing
 *     to a known-good door midpoint, and the optional `doorHardpoint`
 *     (versions 0004+ of PRTL) gives an even better one when present.
 *   - `~/code/swg-main/src/engine/shared/library/sharedFile/src/shared/Iff.cpp:1495`
 *     `read_floatTransform()` reads 12 floats row-major as a 3×4 matrix
 *     `matrix[3][4]`. Position lives at `matrix[0..2][3]` (the last column
 *     of each row) per `Transform::getPosition_p()`.
 *
 * # Public API
 *
 *   - `parsePortalLayout(bytes, sourceName?)` — pure, synchronous.
 *   - `loadPortalLayout(filename)` — async loader that resolves bytes
 *     through the same asset-loader chain `StringKB` uses (extracted on
 *     disk first, then the TRE archive).
 *
 * Both throw with a contextual message on malformed input. Caller decides
 * fallback (the navigate path falls back to today's outdoor-anchor walk).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Vector3 } from '../types.js';
import { Iff } from './iff.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One portal geometry — a 4-vertex coplanar quad in cell-local coordinates.
 *
 * SWG portals are always quads (the C++ parser's `validateCoplanar` debug
 * check warns if any vertex is more than 1mm off the plane through the
 * first three). The same geometry is referenced by two cell endpoints —
 * the portal is stored once in the file's top-level `PRTS` list and indexed
 * from each cell's portal entries.
 */
export interface PortalGeometry {
  /** Four cell-relative quad vertices, in the file's on-disk winding order. */
  vertices: readonly [Vector3, Vector3, Vector3, Vector3];
  /**
   * Arithmetic mean of the four vertices — the geometric center of the
   * quad. This is the bot framework's fallback "door midpoint" when a cell
   * portal doesn't have a `doorHardpoint` (i.e. PRTL versions 0001..0003).
   */
  center: Vector3;
}

/**
 * One cell's view of a portal — the per-endpoint metadata that decides
 * how the cell uses this portal.
 *
 * Each portal appears in exactly TWO cells (the two it connects). The C++
 * parser asserts this invariant during load. We surface both endpoints
 * because pathfinding needs both: to walk from cell A to cell B we need
 * cell A's portal entry (for "where do I stand on this side?") and cell
 * B's portal entry (for "where do I appear on the other side?").
 */
export interface CellPortal {
  /** Index into `PortalLayout.geometries`. */
  geometryIndex: number;
  /** The shared geometry the index points to (denormalized for caller convenience). */
  geometry: PortalGeometry;
  /** Cell index this portal opens onto (0 = exterior). */
  targetCellIndex: number;
  /** False means the portal is blocked — e.g. a sealed wall. */
  passable: boolean;
  /** True means the portal exists in the file but is currently inert. */
  disabled: boolean;
  /**
   * Winding-order flag. The same quad geometry is shared between two cells
   * but its "facing" (which side faces inside vs. outside) flips between
   * them. Plane-normal math has to negate when this is false.
   */
  windingClockwise: boolean;
  /** Door style / appearance name (`""` if none). */
  doorStyle: string;
  /**
   * Cell-relative best-guess "door midpoint" position. Pulled from
   * `doorTransform` when the .pob version has hardpoints (PRTL v0004+
   * AND `hasDoorHardpoint=true`), otherwise from `geometry.center`.
   */
  doorPosition: Vector3;
  /**
   * Door transform if the .pob version carries one and the portal flagged
   * it as present, else null. When present it carries both the door's
   * orientation and its position; we expose the raw 12 floats (3×4 matrix)
   * so callers can pull the local frame (right/up/forward) if they want.
   */
  doorTransform: DoorTransform | null;
}

/**
 * 12-float (3×4) door transform as stored on disk. Row-major:
 * `[m00 m01 m02 m03] [m10 m11 m12 m13] [m20 m21 m22 m23]`.
 * Per `Transform::getPosition_p()` the position is `(m03, m13, m23)`.
 */
export interface DoorTransform {
  rows: readonly [
    readonly [number, number, number, number],
    readonly [number, number, number, number],
    readonly [number, number, number, number],
  ];
  /** Convenience: `(rows[0][3], rows[1][3], rows[2][3])`. */
  position: Vector3;
}

/**
 * One cell in the portal layout. Cell 0 is always the exterior — the world
 * outside the building — and it has portals pointing back into each
 * outward-facing interior cell. Cells 1..N are interior cells in the order
 * they were authored. Cell names (`name`) for cells 1..N usually look like
 * `r0` / `r1` / `r2` (with `r0` being the entrance foyer); v0001..v0003
 * .pob files don't carry per-cell names on the wire, so we synthesize
 * `old_N` to match the C++ fallback (`PortalPropertyTemplateCell::load_0001`).
 */
export interface Cell {
  /** Matches the file's authored cell number. */
  index: number;
  /** Cell name (e.g. `r0`, `r5`); fallback `old_<index>` for very old cell versions. */
  name: string;
  /** Portals leaving this cell. Order matches the file. */
  portals: readonly CellPortal[];
}

/** Fully decoded portal layout — the parser's output. */
export interface PortalLayout {
  /** Caller-supplied label (e.g. file path). Used only for diagnostics. */
  sourceName: string;
  /** Outer PRTO form-type tag — `'0000'` through `'0004'`. */
  version: string;
  /** All portal quads in the file, indexed by `CellPortal.geometryIndex`. */
  geometries: readonly PortalGeometry[];
  /** All cells, indexed by `Cell.index`. Always `length >= 1` (cell 0 = exterior). */
  cells: readonly Cell[];
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Parse a `.pob` (portal-layout) file from raw bytes. Pure; no I/O.
 *
 * Throws if the bytes aren't a SWG portal-layout file, if the version isn't
 * recognized, or if any chunk is truncated. The caller can `try` this and
 * fall back to whatever it wants — the navigate path falls back to today's
 * outdoor-anchor walk.
 *
 * `sourceName` is stamped onto the returned layout and on any error
 * messages so multi-file diagnostics stay clear.
 */
export function parsePortalLayout(bytes: Uint8Array, sourceName = '<bytes>'): PortalLayout {
  const iff = Iff.fromBytes(bytes, sourceName);

  iff.enterForm('PRTO');

  // The version sub-FORM tag (`0000`..`0004`) selects the per-version body.
  const version = iff.enterAnyForm();
  if (!SUPPORTED_PRTO_VERSIONS.has(version)) {
    throw new Error(
      `parsePortalLayout[${sourceName}]: unsupported PRTO version '${version}' (supported: ${[...SUPPORTED_PRTO_VERSIONS].join(', ')})`,
    );
  }

  // Per-version: DATA chunk → PRTS form → CELS form → optional trailing
  // PGRF form + CRC chunk (PRTO 0001+). The DATA / PRTS / CELS layout is
  // the same across versions 0000..0003. v0004 changes PRTS to wrap each
  // portal in an `IndexedTriangleList`; we throw rather than silently
  // mis-parse — none of the SWG-Main interior templates use it.
  iff.enterChunk('DATA');
  const numPortals = iff.readI32();
  const numCells = iff.readI32();
  iff.exitChunk('DATA');

  if (numPortals < 0 || numCells < 0) {
    throw new Error(
      `parsePortalLayout[${sourceName}]: negative counts (numPortals=${numPortals}, numCells=${numCells})`,
    );
  }
  if (numCells < 1) {
    throw new Error(
      `parsePortalLayout[${sourceName}]: must have at least 1 cell (exterior), got ${numCells}`,
    );
  }

  const geometries = readPortalGeometries(iff, numPortals, version, sourceName);
  const cells = readCells(iff, numCells, geometries, sourceName);

  // Trailing PGRF / CRC blocks — skip past them so the parser leaves the
  // navigation stack clean. We don't validate the CRC; it's informational.
  // (PortalPropertyTemplate.cpp:1518 reads it as int32; we trust the
  // server's wire baseline rather than relying on offline validation.)

  iff.exitForm(version);
  iff.exitForm('PRTO');

  return {
    sourceName,
    version,
    geometries,
    cells,
  };
}

/**
 * Async loader: resolve a `portalLayoutFilename` (e.g.
 * `'appearance/thm_tato_cantina.pob'`) to a parsed `PortalLayout` using
 * the same priority chain as `StringKB`:
 *
 *   1. `<cwd>/assets/<filename>`
 *   2. `<cwd>/../swg-main/serverdata/<filename>`
 *   3. The configured TRE archive entry `<filename>`
 *
 * Throws (or returns a rejecting promise) on file-not-found, malformed
 * bytes, or unsupported version. The `BuildingKB` cache evicts the
 * failed promise so a retry can succeed.
 */
export async function loadPortalLayout(portalLayoutFilename: string): Promise<PortalLayout> {
  const bytes = await defaultLoadFile(portalLayoutFilename);
  return parsePortalLayout(bytes, portalLayoutFilename);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const SUPPORTED_PRTO_VERSIONS = new Set(['0000', '0001', '0002', '0003']);

/**
 * Cell versions we know how to parse. v0001..v0003 do NOT carry cell
 * names; v0004 / v0005 do.
 */
const SUPPORTED_CELL_VERSIONS = new Set(['0001', '0002', '0003', '0004', '0005']);

/** Portal (PRTL) versions we know how to parse. */
const SUPPORTED_PRTL_VERSIONS = new Set(['0001', '0002', '0003', '0004', '0005']);

function readPortalGeometries(
  iff: Iff,
  numPortals: number,
  prtoVersion: string,
  sourceName: string,
): PortalGeometry[] {
  iff.enterForm('PRTS');
  const geometries: PortalGeometry[] = [];

  if (prtoVersion === '0004') {
    // v0004 wraps each portal in an IndexedTriangleList form, not a simple
    // PRTL chunk. We don't support it yet — fail loudly so callers fall back
    // rather than silently mis-parsing.
    iff.exitForm('PRTS');
    throw new Error(
      `parsePortalLayout[${sourceName}]: PRTO version 0004 wraps portal geometries in IndexedTriangleList — not implemented`,
    );
  }

  for (let i = 0; i < numPortals; ++i) {
    iff.enterChunk('PRTL');
    const numVerts = iff.readI32();
    if (numVerts !== 4) {
      throw new Error(
        `parsePortalLayout[${sourceName}]: portal ${i} has numVerts=${numVerts}, expected 4 (SWG portals are always quads)`,
      );
    }
    const v0 = readVector(iff);
    const v1 = readVector(iff);
    const v2 = readVector(iff);
    const v3 = readVector(iff);
    iff.exitChunk('PRTL');

    geometries.push({
      vertices: [v0, v1, v2, v3],
      center: {
        x: (v0.x + v1.x + v2.x + v3.x) / 4,
        y: (v0.y + v1.y + v2.y + v3.y) / 4,
        z: (v0.z + v1.z + v2.z + v3.z) / 4,
      },
    });
  }
  iff.exitForm('PRTS');
  return geometries;
}

function readCells(
  iff: Iff,
  numCells: number,
  geometries: readonly PortalGeometry[],
  sourceName: string,
): Cell[] {
  iff.enterForm('CELS');
  const cells: Cell[] = [];
  for (let i = 0; i < numCells; ++i) {
    cells.push(readOneCell(iff, i, geometries, sourceName));
  }
  iff.exitForm('CELS');
  return cells;
}

function readOneCell(
  iff: Iff,
  index: number,
  geometries: readonly PortalGeometry[],
  sourceName: string,
): Cell {
  iff.enterForm('CELL');
  const version = iff.enterAnyForm();
  if (!SUPPORTED_CELL_VERSIONS.has(version)) {
    throw new Error(
      `parsePortalLayout[${sourceName}]: cell ${index} has unsupported version '${version}'`,
    );
  }

  // DATA chunk: shape varies by version.
  // v0001:  [int32 numPortals][bool8 canSeeParent][cstring appearanceName]
  // v0002:  v0001 + [bool8 hasFloor][optional cstring floorName]
  // v0003:  same as v0002 (different trailing structures — lights chunk is
  //         present like v0002 except the LGHT chunk is inside the CELL
  //         form rather than after it)
  // v0004:  [int32 numPortals][bool8 canSeeParent][cstring cellName]
  //         [cstring appearanceName][bool8 hasFloor][optional cstring floorName]
  // v0005:  same as v0004 (with a leading collision-extent EXTN form
  //         between DATA and the portals)
  iff.enterChunk('DATA');
  const numPortals = iff.readI32();
  // `canSeeParentCell`: read so the cursor advances; we don't expose it.
  void iff.readBool();
  let cellName: string;
  if (version === '0004' || version === '0005') {
    cellName = iff.readString();
    // `appearanceName` — discard.
    void iff.readString();
  } else {
    // v0001..v0003 do NOT carry a per-cell name on the wire. The C++ code
    // synthesizes `old_<index>` (PortalPropertyTemplateCell::load_0001:633).
    void iff.readString(); // appearanceName
    cellName = `old_${index}`;
  }
  if (version === '0002' || version === '0003' || version === '0004' || version === '0005') {
    const hasFloor = iff.readBool();
    if (hasFloor) {
      // `floorName` — discard.
      void iff.readString();
    }
  }
  iff.exitChunk('DATA');

  // v0005 inserts a collision-extent FORM (ExtentList::create reads any
  // FORM tag it understands — Box, Sphere, Polytope, etc.) BEFORE the
  // portal entries. We don't need it; skip past it as opaque bytes.
  if (version === '0005') {
    skipNextBlock(iff);
  }

  // Per-portal: each is a `FORM PRTL` with a versioned sub-form.
  const portals: CellPortal[] = [];
  for (let i = 0; i < numPortals; ++i) {
    portals.push(readOnePortal(iff, geometries, sourceName, index, i));
  }

  // Trailing LGHT chunk for v0003+ — present even when there are zero
  // lights. v0001 / v0002 don't have it. We skip the chunk regardless
  // since the lights aren't used by the bot framework.
  if (version === '0003' || version === '0004' || version === '0005') {
    if (!iff.atEndOfForm() && iff.getCurrentName() === 'LGHT') {
      skipNextBlock(iff);
    }
  }

  // Skip any other trailing blocks the cell form may carry (forward-compat).
  while (!iff.atEndOfForm()) {
    skipNextBlock(iff);
  }

  iff.exitForm(version);
  iff.exitForm('CELL');
  return { index, name: cellName, portals };
}

function readOnePortal(
  iff: Iff,
  geometries: readonly PortalGeometry[],
  sourceName: string,
  cellIndex: number,
  portalIndex: number,
): CellPortal {
  // PRTL layout per `PortalPropertyTemplateCellPortal::load`:
  //   FORM PRTL → CHUNK <version 0001..0005>
  // i.e. the version tag is a CHUNK (not a FORM-wrapped sub-form like the
  // PRTO / CELL outer envelopes), so we go straight from `enterForm('PRTL')`
  // into `enterChunk(<version>)` without an intermediate `enterAnyForm`.
  iff.enterForm('PRTL');
  if (!iff.isCurrentChunk()) {
    throw new Error(
      `parsePortalLayout[${sourceName}]: cell ${cellIndex} portal ${portalIndex} expected version chunk, got form '${iff.getCurrentName()}'`,
    );
  }
  const version = iff.getCurrentName();
  if (!SUPPORTED_PRTL_VERSIONS.has(version)) {
    throw new Error(
      `parsePortalLayout[${sourceName}]: cell ${cellIndex} portal ${portalIndex} has unsupported PRTL version '${version}'`,
    );
  }
  iff.enterChunk(version);

  // v0001:                  [int32 geomIdx][bool8 wind][int32 targetCell]
  //   disabled = false; passable = true (no flags on wire).
  // v0002:                  [bool8 passable][int32 geomIdx][bool8 wind][int32 targetCell]
  //   disabled = false. Note: v0002 cells flip passable post-parse per
  //   PortalPropertyTemplate::load_0002 — we don't replicate that here
  //   because the only known .pob using v0002 has been re-exported as
  //   v0003 in practice; if we ever see one in the wild we'll add it.
  // v0003:                  v0002 + cstring doorStyle
  // v0004:                  [bool8 passable][int32 geomIdx][bool8 wind][int32 targetCell]
  //                          [cstring doorStyle][bool8 hasHardpoint][12 floats]
  //   disabled = false on the wire (load_0004 doesn't read it).
  // v0005:                  [bool8 disabled][bool8 passable]... rest same as v0004.
  let disabled = false;
  let passable = true;

  if (version === '0005') {
    disabled = iff.readBool();
    passable = iff.readBool();
  } else if (version === '0002' || version === '0003' || version === '0004') {
    passable = iff.readBool();
  }

  const geometryIndex = iff.readI32();
  const windingClockwise = iff.readBool();
  const targetCellIndex = iff.readI32();

  let doorStyle = '';
  let doorTransform: DoorTransform | null = null;
  if (version === '0003' || version === '0004' || version === '0005') {
    doorStyle = iff.readString();
  }
  if (version === '0004' || version === '0005') {
    const hasHardpoint = iff.readBool();
    const matrix = readDoorTransform(iff);
    if (hasHardpoint) {
      doorTransform = matrix;
    }
  }

  iff.exitChunk(version);
  iff.exitForm('PRTL');

  // Bounds-check the geometry index before we dereference.
  if (geometryIndex < 0 || geometryIndex >= geometries.length) {
    throw new Error(
      `parsePortalLayout[${sourceName}]: cell ${cellIndex} portal ${portalIndex} references geometry ${geometryIndex} out of [0, ${geometries.length})`,
    );
  }
  const geometry = geometries[geometryIndex];
  if (geometry === undefined) {
    // Unreachable given the bounds check, but the type system can't tell
    // and `noUncheckedIndexedAccess` insists on a guard.
    throw new Error(`parsePortalLayout[${sourceName}]: missing geometry ${geometryIndex}`);
  }

  // Choose the best available door midpoint:
  //   - explicit hardpoint when the file carries one (matches the C++
  //     `getDoorTransform(true)` path), else
  //   - the quad center (matches the spirit of `getDoorTransform(false)`
  //     which uses `tempBox.getBase()`; we use the quad center because
  //     a true bottom-of-bounding-box requires knowing the world-up axis
  //     in the cell frame, and the center is the most-robust fallback
  //     for "stand here and the server will accept the cell change").
  const doorPosition: Vector3 = doorTransform?.position ?? geometry.center;

  return {
    geometryIndex,
    geometry,
    targetCellIndex,
    passable,
    disabled,
    windingClockwise,
    doorStyle,
    doorPosition,
    doorTransform,
  };
}

function readVector(iff: Iff): Vector3 {
  return { x: iff.readF32(), y: iff.readF32(), z: iff.readF32() };
}

function readDoorTransform(iff: Iff): DoorTransform {
  // Row-major 3×4. Position is `(m03, m13, m23)` per Transform::getPosition_p().
  const m00 = iff.readF32();
  const m01 = iff.readF32();
  const m02 = iff.readF32();
  const m03 = iff.readF32();
  const m10 = iff.readF32();
  const m11 = iff.readF32();
  const m12 = iff.readF32();
  const m13 = iff.readF32();
  const m20 = iff.readF32();
  const m21 = iff.readF32();
  const m22 = iff.readF32();
  const m23 = iff.readF32();
  return {
    rows: [
      [m00, m01, m02, m03],
      [m10, m11, m12, m13],
      [m20, m21, m22, m23],
    ],
    position: { x: m03, y: m13, z: m23 },
  };
}

/**
 * Skip the next block under the current FORM frame (works for either FORM
 * or chunk children). The Iff's `forEachBlock` doesn't quite fit — it
 * iterates ALL children — so we open + immediately close.
 */
function skipNextBlock(iff: Iff): void {
  if (iff.isCurrentForm()) {
    iff.enterAnyForm();
    // Drain whatever is inside.
    while (!iff.atEndOfForm()) {
      skipNextBlock(iff);
    }
    iff.exitForm();
  } else {
    // Chunk — enter and exit to advance the cursor past it.
    const tag = iff.getCurrentName();
    iff.enterChunk(tag);
    iff.exitChunk(tag);
  }
}

/**
 * Default asset loader for `.pob` files. Walks the same priority list as
 * `loadPlanetTrn` in `src/terrain/asset-loader.ts`:
 *   1. extracted-on-disk under `<cwd>/assets/`
 *   2. extracted-on-disk under the sibling `swg-main` server-data tree
 *   3. the TRE archive entry — best effort; if no TRE is configured we
 *      just throw "asset missing" rather than "TRE missing".
 *
 * Lazy-imports TRE bits so the parser stays usable without an archive
 * configured (tests + offline tooling).
 */
async function defaultLoadFile(portalLayoutFilename: string): Promise<Uint8Array> {
  const localAsset = join(process.cwd(), 'assets', portalLayoutFilename);
  if (existsSync(localAsset)) return readFileSync(localAsset);

  const siblingExtract = join(process.cwd(), '..', 'swg-main', 'serverdata', portalLayoutFilename);
  if (existsSync(siblingExtract)) return readFileSync(siblingExtract);

  try {
    const { getTreReader, resolveDefaultTrePath } = await import('../terrain/asset-loader.js');
    const trePath = resolveDefaultTrePath();
    const reader = getTreReader(trePath);
    if (reader.exists(portalLayoutFilename)) {
      return reader.read(portalLayoutFilename);
    }
  } catch {
    // No TRE configured. Fall through to the throw below.
  }

  throw new Error(`loadPortalLayout: no asset found for '${portalLayoutFilename}'`);
}
