/**
 * `findFlatPatch` unit tests — mocked probe function (no live server).
 *
 * The probe injection lets us assert:
 *   - candidates are visited in concentric-ring order (center, then ring 1, etc.)
 *   - min-spacing is honored (no two returned spots within `minSpacing`)
 *   - search short-circuits as soon as `count` accepts are gathered
 *   - all-failure case returns []
 */

import { describe, expect, it } from 'vitest';
import type { ScriptContext } from '../client/script/context.js';
import { findFlatPatch, generateCandidateGrid } from './find-flat-patch.js';
import type { BuildableProbeResult, ProbeOptions } from './probe.js';

/** Cheap stand-in for ScriptContext — none of its fields are touched by the search. */
const FAKE_CTX = {} as unknown as ScriptContext;
const FAKE_INV = 1n;

interface Probe {
  fn: (
    _ctx: ScriptContext,
    _inv: bigint,
    x: number,
    z: number,
    _opts?: ProbeOptions,
  ) => Promise<BuildableProbeResult>;
  visited: Array<{ x: number; z: number }>;
}

/** A probe that says "buildable" for whichever coords match `accept(x,z)`. */
function makeProbe(accept: (x: number, z: number) => boolean): Probe {
  const visited: Array<{ x: number; z: number }> = [];
  return {
    visited,
    fn: async (_ctx, _inv, x, z) => {
      visited.push({ x, z });
      return Promise.resolve({
        buildable: accept(x, z),
        chatOob: accept(x, z) ? '' : 'no_room',
      });
    },
  };
}

describe('generateCandidateGrid', () => {
  it('starts at the center, then rings outward', () => {
    const grid = generateCandidateGrid({
      centerX: 100,
      centerZ: 200,
      maxRadius: 100,
      rings: 2,
      angularSteps: 4,
    });
    // 1 center + 2 * 4 = 9 candidates
    expect(grid.length).toBe(9);
    expect(grid[0]).toEqual({ x: 100, z: 200 });

    // Ring 1 is at radius 50 (= 100 * 1/2), four cardinal-direction points.
    // First is east (theta=0): (100+50, 200)
    expect(grid[1]?.x).toBeCloseTo(150);
    expect(grid[1]?.z).toBeCloseTo(200);
    // Second is north (theta=90°): (100, 200+50)
    expect(grid[2]?.x).toBeCloseTo(100);
    expect(grid[2]?.z).toBeCloseTo(250);

    // Ring 2 at radius 100. First is east (theta=0): (200, 200).
    expect(grid[5]?.x).toBeCloseTo(200);
    expect(grid[5]?.z).toBeCloseTo(200);
  });

  it('returns center-only when rings=0', () => {
    const grid = generateCandidateGrid({
      centerX: 0,
      centerZ: 0,
      maxRadius: 50,
      rings: 0,
      angularSteps: 8,
    });
    expect(grid).toEqual([{ x: 0, z: 0 }]);
  });

  it('returns center-only when maxRadius=0', () => {
    const grid = generateCandidateGrid({
      centerX: 0,
      centerZ: 0,
      maxRadius: 0,
      rings: 3,
      angularSteps: 8,
    });
    expect(grid).toEqual([{ x: 0, z: 0 }]);
  });
});

describe('findFlatPatch', () => {
  it('returns the center first when it is buildable', async () => {
    const probe = makeProbe(() => true);
    const out = await findFlatPatch(FAKE_CTX, FAKE_INV, {
      count: 1,
      centerX: 0,
      centerZ: 0,
      maxRadius: 100,
      probeFn: probe.fn,
    });
    expect(out).toEqual([{ x: 0, z: 0 }]);
    expect(probe.visited.length).toBe(1);
  });

  it('returns [] when every probe fails', async () => {
    const probe = makeProbe(() => false);
    const out = await findFlatPatch(FAKE_CTX, FAKE_INV, {
      count: 3,
      centerX: 100,
      centerZ: 100,
      maxRadius: 50,
      rings: 2,
      angularSteps: 4,
      probeFn: probe.fn,
    });
    expect(out).toEqual([]);
    // 1 center + 2 * 4 = 9 candidates, all probed
    expect(probe.visited.length).toBe(9);
  });

  it('returns N spots respecting min-spacing', async () => {
    // Mark every candidate buildable; ensure the spacing filter prunes
    // densely-packed picks. With centerX=0, centerZ=0, radius=10, rings=4,
    // angularSteps=8, the innermost ring is at 2.5m — clearly inside any
    // sane minSpacing.
    const probe = makeProbe(() => true);
    const out = await findFlatPatch(FAKE_CTX, FAKE_INV, {
      count: 3,
      centerX: 0,
      centerZ: 0,
      maxRadius: 10,
      rings: 4,
      angularSteps: 8,
      minSpacing: 6,
      probeFn: probe.fn,
    });
    expect(out.length).toBeLessThanOrEqual(3);
    // Every returned pair must be at least 6 m apart.
    for (let i = 0; i < out.length; ++i) {
      for (let j = i + 1; j < out.length; ++j) {
        const a = out[i];
        const b = out[j];
        if (a === undefined || b === undefined) continue;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        expect(d).toBeGreaterThanOrEqual(6 - 1e-9);
      }
    }
  });

  it('short-circuits once N accepts are gathered', async () => {
    let probeCount = 0;
    const out = await findFlatPatch(FAKE_CTX, FAKE_INV, {
      count: 2,
      centerX: 0,
      centerZ: 0,
      maxRadius: 1000,
      rings: 10,
      angularSteps: 16,
      minSpacing: 0, // accept everything spacing-wise
      probeFn: async (_ctx, _inv, x, z) => {
        probeCount++;
        return { buildable: true, chatOob: '' };
      },
    });
    expect(out.length).toBe(2);
    // Probes only 2 candidates — the center, plus the first ring-1 point.
    expect(probeCount).toBe(2);
  });

  it('skips candidates too close to accepted spots without probing them', async () => {
    // 6 rings × 8 steps = 49 candidates. minSpacing = a very large value
    // means after the center is accepted, every other candidate must be
    // skipped without probing — total probe count == 1.
    let probeCount = 0;
    const out = await findFlatPatch(FAKE_CTX, FAKE_INV, {
      count: 5,
      centerX: 0,
      centerZ: 0,
      maxRadius: 50,
      rings: 6,
      angularSteps: 8,
      minSpacing: 9999,
      probeFn: async () => {
        probeCount++;
        return { buildable: true, chatOob: '' };
      },
    });
    expect(out).toEqual([{ x: 0, z: 0 }]);
    expect(probeCount).toBe(1);
  });

  it('invokes onProbe for every probe attempt', async () => {
    const calls: Array<{ x: number; z: number; index: number; total: number }> = [];
    const probe = makeProbe((x, z) => x === 0 && z === 0);
    await findFlatPatch(FAKE_CTX, FAKE_INV, {
      count: 1,
      centerX: 0,
      centerZ: 0,
      maxRadius: 100,
      rings: 1,
      angularSteps: 2,
      probeFn: probe.fn,
      onProbe: (c, _r, idx, total) => calls.push({ x: c.x, z: c.z, index: idx, total }),
    });
    // Only the center is probed (search ends once we hit `count`).
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ x: 0, z: 0, index: 0, total: 3 });
  });

  it('rejects nonsense parameters', async () => {
    await expect(
      findFlatPatch(FAKE_CTX, FAKE_INV, {
        count: 1,
        centerX: 0,
        centerZ: 0,
        maxRadius: -1,
        probeFn: makeProbe(() => true).fn,
      }),
    ).rejects.toThrow(/maxRadius/);

    await expect(
      findFlatPatch(FAKE_CTX, FAKE_INV, {
        count: 1,
        centerX: 0,
        centerZ: 0,
        maxRadius: 10,
        rings: -1,
        probeFn: makeProbe(() => true).fn,
      }),
    ).rejects.toThrow(/rings|angularSteps/);
  });

  it('returns empty for count=0', async () => {
    let probeCount = 0;
    const out = await findFlatPatch(FAKE_CTX, FAKE_INV, {
      count: 0,
      centerX: 0,
      centerZ: 0,
      maxRadius: 100,
      probeFn: async () => {
        probeCount++;
        return { buildable: true, chatOob: '' };
      },
    });
    expect(out).toEqual([]);
    expect(probeCount).toBe(0);
  });
});
