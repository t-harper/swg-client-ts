/**
 * DatapadView — live, always-fresh view of the player's datapad container.
 *
 * The datapad is a per-player container (`slot='datapad'` on the player
 * creature) that holds: vehicle/pet PCDs (PersistentControlDevices),
 * waypoints, missions, ship items, manufacturing schematics. The wire
 * arrival pattern is identical to the inventory: a `SceneCreateObjectByName`
 * whose template path ends in `(shared_)?character_datapad.iff`, then
 * baselines, then per-entry `UpdateContainmentMessage` events linking
 * children to it.
 *
 * Lifetime: constructed once by the script-context factory and held for
 * the duration of the script run. Derived entirely from `WorldModel`
 * (which already absorbs the baseline/delta/transform/containment/destroy
 * stream from the dispatcher) — we don't duplicate state, we just filter
 * the world by `containerId === datapadContainerId` on demand.
 *
 * The datapad's NetworkId is unknown until either:
 *   - the transcript carries a `SceneCreateObjectByName` whose template
 *     matches the datapad pattern (the live-server path — fastest), or
 *   - someone calls `setContainerId()` explicitly (the test path / future
 *     ByCrc-only spawn path).
 *
 * Once the id is known, `items` returns every world object whose
 * `containerId` matches. `kind` is derived from `templateName` via a small
 * regex table so consumers can ask `vehicles()` / `pets()` / `waypoints()`
 * without remembering the exact PCD template names.
 */

import {
  BaselinePackageIds,
  type CreatureObjectSharedBaseline,
  ObjectTypeTags,
  type TangibleObjectSharedBaseline,
} from '../../messages/game/baselines/index.js';
import type { NetworkId } from '../../types.js';
import { extractDatapadContainerId } from '../baseline-helpers.js';
import type { TranscriptEvent } from '../dispatcher.js';
import type { WorldEvent, WorldModel, WorldObject } from '../world-model.js';

/** Discriminated `kind` derived from a datapad entry's `templateName`. */
export type DatapadItemKind =
  | 'vehicle-pcd'
  | 'pet-pcd'
  | 'waypoint'
  | 'mission'
  | 'ship'
  | 'manufacturing-schematic'
  | 'other';

/**
 * Lifecycle state of a pet / vehicle controlled by a PCD. Driven by the
 * sequence of radial `PET_*` sends the script has issued plus observed
 * world-creates for the linked creature.
 *
 *   - `'stored'` — the PCD has not been called, OR the live creature was
 *     stored via `storeVehicle()` / `storePet()`. The creature is not
 *     currently in the world.
 *   - `'called'` — `callVehicle()` / `callPet()` was just sent; we're
 *     waiting for the server to spawn the creature in the world.
 *   - `'following'` — `petCommand(petId, 'follow')` was sent and the pet
 *     is presumed to be following the player.
 *   - `'staying'` — `petCommand(petId, 'stay')` was sent.
 *   - `'attacking'` — `petCommand(petId, 'attack', targetId)` was sent.
 *
 * The state is "best effort" — it's derived from sends, not from server
 * acknowledgements. A subsequent `petCommand` overrides the previous
 * state; a `storePet` / `storeVehicle` resets to `'stored'`.
 */
export type PetState = 'stored' | 'called' | 'following' | 'staying' | 'attacking';

/**
 * One entry in the datapad. Mirrors `WorldObject` but with the few fields
 * that callers typically reach for, plus a derived `kind` tag.
 *
 * `templateName` is populated when the SceneCreateObject arrived via
 * `ByName` (uncompressed wire form); `templateCrc` when it arrived via
 * `ByCrc` (compact form, which is what the live server typically uses for
 * datapad children). At least one of the two is set after a SceneCreate
 * has been observed.
 */
export interface DatapadItem {
  /** This item's NetworkId. */
  networkId: NetworkId;
  /** Template path from `SceneCreateObjectByName`, or `null` if only CRC is known. */
  templateName: string | null;
  /** Template CRC from `SceneCreateObjectByCrc`, or `null` if only the name is known. */
  templateCrc: number | null;
  /** Best-effort display name from the SHARED baseline; `null` if not decoded. */
  name: string | null;
  /**
   * Derived from `templateName` and `templateCrc`; defaults to `'other'`
   * when nothing matches.
   */
  kind: DatapadItemKind;
  /** The datapad container that holds this item (== `view.containerId`). */
  containerId: NetworkId;
  /**
   * For `'vehicle-pcd'` and `'pet-pcd'` entries — the NetworkId of the
   * currently-spawned live creature in the world that this PCD controls,
   * or `null` if the creature is not currently called out. Discovered by
   * watching CREO baselines for `masterId === playerNetworkId` after a
   * `callVehicle()` / `callPet()` is issued.
   */
  linkedCreatureId: NetworkId | null;
  /**
   * For `'vehicle-pcd'` and `'pet-pcd'` entries with a live linked
   * creature — current hit-point ratio in [0,1], computed as
   * `(maxHitPoints - damageTaken) / maxHitPoints` from the live
   * creature's TANO SHARED baseline. `null` if no linked creature is in
   * the world or its baselines haven't arrived yet. `1` means full
   * health; `0` means destroyed. For non-PCD kinds, always `null`.
   */
  condition: number | null;
  /**
   * For `'vehicle-pcd'` and `'pet-pcd'` entries — current pet state
   * (`'stored'` / `'called'` / `'following'` / `'staying'` / `'attacking'`).
   * Derived from observed PET_* radial sends issued through the script
   * context. For non-PCD kinds, always `null`.
   */
  state: PetState | null;
}

/**
 * Read-only view exposed on `ScriptContext.datapad`.
 *
 * `containerId` is `null` until zone-in completes and the datapad's
 * `SceneCreateObjectByName` arrives. `items` is a snapshot (safe to mutate
 * the returned array; the underlying entries are shared though, so treat
 * them as readonly).
 */
export interface DatapadView {
  /** Datapad container's NetworkId, or `null` if not yet discovered. */
  readonly containerId: NetworkId | null;
  /** Live snapshot of every WorldObject whose `containerId === datapad.containerId`. */
  readonly items: ReadonlyArray<DatapadItem>;
  /** `true` once `containerId` is set AND at least one baseline has arrived. */
  readonly ready: boolean;
  /** All `kind === 'vehicle-pcd'` entries. */
  vehicles(): DatapadItem[];
  /** All `kind === 'pet-pcd'` entries. */
  pets(): DatapadItem[];
  /** All `kind === 'waypoint'` entries. */
  waypoints(): DatapadItem[];
  /** All `kind === 'mission'` entries. */
  missions(): DatapadItem[];
  /** Entries whose `templateName` matches `re`. */
  findByTemplate(re: RegExp): DatapadItem[];
  /** Lookup by NetworkId; `undefined` if not in the datapad. */
  findById(id: NetworkId): DatapadItem | undefined;
  /**
   * Notify the view that the script just called/stored a vehicle or pet.
   * Used to keep the per-PCD `state` field current. Called automatically
   * by the script context's vehicle/pet primitives.
   */
  notifyPetAction(
    pcdOrCreatureId: NetworkId,
    action: 'call' | 'store' | 'follow' | 'stay' | 'attack' | 'guard' | 'patrol',
  ): void;
}

/** Patterns matched against `templateName` to derive `kind`. */
const KIND_PATTERNS: ReadonlyArray<{ pattern: RegExp; kind: DatapadItemKind }> = [
  // Vehicle PCDs. Server templates live under
  // object/intangible/vehicle/*_pcd.iff (e.g. vehicle_speeder_swoop_pcd.iff).
  // The legacy vehicle_control_device variants also exist for back-compat.
  { pattern: /vehicle_.*_pcd\.iff$/i, kind: 'vehicle-pcd' },
  { pattern: /vehicle_control_device/i, kind: 'vehicle-pcd' },
  // Pet PCDs — same intangible/pet path: object/intangible/pet/*_pcd.iff.
  { pattern: /pet_.*_pcd\.iff$/i, kind: 'pet-pcd' },
  { pattern: /pet_control_device/i, kind: 'pet-pcd' },
  // Waypoints — object/waypoint/* or any path with /waypoint/ in it.
  { pattern: /\/waypoint\//i, kind: 'waypoint' },
  // Missions — object/mission/mission_data.iff and similar.
  { pattern: /mission_data/i, kind: 'mission' },
  { pattern: /\/mission\//i, kind: 'mission' },
  // Ships — object/intangible/ship/*.iff.
  { pattern: /\/ship_/i, kind: 'ship' },
  { pattern: /intangible\/ship\//i, kind: 'ship' },
  // Manufacturing schematics — object/manufacture_schematic/*.iff.
  { pattern: /manuf_schematic/i, kind: 'manufacturing-schematic' },
  { pattern: /manufacture_schematic/i, kind: 'manufacturing-schematic' },
];

/**
 * Known template CRCs (SHARED variants only — that's what the live server
 * sends to clients) → datapad kind. Computed from `Crc::calculate` over
 * the IFF path. Expand this list as new templates are observed in the
 * wild.
 *
 * The hash is standard CRC-32 with the polynomial table at
 * `/home/tharper/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/Crc.cpp`.
 */
const KIND_CRC_MAP = new Map<number, DatapadItemKind>([
  // Vehicle PCDs (SHARED variants).
  [0xaa2d5b0e, 'vehicle-pcd'], // shared_vehicle_speeder_swoop_pcd.iff
  [0xe0452bf5, 'vehicle-pcd'], // shared_landspeeder_av21_pcd.iff
  [0xd098384a, 'vehicle-pcd'], // shared_vehicle_control_device.iff
  // Pet PCDs (SHARED variants).
  [0x2ac68039, 'pet-pcd'], // shared_pet_control_device.iff
  // Waypoints — there's just one shared template; in-world waypoint
  // styling is via objvar/SHARED-baseline color, not different templates.
  [0xb514401e, 'waypoint'], // shared_world_waypoint_blue.iff
  // Missions.
  [0xd67b04a8, 'mission'], // shared_mission_data.iff
]);

/**
 * Derive a `DatapadItemKind` from one or both of: a template path (set when
 * the server sent `SceneCreateObjectByName`) and a template CRC (set when
 * `SceneCreateObjectByCrc`). The name takes precedence — exact string
 * matches are more expressive than CRC lookups.
 */
export function classifyDatapadItem(
  templateName: string | null,
  templateCrc: number | null = null,
): DatapadItemKind {
  if (templateName !== null && templateName !== '') {
    for (const { pattern, kind } of KIND_PATTERNS) {
      if (pattern.test(templateName)) return kind;
    }
  }
  if (templateCrc !== null) {
    const hit = KIND_CRC_MAP.get(templateCrc);
    if (hit !== undefined) return hit;
  }
  return 'other';
}

/**
 * Pick the best display name for a WorldObject's TANO SHARED baseline.
 * Mirrors the same convention used by ContainerView — `objectName`
 * (Unicode free-text override) wins, else the `nameStringId.text`
 * lookup key, else `null`.
 */
function pickName(obj: WorldObject): string | null {
  // SHARED package = 3 (TangibleObjectShared variant). Don't import the enum
  // value — the world-model already keys baselines by raw package id.
  const shared = obj.baselines.get(3) as
    | { objectName?: string; nameStringId?: { text?: string } }
    | undefined;
  if (shared === undefined) return null;
  if (typeof shared.objectName === 'string' && shared.objectName !== '') {
    return shared.objectName;
  }
  if (
    typeof shared.nameStringId === 'object' &&
    shared.nameStringId !== null &&
    typeof shared.nameStringId.text === 'string' &&
    shared.nameStringId.text !== ''
  ) {
    return shared.nameStringId.text;
  }
  return null;
}

function toItem(
  obj: WorldObject,
  world: WorldModel,
  pcdLinks: ReadonlyMap<NetworkId, NetworkId>,
  pcdStates: ReadonlyMap<NetworkId, PetState>,
): DatapadItem {
  const templateName = obj.templateName ?? null;
  const templateCrc = obj.templateCrc ?? null;
  const kind = classifyDatapadItem(templateName, templateCrc);
  const isPcd = kind === 'vehicle-pcd' || kind === 'pet-pcd';
  const linkedCreatureId = isPcd ? (pcdLinks.get(obj.id) ?? null) : null;
  return {
    networkId: obj.id,
    templateName,
    templateCrc,
    name: pickName(obj),
    kind,
    containerId: obj.containerId,
    linkedCreatureId,
    condition: linkedCreatureId !== null ? hpRatio(world.get(linkedCreatureId)) : null,
    state: isPcd ? (pcdStates.get(obj.id) ?? 'stored') : null,
  };
}

/**
 * Compute the HP ratio (0..1, inclusive) for a creature/tangible from its
 * TANO SHARED baseline. Returns `null` if the object is missing or hasn't
 * received its SHARED baseline yet, OR if `maxHitPoints` is <= 0 (invalid).
 */
function hpRatio(obj: WorldObject | undefined): number | null {
  if (obj === undefined) return null;
  const shared = obj.baselines.get(BaselinePackageIds.SHARED);
  if (shared === undefined || shared instanceof Uint8Array) return null;
  // TANO SHARED + CREO SHARED both expose `damageTaken` + `maxHitPoints`
  // at the same offset (CREO extends TANO, ServerObject section first).
  const tano = shared as Partial<TangibleObjectSharedBaseline>;
  if (typeof tano.maxHitPoints !== 'number' || typeof tano.damageTaken !== 'number') {
    return null;
  }
  if (tano.maxHitPoints <= 0) return null;
  const current = tano.maxHitPoints - tano.damageTaken;
  if (current <= 0) return 0;
  const ratio = current / tano.maxHitPoints;
  if (ratio > 1) return 1;
  return ratio;
}

/**
 * Implementation of `DatapadView`. Wraps a `WorldModel` and a mutable
 * `containerId` (set when the datapad's create event is observed). All
 * derived data is computed lazily by walking the world model — no
 * duplicate state.
 */
export class DatapadViewImpl implements DatapadView {
  private _containerId: NetworkId | null;
  private readonly world: WorldModel;
  private readonly playerNetworkId: NetworkId;
  /**
   * Pending vehicle/pet `call` actions awaiting a matching CREO spawn.
   * Recorded in insertion order so the next CREO whose `masterId ===
   * playerNetworkId` arrives gets associated with the earliest pending
   * PCD. Each entry: `{ pcdId, expiresAt }`. Pending entries expire
   * after `CALL_TIMEOUT_MS` to avoid associating a random CREO that
   * happened to spawn for an unrelated reason.
   */
  private readonly pendingCalls: { pcdId: NetworkId; expiresAt: number }[] = [];
  /**
   * Map of PCD NetworkId → live creature NetworkId. Populated when the
   * server spawns a new CREO with `masterId === playerNetworkId` after
   * `callVehicle()` / `callPet()` was invoked. Cleared on the matching
   * `store*()` call.
   */
  private readonly pcdLinks = new Map<NetworkId, NetworkId>();
  /** Inverse of `pcdLinks` — live-creature-id → PCD-id. */
  private readonly creatureToPcd = new Map<NetworkId, NetworkId>();
  /** Map of PCD NetworkId → current {@link PetState}. */
  private readonly pcdStates = new Map<NetworkId, PetState>();
  /** Unsubscribe handle for the world-events listener. */
  private unsubscribe: (() => void) | null = null;
  /**
   * Auto-prune linkages when the server destroys the linked creature
   * (vehicle dismount, pet store, killed by mob, etc.).
   */
  private static readonly CALL_TIMEOUT_MS = 10_000;

  constructor(
    world: WorldModel,
    initialContainerId: NetworkId | null = null,
    playerNetworkId: NetworkId = 0n,
  ) {
    this.world = world;
    this._containerId = initialContainerId;
    this.playerNetworkId = playerNetworkId;
  }

  /** Set the datapad container id (called by the orchestrator when discovered). */
  setContainerId(id: NetworkId): void {
    this._containerId = id;
  }

  /**
   * Subscribe to the WorldModel so that CREO baselines (which carry
   * `m_masterId`) auto-associate freshly-spawned vehicles/pets with the
   * PCD that called them. Idempotent. Call `detach()` at teardown.
   */
  attach(): void {
    if (this.unsubscribe !== null) return;
    this.unsubscribe = this.world.on((e) => this.onWorldEvent(e));
  }

  /** Unsubscribe from the WorldModel. Idempotent. */
  detach(): void {
    if (this.unsubscribe === null) return;
    this.unsubscribe();
    this.unsubscribe = null;
  }

  get containerId(): NetworkId | null {
    return this._containerId;
  }

  get items(): ReadonlyArray<DatapadItem> {
    if (this._containerId === null) return [];
    const id = this._containerId;
    return this.world
      .filter((o) => o.containerId === id)
      .map((o) => toItem(o, this.world, this.pcdLinks, this.pcdStates));
  }

  get ready(): boolean {
    return this._containerId !== null;
  }

  vehicles(): DatapadItem[] {
    return this.items.filter((it) => it.kind === 'vehicle-pcd');
  }

  pets(): DatapadItem[] {
    return this.items.filter((it) => it.kind === 'pet-pcd');
  }

  waypoints(): DatapadItem[] {
    return this.items.filter((it) => it.kind === 'waypoint');
  }

  missions(): DatapadItem[] {
    return this.items.filter((it) => it.kind === 'mission');
  }

  findByTemplate(re: RegExp): DatapadItem[] {
    return this.items.filter((it) => it.templateName !== null && re.test(it.templateName));
  }

  findById(id: NetworkId): DatapadItem | undefined {
    return this.items.find((it) => it.networkId === id);
  }

  notifyPetAction(
    pcdOrCreatureId: NetworkId,
    action: 'call' | 'store' | 'follow' | 'stay' | 'attack' | 'guard' | 'patrol',
  ): void {
    // Caller may pass the live creature id (for state-on-creature actions
    // like petCommand) OR the PCD id (for call/store). Resolve to the
    // PCD id by checking both maps.
    let pcdId: NetworkId | null = null;
    if (
      this.pcdStates.has(pcdOrCreatureId) ||
      this.pendingCalls.some((p) => p.pcdId === pcdOrCreatureId)
    ) {
      pcdId = pcdOrCreatureId;
    } else if (this.creatureToPcd.has(pcdOrCreatureId)) {
      pcdId = this.creatureToPcd.get(pcdOrCreatureId) ?? null;
    } else {
      // First time we've seen this id — assume it's a PCD id.
      pcdId = pcdOrCreatureId;
    }

    if (pcdId === null) return;

    switch (action) {
      case 'call': {
        this.pcdStates.set(pcdId, 'called');
        // Drop expired entries, then record this pending call.
        const now = Date.now();
        for (let i = this.pendingCalls.length - 1; i >= 0; i--) {
          const entry = this.pendingCalls[i];
          if (entry !== undefined && entry.expiresAt < now) this.pendingCalls.splice(i, 1);
        }
        this.pendingCalls.push({
          pcdId,
          expiresAt: now + DatapadViewImpl.CALL_TIMEOUT_MS,
        });
        break;
      }
      case 'store': {
        this.pcdStates.set(pcdId, 'stored');
        const linkedId = this.pcdLinks.get(pcdId);
        if (linkedId !== undefined) {
          this.creatureToPcd.delete(linkedId);
        }
        this.pcdLinks.delete(pcdId);
        // Cancel any still-pending call for this PCD.
        for (let i = this.pendingCalls.length - 1; i >= 0; i--) {
          const entry = this.pendingCalls[i];
          if (entry !== undefined && entry.pcdId === pcdId) this.pendingCalls.splice(i, 1);
        }
        break;
      }
      case 'follow':
        this.pcdStates.set(pcdId, 'following');
        break;
      case 'stay':
        this.pcdStates.set(pcdId, 'staying');
        break;
      case 'attack':
      case 'guard':
        this.pcdStates.set(pcdId, 'attacking');
        break;
      case 'patrol':
        // No dedicated 'patrolling' literal in PetState; closest analog
        // is 'following' (the pet is actively moving under master orders).
        this.pcdStates.set(pcdId, 'following');
        break;
    }
  }

  /**
   * Handle world events relevant to pet/vehicle linkage:
   *   - CREO SHARED baseline with `masterId === playerNetworkId` →
   *     associate with the earliest pending PCD call.
   *   - SceneDestroyObject for a linked creature → clear the linkage and
   *     reset the PCD's state to `'stored'`.
   */
  private onWorldEvent(e: WorldEvent): void {
    switch (e.kind) {
      case 'baseline': {
        if (e.object.typeId !== ObjectTypeTags.CREO) return;
        // Only CREO SHARED carries `masterId`. Other packages (p1/p6/etc.)
        // can be ignored for linkage purposes.
        if (e.decodedKind !== 'CreatureObjectShared') return;
        if (this.creatureToPcd.has(e.object.id)) return; // already linked
        const data = e.data as Partial<CreatureObjectSharedBaseline>;
        if (data.masterId === undefined) return;
        if (this.playerNetworkId === 0n || data.masterId !== this.playerNetworkId) return;
        this.tryLinkCreature(e.object.id);
        break;
      }
      case 'create':
      case 'transform': {
        // After CREO baseline, the next create/transform for the same
        // object id may also bring it into our view if the original
        // baseline came in earlier — check by scanning for masterId on
        // the latest SHARED baseline.
        if (e.object.typeId !== ObjectTypeTags.CREO) return;
        if (this.creatureToPcd.has(e.object.id)) return;
        const shared = e.object.baselines.get(BaselinePackageIds.SHARED);
        if (shared === undefined || shared instanceof Uint8Array) return;
        const data = shared as Partial<CreatureObjectSharedBaseline>;
        if (data.masterId === undefined || this.playerNetworkId === 0n) return;
        if (data.masterId !== this.playerNetworkId) return;
        this.tryLinkCreature(e.object.id);
        break;
      }
      case 'destroy': {
        const pcdId = this.creatureToPcd.get(e.objectId);
        if (pcdId === undefined) return;
        this.creatureToPcd.delete(e.objectId);
        this.pcdLinks.delete(pcdId);
        this.pcdStates.set(pcdId, 'stored');
        break;
      }
      default:
        break;
    }
  }

  /**
   * Associate `creatureId` with the earliest non-expired pending PCD
   * call. Idempotent — if `creatureId` is already linked, no-op.
   */
  private tryLinkCreature(creatureId: NetworkId): void {
    const now = Date.now();
    // Drop expired entries.
    for (let i = this.pendingCalls.length - 1; i >= 0; i--) {
      const entry = this.pendingCalls[i];
      if (entry !== undefined && entry.expiresAt < now) this.pendingCalls.splice(i, 1);
    }
    const next = this.pendingCalls.shift();
    if (next === undefined) return;
    this.pcdLinks.set(next.pcdId, creatureId);
    this.creatureToPcd.set(creatureId, next.pcdId);
    // The PCD is now spawned and live — update its state if it was
    // still in the `'called'` transitional state.
    const cur = this.pcdStates.get(next.pcdId);
    if (cur === 'called' || cur === undefined) {
      this.pcdStates.set(next.pcdId, 'following');
    }
  }
}

/**
 * Scan a transcript for the datapad's create event and return the
 * resolved id, or `null` if none observed yet. Re-exported for callers
 * that want the raw scan without going through a `DatapadView`.
 */
export function findDatapadContainerId(transcript: readonly TranscriptEvent[]): NetworkId | null {
  return extractDatapadContainerId(transcript as TranscriptEvent[]);
}
