import { describe, expect, it } from 'vitest';
import { createFakeContext, movementSends } from './test-helpers.js';

/**
 * Engine-locked movement speed. On foot the walk primitives always run at
 * `BASE_RUN_SPEED` (7.3 m/s, the canonical `speed[MT_run]` from
 * `shared_base_player.tpf`). When `ctx.mountedSpeedCap()` is set (via
 * `ctx.mount(vehicleId)` or `setMountedSpeedCap()`), the cap replaces the
 * base run speed — faster mounts go faster, slower mounts go slower.
 */
describe('movement (speed lock + mounted cap)', () => {
  it('walkTo: on foot, runs at BASE_RUN_SPEED (~7.3 m/s)', async () => {
    const { ctx, sent } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    // 20m @ 7.3 m/s @ 200ms tick → ~1.46m/tick → ~14 ticks
    await ctx.walkTo({ x: 0, z: 20 }, { tickMs: 200 });
    const moves = movementSends(sent);
    expect(moves.length).toBeGreaterThanOrEqual(13);
    expect(moves.length).toBeLessThanOrEqual(15);
  });

  it('walkTo: mounted with cap=5 walks at the cap (slower than base)', async () => {
    const { ctx, sent } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    ctx.setMountedSpeedCap(5);
    await ctx.walkTo({ x: 0, z: 20 }, { tickMs: 200 });
    // 5 m/s @ 200ms → 1m/tick. 20m → 20 ticks.
    const moves = movementSends(sent);
    expect(moves.length).toBe(20);
  });

  it('walkTo: mounted with cap=20 walks at the cap (faster than base)', async () => {
    const { ctx, sent } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    ctx.setMountedSpeedCap(20);
    await ctx.walkTo({ x: 0, z: 20 }, { tickMs: 200 });
    // 20 m/s @ 200ms → 4m/tick. 20m → 5 ticks.
    const moves = movementSends(sent);
    expect(moves.length).toBe(5);
  });

  it('mount() sets a default speed cap (12 m/s — speeder-bike default)', async () => {
    const { ctx, sent } = createFakeContext();
    expect(ctx.mountedSpeedCap()).toBeNull();
    ctx.mount(0xabcdn);
    expect(ctx.mountedSpeedCap()).toBe(12);
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

  it('walkCircle: implicit speed is capped — mounted-slow sweeps less arc per tick than on-foot', async () => {
    const { ctx: foot, sent: footSent } = createFakeContext({
      startPosition: { x: 5, y: 0, z: 0 },
    });
    const { ctx: mounted, sent: mountedSent } = createFakeContext({
      startPosition: { x: 5, y: 0, z: 0 },
    });
    mounted.setMountedSpeedCap(2);

    // Tight 5m radius in 1s would imply ~31 m/s tangential — way over both
    // BASE_RUN_SPEED (foot) and cap=2 (mounted). Both clamp; the mounted one
    // clamps harder, so the mounted arc per tick is shorter.
    await foot.walkCircle({ centerX: 0, centerZ: 0, radius: 5, durationMs: 1000, tickMs: 200 });
    await mounted.walkCircle({ centerX: 0, centerZ: 0, radius: 5, durationMs: 1000, tickMs: 200 });

    const footMoves = movementSends(footSent);
    const mountedMoves = movementSends(mountedSent);
    expect(footMoves.length).toBe(mountedMoves.length);
    const angleAt = (p: { x: number; z: number }): number => Math.atan2(p.x, p.z);
    const footStart = angleAt(footMoves[0]?.data.position ?? { x: 5, z: 0 });
    const footEnd = angleAt(footMoves[footMoves.length - 1]?.data.position ?? { x: 5, z: 0 });
    const mountedStart = angleAt(mountedMoves[0]?.data.position ?? { x: 5, z: 0 });
    const mountedEnd = angleAt(
      mountedMoves[mountedMoves.length - 1]?.data.position ?? { x: 5, z: 0 },
    );
    expect(Math.abs(footEnd - footStart)).toBeGreaterThan(Math.abs(mountedEnd - mountedStart));
  });

  it('walkToCell: mounted cap also caps cell-relative movement', async () => {
    const { ctx, sent } = createFakeContext();
    const CELL_ID = 0xc0ffee_1234n;
    ctx.setMountedSpeedCap(4);
    // 20m at cap 4 m/s @ 200ms → 0.8m/tick → 25 ticks.
    await ctx.walkToCell(CELL_ID, { x: 0, z: 20 }, { tickMs: 200 });
    const moves = sent.filter((m) => 'message' in m && (m as { message: number }).message === 241);
    expect(moves.length).toBeGreaterThanOrEqual(24);
    expect(moves.length).toBeLessThanOrEqual(26);
  });

  it('setMountedSpeedCap(null) restores BASE_RUN_SPEED behaviour', async () => {
    const { ctx, sent } = createFakeContext({ startPosition: { x: 0, y: 0, z: 0 } });
    ctx.setMountedSpeedCap(5);
    ctx.setMountedSpeedCap(null);
    expect(ctx.mountedSpeedCap()).toBeNull();
    await ctx.walkTo({ x: 0, z: 20 }, { tickMs: 200 });
    // Back to BASE_RUN_SPEED=7.3 m/s — same as test #1 (~14 ticks).
    const moves = movementSends(sent);
    expect(moves.length).toBeGreaterThanOrEqual(13);
    expect(moves.length).toBeLessThanOrEqual(15);
  });
});
