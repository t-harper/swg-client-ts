/**
 * Tests for `Layer` — the recursive composition node of the procedural
 * terrain generator.
 *
 * Coverage:
 *   - Constructed layer (no IFF): boundary mask gates affectors so cells
 *     inside the circle get the constant height and cells outside stay 0.
 *   - Inactive layer / inactive boundary / inactive affector: no-op.
 *   - `invertBoundaries`: inverts the mask (outside cells get the height).
 *   - Sub-layer recursion: parent gate × sub-layer gate compose multiplicatively.
 *   - IFF round-trip: LAYR > 0002 with an ADTA chunk, a child boundary, and
 *     a child affector; verify the loaded layer matches what was written.
 */

import { describe, expect, it } from 'vitest';
import { Iff, IffWriter } from '../../../iff/iff.js';
import {
  type GeneratorChunkData, type IFractalGroup, type IMultiFractal,
  type ITerrainGenerator, type ILayer,
  Array2d,
  FeatherFunction, Operation,
} from '../types.js';
import { BoundaryCircle } from '../boundary/circle.js';
import { BoundaryRectangle } from '../boundary/rectangle.js';
import { AffectorHeightConstant } from '../affector/height-constant-terrace.js';
import { Layer } from './layer.js';

// ─────────────────────────────────────────────────────────────────────────
// Test scaffolding
// ─────────────────────────────────────────────────────────────────────────

/** Bare-minimum `IFractalGroup` for tests that don't touch fractals. */
class EmptyFractalGroup implements IFractalGroup {
  getFamilyMultiFractal(_id: number): IMultiFractal | null { return null; }
  getFamilyName(_id: number): string | null { return null; }
  getNumberOfFamilies(): number { return 0; }
  getFamilyId(_index: number): number { return 0; }
  hasFamily(_id: number): boolean { return false; }
}

/** Minimal `ITerrainGenerator` used by `Layer.load`. */
class StubTerrainGenerator implements ITerrainGenerator {
  fractalGroup: IFractalGroup = new EmptyFractalGroup();
  layers: readonly ILayer[] = [];
  generateChunk(_chunkData: GeneratorChunkData): void { /* no-op */ }
}

/**
 * Build a 5-pole × 5-pole chunk centered on the origin. World extent is
 * `[-5, -5] .. [3, 3]` (8 m wide, 2 m between poles, 5 poles → indices
 * 0..4 map to world coordinates {-5, -3, -1, 1, 3}). The 25 poles laid
 * out as `(worldX, worldZ)`:
 *
 *      x: -5  -3  -1   1   3        z:
 *       . . . . .                   -5  (zi=0)
 *       . . . . .                   -3  (zi=1)
 *       . . X . .                   -1  (zi=2)   center column of mask
 *       . . . . .                    1  (zi=3)
 *       . . . . .                    3  (zi=4)
 */
function makeChunk(): GeneratorChunkData {
  const numberOfPoles = 5;
  const distanceBetweenPoles = 2;
  return {
    originOffset: 0,
    numberOfPoles,
    upperPad: 0,
    distanceBetweenPoles,
    start: { x: -5, y: 0, z: -5 },
    heightMap: new Array2d<number>(numberOfPoles, numberOfPoles, 0),
    vertexPositionMap: null,
    vertexNormalMap: null,
    excludeMap: new Array2d<boolean>(numberOfPoles, numberOfPoles, false),
    passableMap: new Array2d<boolean>(numberOfPoles, numberOfPoles, true),
    fractalGroup: new EmptyFractalGroup(),
    normalsDirty: false,
    chunkExtent: { x0: -5, z0: -5, x1: 3, z1: 3 },
  };
}

/** Pretty-print the heightMap as a 5×5 grid for easier debugging on failure. */
function dumpHeights(chunkData: GeneratorChunkData): number[][] {
  const out: number[][] = [];
  for (let z = 0; z < chunkData.numberOfPoles; z++) {
    const row: number[] = [];
    for (let x = 0; x < chunkData.numberOfPoles; x++) {
      row.push(chunkData.heightMap.get(x, z));
    }
    out.push(row);
  }
  return out;
}

/** Distance from a pole index to world origin, given the chunk in `makeChunk`. */
function poleDistanceFromOrigin(x: number, z: number): number {
  const wx = -5 + x * 2;
  const wz = -5 + z * 2;
  return Math.sqrt(wx * wx + wz * wz);
}

// ─────────────────────────────────────────────────────────────────────────
// affect — constructed layer (no IFF involvement)
// ─────────────────────────────────────────────────────────────────────────

describe('Layer.affect', () => {
  /** Build a layer that stamps height 50 inside a circle of `radius` at world origin. */
  function makeCircleStampLayer(radius: number, operation = Operation.Add, height = 50): Layer {
    const layer = new Layer();
    layer.name = 'circle-stamp';

    const circle = new BoundaryCircle();
    circle.centerX = 0;
    circle.centerZ = 0;
    circle.radius = radius;
    circle.radiusSquared = radius * radius;
    layer.boundaries.push(circle);

    const affector = new AffectorHeightConstant();
    affector.operation = operation;
    affector.height = height;
    layer.affectors.push(affector);

    return layer;
  }

  it('stamps the constant height at poles INSIDE the circle and leaves OUTSIDE poles at zero', () => {
    const layer = makeCircleStampLayer(3);
    const chunk = makeChunk();
    layer.affect(null, chunk);

    const heights = dumpHeights(chunk);
    for (let z = 0; z < chunk.numberOfPoles; z++) {
      for (let x = 0; x < chunk.numberOfPoles; x++) {
        const dist = poleDistanceFromOrigin(x, z);
        const h = (heights[z] as number[])[x] as number;
        if (dist < 3) {
          // Inside the radius — fully inside the unfeathered core.
          expect(h).toBeCloseTo(50, 6);
        } else {
          // Outside the radius — boundary returns 0 so the affector
          // produces 0 height delta. Origin-init was 0; stays 0.
          expect(h).toBe(0);
        }
      }
    }

    // Sanity: at least one pole landed inside (center-column poles at
    // world (-1,-1), (-1, 1), (1,-1), (1, 1) are all within sqrt(2) of origin).
    const insideCount = heights.flat().filter((h) => h > 0).length;
    expect(insideCount).toBeGreaterThan(0);
  });

  it('uses Operation.Replace when configured', () => {
    const layer = makeCircleStampLayer(3, Operation.Replace, 50);
    const chunk = makeChunk();
    // Seed heightMap with a baseline so we can prove "replace" actually
    // overrides it (not just adds onto 0).
    for (let z = 0; z < chunk.numberOfPoles; z++) {
      for (let x = 0; x < chunk.numberOfPoles; x++) {
        chunk.heightMap.set(x, z, 999);
      }
    }
    layer.affect(null, chunk);
    // Pole (2,2) — world (-1, -1) — distance √2 < 3 → inside → replaced with 50.
    expect(chunk.heightMap.get(2, 2)).toBeCloseTo(50, 6);
    // Pole (0, 0) — world (-5, -5) — distance √50 > 3 → outside → unchanged.
    expect(chunk.heightMap.get(0, 0)).toBe(999);
  });

  it('does nothing when active is false', () => {
    const layer = makeCircleStampLayer(3);
    layer.active = false;
    const chunk = makeChunk();
    layer.affect(null, chunk);
    expect(chunk.heightMap.get(2, 2)).toBe(0);
  });

  it('does nothing when pruned is true', () => {
    const layer = makeCircleStampLayer(3);
    layer.pruned = true;
    const chunk = makeChunk();
    layer.affect(null, chunk);
    expect(chunk.heightMap.get(2, 2)).toBe(0);
  });

  it('with the only boundary inactive, the layer applies everywhere (C++ no-active-boundaries semantics)', () => {
    const layer = makeCircleStampLayer(3);
    if (layer.boundaries[0]) layer.boundaries[0].active = false;
    const chunk = makeChunk();
    layer.affect(null, chunk);
    // hasActiveBoundaries=false → boundaryMap stays null → fuzzyTest=1.
    // The affector stamps every pole. This matches the C++ behaviour
    // (TerrainGenerator.cpp:1116-1123: `if (boundaryMap) ... else fuzzyTest=1.0`).
    for (let z = 0; z < chunk.numberOfPoles; z++) {
      for (let x = 0; x < chunk.numberOfPoles; x++) {
        expect(chunk.heightMap.get(x, z)).toBeCloseTo(50, 6);
      }
    }
  });

  it('with one active and one inactive boundary, only the active one shapes the mask', () => {
    const layer = makeCircleStampLayer(3);
    // Add a SECOND boundary that, if active, would cover every pole; mark
    // it inactive so it must be skipped.
    const big = new BoundaryCircle();
    big.centerX = 0; big.centerZ = 0; big.radius = 50; big.radiusSquared = 2500;
    big.active = false;
    layer.boundaries.push(big);

    const chunk = makeChunk();
    layer.affect(null, chunk);
    // Pole (2,2) — inside the active radius-3 circle.
    expect(chunk.heightMap.get(2, 2)).toBeCloseTo(50, 6);
    // Pole (0,0) — outside radius-3, would be inside radius-50 if it
    // were active. Because it isn't, this stays 0.
    expect(chunk.heightMap.get(0, 0)).toBe(0);
  });

  it('with no active boundaries at ALL (zero-length list), the layer applies everywhere', () => {
    const layer = new Layer();
    const affector = new AffectorHeightConstant();
    affector.operation = Operation.Add;
    affector.height = 7;
    layer.affectors.push(affector);
    const chunk = makeChunk();
    layer.affect(null, chunk);
    // hasActiveBoundaries=false → boundaryMap stays null → fuzzyTest=1 for every pole.
    for (let z = 0; z < chunk.numberOfPoles; z++) {
      for (let x = 0; x < chunk.numberOfPoles; x++) {
        expect(chunk.heightMap.get(x, z)).toBeCloseTo(7, 6);
      }
    }
  });

  it('invertBoundaries flips the mask — cells OUTSIDE the circle get the stamp', () => {
    const layer = makeCircleStampLayer(3);
    layer.invertBoundaries = true;
    const chunk = makeChunk();
    layer.affect(null, chunk);

    for (let z = 0; z < chunk.numberOfPoles; z++) {
      for (let x = 0; x < chunk.numberOfPoles; x++) {
        const dist = poleDistanceFromOrigin(x, z);
        const h = chunk.heightMap.get(x, z);
        if (dist >= 3) {
          // Outside the radius — inverted boundary is 1 → height stamped.
          expect(h).toBeCloseTo(50, 6);
        } else {
          // Inside — inverted to 0 → unchanged.
          expect(h).toBe(0);
        }
      }
    }
  });

  it('passes correct world coordinates to affectors (smoke check)', () => {
    // Use a tracking affector to confirm Layer derives world coords from
    // chunkData.start + pole_index * distanceBetweenPoles.
    let observed: Array<{ wx: number; wz: number; x: number; z: number; amount: number }> = [];
    class TrackingAffector extends AffectorHeightConstant {
      override affect(wx: number, wz: number, x: number, z: number, amount: number, _cd: GeneratorChunkData): void {
        observed.push({ wx, wz, x, z, amount });
      }
    }
    const layer = makeCircleStampLayer(3);
    layer.affectors = [new TrackingAffector()];
    const chunk = makeChunk();
    layer.affect(null, chunk);

    // Find pole (2, 2). World coords should be (-1, -1).
    const center = observed.find((o) => o.x === 2 && o.z === 2);
    expect(center).toBeDefined();
    if (center) {
      expect(center.wx).toBeCloseTo(-1, 6);
      expect(center.wz).toBeCloseTo(-1, 6);
      expect(center.amount).toBeCloseTo(1, 6);
    }
  });

  it('previousAmountMap gates affector amount multiplicatively', () => {
    // Use Add to make the half-strength visible (Replace would lerp).
    const layer = makeCircleStampLayer(3, Operation.Add, 100);
    const chunk = makeChunk();
    const n = chunk.numberOfPoles;
    const half = new Float32Array(n * n).fill(0.5);
    layer.affect(half, chunk);
    // Pole (2, 2) — inside the circle, boundary=1, previousAmount=0.5 → amount=0.5 → height += 50.
    expect(chunk.heightMap.get(2, 2)).toBeCloseTo(50, 6);
  });

  it('recurses into sub-layers with the parent\'s effective amount as previousAmount', () => {
    // Outer layer: circle of radius 3, no affector — just gates.
    const outer = new Layer();
    outer.name = 'outer-gate';
    const outerCircle = new BoundaryCircle();
    outerCircle.centerX = 0; outerCircle.centerZ = 0;
    outerCircle.radius = 3; outerCircle.radiusSquared = 9;
    outer.boundaries.push(outerCircle);

    // Inner sub-layer: no boundaries → applies everywhere it's allowed to.
    const inner = new Layer();
    inner.name = 'inner-stamp';
    const innerAffector = new AffectorHeightConstant();
    innerAffector.operation = Operation.Add;
    innerAffector.height = 25;
    inner.affectors.push(innerAffector);
    outer.sublayers.push(inner);

    const chunk = makeChunk();
    outer.affect(null, chunk);

    // Inside the outer circle (pole 2,2) — inner stamps 25. Outside (pole 0,0)
    // — outer's amountMap is 0, inner gets all-zero previousAmount → no stamp.
    expect(chunk.heightMap.get(2, 2)).toBeCloseTo(25, 6);
    expect(chunk.heightMap.get(0, 0)).toBe(0);
  });

  it('with no active affectors AND no active boundaries, sub-layers inherit the parent amount verbatim', () => {
    // "onlyHasSubLayers" path — outer is just a pass-through gate.
    const outer = new Layer();
    outer.name = 'pass-through';

    const inner = new Layer();
    const innerCircle = new BoundaryCircle();
    innerCircle.centerX = 0; innerCircle.centerZ = 0;
    innerCircle.radius = 3; innerCircle.radiusSquared = 9;
    inner.boundaries.push(innerCircle);
    const innerAffector = new AffectorHeightConstant();
    innerAffector.operation = Operation.Add;
    innerAffector.height = 42;
    inner.affectors.push(innerAffector);

    outer.sublayers.push(inner);

    const chunk = makeChunk();
    outer.affect(null, chunk);

    // Inner's circle still gates — only inside cells get 42.
    expect(chunk.heightMap.get(2, 2)).toBeCloseTo(42, 6);
    expect(chunk.heightMap.get(0, 0)).toBe(0);
  });

  it('boundary fuzzy-OR: two overlapping circles stamp the union', () => {
    const layer = new Layer();
    // Circle 1 at (0, 0) radius 3 — covers center poles.
    const c1 = new BoundaryCircle();
    c1.centerX = 0; c1.centerZ = 0; c1.radius = 3; c1.radiusSquared = 9;
    layer.boundaries.push(c1);
    // Circle 2 at (-5, -5) radius 1.5 — covers ONLY pole (0, 0) (world (-5,-5)).
    const c2 = new BoundaryCircle();
    c2.centerX = -5; c2.centerZ = -5; c2.radius = 1.5; c2.radiusSquared = 2.25;
    layer.boundaries.push(c2);

    const affector = new AffectorHeightConstant();
    affector.operation = Operation.Add;
    affector.height = 11;
    layer.affectors.push(affector);

    const chunk = makeChunk();
    layer.affect(null, chunk);

    // Pole (2,2) — covered by c1.
    expect(chunk.heightMap.get(2, 2)).toBeCloseTo(11, 6);
    // Pole (0,0) — covered ONLY by c2 (distance from origin √50 > 3, but
    // distance from (-5,-5) = 0 < 1.5).
    expect(chunk.heightMap.get(0, 0)).toBeCloseTo(11, 6);
    // Pole (4,4) — world (3, 3), distance √18 ≈ 4.24 from origin, distance
    // √128 ≈ 11.3 from (-5, -5) → outside both.
    expect(chunk.heightMap.get(4, 4)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// IFF load — round-trip a constructed LAYR form via IffWriter
// ─────────────────────────────────────────────────────────────────────────

describe('Layer.load', () => {
  /**
   * Write a complete IHDR sub-form (v0001 — the simpler shape: just
   * active+name). Cursor must be inside a form ready to accept a new child.
   */
  function writeIhdr(w: IffWriter, name: string, active = true): void {
    w.insertForm('IHDR').insertForm('0001').insertChunk('DATA')
      .writeI32(active ? 1 : 0)
      .writeString(name)
      .exitChunk()
      .exitForm()
      .exitForm();
  }

  /** Write a minimal BCIR > 0000 form with the given center/radius. */
  function writeBcir(w: IffWriter, centerX: number, centerZ: number, radius: number, name = 'c'): void {
    w.insertForm('BCIR').insertForm('0000');
    writeIhdr(w, name);
    w.insertChunk('DATA')
      .writeF32(centerX)
      .writeF32(centerZ)
      .writeF32(radius)
      .exitChunk();
    w.exitForm().exitForm();
  }

  /** Write a minimal AHCN > 0000 form with Add op and the given height. */
  function writeAhcn(w: IffWriter, height: number, name = 'a'): void {
    w.insertForm('AHCN').insertForm('0000');
    writeIhdr(w, name);
    w.insertChunk('DATA')
      .writeI32(Operation.Add)
      .writeF32(height)
      .exitChunk();
    w.exitForm().exitForm();
  }

  it('round-trips a LAYR > 0002 with header, ADTA, one circle, and one constant-height affector', () => {
    const w = new IffWriter();
    w.insertForm('LAYR').insertForm('0002');
    writeIhdr(w, 'my-layer', true);
    w.insertChunk('ADTA')
      .writeI32(0)  // invertBoundaries
      .writeI32(0)  // invertFilters
      .writeI32(1)  // expanded
      .exitChunk();
    writeBcir(w, 0, 0, 3);
    writeAhcn(w, 50);
    w.exitForm().exitForm();

    const iff = Iff.fromBytes(w.toBytes());
    const layer = new Layer();
    layer.load(iff, new StubTerrainGenerator());

    expect(layer.name).toBe('my-layer');
    expect(layer.active).toBe(true);
    expect(layer.invertBoundaries).toBe(false);
    expect(layer.invertFilters).toBe(false);
    expect(layer.expanded).toBe(true);

    expect(layer.boundaries).toHaveLength(1);
    const b = layer.boundaries[0];
    expect(b).toBeInstanceOf(BoundaryCircle);
    expect((b as BoundaryCircle).centerX).toBe(0);
    expect((b as BoundaryCircle).radius).toBe(3);

    expect(layer.affectors).toHaveLength(1);
    const a = layer.affectors[0];
    expect(a).toBeInstanceOf(AffectorHeightConstant);
    expect((a as AffectorHeightConstant).operation).toBe(Operation.Add);
    expect((a as AffectorHeightConstant).height).toBe(50);

    // Loaded layer should now produce the same stamp pattern as the
    // hand-constructed version.
    const chunk = makeChunk();
    layer.affect(null, chunk);
    expect(chunk.heightMap.get(2, 2)).toBeCloseTo(50, 6);
    expect(chunk.heightMap.get(0, 0)).toBe(0);
  });

  it('loads v0001 (invertBoundaries + invertFilters only)', () => {
    const w = new IffWriter();
    w.insertForm('LAYR').insertForm('0001');
    writeIhdr(w, 'v0001-layer');
    w.insertChunk('ADTA')
      .writeI32(1)  // invertBoundaries
      .writeI32(0)
      .exitChunk();
    writeBcir(w, 0, 0, 3);
    w.exitForm().exitForm();

    const iff = Iff.fromBytes(w.toBytes());
    const layer = new Layer();
    layer.load(iff, new StubTerrainGenerator());

    expect(layer.invertBoundaries).toBe(true);
    expect(layer.invertFilters).toBe(false);
    expect(layer.boundaries).toHaveLength(1);
  });

  it('loads v0003 (with notes)', () => {
    const w = new IffWriter();
    w.insertForm('LAYR').insertForm('0003');
    writeIhdr(w, 'v0003-layer');
    w.insertChunk('ADTA')
      .writeI32(0)
      .writeI32(0)
      .writeI32(0)
      .writeString('some notes here')
      .exitChunk();
    w.exitForm().exitForm();

    const iff = Iff.fromBytes(w.toBytes());
    const layer = new Layer();
    layer.load(iff, new StubTerrainGenerator());

    expect(layer.notes).toBe('some notes here');
  });

  it('loads v0004 (with unused int + notes)', () => {
    const w = new IffWriter();
    w.insertForm('LAYR').insertForm('0004');
    writeIhdr(w, 'v0004-layer');
    w.insertChunk('ADTA')
      .writeI32(0)
      .writeI32(0)
      .writeI32(42)  // unused int
      .writeI32(1)   // expanded
      .writeString('v4 notes')
      .exitChunk();
    w.exitForm().exitForm();

    const iff = Iff.fromBytes(w.toBytes());
    const layer = new Layer();
    layer.load(iff, new StubTerrainGenerator());

    expect(layer.notes).toBe('v4 notes');
    expect(layer.expanded).toBe(true);
  });

  it('loads a LAYR with a nested LAYR sub-layer', () => {
    const w = new IffWriter();
    w.insertForm('LAYR').insertForm('0002');
    writeIhdr(w, 'outer');
    w.insertChunk('ADTA').writeI32(0).writeI32(0).writeI32(0).exitChunk();
    // Nested LAYR child.
    w.insertForm('LAYR').insertForm('0002');
    writeIhdr(w, 'inner');
    w.insertChunk('ADTA').writeI32(0).writeI32(0).writeI32(0).exitChunk();
    writeBcir(w, 1, 1, 5, 'inner-circle');
    writeAhcn(w, 33, 'inner-affector');
    w.exitForm().exitForm(); // close inner 0002 / LAYR
    w.exitForm().exitForm(); // close outer 0002 / LAYR

    const iff = Iff.fromBytes(w.toBytes());
    const layer = new Layer();
    layer.load(iff, new StubTerrainGenerator());

    expect(layer.name).toBe('outer');
    expect(layer.sublayers).toHaveLength(1);
    const inner = layer.sublayers[0];
    expect(inner).toBeInstanceOf(Layer);
    expect((inner as Layer).name).toBe('inner');
    expect((inner as Layer).boundaries).toHaveLength(1);
    expect((inner as Layer).affectors).toHaveLength(1);
  });

  it('loads a LAYR with a BREC boundary (sanity: other boundary subclasses too)', () => {
    const w = new IffWriter();
    w.insertForm('LAYR').insertForm('0001');
    writeIhdr(w, 'rect-layer');
    w.insertChunk('ADTA').writeI32(0).writeI32(0).exitChunk();

    // BREC > 0000 — simplest variant.
    w.insertForm('BREC').insertForm('0000');
    writeIhdr(w, 'r');
    w.insertChunk('DATA')
      .writeF32(-1).writeF32(-1).writeF32(1).writeF32(1)
      .exitChunk();
    w.exitForm().exitForm();

    w.exitForm().exitForm();

    const iff = Iff.fromBytes(w.toBytes());
    const layer = new Layer();
    layer.load(iff, new StubTerrainGenerator());

    expect(layer.boundaries).toHaveLength(1);
    expect(layer.boundaries[0]).toBeInstanceOf(BoundaryRectangle);
  });

  it('skips unknown child forms without error (forward compatibility)', () => {
    const w = new IffWriter();
    w.insertForm('LAYR').insertForm('0001');
    writeIhdr(w, 'fwd-compat');
    w.insertChunk('ADTA').writeI32(0).writeI32(0).exitChunk();

    // Real child we know about.
    writeBcir(w, 0, 0, 3);

    // Unknown child — pretend it's a future affector tag. Layer should
    // walk-and-discard it without throwing.
    w.insertForm('ACCN').insertForm('0000');  // AffectorColorConstant — not modeled
    w.insertChunk('DATA').writeI32(0).writeI32(0xff).writeI32(0).exitChunk();
    w.exitForm().exitForm();

    // Another real child after the unknown one — the parent cursor must
    // still be aligned for this to load correctly.
    writeAhcn(w, 99);

    w.exitForm().exitForm();

    const iff = Iff.fromBytes(w.toBytes());
    const layer = new Layer();
    layer.load(iff, new StubTerrainGenerator());

    expect(layer.boundaries).toHaveLength(1);
    expect(layer.affectors).toHaveLength(1);
    expect((layer.affectors[0] as AffectorHeightConstant).height).toBe(99);
  });

  it('throws on an unknown LAYR version', () => {
    const w = new IffWriter()
      .insertForm('LAYR').insertForm('0099').exitForm().exitForm();
    const iff = Iff.fromBytes(w.toBytes());
    const layer = new Layer();
    expect(() => layer.load(iff, new StubTerrainGenerator())).toThrow(/unknown LAYR version/);
  });
});
