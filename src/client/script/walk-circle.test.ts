import { describe, expect, it } from 'vitest';
import { UpdateTransformMessage } from '../../messages/game/update-transform-message.js';
import { createFakeContext } from './test-helpers.js';

describe('walkCircle', () => {
  it('keeps every emitted position on the circle (within fixed-point quantization)', async () => {
    const { ctx, sent } = createFakeContext({
      // Start exactly on the circle so the first sample is on-radius too
      startPosition: { x: 8, y: 0, z: 0 },
    });
    await ctx.walkCircle({
      centerX: 0,
      centerZ: 0,
      radius: 8,
      durationMs: 1200,
      tickMs: 200,
    });

    // 1200ms / 200ms = 6 ticks
    expect(sent.length).toBe(6);
    for (const m of sent as UpdateTransformMessage[]) {
      const x = m.positionX / 4;
      const z = m.positionZ / 4;
      const r = Math.hypot(x, z);
      // Allow 0.5m slack: 0.25 for x quantization + 0.25 for z
      expect(Math.abs(r - 8)).toBeLessThanOrEqual(0.5);
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
    const seqs = (sent as UpdateTransformMessage[]).map((m) => m.sequenceNumber);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? -1);
    }
  });

  it('respects direction flag (clockwise reverses theta progression)', async () => {
    const ccw = createFakeContext({ startPosition: { x: 5, y: 0, z: 0 } });
    const cw = createFakeContext({ startPosition: { x: 5, y: 0, z: 0 } });
    await ccw.ctx.walkCircle({
      centerX: 0, centerZ: 0, radius: 5, durationMs: 400, tickMs: 200, direction: 1,
    });
    await cw.ctx.walkCircle({
      centerX: 0, centerZ: 0, radius: 5, durationMs: 400, tickMs: 200, direction: -1,
    });
    const ccwSecond = ccw.sent[1] as UpdateTransformMessage;
    const cwSecond = cw.sent[1] as UpdateTransformMessage;
    // After one tick from (5,0), CCW (omega>0) and CW (omega<0) should be
    // on opposite sides of the starting line z=0.
    expect(Math.sign(ccwSecond.positionZ)).not.toBe(Math.sign(cwSecond.positionZ));
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
    setTimeout(() => abort(), 50);
    await expect(p).rejects.toThrow(/aborted/);
  });
});
