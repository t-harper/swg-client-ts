import { describe, expect, it } from 'vitest';
import { UpdateTransformMessage } from '../../messages/game/update-transform-message.js';
import { UpdateTransformWithParentMessage } from '../../messages/game/update-transform-with-parent-message.js';
import { createFakeContext } from './test-helpers.js';

const CELL_ID = 0xc0ffee_1234_5678n;
const OTHER_CELL = 0xdead_beef_cafe_baben;

describe('walkToCell', () => {
  it('emits a sequence of UpdateTransformWithParentMessages reaching the target', async () => {
    const { ctx, sent } = createFakeContext();
    await ctx.walkToCell(CELL_ID, { x: 0, z: 10 }, { speed: 5, tickMs: 200 });

    // distance 10m, speed 5m/s = 2s travel = 10 ticks at 200ms
    expect(sent.length).toBeGreaterThanOrEqual(9);
    expect(sent.length).toBeLessThanOrEqual(11);
    for (const m of sent) {
      expect(m).toBeInstanceOf(UpdateTransformWithParentMessage);
      // None of the sends should be world-relative messages
      expect(m).not.toBeInstanceOf(UpdateTransformMessage);
    }
  });

  it('sets the cellId on every send to the supplied parent', async () => {
    const { ctx, sent } = createFakeContext();
    await ctx.walkToCell(CELL_ID, { x: 5, z: 0 }, { speed: 5, tickMs: 200 });
    for (const m of sent as UpdateTransformWithParentMessage[]) {
      expect(m.cellId).toBe(CELL_ID);
    }
  });

  it('emits strictly monotonic sequence numbers starting at 1', async () => {
    const { ctx, sent } = createFakeContext();
    await ctx.walkToCell(CELL_ID, { x: 0, z: 10 }, { speed: 5, tickMs: 200 });
    const seqs = (sent as UpdateTransformWithParentMessage[]).map((m) => m.sequenceNumber);
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe((seqs[i - 1] ?? 0) + 1);
    }
  });

  it('uses cell-relative * 8 quantization (not * 4 like world)', async () => {
    const { ctx, sent } = createFakeContext();
    // Zero-distance walk → emits exactly one update
    ctx.setCellPose(CELL_ID, { x: 3.5, y: 0, z: 1.25 }, 0);
    await ctx.walkToCell(CELL_ID, { x: 3.5, z: 1.25 }, { speed: 5 });
    expect(sent.length).toBe(1);
    const m = sent[0] as UpdateTransformWithParentMessage;
    // 3.5 * 8 = 28; 1.25 * 8 = 10
    expect(m.positionX).toBe(28);
    expect(m.positionZ).toBe(10);
  });

  it('computes yaw via atan2(dx, dz) — same SWG heading convention as world walk', async () => {
    const { ctx, sent } = createFakeContext();
    ctx.setCellPose(CELL_ID, { x: 0, y: 0, z: 0 }, 0);
    await ctx.walkToCell(CELL_ID, { x: 5, z: 0 }, { speed: 5, tickMs: 200 });
    const first = sent[0] as UpdateTransformWithParentMessage;
    // Moving +x with z=0 → atan2(5, 0) = π/2 radians; * 16 = ~25.13 → rounded to 25
    expect(first.yaw).toBe(25);
  });

  it('sends with the player networkId from sceneStart', async () => {
    const playerNetworkId = 0xabcd_0001_0002_0003n;
    const { ctx, sent } = createFakeContext({ playerNetworkId });
    await ctx.walkToCell(CELL_ID, { x: 1, z: 1 }, { speed: 5, tickMs: 200 });
    for (const m of sent as UpdateTransformWithParentMessage[]) {
      expect(m.networkId).toBe(playerNetworkId);
    }
  });

  it('updates ctx.cellPosition() / ctx.parentCell() as it moves', async () => {
    const { ctx } = createFakeContext();
    expect(ctx.parentCell()).toBe(0n);
    await ctx.walkToCell(CELL_ID, { x: 10, z: 0 }, { speed: 5, tickMs: 200 });
    expect(ctx.parentCell()).toBe(CELL_ID);
    const pos = ctx.cellPosition();
    expect(pos.x).toBeCloseTo(10, 5);
    expect(pos.z).toBeCloseTo(0, 5);
  });

  it('does NOT touch the world cursor (ctx.position())', async () => {
    const { ctx } = createFakeContext({ startPosition: { x: 100, y: 5, z: 200 } });
    const beforeWorld = ctx.position();
    await ctx.walkToCell(CELL_ID, { x: 10, z: 0 }, { speed: 5, tickMs: 200 });
    const afterWorld = ctx.position();
    expect(afterWorld.x).toBe(beforeWorld.x);
    expect(afterWorld.y).toBe(beforeWorld.y);
    expect(afterWorld.z).toBe(beforeWorld.z);
  });

  it('resets cell cursor to (0,0,0) when entering a new cell', async () => {
    const { ctx, sent } = createFakeContext();
    ctx.setCellPose(CELL_ID, { x: 4, y: 0, z: 4 }, 0);
    // Switch to a new cell; should walk from (0,0) → (5,0), NOT from (4,4) → (5,0).
    await ctx.walkToCell(OTHER_CELL, { x: 5, z: 0 }, { speed: 5, tickMs: 200 });
    // The first message's cellId should be the NEW cell, and its position should
    // be along the (0,0) → (5,0) path.
    const first = sent[0] as UpdateTransformWithParentMessage;
    expect(first.cellId).toBe(OTHER_CELL);
    // Final message should be exactly at the target.
    const last = sent[sent.length - 1] as UpdateTransformWithParentMessage;
    // 5m * 8 = 40
    expect(last.positionX).toBe(40);
    expect(last.positionZ).toBe(0);
  });

  it('honors setCellPose for the starting cursor when already in the cell', async () => {
    const { ctx, sent } = createFakeContext();
    ctx.setCellPose(CELL_ID, { x: 2, y: 0, z: 2 }, 0);
    // Walk a known distance from (2,2) → (5,6). Distance = 5m.
    await ctx.walkToCell(CELL_ID, { x: 5, z: 6 }, { speed: 5, tickMs: 200 });
    // 5m / 5m/s = 1s = 5 ticks at 200ms (give or take 1).
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(sent.length).toBeLessThanOrEqual(6);
    const last = sent[sent.length - 1] as UpdateTransformWithParentMessage;
    // 5m * 8 = 40; 6m * 8 = 48
    expect(last.positionX).toBe(40);
    expect(last.positionZ).toBe(48);
  });

  it('aborts cleanly when the signal fires mid-walk', async () => {
    const { ctx, abort } = createFakeContext();
    const walkPromise = ctx.walkToCell(CELL_ID, { x: 0, z: 100 }, { speed: 5, tickMs: 100 });
    setTimeout(() => abort(), 50);
    await expect(walkPromise).rejects.toThrow(/aborted/);
  });

  it('counts every send in scriptResult.sendsCount', async () => {
    const { ctx } = createFakeContext();
    const baselineSendsCount = (
      ctx as unknown as { _state: { sendsCount: number } }
    )._state.sendsCount;
    await ctx.walkToCell(CELL_ID, { x: 0, z: 10 }, { speed: 5, tickMs: 200 });
    const finalSends = (
      ctx as unknown as { _state: { sendsCount: number } }
    )._state.sendsCount;
    // Should be at least 9 sends counted
    expect(finalSends - baselineSendsCount).toBeGreaterThanOrEqual(9);
  });
});
