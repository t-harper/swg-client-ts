import { describe, expect, it } from 'vitest';
import { createFakeContext, movementSends } from './test-helpers.js';

describe('walkCircle', () => {
  it('keeps every emitted position on the circle (float wire, no quantization)', async () => {
    const { ctx, sent } = createFakeContext({
      startPosition: { x: 8, y: 0, z: 0 },
    });
    await ctx.walkCircle({
      centerX: 0,
      centerZ: 0,
      radius: 8,
      durationMs: 1200,
      tickMs: 200,
    });

    const moves = movementSends(sent);
    expect(moves.length).toBe(6);
    for (const { data } of moves) {
      const r = Math.hypot(data.position.x, data.position.z);
      expect(Math.abs(r - 8)).toBeLessThan(1e-5);
    }
  });

  it('produces strictly increasing sequence numbers', async () => {
    const { ctx, sent } = createFakeContext();
    await ctx.walkCircle({
      centerX: 0,
      centerZ: 0,
      radius: 5,
      durationMs: 1000,
      tickMs: 200,
    });
    const seqs = movementSends(sent).map((m) => m.data.sequenceNumber);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? -1);
    }
  });

  it('respects direction flag (clockwise reverses theta progression)', async () => {
    const ccw = createFakeContext({ startPosition: { x: 5, y: 0, z: 0 } });
    const cw = createFakeContext({ startPosition: { x: 5, y: 0, z: 0 } });
    await ccw.ctx.walkCircle({
      centerX: 0,
      centerZ: 0,
      radius: 5,
      durationMs: 400,
      tickMs: 200,
      direction: 1,
    });
    await cw.ctx.walkCircle({
      centerX: 0,
      centerZ: 0,
      radius: 5,
      durationMs: 400,
      tickMs: 200,
      direction: -1,
    });
    const ccwSecond = movementSends(ccw.sent)[1]?.data;
    const cwSecond = movementSends(cw.sent)[1]?.data;
    expect(Math.sign(ccwSecond?.position.z ?? 0)).not.toBe(Math.sign(cwSecond?.position.z ?? 0));
  });

  it('sends speed=0 in the wire field', async () => {
    const { ctx, sent } = createFakeContext();
    await ctx.walkCircle({
      centerX: 0,
      centerZ: 0,
      radius: 5,
      durationMs: 1000,
      tickMs: 200,
    });
    for (const { data } of movementSends(sent)) {
      expect(data.speed).toBe(0);
    }
  });

  it('aborts mid-circle when signal fires', async () => {
    const { ctx, abort } = createFakeContext();
    const p = ctx.walkCircle({
      centerX: 0,
      centerZ: 0,
      radius: 5,
      durationMs: 5_000,
      tickMs: 100,
    });
    setTimeout(() => abort(), 100);
    await expect(p).rejects.toThrow(/aborted/);
  });
});
