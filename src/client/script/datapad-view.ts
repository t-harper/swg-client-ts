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

import { extractDatapadContainerId } from '../baseline-helpers.js';
import type { TranscriptEvent } from '../dispatcher.js';
import type { WorldModel, WorldObject } from '../world-model.js';
import type { NetworkId } from '../../types.js';

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

function toItem(obj: WorldObject): DatapadItem {
  const templateName = obj.templateName ?? null;
  const templateCrc = obj.templateCrc ?? null;
  return {
    networkId: obj.id,
    templateName,
    templateCrc,
    name: pickName(obj),
    kind: classifyDatapadItem(templateName, templateCrc),
    containerId: obj.containerId,
  };
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

  constructor(world: WorldModel, initialContainerId: NetworkId | null = null) {
    this.world = world;
    this._containerId = initialContainerId;
  }

  /** Set the datapad container id (called by the orchestrator when discovered). */
  setContainerId(id: NetworkId): void {
    this._containerId = id;
  }

  get containerId(): NetworkId | null {
    return this._containerId;
  }

  get items(): ReadonlyArray<DatapadItem> {
    if (this._containerId === null) return [];
    const id = this._containerId;
    return this.world.filter((o) => o.containerId === id).map(toItem);
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
}

/**
 * Scan a transcript for the datapad's create event and return the
 * resolved id, or `null` if none observed yet. Re-exported for callers
 * that want the raw scan without going through a `DatapadView`.
 */
export function findDatapadContainerId(transcript: readonly TranscriptEvent[]): NetworkId | null {
  return extractDatapadContainerId(transcript as TranscriptEvent[]);
}
