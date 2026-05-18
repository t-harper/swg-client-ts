import { describe, expect, it } from 'vitest';
import { yawToQuat } from '../../archive/transform.js';
import { ObjControllerMessage } from '../../messages/game/obj-controller-message.js';
import { ObjControllerSubtypeIds } from '../../messages/game/obj-controller/index.js';
import { createFakeContext, movementSends, teleportAckSends } from './test-helpers.js';

describe('walkTo', () => {
  it('emits a sequence of CM_netUpdateTransform messages reaching the target', async () => {
    const { ctx, sent } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    await ctx.walkTo({ x: 0, z: 10 }, { tickMs: 200 });

    const moves = movementSends(sent);
    // distance 10m, locked BASE_RUN_SPEED=7.3m/s, tickMs=200ms → ~1.46m/tick → ~7 ticks
    expect(moves.length).toBeGreaterThanOrEqual(6);
    expect(moves.length).toBeLessThanOrEqual(8);

    // Sequence numbers strictly monotonic, starting at 1
    const seqs = moves.map((m) => m.data.sequenceNumber);
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe((seqs[i - 1] ?? 0) + 1);
    }

    // Final position reaches target exactly (no quantization on float wire)
    const last = moves[moves.length - 1]?.data;
    expect(last?.position.x).toBeCloseTo(0, 5);
    expect(last?.position.z).toBeCloseTo(10, 5);
  });

  it('sends speed=0 in the wire field (matching real client; server derives from delta)', async () => {
    const { ctx, sent } = createFakeContext();
    await ctx.walkTo({ x: 0, z: 10 }, { tickMs: 200 });
    for (const m of movementSends(sent)) {
      expect(m.data.speed).toBe(0);
    }
  });

  it('encodes yaw as a Y-axis quaternion (atan2(dx, dz) → quat)', async () => {
    const { ctx, sent } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    await ctx.walkTo({ x: 5, z: 0 }, { tickMs: 200 });
    const first = movementSends(sent)[0]?.data;
    // Moving +x with z=0 → yaw = atan2(5, 0) = π/2
    const expected = yawToQuat(Math.PI / 2);
    expect(first?.rotation.x).toBeCloseTo(expected.x, 5);
    expect(first?.rotation.y).toBeCloseTo(expected.y, 5);
    expect(first?.rotation.z).toBeCloseTo(expected.z, 5);
    expect(first?.rotation.w).toBeCloseTo(expected.w, 5);
  });

  it('preserves exact float position (no fixed-point quantization)', async () => {
    const { ctx, sent } = createFakeContext({ startPosition: { x: 12.37, y: 1, z: -4.81 } });
    await ctx.walkTo({ x: 12.37, z: -4.81 });
    const moves = movementSends(sent);
    expect(moves.length).toBe(1);
    const m = moves[0]?.data;
    expect(m?.position.x).toBeCloseTo(12.37, 5);
    expect(m?.position.z).toBeCloseTo(-4.81, 5);
    expect(m?.position.y).toBeCloseTo(1, 5);
  });

  it('sends with the player networkId from sceneStart and CLIENT_TO_AUTH_SERVER_FLAGS', async () => {
    const playerNetworkId = 0xabcd_0001_0002_0003n;
    const { ctx, sent } = createFakeContext({ playerNetworkId });
    await ctx.walkTo({ x: 0, z: 10 }, { tickMs: 200 });
    for (const { msg } of movementSends(sent)) {
      expect(msg.networkId).toBe(playerNetworkId);
      expect(msg.flags).toBe(0x23);
      expect(msg.message).toBe(ObjControllerSubtypeIds.CM_netUpdateTransform);
    }
  });

  it('aborts cleanly when the signal fires mid-walk', async () => {
    const { ctx, abort } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    const walkPromise = ctx.walkTo({ x: 0, z: 100 }, { tickMs: 100 });
    setTimeout(() => abort(), 100);
    await expect(walkPromise).rejects.toThrow(/aborted/);
  });

  it('updates ctx.position() as it moves', async () => {
    const { ctx } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    await ctx.walkTo({ x: 10, z: 0 }, { tickMs: 200 });
    const pos = ctx.position();
    expect(pos.x).toBeCloseTo(10, 5);
    expect(pos.z).toBeCloseTo(0, 5);
  });

  it('auto-sends a CM_teleportAck(-1) bootstrap before the first transform', async () => {
    const { ctx, sent } = createFakeContext();
    await ctx.walkTo({ x: 0, z: 5 }, { tickMs: 200 });
    const acks = teleportAckSends(sent);
    expect(acks.length).toBeGreaterThanOrEqual(1);
    expect(acks.some((a) => a.data.sequenceId === -1)).toBe(true);
    // The ack must come before any movement send.
    const firstAckIdx = sent.findIndex(
      (m) =>
        m instanceof ObjControllerMessage && m.message === ObjControllerSubtypeIds.CM_teleportAck,
    );
    const firstMoveIdx = sent.findIndex(
      (m) =>
        m instanceof ObjControllerMessage &&
        m.message === ObjControllerSubtypeIds.CM_netUpdateTransform,
    );
    expect(firstAckIdx).toBeGreaterThanOrEqual(0);
    expect(firstMoveIdx).toBeGreaterThan(firstAckIdx);
  });

  it('produces monotonic-with-positive-delta syncStamps', async () => {
    const { ctx, sent } = createFakeContext();
    await ctx.walkTo({ x: 0, z: 10 }, { tickMs: 200 });
    const stamps = movementSends(sent).map((m) => m.data.syncStamp);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]).toBeGreaterThan(stamps[i - 1] ?? -1);
    }
  });
});
