/**
 * Tests for `findCellPath` — the BFS portal pathfinder.
 *
 * Layouts are constructed inline using the same type shape exported by
 * `src/iff/portal-layout-reader.ts` (the .pob loader).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Vector3 } from '../types.js';
import type { Cell, CellPortal, PortalGeometry, PortalLayout } from '../iff/portal-layout-reader.js';
import { type CellPathHop, findCellPath } from './cell-graph.js';

// -- Fixture builders --------------------------------------------------------

function vec(x: number, y: number, z: number): Vector3 {
  return { x, y, z };
}

function dummyGeometry(seed: number): PortalGeometry {
  const v = vec(seed, 0, seed);
  return {
    vertices: [v, v, v, v],
    center: v,
  };
}

interface PortalSpec {
  geometryIndex: number;
  targetCellIndex: number;
  doorPosition?: Vector3;
  passable?: boolean;
  disabled?: boolean;
  doorStyle?: string;
}

function portal(spec: PortalSpec): CellPortal {
  return {
    geometryIndex: spec.geometryIndex,
    geometry: dummyGeometry(spec.geometryIndex),
    targetCellIndex: spec.targetCellIndex,
    windingClockwise: false,
    passable: spec.passable ?? true,
    disabled: spec.disabled ?? false,
    doorStyle: spec.doorStyle ?? '',
    doorPosition: spec.doorPosition ?? vec(spec.geometryIndex, 0, spec.targetCellIndex),
    doorTransform: null,
  };
}

function cell(index: number, name: string, portals: CellPortal[]): Cell {
  return { index, name, portals };
}

function layout(cells: Cell[]): PortalLayout {
  // Deduplicate geometries by index for the geometries[] list — the
  // pathfinder doesn't read it, but a well-formed layout has every unique
  // geometryIndex present once.
  const geomMap = new Map<number, PortalGeometry>();
  for (const c of cells) {
    for (const p of c.portals) {
      if (!geomMap.has(p.geometryIndex)) {
        geomMap.set(p.geometryIndex, p.geometry);
      }
    }
  }
  return {
    sourceName: 'test.pob',
    version: '0003',
    geometries: [...geomMap.values()],
    cells,
  };
}

/** Assert non-null and return the narrowed value — tightens chains of `?.`. */
function present<T>(value: T | null | undefined, label = 'value'): T {
  expect(value, `${label} should be defined`).toBeDefined();
  if (value == null) {
    throw new Error(`${label} was null/undefined after presence assertion`);
  }
  return value;
}

function toCellSequence(path: CellPathHop[] | null): number[] {
  return present(path, 'path').map((h) => h.toCellIndex);
}

function fromCellSequence(path: CellPathHop[] | null): number[] {
  return present(path, 'path').map((h) => h.fromCellIndex);
}

// -- Tests -------------------------------------------------------------------

describe('findCellPath — trivial cases', () => {
  it('returns an empty array when from === to', () => {
    const lay = layout([
      cell(0, 'exterior', [portal({ geometryIndex: 0, targetCellIndex: 1 })]),
      cell(1, 'lobby', [portal({ geometryIndex: 0, targetCellIndex: 0 })]),
    ]);
    expect(findCellPath(lay, 0, 0)).toEqual([]);
    expect(findCellPath(lay, 1, 1)).toEqual([]);
  });

  it('returns null for negative cell indices', () => {
    const lay = layout([
      cell(0, 'exterior', [portal({ geometryIndex: 0, targetCellIndex: 1 })]),
      cell(1, 'lobby', [portal({ geometryIndex: 0, targetCellIndex: 0 })]),
    ]);
    expect(findCellPath(lay, -1, 0)).toBeNull();
    expect(findCellPath(lay, 0, -1)).toBeNull();
  });

  it('returns null for out-of-bounds cell indices', () => {
    const lay = layout([
      cell(0, 'exterior', [portal({ geometryIndex: 0, targetCellIndex: 1 })]),
      cell(1, 'lobby', [portal({ geometryIndex: 0, targetCellIndex: 0 })]),
    ]);
    expect(findCellPath(lay, 0, 999)).toBeNull();
    expect(findCellPath(lay, 999, 0)).toBeNull();
  });

  it('returns null for non-integer cell indices', () => {
    const lay = layout([
      cell(0, 'exterior', [portal({ geometryIndex: 0, targetCellIndex: 1 })]),
      cell(1, 'lobby', [portal({ geometryIndex: 0, targetCellIndex: 0 })]),
    ]);
    expect(findCellPath(lay, 0.5, 1)).toBeNull();
    expect(findCellPath(lay, 0, Number.NaN)).toBeNull();
  });
});

describe('findCellPath — direct neighbor', () => {
  it('produces a single hop with both door positions populated', () => {
    // Cell 0 (exterior) <-> cell 1 (lobby), portal geometryIndex=7.
    // Source door at (5, 0, 0); mirror in cell 1 at (-5, 0, 0).
    const lay = layout([
      cell(0, 'exterior', [
        portal({ geometryIndex: 7, targetCellIndex: 1, doorPosition: vec(5, 0, 0) }),
      ]),
      cell(1, 'lobby', [
        portal({ geometryIndex: 7, targetCellIndex: 0, doorPosition: vec(-5, 0, 0) }),
      ]),
    ]);

    const path = present(findCellPath(lay, 0, 1), 'path');
    expect(path).toHaveLength(1);
    const hop = present(path[0], 'hop');
    expect(hop.fromCellIndex).toBe(0);
    expect(hop.toCellIndex).toBe(1);
    expect(hop.fromCellLocalDoor).toEqual(vec(5, 0, 0));
    expect(hop.toCellLocalDoor).toEqual(vec(-5, 0, 0));
    expect(hop.portal.geometryIndex).toBe(7);
  });
});

describe('findCellPath — multi-hop path', () => {
  it('routes 0 → 1 → 2 across two portals', () => {
    // Linear chain: exterior(0) -- portal2 -- lobby(1) -- portal3 -- bar(2)
    const lay = layout([
      cell(0, 'exterior', [
        portal({ geometryIndex: 2, targetCellIndex: 1, doorPosition: vec(1, 0, 0) }),
      ]),
      cell(1, 'lobby', [
        portal({ geometryIndex: 2, targetCellIndex: 0, doorPosition: vec(-1, 0, 0) }),
        portal({ geometryIndex: 3, targetCellIndex: 2, doorPosition: vec(10, 0, 0) }),
      ]),
      cell(2, 'bar', [
        portal({ geometryIndex: 3, targetCellIndex: 1, doorPosition: vec(-10, 0, 0) }),
      ]),
    ]);

    const path = present(findCellPath(lay, 0, 2), 'path');
    expect(path).toHaveLength(2);

    const hop0 = present(path[0], 'hop0');
    expect(hop0.fromCellIndex).toBe(0);
    expect(hop0.toCellIndex).toBe(1);
    expect(hop0.portal.geometryIndex).toBe(2);
    expect(hop0.fromCellLocalDoor).toEqual(vec(1, 0, 0));
    expect(hop0.toCellLocalDoor).toEqual(vec(-1, 0, 0));

    const hop1 = present(path[1], 'hop1');
    expect(hop1.fromCellIndex).toBe(1);
    expect(hop1.toCellIndex).toBe(2);
    expect(hop1.portal.geometryIndex).toBe(3);
    expect(hop1.fromCellLocalDoor).toEqual(vec(10, 0, 0));
    expect(hop1.toCellLocalDoor).toEqual(vec(-10, 0, 0));
  });

  it('routes a 3-hop chain 0 → 1 → 2 → 3', () => {
    const lay = layout([
      cell(0, 'a', [portal({ geometryIndex: 10, targetCellIndex: 1 })]),
      cell(1, 'b', [
        portal({ geometryIndex: 10, targetCellIndex: 0 }),
        portal({ geometryIndex: 11, targetCellIndex: 2 }),
      ]),
      cell(2, 'c', [
        portal({ geometryIndex: 11, targetCellIndex: 1 }),
        portal({ geometryIndex: 12, targetCellIndex: 3 }),
      ]),
      cell(3, 'd', [portal({ geometryIndex: 12, targetCellIndex: 2 })]),
    ]);
    const path = findCellPath(lay, 0, 3);
    expect(toCellSequence(path)).toEqual([1, 2, 3]);
    expect(fromCellSequence(path)).toEqual([0, 1, 2]);
  });
});

describe('findCellPath — unreachable destinations', () => {
  it('returns null when the destination is in a disconnected component', () => {
    // Two islands: {0,1} and {2,3}. No portal between them.
    const lay = layout([
      cell(0, 'a', [portal({ geometryIndex: 0, targetCellIndex: 1 })]),
      cell(1, 'b', [portal({ geometryIndex: 0, targetCellIndex: 0 })]),
      cell(2, 'c', [portal({ geometryIndex: 1, targetCellIndex: 3 })]),
      cell(3, 'd', [portal({ geometryIndex: 1, targetCellIndex: 2 })]),
    ]);
    expect(findCellPath(lay, 0, 2)).toBeNull();
    expect(findCellPath(lay, 1, 3)).toBeNull();
  });

  it('returns null when source cell has no portals', () => {
    const lay = layout([
      cell(0, 'isolated', []),
      cell(1, 'other', [portal({ geometryIndex: 0, targetCellIndex: 0 })]),
    ]);
    expect(findCellPath(lay, 0, 1)).toBeNull();
  });
});

describe('findCellPath — portal filtering', () => {
  it('skips disabled portals and routes around them', () => {
    // 0 <-> 1 directly (DISABLED) but 0 <-> 2 <-> 1 works.
    const lay = layout([
      cell(0, 'exterior', [
        portal({ geometryIndex: 0, targetCellIndex: 1, disabled: true }),
        portal({ geometryIndex: 1, targetCellIndex: 2 }),
      ]),
      cell(1, 'lobby', [
        portal({ geometryIndex: 0, targetCellIndex: 0, disabled: true }),
        portal({ geometryIndex: 2, targetCellIndex: 2 }),
      ]),
      cell(2, 'side', [
        portal({ geometryIndex: 1, targetCellIndex: 0 }),
        portal({ geometryIndex: 2, targetCellIndex: 1 }),
      ]),
    ]);
    const path = findCellPath(lay, 0, 1);
    expect(present(path, 'path')).toHaveLength(2);
    expect(toCellSequence(path)).toEqual([2, 1]);
  });

  it('skips non-passable portals and routes around them', () => {
    const lay = layout([
      cell(0, 'exterior', [
        portal({ geometryIndex: 0, targetCellIndex: 1, passable: false }),
        portal({ geometryIndex: 1, targetCellIndex: 2 }),
      ]),
      cell(1, 'lobby', [
        portal({ geometryIndex: 0, targetCellIndex: 0, passable: false }),
        portal({ geometryIndex: 2, targetCellIndex: 2 }),
      ]),
      cell(2, 'side', [
        portal({ geometryIndex: 1, targetCellIndex: 0 }),
        portal({ geometryIndex: 2, targetCellIndex: 1 }),
      ]),
    ]);
    const path = findCellPath(lay, 0, 1);
    expect(present(path, 'path')).toHaveLength(2);
    expect(toCellSequence(path)).toEqual([2, 1]);
  });

  it('returns null when every outbound portal is disabled', () => {
    const lay = layout([
      cell(0, 'a', [
        portal({ geometryIndex: 0, targetCellIndex: 1, disabled: true }),
        portal({ geometryIndex: 1, targetCellIndex: 2, passable: false }),
      ]),
      cell(1, 'b', [portal({ geometryIndex: 0, targetCellIndex: 0, disabled: true })]),
      cell(2, 'c', [portal({ geometryIndex: 1, targetCellIndex: 0, passable: false })]),
    ]);
    expect(findCellPath(lay, 0, 1)).toBeNull();
    expect(findCellPath(lay, 0, 2)).toBeNull();
  });
});

describe('findCellPath — deterministic tie-breaking', () => {
  it('prefers the portal listed FIRST in the source cell when two same-length paths exist', () => {
    // Cell 0 has two equal-length one-hop paths to cell 3:
    //   - via cell 1 (portal index 0 in cell 0)
    //   - via cell 2 (portal index 1 in cell 0)
    // Tie-break rule: BFS enqueues neighbors in source-cell portal-array order,
    // so cell 1 wins.
    const lay = layout([
      cell(0, 'a', [
        portal({ geometryIndex: 10, targetCellIndex: 1 }),
        portal({ geometryIndex: 11, targetCellIndex: 2 }),
      ]),
      cell(1, 'b', [
        portal({ geometryIndex: 10, targetCellIndex: 0 }),
        portal({ geometryIndex: 20, targetCellIndex: 3 }),
      ]),
      cell(2, 'c', [
        portal({ geometryIndex: 11, targetCellIndex: 0 }),
        portal({ geometryIndex: 21, targetCellIndex: 3 }),
      ]),
      cell(3, 'd', [
        portal({ geometryIndex: 20, targetCellIndex: 1 }),
        portal({ geometryIndex: 21, targetCellIndex: 2 }),
      ]),
    ]);
    expect(toCellSequence(findCellPath(lay, 0, 3))).toEqual([1, 3]);
  });

  it('swapping source-cell portal order swaps the route choice', () => {
    // Same graph as above but cell 0's portals are listed in opposite order.
    const lay = layout([
      cell(0, 'a', [
        portal({ geometryIndex: 11, targetCellIndex: 2 }),
        portal({ geometryIndex: 10, targetCellIndex: 1 }),
      ]),
      cell(1, 'b', [
        portal({ geometryIndex: 10, targetCellIndex: 0 }),
        portal({ geometryIndex: 20, targetCellIndex: 3 }),
      ]),
      cell(2, 'c', [
        portal({ geometryIndex: 11, targetCellIndex: 0 }),
        portal({ geometryIndex: 21, targetCellIndex: 3 }),
      ]),
      cell(3, 'd', [
        portal({ geometryIndex: 20, targetCellIndex: 1 }),
        portal({ geometryIndex: 21, targetCellIndex: 2 }),
      ]),
    ]);
    expect(toCellSequence(findCellPath(lay, 0, 3))).toEqual([2, 3]);
  });
});

describe('findCellPath — mirror door lookup', () => {
  it('warns and falls back to source door when the destination has no mirror portal', () => {
    // Asymmetric .pob: cell 0 lists a portal to cell 1, but cell 1 has no
    // corresponding return entry. Pathfinder should still resolve the hop
    // and emit a warning.
    const lay = layout([
      cell(0, 'a', [portal({ geometryIndex: 7, targetCellIndex: 1, doorPosition: vec(3, 0, 0) })]),
      cell(1, 'b', [
        portal({ geometryIndex: 99, targetCellIndex: 0, doorPosition: vec(50, 0, 0) }),
      ]),
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const path = present(findCellPath(lay, 0, 1), 'path');
      expect(path).toHaveLength(1);
      const hop = present(path[0], 'hop');
      // Mirror lookup fails -> fallback uses fromCellLocalDoor.
      expect(hop.toCellLocalDoor).toEqual(vec(3, 0, 0));
      expect(warn).toHaveBeenCalledTimes(1);
      const firstCallArg = warn.mock.calls[0]?.[0];
      expect(String(firstCallArg)).toMatch(/mirror portal/);
    } finally {
      warn.mockRestore();
    }
  });

  it('uses the mirror entry whose targetCellIndex points back at the source', () => {
    // Cell 2 has two portals with geometryIndex=5 (unusual but legal): one
    // pointing back at cell 0 and one pointing at cell 3. Path 0 -> 2
    // should pick the one pointing back at 0.
    const lay = layout([
      cell(0, 'a', [portal({ geometryIndex: 5, targetCellIndex: 2, doorPosition: vec(1, 0, 0) })]),
      cell(1, 'b', []),
      cell(2, 'c', [
        portal({ geometryIndex: 5, targetCellIndex: 3, doorPosition: vec(99, 0, 0) }),
        portal({ geometryIndex: 5, targetCellIndex: 0, doorPosition: vec(-1, 0, 0) }),
      ]),
      cell(3, 'd', [portal({ geometryIndex: 5, targetCellIndex: 2 })]),
    ]);
    const path = present(findCellPath(lay, 0, 2), 'path');
    expect(path).toHaveLength(1);
    const hop = present(path[0], 'hop');
    expect(hop.toCellLocalDoor).toEqual(vec(-1, 0, 0));
  });
});

describe('findCellPath — defensive against malformed layouts', () => {
  it('skips self-loop portals (targetCellIndex === sourceCellIndex)', () => {
    // Cell 0 has a portal pointing at itself; should be ignored. Real path
    // is 0 -> 1 via geometry 8.
    const lay = layout([
      cell(0, 'a', [
        portal({ geometryIndex: 0, targetCellIndex: 0 }),
        portal({ geometryIndex: 8, targetCellIndex: 1 }),
      ]),
      cell(1, 'b', [portal({ geometryIndex: 8, targetCellIndex: 0 })]),
    ]);
    const path = present(findCellPath(lay, 0, 1), 'path');
    expect(path).toHaveLength(1);
    const hop = present(path[0], 'hop');
    expect(hop.portal.geometryIndex).toBe(8);
  });

  it('skips portals whose targetCellIndex does not match any known cell', () => {
    // Portal to phantom cell 42; pathfinder treats it as a dead edge.
    const lay = layout([
      cell(0, 'a', [
        portal({ geometryIndex: 0, targetCellIndex: 42 }),
        portal({ geometryIndex: 1, targetCellIndex: 1 }),
      ]),
      cell(1, 'b', [portal({ geometryIndex: 1, targetCellIndex: 0 })]),
    ]);
    const path = present(findCellPath(lay, 0, 1), 'path');
    expect(path).toHaveLength(1);
    const hop = present(path[0], 'hop');
    expect(hop.portal.targetCellIndex).toBe(1);
    expect(findCellPath(lay, 0, 42)).toBeNull();
  });
});
