/**
 * Unit tests for `AffectorHeightConstant` and `AffectorHeightTerrace` —
 * covers `affect()` math for every Operation, the terrace snap formula,
 * `affectsHeight()` / `getAffectedMaps()`, and IFF round-trip via IffWriter.
 *
 * The chunkData stub is intentionally minimal — only `heightMap` is touched
 * by these affectors, so every other field is cast in via `unknown as`.
 */

import { describe, expect, it } from 'vitest';
import { Iff, IffWriter } from '../../../iff/iff.js';
import { Array2d } from '../array2d.js';
import { Operation, TGM, type GeneratorChunkData } from '../types.js';
import { AffectorHeightConstant, AffectorHeightTerrace } from './height-constant-terrace.js';

/** Build a 3×3 zero-filled heightMap inside a minimal chunkData shell. */
function makeChunkData(initial = 0): { chunkData: GeneratorChunkData; heightMap: Array2d<number> } {
  const heightMap = new Array2d<number>(3, 3, initial);
  const chunkData = {
    heightMap,
    // Every other field is irrelevant for height-constant / height-terrace.
  } as unknown as GeneratorChunkData;
  return { chunkData, heightMap };
}

// ---------------------------------------------------------------------------
// AffectorHeightConstant
// ---------------------------------------------------------------------------

describe('AffectorHeightConstant', () => {
  describe('affect()', () => {
    it('Add op: cell becomes cur + amount * height', () => {
      const a = new AffectorHeightConstant();
      a.operation = Operation.Add;
      a.height = 100;
      const { chunkData, heightMap } = makeChunkData(0);
      a.affect(0, 0, 1, 1, 0.5, chunkData);
      // 0 + 0.5 * 100 = 50
      expect(heightMap.get(1, 1)).toBe(50);
    });

    it('Add op: non-zero starting height accumulates', () => {
      const a = new AffectorHeightConstant();
      a.operation = Operation.Add;
      a.height = 10;
      const { chunkData, heightMap } = makeChunkData(7);
      a.affect(0, 0, 0, 0, 1.0, chunkData);
      expect(heightMap.get(0, 0)).toBe(17);
    });

    it('Subtract op: cell becomes cur - amount * height', () => {
      const a = new AffectorHeightConstant();
      a.operation = Operation.Subtract;
      a.height = 50;
      const { chunkData, heightMap } = makeChunkData(100);
      a.affect(0, 0, 0, 0, 0.4, chunkData);
      // 100 - 0.4 * 50 = 80
      expect(heightMap.get(0, 0)).toBe(80);
    });

    it('Replace op with amount=1.0: cell becomes height exactly', () => {
      const a = new AffectorHeightConstant();
      a.operation = Operation.Replace;
      a.height = 200;
      const { chunkData, heightMap } = makeChunkData(50);
      a.affect(0, 0, 2, 2, 1.0, chunkData);
      expect(heightMap.get(2, 2)).toBe(200);
    });

    it('Replace op with amount=0.5: cell is half-way blended', () => {
      const a = new AffectorHeightConstant();
      a.operation = Operation.Replace;
      a.height = 100;
      const { chunkData, heightMap } = makeChunkData(0);
      a.affect(0, 0, 0, 0, 0.5, chunkData);
      // 0.5 * 100 + 0.5 * 0 = 50
      expect(heightMap.get(0, 0)).toBe(50);
    });

    it('Multiply op: lerps between current and current*height', () => {
      const a = new AffectorHeightConstant();
      a.operation = Operation.Multiply;
      a.height = 3; // target = 10 * 3 = 30; lerp(10, 30, 0.5) = 20
      const { chunkData, heightMap } = makeChunkData(10);
      a.affect(0, 0, 0, 0, 0.5, chunkData);
      expect(heightMap.get(0, 0)).toBeCloseTo(20, 6);
    });

    it('amount <= 0 is a no-op', () => {
      const a = new AffectorHeightConstant();
      a.operation = Operation.Add;
      a.height = 100;
      const { chunkData, heightMap } = makeChunkData(5);
      a.affect(0, 0, 0, 0, 0, chunkData);
      expect(heightMap.get(0, 0)).toBe(5);
      a.affect(0, 0, 0, 0, -1, chunkData);
      expect(heightMap.get(0, 0)).toBe(5);
    });

    it('only mutates the targeted (x, z) cell', () => {
      const a = new AffectorHeightConstant();
      a.operation = Operation.Replace;
      a.height = 999;
      const { chunkData, heightMap } = makeChunkData(0);
      a.affect(0, 0, 1, 1, 1.0, chunkData);
      expect(heightMap.get(1, 1)).toBe(999);
      // Untouched cells.
      expect(heightMap.get(0, 0)).toBe(0);
      expect(heightMap.get(2, 2)).toBe(0);
      expect(heightMap.get(0, 1)).toBe(0);
    });
  });

  it('affectsHeight() returns true', () => {
    expect(new AffectorHeightConstant().affectsHeight()).toBe(true);
  });

  it('getAffectedMaps() returns TGM.Height', () => {
    expect(new AffectorHeightConstant().getAffectedMaps()).toBe(TGM.Height);
  });

  describe('load()', () => {
    function buildAhcnBytes(params: {
      active: boolean; name: string; operation: Operation; height: number;
    }): Uint8Array {
      const w = new IffWriter()
        .insertForm('AHCN')
        .insertForm('0000');
      // IHDR (LayerItem base) — use the newer 0001 layout (no toolColor).
      w.insertForm('IHDR').insertForm('0001').insertChunk('DATA');
      w.writeI32(params.active ? 1 : 0);
      w.writeString(params.name);
      w.exitChunk().exitForm().exitForm();
      // DATA: operation (i32) + height (f32).
      w.insertChunk('DATA');
      w.writeI32(params.operation);
      w.writeF32(params.height);
      w.exitChunk();
      w.exitForm().exitForm();
      return w.toBytes();
    }

    it('round-trips version 0000', () => {
      const bytes = buildAhcnBytes({
        active: true, name: 'flat plateau', operation: Operation.Add, height: 42.5,
      });
      const a = new AffectorHeightConstant();
      a.load(Iff.fromBytes(bytes));
      expect(a.active).toBe(true);
      expect(a.name).toBe('flat plateau');
      expect(a.operation).toBe(Operation.Add);
      expect(a.height).toBeCloseTo(42.5, 6);
    });

    it('round-trips Replace operation with inactive flag', () => {
      const bytes = buildAhcnBytes({
        active: false, name: '', operation: Operation.Replace, height: -10,
      });
      const a = new AffectorHeightConstant();
      a.load(Iff.fromBytes(bytes));
      expect(a.active).toBe(false);
      expect(a.operation).toBe(Operation.Replace);
      expect(a.height).toBe(-10);
    });

    it('throws on an out-of-range operation value', () => {
      const bytes = buildAhcnBytes({
        active: true, name: 'x', operation: 99 as Operation, height: 1,
      });
      const a = new AffectorHeightConstant();
      expect(() => a.load(Iff.fromBytes(bytes))).toThrow(/out of bounds/);
    });

    it('throws on an unsupported version tag', () => {
      const w = new IffWriter()
        .insertForm('AHCN')
        .insertForm('0099')
        .insertChunk('DATA').exitChunk()
        .exitForm()
        .exitForm();
      const a = new AffectorHeightConstant();
      expect(() => a.load(Iff.fromBytes(w.toBytes()))).toThrow(/unsupported version/);
    });
  });
});

// ---------------------------------------------------------------------------
// AffectorHeightTerrace
// ---------------------------------------------------------------------------

describe('AffectorHeightTerrace', () => {
  describe('affect()', () => {
    it('snaps cur=23.5 with height=10, fraction=0, amount=1 to 30', () => {
      // fraction=0 means midHeight == lowHeight, so anything strictly above
      // lowHeight gets pulled all the way up to highHeight.
      const a = new AffectorHeightTerrace();
      a.height = 10;
      a.fraction = 0;
      const { chunkData, heightMap } = makeChunkData(23.5);
      a.affect(0, 0, 0, 0, 1.0, chunkData);
      // lowHeight = 20, highHeight = 30; cur=23.5 > midHeight(=20),
      // t = (23.5 - 20) / 10 = 0.35 → lerp(20, 30, 0.35) = 23.5
      // Wait, that's the *snapped* value (lerp produces 23.5 again).
      // Actually with fraction=0 + amount=1, the snapped value is on
      // the line from low to high, parameterized by t = (cur-low)/(high-low),
      // i.e. snapped == cur. Then we blend back: lerp(cur, snapped, 1) = cur.
      // So with fraction=0 the terrace is a no-op? Let me verify against C++.
      // Looking again: fraction=0 → midHeight=lowHeight → if cur > mid
      // (true here), t = (23.5-20)/(30-20) = 0.35, newHeight = lerp(20,30,0.35) = 23.5.
      // That's correct — fraction=0 is a ramp, not a step.
      expect(heightMap.get(0, 0)).toBeCloseTo(23.5, 6);
    });

    it('snaps cur=23.5 with height=10, fraction=0.5, amount=1 to 20 (below mid)', () => {
      // fraction=0.5 → midHeight = 25. cur=23.5 < midHeight → newHeight = lowHeight = 20.
      const a = new AffectorHeightTerrace();
      a.height = 10;
      a.fraction = 0.5;
      const { chunkData, heightMap } = makeChunkData(23.5);
      a.affect(0, 0, 0, 0, 1.0, chunkData);
      expect(heightMap.get(0, 0)).toBeCloseTo(20, 6);
    });

    it('snaps cur=27 with height=10, fraction=0.5, amount=1 toward 30 (above mid)', () => {
      // fraction=0.5 → midHeight = 25. cur=27 > 25 →
      // t = (27 - 25) / (30 - 25) = 0.4, newHeight = lerp(20, 30, 0.4) = 24.
      const a = new AffectorHeightTerrace();
      a.height = 10;
      a.fraction = 0.5;
      const { chunkData, heightMap } = makeChunkData(27);
      a.affect(0, 0, 0, 0, 1.0, chunkData);
      expect(heightMap.get(0, 0)).toBeCloseTo(24, 6);
    });

    it('blends with original by amount', () => {
      const a = new AffectorHeightTerrace();
      a.height = 10;
      a.fraction = 0.5;
      const { chunkData, heightMap } = makeChunkData(23.5);
      // Full snap target is 20; amount=0.5 → lerp(23.5, 20, 0.5) = 21.75.
      a.affect(0, 0, 0, 0, 0.5, chunkData);
      expect(heightMap.get(0, 0)).toBeCloseTo(21.75, 6);
    });

    it('amount <= 0 is a no-op', () => {
      const a = new AffectorHeightTerrace();
      a.height = 10;
      a.fraction = 0.5;
      const { chunkData, heightMap } = makeChunkData(23.5);
      a.affect(0, 0, 0, 0, 0, chunkData);
      expect(heightMap.get(0, 0)).toBe(23.5);
    });

    it('height <= 0 is a no-op', () => {
      const a = new AffectorHeightTerrace();
      a.height = 0;
      a.fraction = 0.5;
      const { chunkData, heightMap } = makeChunkData(5);
      a.affect(0, 0, 0, 0, 1, chunkData);
      expect(heightMap.get(0, 0)).toBe(5);
    });

    it('handles negative original heights symmetrically', () => {
      // cur = -23.5, height = 10 → low should be -30 (one step below cur),
      // high should be -20. fraction = 0.5 → mid = -25.
      // -23.5 > -25, so t = (-23.5 - -25) / (-20 - -25) = 1.5/5 = 0.3
      // → newHeight = lerp(-30, -20, 0.3) = -27.
      const a = new AffectorHeightTerrace();
      a.height = 10;
      a.fraction = 0.5;
      const { chunkData, heightMap } = makeChunkData(-23.5);
      a.affect(0, 0, 0, 0, 1.0, chunkData);
      expect(heightMap.get(0, 0)).toBeCloseTo(-27, 6);
    });

    it('only mutates the targeted (x, z) cell', () => {
      const a = new AffectorHeightTerrace();
      a.height = 10;
      a.fraction = 0.5;
      const { chunkData, heightMap } = makeChunkData(23.5);
      a.affect(0, 0, 2, 1, 1.0, chunkData);
      expect(heightMap.get(2, 1)).toBeCloseTo(20, 6);
      expect(heightMap.get(0, 0)).toBe(23.5);
      expect(heightMap.get(1, 1)).toBe(23.5);
    });
  });

  it('affectsHeight() returns true', () => {
    expect(new AffectorHeightTerrace().affectsHeight()).toBe(true);
  });

  it('getAffectedMaps() returns TGM.Height', () => {
    expect(new AffectorHeightTerrace().getAffectedMaps()).toBe(TGM.Height);
  });

  describe('load()', () => {
    function buildAhtrBytes(
      version: '0000' | '0001' | '0002' | '0004',
      params: { active: boolean; name: string; fraction: number; height: number },
    ): Uint8Array {
      const w = new IffWriter()
        .insertForm('AHTR')
        .insertForm(version);
      w.insertForm('IHDR').insertForm('0001').insertChunk('DATA');
      w.writeI32(params.active ? 1 : 0);
      w.writeString(params.name);
      w.exitChunk().exitForm().exitForm();
      w.insertChunk('DATA');
      w.writeF32(params.fraction);
      w.writeF32(params.height);
      w.exitChunk();
      w.exitForm().exitForm();
      return w.toBytes();
    }

    it('round-trips version 0000', () => {
      const bytes = buildAhtrBytes('0000', {
        active: true, name: 'mesa', fraction: 0.3, height: 15,
      });
      const a = new AffectorHeightTerrace();
      a.load(Iff.fromBytes(bytes));
      expect(a.active).toBe(true);
      expect(a.name).toBe('mesa');
      expect(a.fraction).toBeCloseTo(0.3, 6);
      expect(a.height).toBeCloseTo(15, 6);
    });

    it('round-trips version 0004 (current shipping version)', () => {
      const bytes = buildAhtrBytes('0004', {
        active: false, name: 'cliffs', fraction: 0.75, height: 50,
      });
      const a = new AffectorHeightTerrace();
      a.load(Iff.fromBytes(bytes));
      expect(a.active).toBe(false);
      expect(a.name).toBe('cliffs');
      expect(a.fraction).toBeCloseTo(0.75, 6);
      expect(a.height).toBeCloseTo(50, 6);
    });

    it('round-trips versions 0001 and 0002 identically', () => {
      for (const ver of ['0001', '0002'] as const) {
        const bytes = buildAhtrBytes(ver, {
          active: true, name: `v${ver}`, fraction: 0.5, height: 20,
        });
        const a = new AffectorHeightTerrace();
        a.load(Iff.fromBytes(bytes));
        expect(a.fraction).toBeCloseTo(0.5, 6);
        expect(a.height).toBeCloseTo(20, 6);
      }
    });

    it('throws on an unsupported version tag', () => {
      const w = new IffWriter()
        .insertForm('AHTR')
        .insertForm('0099')
        .insertChunk('DATA').exitChunk()
        .exitForm()
        .exitForm();
      const a = new AffectorHeightTerrace();
      expect(() => a.load(Iff.fromBytes(w.toBytes()))).toThrow(/unsupported version/);
    });
  });
});
