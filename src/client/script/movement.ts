/**
 * Movement primitives — tick-based UpdateTransformMessage senders.
 *
 * Wire encoding (matches `UpdateTransformMessage`):
 *   - position: meters → i16 via `Math.round(meters * 4)` (0.25m resolution)
 *   - yaw:     radians → i8 via `Math.round(yaw * 16)` (clamped)
 *   - speed:    passed through as i8 (server validates)
 *
 * The server's PlayerCreatureController enforces ~100m max distance per
 * update and a speed-tolerance check; we keep ticks small and split long
 * moves into multiple ticks. Default cadence 200ms (~5Hz), matching what
 * the real Windows client emits while running.
 */

import { UpdateTransformMessage } from '../../messages/game/update-transform-message.js';
import { UpdateTransformWithParentMessage } from '../../messages/game/update-transform-with-parent-message.js';
import type { NetworkId } from '../../types.js';
import type { ScriptContext } from './context.js';

export interface WalkToOptions {
  /** Walking speed in meters/sec. Default 5 (run speed). */
  speed?: number;
  /** Update cadence in ms. Default 200. */
  tickMs?: number;
  /** Override the y-coordinate (otherwise hold current y). */
  y?: number;
}

export interface CircleOptions {
  centerX: number;
  centerZ: number;
  radius: number;
  durationMs: number;
  /** Tangential speed in m/s. If omitted, completes exactly one revolution in durationMs. */
  speed?: number;
  /** Update cadence in ms. Default 200. */
  tickMs?: number;
  /** Override the y-coordinate (otherwise hold current y). */
  y?: number;
  /** Direction: 1 = counter-clockwise (default), -1 = clockwise. */
  direction?: 1 | -1;
}

const MAX_DISTANCE_PER_TICK_METERS = 90; // stay safely under server's ~100m cap
const POSITION_QUANT = 4; // wire units per meter
const YAW_QUANT = 16; // wire units per radian
const POSITION_WIRE_MIN = -0x8000;
const POSITION_WIRE_MAX = 0x7fff;
const YAW_WIRE_MIN = -0x80;
const YAW_WIRE_MAX = 0x7f;

export async function walkTo(
  ctx: ScriptContext,
  target: { x: number; z: number; y?: number },
  opts: WalkToOptions,
): Promise<void> {
  const speed = opts.speed ?? 5;
  const tickMs = opts.tickMs ?? 200;
  const tickSeconds = tickMs / 1000;
  const startY = opts.y ?? target.y ?? ctx.position().y;

  let cur = ctx.position();
  const dx = target.x - cur.x;
  const dz = target.z - cur.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 1e-6) {
    // Nothing to do; still send one update so the server knows our yaw.
    sendTransform(ctx, target.x, startY, target.z, ctx.yaw(), speed);
    return;
  }

  const yaw = Math.atan2(dx, dz); // SWG: z = north, x = east → atan2(x,z) is heading
  const stepLen = Math.min(speed * tickSeconds, MAX_DISTANCE_PER_TICK_METERS);
  const totalTicks = Math.max(1, Math.ceil(distance / stepLen));
  const ux = dx / distance;
  const uz = dz / distance;

  for (let i = 1; i <= totalTicks; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const isLast = i === totalTicks;
    const traveled = isLast ? distance : stepLen * i;
    const x = isLast ? target.x : cur.x + ux * traveled;
    const z = isLast ? target.z : cur.z + uz * traveled;
    sendTransform(ctx, x, startY, z, yaw, speed);
    if (!isLast) {
      await sleep(tickMs, ctx.signal);
    }
  }
}

export async function walkCircle(ctx: ScriptContext, opts: CircleOptions): Promise<void> {
  const tickMs = opts.tickMs ?? 200;
  const tickSeconds = tickMs / 1000;
  const direction = opts.direction ?? 1;
  const y = opts.y ?? ctx.position().y;

  // omega = angular velocity in rad/sec. If speed given, omega = v / r.
  // Otherwise, default to one full revolution in durationMs.
  const omega =
    opts.speed !== undefined
      ? (direction * opts.speed) / opts.radius
      : (direction * (2 * Math.PI * 1000)) / opts.durationMs;
  // Tangential linear speed for the wire speed field
  const speed = Math.abs(omega * opts.radius);

  // Seed theta from current position relative to the centre.
  const cur = ctx.position();
  let theta = Math.atan2(cur.x - opts.centerX, cur.z - opts.centerZ);

  const totalTicks = Math.max(1, Math.floor(opts.durationMs / tickMs));
  for (let i = 0; i < totalTicks; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    theta += omega * tickSeconds;
    const x = opts.centerX + opts.radius * Math.sin(theta);
    const z = opts.centerZ + opts.radius * Math.cos(theta);
    // Tangent to a circle traced by (sin, cos) is (cos, -sin) for CCW;
    // heading in SWG = atan2(x', z') of the velocity vector.
    const vx = direction * Math.cos(theta);
    const vz = -direction * Math.sin(theta);
    const yaw = Math.atan2(vx, vz);
    sendTransform(ctx, x, y, z, yaw, speed);
    if (i < totalTicks - 1) {
      await sleep(tickMs, ctx.signal);
    }
  }
}

function sendTransform(
  ctx: ScriptContext,
  x: number,
  y: number,
  z: number,
  yaw: number,
  speed: number,
): void {
  const px = clampInt(Math.round(x * POSITION_QUANT), POSITION_WIRE_MIN, POSITION_WIRE_MAX);
  const py = clampInt(Math.round(y * POSITION_QUANT), POSITION_WIRE_MIN, POSITION_WIRE_MAX);
  const pz = clampInt(Math.round(z * POSITION_QUANT), POSITION_WIRE_MIN, POSITION_WIRE_MAX);
  const yawWire = clampInt(Math.round(yaw * YAW_QUANT), YAW_WIRE_MIN, YAW_WIRE_MAX);
  const speedWire = clampInt(Math.round(speed), YAW_WIRE_MIN, YAW_WIRE_MAX);
  const seq = ctx.nextSequenceNumber();
  ctx.send(new UpdateTransformMessage(ctx.sceneStart.playerNetworkId, px, py, pz, seq, speedWire, yawWire, 0, 0));
  ctx.setPose({ x, y, z }, yaw);
}

function clampInt(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    t.unref?.();
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// -----------------------------------------------------------------------------
// Cell-relative movement (UpdateTransformWithParentMessage)
// -----------------------------------------------------------------------------

/**
 * Options for `walkToCell`. Mirrors `WalkToOptions`. Position fields are in
 * the parent cell's local coordinate frame (origin = cell origin, axes =
 * cell axes), not world coords.
 */
export interface WalkToCellOptions {
  /** Walking speed in meters/sec. Default 5 (run speed). */
  speed?: number;
  /** Update cadence in ms. Default 200. */
  tickMs?: number;
  /** Override the cell-relative y-coordinate (otherwise hold current cell y, defaulting to 0). */
  y?: number;
}

/** Cell-relative position quantization: int16 fixed-point * 8 (0.125m resolution). */
const CELL_POSITION_QUANT = 8; // wire units per meter for cell-relative coords

/**
 * Walk to (x, z) inside `parentId`'s cell-local coordinate frame.
 *
 * Uses `UpdateTransformWithParentMessage` with the same tick/quantization
 * approach as `walkTo`, but with the cell-relative `* 8` position scale.
 * The orchestrator's pose cursor is intentionally NOT updated by this
 * function (it tracks world coords); use `ctx.cellPosition()` /
 * `ctx.parentCell()` to read the cell-relative cursor that `walkToCell`
 * maintains via `ctx.setCellPose`.
 *
 * Note: there is no `walkCircle` for cell-relative coordinates because
 * interior cells are usually small enough that a straight-line walk to a
 * point suffices. If you need a parametric pattern, call this in a loop.
 */
export async function walkToCell(
  ctx: ScriptContext,
  parentId: NetworkId,
  target: { x: number; z: number; y?: number },
  opts: WalkToCellOptions = {},
): Promise<void> {
  const speed = opts.speed ?? 5;
  const tickMs = opts.tickMs ?? 200;
  const tickSeconds = tickMs / 1000;
  const cellCursor = ctx.cellPosition();
  // If we're entering a new cell, reset cursor to (0, 0, 0) — caller should
  // call ctx.setCellPose first if they have a better seed.
  const startCursor =
    ctx.parentCell() === parentId ? cellCursor : { x: 0, y: opts.y ?? 0, z: 0 };
  const startY = opts.y ?? target.y ?? startCursor.y;

  const dx = target.x - startCursor.x;
  const dz = target.z - startCursor.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 1e-6) {
    // Nothing to do; still send one update so the server knows our yaw + parent.
    sendCellTransform(ctx, parentId, target.x, startY, target.z, ctx.yaw(), speed);
    return;
  }

  const yaw = Math.atan2(dx, dz); // SWG: z = north, x = east → atan2(x,z) is heading
  const stepLen = Math.min(speed * tickSeconds, MAX_DISTANCE_PER_TICK_METERS);
  const totalTicks = Math.max(1, Math.ceil(distance / stepLen));
  const ux = dx / distance;
  const uz = dz / distance;

  for (let i = 1; i <= totalTicks; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const isLast = i === totalTicks;
    const traveled = isLast ? distance : stepLen * i;
    const x = isLast ? target.x : startCursor.x + ux * traveled;
    const z = isLast ? target.z : startCursor.z + uz * traveled;
    sendCellTransform(ctx, parentId, x, startY, z, yaw, speed);
    if (!isLast) {
      await sleep(tickMs, ctx.signal);
    }
  }
}

function sendCellTransform(
  ctx: ScriptContext,
  parentId: NetworkId,
  x: number,
  y: number,
  z: number,
  yaw: number,
  speed: number,
): void {
  const px = clampInt(Math.round(x * CELL_POSITION_QUANT), POSITION_WIRE_MIN, POSITION_WIRE_MAX);
  const py = clampInt(Math.round(y * CELL_POSITION_QUANT), POSITION_WIRE_MIN, POSITION_WIRE_MAX);
  const pz = clampInt(Math.round(z * CELL_POSITION_QUANT), POSITION_WIRE_MIN, POSITION_WIRE_MAX);
  const yawWire = clampInt(Math.round(yaw * YAW_QUANT), YAW_WIRE_MIN, YAW_WIRE_MAX);
  const speedWire = clampInt(Math.round(speed), YAW_WIRE_MIN, YAW_WIRE_MAX);
  const seq = ctx.nextSequenceNumber();
  ctx.send(
    new UpdateTransformWithParentMessage(
      parentId,
      ctx.sceneStart.playerNetworkId,
      px,
      py,
      pz,
      seq,
      speedWire,
      yawWire,
      0,
      0,
    ),
  );
  ctx.setCellPose(parentId, { x, y, z }, yaw);
}
