import { describe, expect, it } from 'vitest';
import { createFakeContext, movementSends } from './test-helpers.js';

/**
 * Mounted-speed clamping. When `ctx.mountedSpeedCap()` is set (via
 * `ctx.mount(vehicleId)` or `setMountedSpeedCap()`), the movement primitives
 * should clamp the requested `speed` down to the cap so the server's
 * anti-cheat doesn't reject the transform.
 */
describe('movement (mounted speed cap)', () => {
  it('walkTo: on foot, requested speed is honored — no clamp', async () => {
    const { ctx, sent } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    // tickMs=200ms with speed=10 → 2m / tick. 20m → 10 ticks.
    await ctx.walkTo({ x: 0, z: 20 }, { speed: 10, tickMs: 200 });
    const moves = movementSends(sent);
    expect(moves.length).toBe(10);
  });

  it('walkTo: mounted with cap=5 clamps speed=10 down to 5 (slower path)', async () => {
    const { ctx, sent } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    ctx.setMountedSpeedCap(5);
    await ctx.walkTo({ x: 0, z: 20 }, { speed: 10, tickMs: 200 });
    const moves = movementSends(sent);
    // At cap=5 m/s and tickMs=200ms → 1m/tick. 20m → 20 ticks.
    expect(moves.length).toBe(20);
  });

  it('walkTo: mounted but requested speed below cap is untouched', async () => {
    const { ctx, sent } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    ctx.setMountedSpeedCap(20);
    await ctx.walkTo({ x: 0, z: 20 }, { speed: 4, tickMs: 200 });
    // At speed=4 m/s and tickMs=200ms → 0.8m/tick. 20m → 25 ticks.
    const moves = movementSends(sent);
    expect(moves.length).toBeGreaterThanOrEqual(24);
    expect(moves.length).toBeLessThanOrEqual(26);
  });

  it('mount() sets a default speed cap (12 m/s — speeder-bike default)', async () => {
    const { ctx, sent } = createFakeContext();
    expect(ctx.mountedSpeedCap()).toBeNull();
    ctx.mount(0xabcdn);
    expect(ctx.mountedSpeedCap()).toBe(12);
    // The mount call itself emits a useAbility('mount', vehicleId) — a
    // single ObjControllerMessage with CM_commandQueueEnqueue subtype.
    expect(sent.length).toBe(1);
  });

  it('mount({ speedCap }) overrides the default cap', async () => {
    const { ctx } = createFakeContext();
    ctx.mount(0xabcdn, { speedCap: 17.5 });
    expect(ctx.mountedSpeedCap()).toBe(17.5);
  });

  it('dismount() clears the speed cap back to null', async () => {
    const { ctx } = createFakeContext();
    ctx.mount(0xabcdn);
    expect(ctx.mountedSpeedCap()).toBe(12);
    ctx.dismount();
    expect(ctx.mountedSpeedCap()).toBeNull();
  });

  it('walkCircle: mounted cap clamps an explicit speed and slows the orbit', async () => {
    const { ctx: foot, sent: footSent } = createFakeContext({
      startPosition: { x: 10, y: 0, z: 0 },
    });
    const { ctx: mounted, sent: mountedSent } = createFakeContext({
      startPosition: { x: 10, y: 0, z: 0 },
    });
    mounted.setMountedSpeedCap(5);

    // Both circles same radius and durationMs, but speed=20 → on foot
    // the omega is 4 rad/s; mounted clamps to 5 m/s → omega 1 rad/s, so
    // the mounted circle covers far less angular ground per tick.
    await foot.walkCircle({
      centerX: 0,
      centerZ: 0,
      radius: 5,
      durationMs: 1000,
      tickMs: 200,
      speed: 20,
    });
    await mounted.walkCircle({
      centerX: 0,
      centerZ: 0,
      radius: 5,
      durationMs: 1000,
      tickMs: 200,
      speed: 20,
    });

    const footMoves = movementSends(footSent);
    const mountedMoves = movementSends(mountedSent);
    // Same number of ticks emitted (durationMs / tickMs is constant)…
    expect(footMoves.length).toBe(mountedMoves.length);
    // …but mounted should sweep a shorter arc. Compare total angle
    // delta between first and last sample.
    const angleAt = (p: { x: number; z: number }): number => Math.atan2(p.x, p.z);
    const footStart = angleAt(footMoves[0]?.data.position ?? { x: 10, z: 0 });
    const footEnd = angleAt(footMoves[footMoves.length - 1]?.data.position ?? { x: 10, z: 0 });
    const mountedStart = angleAt(mountedMoves[0]?.data.position ?? { x: 10, z: 0 });
    const mountedEnd = angleAt(
      mountedMoves[mountedMoves.length - 1]?.data.position ?? { x: 10, z: 0 },
    );
    expect(Math.abs(footEnd - footStart)).toBeGreaterThan(Math.abs(mountedEnd - mountedStart));
  });

  it('walkToCell: mounted cap also clamps cell-relative movement', async () => {
    const { ctx, sent } = createFakeContext();
    const CELL_ID = 0xc0ffee_1234n;
    ctx.setMountedSpeedCap(4);
    // Without the clamp, speed=10 would give 2m/tick → 10 ticks for 20m.
    // With the clamp at 4 → 0.8m/tick → 25 ticks.
    await ctx.walkToCell(CELL_ID, { x: 0, z: 20 }, { speed: 10, tickMs: 200 });
    // Cell movement uses CM_netUpdateTransformWithParent (id 241).
    const moves = sent.filter((m) => 'message' in m && (m as { message: number }).message === 241);
    expect(moves.length).toBeGreaterThanOrEqual(24);
    expect(moves.length).toBeLessThanOrEqual(26);
  });

  it('setMountedSpeedCap(null) restores on-foot behavior', async () => {
    const { ctx, sent } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    ctx.setMountedSpeedCap(5);
    ctx.setMountedSpeedCap(null);
    expect(ctx.mountedSpeedCap()).toBeNull();
    await ctx.walkTo({ x: 0, z: 20 }, { speed: 10, tickMs: 200 });
    // No clamp → speed=10, tickMs=200ms → 2m/tick → 10 ticks.
    expect(movementSends(sent).length).toBe(10);
  });
});
