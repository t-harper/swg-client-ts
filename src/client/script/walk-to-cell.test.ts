import { describe, expect, it } from 'vitest';
import { ObjControllerSubtypeIds } from '../../messages/game/obj-controller/index.js';
import { cellMovementSends, createFakeContext, movementSends } from './test-helpers.js';

const CELL_ID = 0xc0ffee_1234_5678n;
const OTHER_CELL = 0xdead_beef_cafe_baben;

describe('walkToCell', () => {
  it('emits CM_netUpdateTransformWithParent (id 241), not the world variant', async () => {
    const { ctx, sent } = createFakeContext();
    await ctx.walkToCell(CELL_ID, { x: 0, z: 10 }, { speed: 5, tickMs: 200 });

    const moves = cellMovementSends(sent);
    expect(moves.length).toBeGreaterThanOrEqual(9);
    expect(moves.length).toBeLessThanOrEqual(11);
    // None of the sends should be world-relative movement (CM_netUpdateTransform=113).
    expect(movementSends(sent).length).toBe(0);
    for (const { msg } of moves) {
      expect(msg.message).toBe(ObjControllerSubtypeIds.CM_netUpdateTransformWithParent);
      expect(msg.flags).toBe(0x23);
    }
  });

  it('sets parentCell on every send to the supplied parent', async () => {
    const { ctx, sent } = createFakeContext();
    await ctx.walkToCell(CELL_ID, { x: 5, z: 0 }, { speed: 5, tickMs: 200 });
    for (const { data } of cellMovementSends(sent)) {
      expect(data.parentCell).toBe(CELL_ID);
    }
  });

  it('emits strictly monotonic sequence numbers starting at 1', async () => {
    const { ctx, sent } = createFakeContext();
    await ctx.walkToCell(CELL_ID, { x: 0, z: 10 }, { speed: 5, tickMs: 200 });
    const seqs = cellMovementSends(sent).map((m) => m.data.sequenceNumber);
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe((seqs[i - 1] ?? 0) + 1);
    }
  });

  it('preserves exact cell-relative floats (no fixed-point quantization)', async () => {
    const { ctx, sent } = createFakeContext();
    ctx.setCellPose(CELL_ID, { x: 3.5, y: 0, z: 1.25 }, 0);
    await ctx.walkToCell(CELL_ID, { x: 3.5, z: 1.25 }, { speed: 5 });
    const moves = cellMovementSends(sent);
    expect(moves.length).toBe(1);
    const m = moves[0]?.data;
    expect(m?.position.x).toBeCloseTo(3.5, 5);
    expect(m?.position.z).toBeCloseTo(1.25, 5);
  });

  it('sends with the player networkId from sceneStart in the ObjController header', async () => {
    const playerNetworkId = 0xabcd_0001_0002_0003n;
    const { ctx, sent } = createFakeContext({ playerNetworkId });
    await ctx.walkToCell(CELL_ID, { x: 1, z: 1 }, { speed: 5, tickMs: 200 });
    for (const { msg } of cellMovementSends(sent)) {
      expect(msg.networkId).toBe(playerNetworkId);
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
    await ctx.walkToCell(OTHER_CELL, { x: 5, z: 0 }, { speed: 5, tickMs: 200 });
    const moves = cellMovementSends(sent);
    const first = moves[0];
    expect(first?.data.parentCell).toBe(OTHER_CELL);
    const last = moves[moves.length - 1];
    expect(last?.data.position.x).toBeCloseTo(5, 5);
    expect(last?.data.position.z).toBeCloseTo(0, 5);
  });

  it('honors setCellPose for the starting cursor when already in the cell', async () => {
    const { ctx, sent } = createFakeContext();
    ctx.setCellPose(CELL_ID, { x: 2, y: 0, z: 2 }, 0);
    await ctx.walkToCell(CELL_ID, { x: 5, z: 6 }, { speed: 5, tickMs: 200 });
    const moves = cellMovementSends(sent);
    expect(moves.length).toBeGreaterThanOrEqual(4);
    expect(moves.length).toBeLessThanOrEqual(6);
    const last = moves[moves.length - 1]?.data;
    expect(last?.position.x).toBeCloseTo(5, 5);
    expect(last?.position.z).toBeCloseTo(6, 5);
  });

  it('aborts cleanly when the signal fires mid-walk', async () => {
    const { ctx, abort } = createFakeContext();
    const walkPromise = ctx.walkToCell(CELL_ID, { x: 0, z: 100 }, { speed: 5, tickMs: 100 });
    setTimeout(() => abort(), 100);
    await expect(walkPromise).rejects.toThrow(/aborted/);
  });

  it('counts every send in scriptResult.sendsCount (including teleport-ack bootstrap)', async () => {
    const { ctx } = createFakeContext();
    const baselineSendsCount = (
      ctx as unknown as { _state: { sendsCount: number } }
    )._state.sendsCount;
    await ctx.walkToCell(CELL_ID, { x: 0, z: 10 }, { speed: 5, tickMs: 200 });
    const finalSends = (
      ctx as unknown as { _state: { sendsCount: number } }
    )._state.sendsCount;
    // 9-11 movement sends plus ≥1 teleport-ack send.
    expect(finalSends - baselineSendsCount).toBeGreaterThanOrEqual(10);
  });
});

