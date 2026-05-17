/**
 * GroupView — live, always-fresh view of the player's group state.
 *
 * Where `CharacterSheet.groupId` just surfaces the raw `m_group`
 * NetworkId, `GroupView` joins that with the WorldModel:
 *
 *   - `id` — the GroupObject NetworkId; `null` if not in a group.
 *   - `members[]` — the GroupObject's roster (from its decoded
 *     `GroupObjectSharedNpBaseline.members`), each member resolved
 *     against `world.get(memberId)` for live position / posture / HAM.
 *   - `size` / `leader` — derived from `members[]`; `members[0]` is the
 *     server-side leader (see `GroupObject::makeLeader`).
 *   - `follow(leaderId)` — engine subscribes to UpdateTransformMessage /
 *     UpdateTransformWithParentMessage broadcasts for `leaderId` and
 *     re-emits them as the local player's own `CM_netUpdateTransform`
 *     ObjController; returns an unsubscribe fn.
 *
 * The GroupObject is a universe-level object — the same GroupObject's
 * baseline arrives at every member, so each client's WorldModel has it
 * once `m_group` is set. We re-derive `members[]` on every read so the
 * latest `BaselinesMessage`/`DeltasMessage` for the GroupObject's
 * SHARED_NP package is reflected without manual cache invalidation.
 *
 * Lifetime: created in `createScriptContext` alongside `CharacterSheet`
 * and `DatapadView`; detached at script teardown. `follow()` registers
 * its own unsubscribe that's also cleaned up at teardown.
 */

import { ByteStream } from '../archive/byte-stream.js';
import type { CreatureObjectSharedNpBaseline } from '../messages/game/baselines/creature-object-baseline-6.js';
import type { GroupObjectSharedNpBaseline } from '../messages/game/baselines/group-object-baseline-6.js';
import { BaselinePackageIds } from '../messages/game/baselines/registry.js';
import { CLIENT_TO_AUTH_SERVER_FLAGS } from '../messages/game/command-queue/index.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import {
  type NetUpdateTransformData,
  NetUpdateTransformDecoder,
  ObjControllerSubtypeIds,
} from '../messages/game/obj-controller/index.js';
import { UpdateTransformMessage } from '../messages/game/update-transform-message.js';
import { UpdateTransformWithParentMessage } from '../messages/game/update-transform-with-parent-message.js';
import type { NetworkId, Vector3 } from '../types.js';
import type { CharacterSheet, HamBar, PostureName } from './character-sheet.js';
import { postureName } from './character-sheet.js';
import type { MessageDispatcher } from './dispatcher.js';
import type { WorldModel } from './world-model.js';

/**
 * One entry in a `GroupView.members` array. `id` and `name` come from the
 * GroupObject roster; live `position` / `health` / `posture` are looked up
 * in the WorldModel on every read (so they reflect the latest transforms /
 * CREO deltas without re-derivation).
 */
export interface GroupMember {
  /** Member's CREO NetworkId. */
  id: NetworkId;
  /** Display name from the GroupObject roster. */
  name: string;
  /**
   * World position from the member's CREO WorldObject; `null` if the
   * member's CREO hasn't been observed in this client's world model
   * (different planet, out of broadcast range, etc.).
   */
  position: Vector3 | null;
  /**
   * Health bar from the member's CREO SHARED_NP baseline; `null` if their
   * CREO hasn't been observed or if their SHARED_NP baseline hasn't
   * arrived yet (i.e. `totalAttributes`/`totalMaxAttributes` empty).
   */
  health: HamBar | null;
  /**
   * Posture as a display string (`'standing'`, `'sitting'`, etc.); `null`
   * if the member's CREO hasn't been observed.
   */
  posture: PostureName | null;
  /**
   * 2D ground distance from the local player; `null` if either party's
   * position is unknown.
   */
  distance: number | null;
}

/**
 * Read-only view exposed on `ScriptContext.group`. All getters re-derive
 * from the world model + character sheet, so reads are always current.
 */
export interface GroupView {
  /** GroupObject NetworkId, or `null` when not in a group. */
  readonly id: NetworkId | null;
  /**
   * Member roster ordered with the leader at index 0. Empty when not in a
   * group OR when the GroupObject's SHARED_NP baseline hasn't been
   * decoded yet (the latter can happen briefly if the local `m_group`
   * delta lands before the GroupObject's baseline broadcast).
   */
  readonly members: GroupMember[];
  /** `members.length`. */
  readonly size: number;
  /** `members[0]` or `null`. */
  readonly leader: GroupMember | null;
  /**
   * Mirror the leader's transforms. Each `UpdateTransformMessage` /
   * `UpdateTransformWithParentMessage` broadcast for `leaderId` is
   * re-emitted as the local player's own `ObjControllerMessage(
   * CM_netUpdateTransform=113)` with `speed=0` (the server derives speed
   * from positional deltas — see CLAUDE.md gotcha 6).
   *
   * Returns an unsubscribe function. Calling it removes the dispatcher
   * subscription; the local player's own transforms are unaffected.
   *
   * **Pre-condition**: caller MUST have already invoked
   * `ctx.ackPendingTeleports()` once after zone-in. The follow-loop bypasses
   * the script-context movement helpers (which would do this automatically)
   * and goes directly through `dispatcher.send(...)`, so a teleport-locked
   * client will see the server silently drop every mirrored transform.
   */
  follow(leaderId: NetworkId): () => void;
}

/**
 * Lookup `CreatureObjectSharedNpBaseline` on a `WorldObject` if it exists.
 * Returns the decoded shape (sparse — only the fields the latest
 * baseline + deltas wrote) or `undefined`.
 */
function readCreoSharedNp(
  world: WorldModel,
  id: NetworkId,
): CreatureObjectSharedNpBaseline | undefined {
  const obj = world.get(id);
  if (obj === undefined) return undefined;
  // CREO SHARED_NP keyed by packageId=6. The shape is sparse-merged by the
  // WorldModel from baselines + deltas.
  const b = obj.baselines.get(BaselinePackageIds.SHARED_NP);
  if (b === undefined || b instanceof Uint8Array) return undefined;
  return b as CreatureObjectSharedNpBaseline;
}

/**
 * `Attributes::Enumerator` — Health = 0 (same index used in `CharacterSheet`).
 */
const HEALTH_ATTR_INDEX = 0;

function hamFor(
  np: CreatureObjectSharedNpBaseline | undefined,
  index: number,
): HamBar | null {
  if (np === undefined) return null;
  const total = np.totalAttributes;
  const totalMax = np.totalMaxAttributes;
  // For non-self members we can't fall back to CREO p1 — that's auth-only
  // — so a max of 0 means "unknown" and we return null rather than a
  // misleading 0/0 pair. The self case still works via the character sheet's
  // `health` getter directly.
  const current = Array.isArray(total) ? total[index] ?? 0 : 0;
  const max = Array.isArray(totalMax) ? totalMax[index] ?? 0 : 0;
  if (current === 0 && max === 0) return null;
  return { current, max };
}

/**
 * Compute 2D ground distance between two `Vector3`s (ignoring y) — same
 * metric used by `ctx.findNearest`/etc.
 */
function distance2D(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export interface CreateGroupViewOptions {
  world: WorldModel;
  /** Character sheet — exposes `groupId` and `networkId`. */
  character: CharacterSheet;
  /** Dispatcher — used by `follow()` to subscribe to leader transforms. */
  dispatcher: MessageDispatcher;
  /** Player's NetworkId — used as the source of mirrored transforms. */
  playerNetworkId: NetworkId;
}

/**
 * Internal handle wrapping a `GroupView` plus a cleanup function the
 * script-context teardown calls. Cleanup is idempotent.
 */
export interface GroupViewHandle {
  readonly view: GroupView;
  /** Detach any `follow()` subscriptions still active. */
  detach(): void;
}

export function createGroupView(opts: CreateGroupViewOptions): GroupViewHandle {
  const { world, character, dispatcher, playerNetworkId } = opts;
  const activeFollows: Array<() => void> = [];

  function toMember(id: NetworkId, name: string): GroupMember {
    const obj = world.get(id);
    const np = readCreoSharedNp(world, id);
    const position: Vector3 | null = obj === undefined
      ? null
      : { x: obj.position.x, y: obj.position.y, z: obj.position.z };
    const sharedPosture = (() => {
      if (obj === undefined) return null;
      const p3 = obj.baselines.get(BaselinePackageIds.SHARED) as
        | { posture?: number }
        | undefined;
      if (p3 === undefined || typeof p3.posture !== 'number') return null;
      return postureName(p3.posture);
    })();
    const self = world.get(playerNetworkId);
    const dist: number | null =
      position === null || self === undefined ? null : distance2D(position, self.position);
    return {
      id,
      name,
      position,
      health: hamFor(np, HEALTH_ATTR_INDEX),
      posture: sharedPosture,
      distance: dist,
    };
  }

  function readGroupRoster(): GroupMember[] {
    const groupId = character.groupId;
    if (groupId === null) return [];
    const groupObj = world.get(groupId);
    if (groupObj === undefined) return [];
    const baseline = groupObj.baselines.get(BaselinePackageIds.SHARED_NP) as
      | GroupObjectSharedNpBaseline
      | undefined;
    if (baseline === undefined || baseline instanceof Uint8Array) return [];
    const members = baseline.members;
    if (!Array.isArray(members)) return [];
    return members.map((m) => toMember(m.id, m.name));
  }

  const view: GroupView = {
    get id(): NetworkId | null {
      return character.groupId;
    },
    get members(): GroupMember[] {
      return readGroupRoster();
    },
    get size(): number {
      return readGroupRoster().length;
    },
    get leader(): GroupMember | null {
      const members = readGroupRoster();
      return members[0] ?? null;
    },
    follow(leaderId: NetworkId): () => void {
      let mirrorSeq = 0;
      const mirrorTransform = (x: number, y: number, z: number, yawIdx: number): void => {
        // Re-emit as our own CM_netUpdateTransform. UpdateTransformMessage's
        // wire payload is i16 fixed-point at 1/4-metre resolution (open
        // world); UpdateTransformWithParentMessage uses 1/8-metre (cells).
        // Encode a unit quaternion approximation for the leader's yaw — the
        // server's `handleMove` validates ground movement primarily against
        // the anti-cheat speed cap (derived from position+syncStamp delta),
        // not the rotation accuracy.
        const yawRadians = (yawIdx / 16) * (Math.PI * 2);
        const elapsedMs = Date.now() & 0xffffffff;
        const data: NetUpdateTransformData = {
          syncStamp: elapsedMs >>> 0,
          sequenceNumber: ++mirrorSeq,
          rotation: {
            x: 0,
            y: Math.sin(yawRadians * 0.5),
            z: 0,
            w: Math.cos(yawRadians * 0.5),
          },
          position: { x, y, z },
          speed: 0,
          lookAtYaw: 0,
          useLookAtYaw: false,
        };
        const stream = new ByteStream();
        NetUpdateTransformDecoder.encode(stream, data);
        const obj = new ObjControllerMessage(
          CLIENT_TO_AUTH_SERVER_FLAGS,
          ObjControllerSubtypeIds.CM_netUpdateTransform,
          playerNetworkId,
          0,
          stream.toBytes(),
          { kind: NetUpdateTransformDecoder.kind, data },
        );
        dispatcher.send(obj);
      };
      const handleTransform = (m: UpdateTransformMessage): void => {
        if (m.networkId !== leaderId) return;
        mirrorTransform(m.positionX / 4, m.positionY / 4, m.positionZ / 4, m.yaw);
      };
      const handleTransformWithParent = (m: UpdateTransformWithParentMessage): void => {
        if (m.networkId !== leaderId) return;
        mirrorTransform(m.positionX / 8, m.positionY / 8, m.positionZ / 8, m.yaw);
      };
      const u1 = dispatcher.onMessage(UpdateTransformMessage, handleTransform);
      const u2 = dispatcher.onMessage(
        UpdateTransformWithParentMessage,
        handleTransformWithParent,
      );
      const unsubscribe = (): void => {
        u1();
        u2();
        const idx = activeFollows.indexOf(unsubscribe);
        if (idx >= 0) activeFollows.splice(idx, 1);
      };
      activeFollows.push(unsubscribe);
      return unsubscribe;
    },
  };

  return {
    view,
    detach(): void {
      // Snapshot then iterate — `unsubscribe` mutates `activeFollows`.
      const all = [...activeFollows];
      activeFollows.length = 0;
      for (const u of all) {
        try {
          u();
        } catch {
          // swallow — teardown should never throw.
        }
      }
    },
  };
}
