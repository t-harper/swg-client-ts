/**
 * Tests for `parsePortalLayout` — the `.pob` portal-layout IFF reader.
 *
 * Three layers of coverage:
 *
 *   1. **Fixture assertions** against the real Mos Eisley cantina .pob
 *      (`tests/fixtures/portal-layout-cantina-tatooine.pob`, copied from
 *      `~/code/swg-main/serverdata/appearance/thm_tato_cantina.pob`).
 *      Verifies the high-level shape — 17 portals, 16 cells, named cells.
 *   2. **Golden-byte assertions** on the first cell's first portal's
 *      `doorPosition` — sourced from the same fixture. If the .pob parser
 *      ever drifts from the C++ ground truth, this catches it as a literal
 *      coordinate mismatch.
 *   3. **Round-trip** via `IffWriter`: programmatically build a 2-cell /
 *      1-portal layout, serialize, re-parse, and confirm every observable
 *      field round-trips. This is the wire-format regression guard.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IffWriter } from './iff.js';
import { parsePortalLayout } from './portal-layout-reader.js';

const FIXTURE_PATH = join(process.cwd(), 'tests', 'fixtures', 'portal-layout-cantina-tatooine.pob');

// ---------------------------------------------------------------------------
// Fixture-based tests
// ---------------------------------------------------------------------------
//
// Project rule: skip paths are errors EXCEPT the outer runner gate. We
// gate via `describe.skipIf(!fixturePresent)` so a missing fixture
// surfaces as a runner-level skip rather than a silent pass; if the
// fixture IS present every assertion runs.

describe.skipIf(!existsSync(FIXTURE_PATH))('parsePortalLayout — cantina fixture', () => {
  // Loaded once; every test below reads the same parsed layout.
  const bytes = existsSync(FIXTURE_PATH) ? readFileSync(FIXTURE_PATH) : new Uint8Array(0);

  it('parses the outer PRTO/0003 envelope', () => {
    const layout = parsePortalLayout(bytes, 'cantina');
    expect(layout.version).toBe('0003');
    expect(layout.sourceName).toBe('cantina');
  });

  it('extracts 17 portal geometries and 16 cells (exterior + 15 interior)', () => {
    const layout = parsePortalLayout(bytes, 'cantina');
    expect(layout.geometries).toHaveLength(17);
    expect(layout.cells).toHaveLength(16);
  });

  it('every portal geometry is a 4-vertex quad', () => {
    const layout = parsePortalLayout(bytes, 'cantina');
    for (let i = 0; i < layout.geometries.length; ++i) {
      const g = layout.geometries[i];
      expect(g, `geometry ${i}`).toBeDefined();
      expect(g?.vertices, `geometry ${i} vertices`).toHaveLength(4);
    }
  });

  it('cell 0 is the exterior with two outward portals (front + back entrances)', () => {
    const layout = parsePortalLayout(bytes, 'cantina');
    const exterior = layout.cells[0];
    expect(exterior).toBeDefined();
    expect(exterior?.index).toBe(0);
    expect(exterior?.name).toBe('r0'); // canonical exterior cell name in v0004+ files
    expect(exterior?.portals).toHaveLength(2);
    // The two exterior portals target named interior cells (front foyer +
    // back entrance) — they should be passable + enabled.
    for (const p of exterior?.portals ?? []) {
      expect(p.passable).toBe(true);
      expect(p.disabled).toBe(false);
      expect(p.targetCellIndex).toBeGreaterThan(0);
    }
  });

  it('preserves authored cell names (cantina v0005 carries names on the wire)', () => {
    const layout = parsePortalLayout(bytes, 'cantina');
    // Pick a couple of representative interior cells the cantina is famous
    // for. The exact set is part of the wire-format regression check.
    const cantinaCell = layout.cells.find((c) => c.name === 'cantina');
    expect(cantinaCell, 'must have a cell named "cantina"').toBeDefined();
    expect(cantinaCell?.portals.length).toBeGreaterThan(0);

    const stageCell = layout.cells.find((c) => c.name === 'stage');
    expect(stageCell, 'must have a cell named "stage"').toBeDefined();
  });

  it('cell graph is symmetric: every portal has a matching reverse in the target cell', () => {
    const layout = parsePortalLayout(bytes, 'cantina');
    for (const cell of layout.cells) {
      for (const portal of cell.portals) {
        const targetCell = layout.cells[portal.targetCellIndex];
        expect(
          targetCell,
          `cell ${cell.index} portal target ${portal.targetCellIndex}`,
        ).toBeDefined();
        const reverse = targetCell?.portals.find(
          (p) => p.geometryIndex === portal.geometryIndex && p.targetCellIndex === cell.index,
        );
        expect(
          reverse,
          `cell ${cell.index}→${portal.targetCellIndex} (geom ${portal.geometryIndex}) missing reverse`,
        ).toBeDefined();
      }
    }
  });

  // Golden bytes — the first cell's first portal's doorPosition. These
  // numbers come straight from the fixture's PRTL v0004 chunk; any drift
  // here means the parser is reading the wrong bytes. `toBeCloseTo` with
  // 1e-4 precision absorbs the f32 → f64 rounding (4 significant digits
  // post-decimal is plenty for "stand inside this cell" semantics).
  it('golden-byte: cell 0 portal 0 doorPosition matches the on-disk hardpoint', () => {
    const layout = parsePortalLayout(bytes, 'cantina');
    const portal = layout.cells[0]?.portals[0];
    expect(portal).toBeDefined();
    // Hardpoint observed by the smoke parser when this fixture was first
    // copied from `~/code/swg-main/serverdata/appearance/thm_tato_cantina.pob`.
    expect(portal?.doorPosition.x).toBeCloseTo(47.80055618286133, 4);
    expect(portal?.doorPosition.y).toBeCloseTo(0.10134533047676086, 4);
    expect(portal?.doorPosition.z).toBeCloseTo(-3.6978752613067627, 4);
    // And the underlying transform's position column should match exactly.
    expect(portal?.doorTransform).not.toBeNull();
    expect(portal?.doorTransform?.position.x).toBeCloseTo(47.80055618286133, 4);
  });
});

// ---------------------------------------------------------------------------
// IffWriter → parsePortalLayout round-trip
// ---------------------------------------------------------------------------
//
// Build the smallest possible legal PRTO programmatically so we can prove
// the parser handles every byte we emit. This is the wire-format regression
// guard: an accidental change to the on-disk shape will surface here.

describe('parsePortalLayout — IffWriter round-trip', () => {
  /**
   * Build a minimal 2-cell, 1-portal PRTO/0003 with:
   *   - 1 portal geometry (cell 0 ↔ cell 1, the standard exterior+interior pair)
   *   - cell 0 (exterior) with PRTL v0003 entry → cell 1
   *   - cell 1 (interior) with PRTL v0003 entry → cell 0
   *
   * v0003 is used because (a) it's the most common in serverdata, (b) it
   * has the door style string, and (c) it does NOT have door hardpoints,
   * letting us prove the geometry-center fallback for `doorPosition`.
   *
   * Cells are CELL v0003 (matching what `PortalPropertyTemplateCell::load_0003`
   * expects: numPortals, canSeeParentCell, appearanceName, hasFloor, optional
   * floorName, plus a trailing LGHT chunk with 0 lights).
   */
  function buildTinyPob(): Uint8Array {
    const w = new IffWriter();
    w.insertForm('PRTO');
    w.insertForm('0003');

    // DATA: 1 portal, 2 cells.
    w.insertChunk('DATA').writeI32(1).writeI32(2).exitChunk();

    // PRTS: 1 portal geometry — a unit-square quad in the XY plane at z=0.
    w.insertForm('PRTS');
    w.insertChunk('PRTL').writeI32(4);
    // 4 vertices of a 2×2 quad centered on the origin
    w.writeF32(-1).writeF32(0).writeF32(0);
    w.writeF32(-1).writeF32(2).writeF32(0);
    w.writeF32(1).writeF32(2).writeF32(0);
    w.writeF32(1).writeF32(0).writeF32(0);
    w.exitChunk();
    w.exitForm(); // PRTS

    // CELS: 2 cells.
    w.insertForm('CELS');

    // Cell 0 (exterior) — name in CELL v0001..v0003 is synthesized as
    // `old_<index>`, so the appearanceName field is just bookkeeping.
    w.insertForm('CELL').insertForm('0003');
    w.insertChunk('DATA');
    w.writeI32(1) /* numPortals */
      .writeBool(false) /* canSeeParentCell */
      .writeString('appearance/_default.apt') /* appearanceName */
      .writeBool(false); /* hasFloor */
    w.exitChunk();
    // Portal entry: PRTL v0003 = passable, geomIdx=0, windingClockwise=true, targetCell=1, doorStyle=''
    w.insertForm('PRTL').insertChunk('0003');
    w.writeBool(true) /* passable */
      .writeI32(0) /* geometryIndex */
      .writeBool(true) /* windingClockwise */
      .writeI32(1) /* targetCellIndex */
      .writeString(''); /* doorStyle */
    w.exitChunk();
    w.exitForm(); // PRTL
    // Trailing LGHT (required by v0003+ even when empty).
    w.insertChunk('LGHT').writeI32(0).exitChunk();
    w.exitForm(); // 0003
    w.exitForm(); // CELL

    // Cell 1 (interior) — points back at cell 0 with the same geometry.
    w.insertForm('CELL').insertForm('0003');
    w.insertChunk('DATA');
    w.writeI32(1).writeBool(true).writeString('appearance/_interior.apt').writeBool(false);
    w.exitChunk();
    w.insertForm('PRTL').insertChunk('0003');
    w.writeBool(true).writeI32(0).writeBool(false).writeI32(0).writeString('door_basic');
    w.exitChunk();
    w.exitForm(); // PRTL
    w.insertChunk('LGHT').writeI32(0).exitChunk();
    w.exitForm(); // 0003
    w.exitForm(); // CELL

    w.exitForm(); // CELS
    w.exitForm(); // 0003
    w.exitForm(); // PRTO
    return w.toBytes();
  }

  it('round-trips a programmatically-built minimal layout', () => {
    const bytes = buildTinyPob();
    const layout = parsePortalLayout(bytes, '<round-trip>');

    expect(layout.version).toBe('0003');
    expect(layout.sourceName).toBe('<round-trip>');
    expect(layout.geometries).toHaveLength(1);
    expect(layout.cells).toHaveLength(2);
  });

  it('round-trips the single portal geometry verbatim', () => {
    const layout = parsePortalLayout(buildTinyPob());
    const geo = layout.geometries[0];
    expect(geo).toBeDefined();
    expect(geo?.vertices).toEqual([
      { x: -1, y: 0, z: 0 },
      { x: -1, y: 2, z: 0 },
      { x: 1, y: 2, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]);
    // Center is the arithmetic mean: ((-1-1+1+1)/4, (0+2+2+0)/4, 0).
    expect(geo?.center).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('round-trips per-cell portal metadata + falls back doorPosition to geometry.center when no hardpoint', () => {
    const layout = parsePortalLayout(buildTinyPob());

    const cell0 = layout.cells[0];
    expect(cell0).toBeDefined();
    expect(cell0?.index).toBe(0);
    // v0003 cells DON'T carry a cell-name on the wire; the parser synthesizes `old_<index>`.
    expect(cell0?.name).toBe('old_0');
    expect(cell0?.portals).toHaveLength(1);
    const p0 = cell0?.portals[0];
    expect(p0?.passable).toBe(true);
    expect(p0?.disabled).toBe(false);
    expect(p0?.windingClockwise).toBe(true);
    expect(p0?.targetCellIndex).toBe(1);
    expect(p0?.doorStyle).toBe('');
    // No hardpoint in PRTL v0003 → doorPosition is the geometry's center.
    expect(p0?.doorTransform).toBeNull();
    expect(p0?.doorPosition).toEqual({ x: 0, y: 1, z: 0 });

    const cell1 = layout.cells[1];
    expect(cell1?.name).toBe('old_1');
    expect(cell1?.portals[0]?.targetCellIndex).toBe(0);
    expect(cell1?.portals[0]?.windingClockwise).toBe(false);
    expect(cell1?.portals[0]?.doorStyle).toBe('door_basic');
  });

  it('throws if numVerts is not 4', () => {
    // Build a malformed PRTL with 3 vertices — should fail at parse time.
    const w = new IffWriter();
    w.insertForm('PRTO').insertForm('0003');
    w.insertChunk('DATA').writeI32(1).writeI32(1).exitChunk();
    w.insertForm('PRTS').insertChunk('PRTL').writeI32(3);
    w.writeF32(0).writeF32(0).writeF32(0);
    w.writeF32(1).writeF32(0).writeF32(0);
    w.writeF32(0).writeF32(1).writeF32(0);
    w.exitChunk();
    w.exitForm(); // PRTS
    // The cells form isn't important here — we'll throw before reaching it.
    w.insertForm('CELS').exitForm();
    w.exitForm().exitForm();
    expect(() => parsePortalLayout(w.toBytes(), 'bad')).toThrow(/numVerts=3, expected 4/);
  });

  it('throws on unsupported PRTO version', () => {
    const w = new IffWriter();
    w.insertForm('PRTO').insertForm('9999');
    w.insertChunk('DATA').writeI32(0).writeI32(1).exitChunk();
    w.insertForm('PRTS').exitForm();
    w.insertForm('CELS').exitForm();
    w.exitForm().exitForm();
    expect(() => parsePortalLayout(w.toBytes(), 'bad-version')).toThrow(
      /unsupported PRTO version '9999'/,
    );
  });

  it('throws when geometry index is out of range', () => {
    // 1 geometry but cell 0 references geometryIndex=5.
    const w = new IffWriter();
    w.insertForm('PRTO').insertForm('0003');
    w.insertChunk('DATA').writeI32(1).writeI32(2).exitChunk();
    w.insertForm('PRTS').insertChunk('PRTL').writeI32(4);
    for (let i = 0; i < 12; ++i) w.writeF32(0);
    w.exitChunk();
    w.exitForm(); // PRTS
    w.insertForm('CELS');
    // Cell 0 with one portal pointing at geometry index 5 (out of bounds).
    w.insertForm('CELL').insertForm('0003');
    w.insertChunk('DATA')
      .writeI32(1)
      .writeBool(false)
      .writeString('a')
      .writeBool(false)
      .exitChunk();
    w.insertForm('PRTL').insertChunk('0003');
    w.writeBool(true).writeI32(5).writeBool(true).writeI32(1).writeString('');
    w.exitChunk();
    w.exitForm(); // PRTL
    w.insertChunk('LGHT').writeI32(0).exitChunk();
    w.exitForm().exitForm(); // 0003, CELL
    // Add a second cell so numCells=2 is satisfied.
    w.insertForm('CELL').insertForm('0003');
    w.insertChunk('DATA')
      .writeI32(0)
      .writeBool(false)
      .writeString('b')
      .writeBool(false)
      .exitChunk();
    w.insertChunk('LGHT').writeI32(0).exitChunk();
    w.exitForm().exitForm();
    w.exitForm(); // CELS
    w.exitForm().exitForm();
    expect(() => parsePortalLayout(w.toBytes(), 'oob')).toThrow(
      /references geometry 5 out of \[0, 1\)/,
    );
  });
});
