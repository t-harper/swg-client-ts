/**
 * Movement primitives — tick-based ObjControllerMessage senders.
 *
 * Wire encoding (matches the real Windows client, verified via pcap):
 *   ObjControllerMessage(
 *     flags = 0x23 (CLIENT_TO_AUTH_SERVER_FLAGS),
 *     message = CM_netUpdateTransform (113)         // CM_netUpdateTransformWithParent (241) when inside a cell
 *     networkId = playerNetworkId,
 *     value = 0,
 *     data = MessageQueueDataTransform { syncStamp, seq, rotation, position, speed=0, lookAtYaw=0, useLookAtYaw=0 }
 *   )
 *
 * **DO NOT** use top-level `UpdateTransformMessage` for client→server sends —
 * the server silently drops it. UpdateTransformMessage is the server's
 * broadcast wire form; client→server movement goes through the
 * ObjController/CM_netUpdateTransform subtype above (verified in the C++
 * server source: `Client::receiveClientMessage` dispatches CM_* via
 * `ControllerMessageFactory::unpack`, and only ObjControllerMessage carries
 * those subtypes).
 *
 * **Speed field**: the real client sends `speed=0`. The server derives the
 * effective speed from `distance / (syncStamp delta seconds)`. Sending a
 * non-zero speed causes the server's anti-cheat to validate against the
 * creature's allowed walk/run cap which may reject moves for freshly-spawned
 * characters whose skill tables haven't fully populated yet.
 *
 * **Cadence**: the real Windows client emits ~1 packet every 2–3s during
 * sustained movement with 5–10m position deltas (effective ~3–4 m/s). Our
 * default tickMs is 500ms so that with the default 4 m/s speed we send
 * roughly one update per 2m of travel.
 *
 * **Teleport-ACK bootstrap**: before the first transform is accepted by the
 * server, the client MUST acknowledge the zone-in teleport-lockout signal
 * (see `ctx.ackPendingTeleports`). The walk primitives call this
 * automatically on first invocation per context.
 */

import { ByteStream } from '../../archive/byte-stream.js';
import { yawToQuat } from '../../archive/transform.js';
import { CLIENT_TO_AUTH_SERVER_FLAGS } from '../../messages/game/command-queue/index.js';
import {
  type NetUpdateTransformData,
  NetUpdateTransformDecoder,
  type NetUpdateTransformWithParentData,
  NetUpdateTransformWithParentDecoder,
  ObjControllerSubtypeIds,
} from '../../messages/game/obj-controller/index.js';
import { ObjControllerMessage } from '../../messages/game/obj-controller-message.js';
import type { NetworkId } from '../../types.js';
import type { ScriptContext } from './context.js';

export interface WalkToOptions {
  /** Walking speed in meters/sec. Default 4 (slow run). */
  speed?: number;
  /**
   * Update cadence in ms. Default 500 (~2 updates / second) — matches the
   * sparseness of real-client movement and stays well under the server's
   * anti-cheat speed window.
   */
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
  /** Update cadence in ms. Default 500. */
  tickMs?: number;
  /** Override the y-coordinate (otherwise hold current y). */
  y?: number;
  /** Direction: 1 = counter-clockwise (default), -1 = clockwise. */
  direction?: 1 | -1;
}

const MAX_DISTANCE_PER_TICK_METERS = 8;

export async function walkTo(
  ctx: ScriptContext,
  target: { x: number; z: number; y?: number },
  opts: WalkToOptions,
): Promise<void> {
  await ctx.ackPendingTeleports();
  const speed = opts.speed ?? 4;
  const tickMs = opts.tickMs ?? 500;
  const tickSeconds = tickMs / 1000;
  const startY = opts.y ?? target.y ?? ctx.position().y;

  const cur = ctx.position();
  const dx = target.x - cur.x;
  const dz = target.z - cur.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 1e-6) {
    sendTransform(ctx, target.x, startY, target.z, ctx.yaw());
    return;
  }

  const yaw = Math.atan2(dx, dz);
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
    sendTransform(ctx, x, startY, z, yaw);
    if (!isLast) {
      await sleep(tickMs, ctx.signal);
    }
  }
}

export async function walkCircle(ctx: ScriptContext, opts: CircleOptions): Promise<void> {
  await ctx.ackPendingTeleports();
  const tickMs = opts.tickMs ?? 500;
  const tickSeconds = tickMs / 1000;
  const direction = opts.direction ?? 1;
  const y = opts.y ?? ctx.position().y;

  const omega =
    opts.speed !== undefined
      ? (direction * opts.speed) / opts.radius
      : (direction * (2 * Math.PI * 1000)) / opts.durationMs;

  const cur = ctx.position();
  let theta = Math.atan2(cur.x - opts.centerX, cur.z - opts.centerZ);

  const totalTicks = Math.max(1, Math.floor(opts.durationMs / tickMs));
  for (let i = 0; i < totalTicks; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    theta += omega * tickSeconds;
    const x = opts.centerX + opts.radius * Math.sin(theta);
    const z = opts.centerZ + opts.radius * Math.cos(theta);
    const vx = direction * Math.cos(theta);
    const vz = -direction * Math.sin(theta);
    const yaw = Math.atan2(vx, vz);
    sendTransform(ctx, x, y, z, yaw);
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
): void {
  const data: NetUpdateTransformData = {
    syncStamp: ctx.nextSyncStamp(),
    sequenceNumber: ctx.nextSequenceNumber(),
    rotation: yawToQuat(yaw),
    position: { x, y, z },
    speed: 0,
    lookAtYaw: 0,
    useLookAtYaw: false,
  };
  const stream = new ByteStream();
  NetUpdateTransformDecoder.encode(stream, data);
  ctx.send(
    new ObjControllerMessage(
      CLIENT_TO_AUTH_SERVER_FLAGS,
      ObjControllerSubtypeIds.CM_netUpdateTransform,
      ctx.sceneStart.playerNetworkId,
      0,
      stream.toBytes(),
      { kind: NetUpdateTransformDecoder.kind, data },
    ),
  );
  ctx.setPose({ x, y, z }, yaw);
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
// Cell-relative movement (CM_netUpdateTransformWithParent)
// -----------------------------------------------------------------------------

/**
 * Options for `walkToCell`. Mirrors `WalkToOptions`. Position fields are in
 * the parent cell's local coordinate frame (origin = cell origin, axes =
 * cell axes), not world coords.
 */
export interface WalkToCellOptions {
  /** Walking speed in meters/sec. Default 4 (slow run). */
  speed?: number;
  /** Update cadence in ms. Default 500. */
  tickMs?: number;
  /** Override the cell-relative y-coordinate (otherwise hold current cell y, defaulting to 0). */
  y?: number;
}

/**
 * Walk to (x, z) inside `parentId`'s cell-local coordinate frame. Uses
 * CM_netUpdateTransformWithParent (id 241) — the cell variant of the
 * movement subtype.
 */
export async function walkToCell(
  ctx: ScriptContext,
  parentId: NetworkId,
  target: { x: number; z: number; y?: number },
  opts: WalkToCellOptions = {},
): Promise<void> {
  await ctx.ackPendingTeleports();
  const speed = opts.speed ?? 4;
  const tickMs = opts.tickMs ?? 500;
  const tickSeconds = tickMs / 1000;
  const cellCursor = ctx.cellPosition();
  const startCursor =
    ctx.parentCell() === parentId ? cellCursor : { x: 0, y: opts.y ?? 0, z: 0 };
  const startY = opts.y ?? target.y ?? startCursor.y;

  const dx = target.x - startCursor.x;
  const dz = target.z - startCursor.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 1e-6) {
    sendCellTransform(ctx, parentId, target.x, startY, target.z, ctx.yaw());
    return;
  }

  const yaw = Math.atan2(dx, dz);
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
    sendCellTransform(ctx, parentId, x, startY, z, yaw);
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
): void {
  const data: NetUpdateTransformWithParentData = {
    parentCell: parentId,
    syncStamp: ctx.nextSyncStamp(),
    sequenceNumber: ctx.nextSequenceNumber(),
    rotation: yawToQuat(yaw),
    position: { x, y, z },
    speed: 0,
    lookAtYaw: 0,
    useLookAtYaw: false,
  };
  const stream = new ByteStream();
  NetUpdateTransformWithParentDecoder.encode(stream, data);
  ctx.send(
    new ObjControllerMessage(
      CLIENT_TO_AUTH_SERVER_FLAGS,
      ObjControllerSubtypeIds.CM_netUpdateTransformWithParent,
      ctx.sceneStart.playerNetworkId,
      0,
      stream.toBytes(),
      { kind: NetUpdateTransformWithParentDecoder.kind, data },
    ),
  );
  ctx.setCellPose(parentId, { x, y, z }, yaw);
}
