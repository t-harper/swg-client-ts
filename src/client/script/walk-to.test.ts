import { describe, expect, it } from 'vitest';
import { UpdateTransformMessage } from '../../messages/game/update-transform-message.js';
import { createFakeContext } from './test-helpers.js';

describe('walkTo', () => {
  it('emits a sequence of UpdateTransformMessages reaching the target', async () => {
    const { ctx, sent } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    await ctx.walkTo({ x: 0, z: 10 }, { speed: 5, tickMs: 200 });

    // distance 10m, speed 5m/s = 2s travel = 10 ticks at 200ms
    expect(sent.length).toBeGreaterThanOrEqual(9);
    expect(sent.length).toBeLessThanOrEqual(11);
    for (const m of sent) expect(m).toBeInstanceOf(UpdateTransformMessage);

    // Sequence numbers strictly monotonic, starting at 1
    const seqs = (sent as UpdateTransformMessage[]).map((m) => m.sequenceNumber);
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe((seqs[i - 1] ?? 0) + 1);
    }

    // Final position reaches target (within 0.25m fixed-point quantization)
    const last = sent[sent.length - 1] as UpdateTransformMessage;
    expect(Math.abs(last.positionX / 4 - 0)).toBeLessThanOrEqual(0.25);
    expect(Math.abs(last.positionZ / 4 - 10)).toBeLessThanOrEqual(0.25);
  });

  it('computes yaw via atan2(dx, dz) — SWG heading convention', async () => {
    const { ctx, sent } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    await ctx.walkTo({ x: 5, z: 0 }, { speed: 5, tickMs: 200 });
    const first = sent[0] as UpdateTransformMessage;
    // Moving +x with z=0 → atan2(5, 0) = π/2 radians; * 16 = ~25.13 → rounded to 25
    expect(first.yaw).toBe(25);
  });

  it('quantizes position to 0.25m and yaw to ~3.6°/unit', async () => {
    const { ctx, sent } = createFakeContext({ startPosition: { x: 12.37, y: 1, z: -4.81 } });
    await ctx.walkTo({ x: 12.37, z: -4.81 }, { speed: 5 }); // zero-distance: one update
    expect(sent.length).toBe(1);
    const m = sent[0] as UpdateTransformMessage;
    // 12.37 * 4 = 49.48 → 49; -4.81 * 4 = -19.24 → -19
    expect(m.positionX).toBe(49);
    expect(m.positionZ).toBe(-19);
  });

  it('aborts cleanly when the signal fires mid-walk', async () => {
    const { ctx, abort } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    // Long walk so the abort lands during a sleep
    const walkPromise = ctx.walkTo({ x: 0, z: 100 }, { speed: 5, tickMs: 100 });
    setTimeout(() => abort(), 50);
    await expect(walkPromise).rejects.toThrow(/aborted/);
  });

  it('updates ctx.position() as it moves', async () => {
    const { ctx } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    await ctx.walkTo({ x: 10, z: 0 }, { speed: 5, tickMs: 200 });
    const pos = ctx.position();
    expect(pos.x).toBeCloseTo(10, 5);
    expect(pos.z).toBeCloseTo(0, 5);
  });
});
