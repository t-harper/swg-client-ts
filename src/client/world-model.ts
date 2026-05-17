/**
 * WorldModel — live in-memory view of every object the server has told us
 * about. Subscribes to the dispatcher's inbound stream and maintains a
 * `Map<NetworkId, WorldObject>` that absorbs creates, transform updates,
 * containment changes, baselines, deltas, and destroys.
 *
 * Lifetime: one per `SwgClient.fullLifecycle()`. Constructed when the
 * connection stage opens its dispatcher (so it sees the baseline flood)
 * and detached at logout. Exposed on `LifecycleResult.world` and (during
 * the dwell) on `ScriptContext.world`.
 *
 * What gets tracked per object:
 *   - `id`, `typeId` (4-char Tag), `typeIdString`, `templateCrc` / `templateName`
 *   - `position` (world coordinates, derived from f32 Transform on Scene*,
 *     i16/4 fixed-point on UpdateTransformMessage)
 *   - `yaw` (radians; from quaternion on Scene*, from i8/16 on UpdateTransform*)
 *   - `parentCell` + `cellPosition` for cell-parented objects
 *   - `containerId` + `slotArrangement` from `UpdateContainmentMessage`
 *   - `baselines: Map<packageId, T>` — initially set by `BaselinesMessage`
 *     / `BatchBaselinesMessage`, sparse-updated by `DeltasMessage` via
 *     `Object.assign(state, delta.data)`.
 *   - `hyperspace` flag (toggled by `SceneDestroyObject(hyperspace=true)`)
 *
 * Events:
 *   - `'create'` fires when a NetworkId is first observed (Scene* or any
 *     stateful message arriving for an unknown id)
 *   - `'baseline'` fires for every `BaselinesMessage` payload, decoded or not
 *   - `'delta'` fires for every `DeltasMessage` payload where the registry
 *     produced a typed `decodedDelta`
 *   - `'transform'` fires on any position/yaw mutation
 *   - `'containment'` fires on `UpdateContainmentMessage`
 *   - `'destroy'` fires on `SceneDestroyObject`
 *
 * The model is purely reactive — it never sends anything. It's safe to
 * keep references to `WorldObject` instances: they're mutated in place,
 * so `const npc = world.get(id); ... npc.position.x` always reads the
 * latest value.
 */

import { quatToYaw } from '../archive/transform.js';
import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import { BatchBaselinesMessage } from '../messages/game/baselines/batch-baselines-message.js';
import { DeltasMessage } from '../messages/game/baselines/deltas-message.js';
import { tagToString } from '../messages/game/baselines/registry.js';
import { SceneCreateObjectByCrc } from '../messages/game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import { SceneDestroyObject } from '../messages/game/scene-destroy-object.js';
import { UpdateContainmentMessage } from '../messages/game/update-containment-message.js';
import { UpdateTransformMessage } from '../messages/game/update-transform-message.js';
import { UpdateTransformWithParentMessage } from '../messages/game/update-transform-with-parent-message.js';
import type { Vector3 } from '../types.js';
import type { NetworkId } from '../types.js';
import type { MessageDispatcher } from './dispatcher.js';

/**
 * A single object the server has told us about. Mutated in place by
 * `WorldModel` — holding a reference is safe and always reads current
 * state.
 *
 * `typeId` is `0` (`'\0\0\0\0'`) until a `BaselinesMessage` arrives — Scene*
 * creates don't carry the type tag, only the template. Most scripts only
 * care about objects post-baseline, so this is fine in practice.
 */
export interface WorldObject {
  readonly id: NetworkId;
  /** 4-byte object-type Tag (e.g. CREO/TANO/PLAY). `0` until first baseline. */
  typeId: number;
  /** Human-readable form of `typeId` (e.g. 'CREO'). `'\0\0\0\0'` until first baseline. */
  typeIdString: string;
  /** Template CRC from `SceneCreateObjectByCrc`. `undefined` if only name-create or baselines-only. */
  templateCrc?: number;
  /** Template path from `SceneCreateObjectByName`. `undefined` if only crc-create. */
  templateName?: string;
  /** World position. Updated by Scene* creates and UpdateTransform*. */
  position: Vector3;
  /** Heading in radians. Updated by Scene* (from quaternion) and UpdateTransform* (i8/16 quant). */
  yaw: number;
  /** Cell-parent NetworkId (`0n` = in the open world). Updated by UpdateContainmentMessage + UpdateTransformWithParentMessage. */
  parentCell: NetworkId;
  /** Cell-relative position when `parentCell !== 0n`. */
  cellPosition: Vector3;
  /** Container that holds this object (`0n` = unparented). Distinct from `parentCell` — UpdateContainmentMessage carries it. */
  containerId: NetworkId;
  /** Slot index within `containerId` (`-1` = no specific slot). */
  slotArrangement: number;
  /** True if the most recent SceneDestroyObject marked us as hyperspaced (vs deleted). */
  hyperspace: boolean;
  /**
   * Per-package baseline state. Key = BASELINES_* / DELTAS_* enum value
   * (e.g. `1` = CLIENT_SERVER, `3` = SHARED). Value = the typed baseline
   * data for that package, sparse-updated by deltas.
   *
   * The same key carries:
   *   - `BaselinesMessage.decodedBaseline.data` initially
   *   - `BaselinesMessage.packageBytes` if no decoder is registered
   *   - Mutated in place by `DeltasMessage.decodedDelta.data` when a
   *     delta package decoder is registered AND the baseline was decoded
   *     (otherwise the delta is logged but can't be merged into opaque bytes).
   */
  baselines: Map<number, unknown>;
  /** Wall-clock ms when this id was first observed. */
  firstSeenAt: number;
  /** Wall-clock ms of the most recent mutation. */
  lastUpdatedAt: number;
}

export type WorldEventKind =
  | 'create'
  | 'baseline'
  | 'delta'
  | 'transform'
  | 'containment'
  | 'destroy';

/**
 * Discriminated event union dispatched by `WorldModel.on(kind, handler)`.
 *
 * `'destroy'` carries `object: undefined` after the entry has been removed;
 * the snapshot of the object's last known state is provided via
 * `lastKnown`. All other events carry the live `WorldObject` instance.
 */
export type WorldEvent =
  | { kind: 'create'; object: WorldObject }
  | {
      kind: 'baseline';
      object: WorldObject;
      packageId: number;
      /** Decoded baseline kind ('TangibleObjectShared', etc.) or null if undecoded. */
      decodedKind: string | null;
      /** Decoded data or the raw bytes if no decoder is registered. */
      data: unknown;
    }
  | {
      kind: 'delta';
      object: WorldObject;
      packageId: number;
      decodedKind: string;
      /** Sparse object: only the fields that changed in this packet. */
      changes: Record<string, unknown>;
    }
  | {
      kind: 'transform';
      object: WorldObject;
      /** True if this came from an UpdateTransformWithParentMessage (cell-relative). */
      withParent: boolean;
    }
  | {
      kind: 'containment';
      object: WorldObject;
      containerId: NetworkId;
      slotArrangement: number;
    }
  | {
      kind: 'destroy';
      objectId: NetworkId;
      lastKnown: WorldObject;
      hyperspace: boolean;
    };

export interface WorldModelOptions {
  dispatcher: MessageDispatcher;
  /**
   * NetworkId of our character. If known, `nearby()` defaults to using the
   * player's current position as the centre. `walkTo`/etc. don't update
   * the WorldModel directly — the player's position in the world is
   * derived from `UpdateTransformMessage` echoes from the server.
   */
  playerId?: NetworkId;
}

export class WorldModel {
  private readonly objs = new Map<NetworkId, WorldObject>();
  private readonly subs = new Set<(e: WorldEvent) => void>();
  private readonly unsubscribers: Array<() => void> = [];
  private playerId: NetworkId | null;

  constructor(opts: WorldModelOptions) {
    this.playerId = opts.playerId ?? null;
    const d = opts.dispatcher;

    this.unsubscribers.push(
      d.onMessage(SceneCreateObjectByCrc, (m) => this.onSceneCreateCrc(m)),
      d.onMessage(SceneCreateObjectByName, (m) => this.onSceneCreateName(m)),
      d.onMessage(SceneDestroyObject, (m) => this.onSceneDestroy(m)),
      d.onMessage(UpdateContainmentMessage, (m) => this.onContainment(m)),
      d.onMessage(UpdateTransformMessage, (m) => this.onTransform(m)),
      d.onMessage(UpdateTransformWithParentMessage, (m) => this.onTransformWithParent(m)),
      d.onMessage(BaselinesMessage, (m) => this.onBaseline(m)),
      d.onMessage(BatchBaselinesMessage, (m) => {
        for (const b of m.baselines) this.onBaseline(b);
      }),
      d.onMessage(DeltasMessage, (m) => this.onDelta(m)),
    );
  }

  /** Unsubscribe from all dispatcher events. Call at logout. */
  detach(): void {
    for (const u of this.unsubscribers) {
      try {
        u();
      } catch {
        // swallow
      }
    }
    this.unsubscribers.length = 0;
  }

  // ─── Query API ──────────────────────────────────────────────────────

  /** Lookup by NetworkId. */
  get(id: NetworkId): WorldObject | undefined {
    return this.objs.get(id);
  }

  has(id: NetworkId): boolean {
    return this.objs.has(id);
  }

  /** Current count of tracked objects. */
  size(): number {
    return this.objs.size;
  }

  /** All tracked objects in insertion order (first-seen). */
  *objects(): IterableIterator<WorldObject> {
    yield* this.objs.values();
  }

  /** Snapshot to an array — convenient for `console.log` and array methods. */
  toArray(): WorldObject[] {
    return [...this.objs.values()];
  }

  /**
   * Filter to objects matching a predicate. Eagerly builds an array — fine for
   * the typical view (low hundreds of objects).
   */
  filter(pred: (obj: WorldObject) => boolean): WorldObject[] {
    const out: WorldObject[] = [];
    for (const o of this.objs.values()) {
      if (pred(o)) out.push(o);
    }
    return out;
  }

  /**
   * Filter to objects of a specific 4-byte type tag (`ObjectTypeTags.CREO`,
   * etc.). Use this in preference to a manual predicate when type-filtering;
   * it's the common case.
   */
  byType(typeId: number): WorldObject[] {
    return this.filter((o) => o.typeId === typeId);
  }

  /**
   * Objects within `radiusM` of `center` (or the player position if `center`
   * is omitted and a `playerId` was supplied at construction). Returns
   * results in ascending distance order.
   *
   * Uses 2D distance (x, z); `y` is ignored because SWG's anti-cheat
   * altitude window is small enough that 2D distance dominates.
   */
  nearby(radiusM: number, center?: Vector3): WorldObject[] {
    const c = center ?? this.playerPosition();
    if (c === null) return [];
    const r2 = radiusM * radiusM;
    const out: Array<[WorldObject, number]> = [];
    for (const o of this.objs.values()) {
      const dx = o.position.x - c.x;
      const dz = o.position.z - c.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= r2) out.push([o, d2]);
    }
    out.sort((a, b) => a[1] - b[1]);
    return out.map(([o]) => o);
  }

  /**
   * The player's current world position, or `null` if no `playerId` was
   * supplied at construction OR no transform has arrived yet.
   */
  playerPosition(): Vector3 | null {
    if (this.playerId === null) return null;
    const p = this.objs.get(this.playerId);
    if (p === undefined) return null;
    return p.position;
  }

  /**
   * Pin the player's NetworkId after construction. Typically called from
   * the orchestrator once `CmdStartScene` arrives (which carries
   * `playerNetworkId`). `nearby()` defaults to using the player's position.
   */
  setPlayerId(id: NetworkId): void {
    this.playerId = id;
  }

  /** The player's NetworkId, if set. */
  getPlayerId(): NetworkId | null {
    return this.playerId;
  }

  // ─── Event API ──────────────────────────────────────────────────────

  /**
   * Subscribe to world events. Returns an unsubscribe function. Handler is
   * called synchronously inside the dispatch loop — keep it fast and don't
   * throw (throws are swallowed).
   */
  on(handler: (e: WorldEvent) => void): () => void {
    this.subs.add(handler);
    return () => {
      this.subs.delete(handler);
    };
  }

  private emit(event: WorldEvent): void {
    for (const h of this.subs) {
      try {
        h(event);
      } catch {
        // swallow
      }
    }
  }

  // ─── Inbound message handlers ──────────────────────────────────────

  private touch(id: NetworkId, typeIdHint?: number): WorldObject {
    let obj = this.objs.get(id);
    if (obj === undefined) {
      const now = Date.now();
      obj = {
        id,
        typeId: typeIdHint ?? 0,
        typeIdString: typeIdHint !== undefined ? tagToString(typeIdHint) : '\0\0\0\0',
        position: { x: 0, y: 0, z: 0 },
        yaw: 0,
        parentCell: 0n,
        cellPosition: { x: 0, y: 0, z: 0 },
        containerId: 0n,
        slotArrangement: -1,
        hyperspace: false,
        baselines: new Map(),
        firstSeenAt: now,
        lastUpdatedAt: now,
      };
      this.objs.set(id, obj);
      this.emit({ kind: 'create', object: obj });
    } else if (typeIdHint !== undefined && obj.typeId === 0) {
      obj.typeId = typeIdHint;
      obj.typeIdString = tagToString(typeIdHint);
    }
    return obj;
  }

  private onSceneCreateCrc(m: SceneCreateObjectByCrc): void {
    const obj = this.touch(m.networkId);
    obj.templateCrc = m.templateCrc;
    obj.position = {
      x: m.transform.position.x,
      y: m.transform.position.y,
      z: m.transform.position.z,
    };
    obj.yaw = quatToYaw(m.transform.rotation);
    obj.hyperspace = m.hyperspace;
    obj.lastUpdatedAt = Date.now();
    this.emit({ kind: 'transform', object: obj, withParent: false });
  }

  private onSceneCreateName(m: SceneCreateObjectByName): void {
    const obj = this.touch(m.networkId);
    obj.templateName = m.templateName;
    obj.position = {
      x: m.transform.position.x,
      y: m.transform.position.y,
      z: m.transform.position.z,
    };
    obj.yaw = quatToYaw(m.transform.rotation);
    obj.hyperspace = m.hyperspace;
    obj.lastUpdatedAt = Date.now();
    this.emit({ kind: 'transform', object: obj, withParent: false });
  }

  private onSceneDestroy(m: SceneDestroyObject): void {
    const obj = this.objs.get(m.networkId);
    if (obj === undefined) return;
    obj.hyperspace = m.hyperspace;
    this.objs.delete(m.networkId);
    this.emit({ kind: 'destroy', objectId: m.networkId, lastKnown: obj, hyperspace: m.hyperspace });
  }

  private onContainment(m: UpdateContainmentMessage): void {
    const obj = this.touch(m.networkId);
    obj.containerId = m.containerId;
    obj.slotArrangement = m.slotArrangement;
    obj.lastUpdatedAt = Date.now();
    this.emit({
      kind: 'containment',
      object: obj,
      containerId: m.containerId,
      slotArrangement: m.slotArrangement,
    });
  }

  private onTransform(m: UpdateTransformMessage): void {
    const obj = this.touch(m.networkId);
    // World wire is i16 fixed-point * 4 (0.25m resolution).
    obj.position = {
      x: m.positionX / 4,
      y: m.positionY / 4,
      z: m.positionZ / 4,
    };
    // Yaw wire is i8 * 16 (rounded to nearest 1/16 radian).
    obj.yaw = m.yaw / 16;
    obj.parentCell = 0n;
    obj.lastUpdatedAt = Date.now();
    this.emit({ kind: 'transform', object: obj, withParent: false });
  }

  private onTransformWithParent(m: UpdateTransformWithParentMessage): void {
    const obj = this.touch(m.networkId);
    // Cell wire is i16 fixed-point * 8 (0.125m resolution).
    obj.cellPosition = {
      x: m.positionX / 8,
      y: m.positionY / 8,
      z: m.positionZ / 8,
    };
    obj.yaw = m.yaw / 16;
    obj.parentCell = m.cellId;
    obj.lastUpdatedAt = Date.now();
    this.emit({ kind: 'transform', object: obj, withParent: true });
  }

  private onBaseline(m: BaselinesMessage): void {
    const obj = this.touch(m.target, m.typeId);
    const data = m.decodedBaseline?.data ?? m.packageBytes;
    obj.baselines.set(m.packageId, data);
    obj.lastUpdatedAt = Date.now();
    this.emit({
      kind: 'baseline',
      object: obj,
      packageId: m.packageId,
      decodedKind: m.decodedBaseline?.kind ?? null,
      data,
    });
  }

  private onDelta(m: DeltasMessage): void {
    const obj = this.touch(m.target, m.typeId);
    obj.lastUpdatedAt = Date.now();
    // Only merge if we got a typed decode; opaque-bytes baselines can't be
    // merged with typed sparse changes.
    if (m.decodedDelta === null) return;
    const changes = m.decodedDelta.data as Record<string, unknown>;
    const current = obj.baselines.get(m.packageId);
    if (current && typeof current === 'object' && !(current instanceof Uint8Array)) {
      Object.assign(current as Record<string, unknown>, changes);
    } else {
      // No baseline yet (or opaque bytes): seed the sparse map so consumers
      // can still query what's been observed.
      obj.baselines.set(m.packageId, { ...changes });
    }
    this.emit({
      kind: 'delta',
      object: obj,
      packageId: m.packageId,
      decodedKind: m.decodedDelta.kind,
      changes,
    });
  }

  // Used by tests; not part of the public API.
  /** @internal */
  _clear(): void {
    this.objs.clear();
  }
}
