/**
 * Helpers for extracting structured findings from a LifecycleResult's
 * `transcript` of decoded baselines. These walk the transcript looking for
 * particular kinds of decoded baseline (or scene-create-object events) and
 * return whatever the consumer is most often asking for.
 *
 * Pattern: caller passes in the `LifecycleResult` (or just its transcript)
 * and gets back a strongly-typed result. We never mutate the input.
 */

import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import { BatchBaselinesMessage } from '../messages/game/baselines/batch-baselines-message.js';
import type {
  BuildingObjectSharedBaseline,
  CellObjectSharedBaseline,
  CellObjectSharedNpBaseline,
  DecodedBaseline,
  PlayerObjectSharedBaseline,
  TangibleObjectSharedBaseline,
} from '../messages/game/baselines/index.js';
import {
  BuildingObjectSharedKind,
  CellObjectSharedKind,
  CellObjectSharedNpKind,
  ObjectTypeTags,
  PlayerObjectSharedKind,
} from '../messages/game/baselines/index.js';
import { SceneCreateObjectByCrc } from '../messages/game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import { UpdateContainmentMessage } from '../messages/game/update-containment-message.js';
import type { NetworkId } from '../types.js';
import type { TranscriptEvent } from './dispatcher.js';

/** Templates we recognize for in-character containers. */
const PLAYER_INVENTORY_TEMPLATE_PATTERN = /(^|\/)(shared_)?character_inventory\.iff$/;
const PLAYER_DATAPAD_TEMPLATE_PATTERN = /(^|\/)(shared_)?character_datapad\.iff$/;

/**
 * Template CRCs the server uses when sending containers via
 * `SceneCreateObjectByCrc` rather than `SceneCreateObjectByName`.
 *
 * Computed from `Crc::calculate` over the IFF path (standard CRC-32 with
 * the same polynomial table at `~/code/swg-main/.../Crc.cpp`). The CRC is
 * an SOE convention; the same hash is used everywhere in the server for
 * template lookups, so we can hardcode the known IFFs.
 *
 * Verified by sniffing live `SceneCreateObjectByCrc` events.
 */
export const PLAYER_INVENTORY_TEMPLATE_CRC = 0x3969e83b;
export const PLAYER_DATAPAD_TEMPLATE_CRC = 0x73ba5001;

/**
 * What we need from the transcript-bearing thing: either a `LifecycleResult`
 * (which has `.transcript`) or a raw `TranscriptEvent[]`.
 */
type TranscriptSource = { transcript: TranscriptEvent[] } | TranscriptEvent[];

function eventsOf(source: TranscriptSource): TranscriptEvent[] {
  return Array.isArray(source) ? source : source.transcript;
}

/**
 * Yield every BaselinesMessage in the transcript, flattening any
 * BatchBaselinesMessage envelopes (the server batches baselines during
 * zone-in for efficiency).
 *
 * Exported for reuse by other transcript-walking helpers (e.g. ContainerView)
 * — keep the visibility narrow to "things inside this package" if you can.
 */
export function* iterBaselines(source: TranscriptSource): Iterable<BaselinesMessage> {
  for (const event of eventsOf(source)) {
    if (event.direction !== 'recv') continue;
    if (event.decoded === null) continue;
    if (event.decoded instanceof BaselinesMessage) {
      yield event.decoded;
    } else if (event.decoded instanceof BatchBaselinesMessage) {
      yield* event.decoded.baselines;
    }
  }
}

/**
 * Find all decoded BaselinesMessage events for a given NetworkId. Returns
 * `[ ]` if none. The result is ordered by transcript position (i.e. wire
 * arrival order).
 */
export function extractBaselinesForObject(
  source: TranscriptSource,
  networkId: NetworkId,
): BaselinesMessage[] {
  const out: BaselinesMessage[] = [];
  for (const b of iterBaselines(source)) {
    if (b.target === networkId) out.push(b);
  }
  return out;
}

/**
 * Find all decoded baselines of a given `kind` (e.g. `'PlayerObjectShared'`).
 * Returns the BaselinesMessage envelopes — caller can pull `.target` for the
 * networkId and `.decodedBaseline.data` for the typed payload.
 */
export function findBaselinesByKind(source: TranscriptSource, kind: string): BaselinesMessage[] {
  const out: BaselinesMessage[] = [];
  for (const b of iterBaselines(source)) {
    const decoded: DecodedBaseline | null = b.decodedBaseline;
    if (decoded?.kind === kind) out.push(b);
  }
  return out;
}

/**
 * Look for the first decoded `PlayerObjectShared` baseline in the transcript.
 * Returns `{ networkId, data }` or `null` if no decoded PlayerObject baseline
 * was observed.
 */
export function extractPlayerObjectBaseline(
  source: TranscriptSource,
): { networkId: NetworkId; data: PlayerObjectSharedBaseline } | null {
  const candidates = findBaselinesByKind(source, PlayerObjectSharedKind);
  const first = candidates[0];
  if (first === undefined) return null;
  if (first.decodedBaseline === null) return null;
  return {
    networkId: first.target,
    data: first.decodedBaseline.data as PlayerObjectSharedBaseline,
  };
}

/**
 * Look for the player character's inventory container.
 *
 * Strategy:
 *   1. Scan `SceneCreateObjectByName` events for the inventory shared template
 *      (`object/tangible/inventory/shared_character_inventory.iff` or the
 *      legacy server path). The earliest match is the most likely; baselines
 *      arrive paired with the create event for the same NetworkId.
 *   2. If no match by template name, return `null`. (For SceneCreateObjectByCrc
 *      we'd need to know the CRC of the inventory template — the server
 *      typically sends inventories ByName since the template is referenced by
 *      path, but if you encounter a ByCrc-only inventory you can add the CRC
 *      to the lookup table.)
 *
 * Note: this finds ANY inventory in the scene flood — for a single-player
 * scene, that's overwhelmingly the player's inventory. For shared scenes
 * with NPCs that also have inventories, the first match wins; constrain via
 * the player's NetworkId if needed (out of scope for the MVP helper).
 */
export function extractInventoryContainerId(source: TranscriptSource): NetworkId | null {
  for (const event of eventsOf(source)) {
    if (event.direction !== 'recv') continue;
    if (event.decoded === null) continue;
    if (event.decoded instanceof SceneCreateObjectByName) {
      if (PLAYER_INVENTORY_TEMPLATE_PATTERN.test(event.decoded.templateName)) {
        return event.decoded.networkId;
      }
    } else if (event.decoded instanceof SceneCreateObjectByCrc) {
      if (event.decoded.templateCrc === PLAYER_INVENTORY_TEMPLATE_CRC) {
        return event.decoded.networkId;
      }
    }
  }
  return null;
}

/**
 * Look for the player character's datapad container.
 *
 * The datapad is a per-player container (slot `'datapad'`) that holds
 * vehicle/pet PCDs (PersistentControlDevices), waypoints, missions, ship
 * items, and manufacturing schematics. Same wire shape as the inventory
 * — a `SceneCreateObject{ByName,ByCrc}` whose template path ends in
 * `(shared_)?character_datapad.iff` (CRC `0x73ba5001`).
 *
 * Returns the earliest matching NetworkId in the transcript, or `null`
 * if the create event hasn't been observed. Live servers send the
 * datapad via ByCrc (compact form, deterministic hash) — both wire
 * shapes are handled here.
 */
export function extractDatapadContainerId(source: TranscriptSource): NetworkId | null {
  for (const event of eventsOf(source)) {
    if (event.direction !== 'recv') continue;
    if (event.decoded === null) continue;
    if (event.decoded instanceof SceneCreateObjectByName) {
      if (PLAYER_DATAPAD_TEMPLATE_PATTERN.test(event.decoded.templateName)) {
        return event.decoded.networkId;
      }
    } else if (event.decoded instanceof SceneCreateObjectByCrc) {
      if (event.decoded.templateCrc === PLAYER_DATAPAD_TEMPLATE_CRC) {
        return event.decoded.networkId;
      }
    }
  }
  return null;
}

/**
 * Find every distinct NetworkId for which we observed any baseline of the
 * specified object-type tag.
 *
 * Returns the unique NetworkIds in insertion order (== first-observed order).
 */
export function networkIdsByObjectType(source: TranscriptSource, typeId: number): NetworkId[] {
  const seen = new Set<NetworkId>();
  const out: NetworkId[] = [];
  for (const b of iterBaselines(source)) {
    if (b.typeId !== typeId) continue;
    if (seen.has(b.target)) continue;
    seen.add(b.target);
    out.push(b.target);
  }
  return out;
}

/** Convenience: `networkIdsByObjectType(source, ObjectTypeTags.TANO)`. */
export function tangibleObjectIds(source: TranscriptSource): NetworkId[] {
  return networkIdsByObjectType(source, ObjectTypeTags.TANO);
}

/** Convenience: `networkIdsByObjectType(source, ObjectTypeTags.PLAY)`. */
export function playerObjectIds(source: TranscriptSource): NetworkId[] {
  return networkIdsByObjectType(source, ObjectTypeTags.PLAY);
}

/** Convenience: `networkIdsByObjectType(source, ObjectTypeTags.CREO)`. */
export function creatureObjectIds(source: TranscriptSource): NetworkId[] {
  return networkIdsByObjectType(source, ObjectTypeTags.CREO);
}

// =============================================================================
// Building + Cell containment index
// =============================================================================

/**
 * One entry in the building side of the BuildingCellIndex. The `name` is a
 * best-effort display name pulled from any decoded BUIO SHARED baseline (the
 * Unicode override `objectName` wins, else the `nameStringId.text` lookup
 * key). `cells` lists every NetworkId reported as a child of this building
 * via an `UpdateContainmentMessage` event for which we also observed a
 * CellObjectSharedDecoder baseline, in arrival order (== building's cell-
 * table walk order).
 */
export interface BuildingIndexEntry {
  /** Free-text or string-id-derived display name, if any baseline carried one. */
  name?: string;
  /** Cell NetworkIds linked to this building, in observation order. */
  cells: NetworkId[];
}

/**
 * One entry in the cell side of the BuildingCellIndex. `buildingId` is the
 * `containerId` reported by the cell's `UpdateContainmentMessage`. The other
 * fields come from the cell's SHARED + SHARED_NP baselines when those were
 * decoded (the optional fields are absent when the corresponding baseline
 * was not observed for this cell).
 */
export interface CellIndexEntry {
  /** NetworkId of the parent building (from this cell's UpdateContainmentMessage). */
  buildingId: NetworkId;
  /** Index into the building's cell table (from SHARED baseline). */
  cellNumber: number;
  /** Player-assigned label, if any (from SHARED_NP baseline). */
  cellName?: string;
  /** True iff the cell is publicly accessible (from SHARED baseline). */
  isPublic?: boolean;
}

/**
 * Two-way index of buildings and cells observed in a transcript:
 *   - `buildings` maps each building's NetworkId to its display name and the
 *     ordered list of NetworkIds of its child cells.
 *   - `cells` maps each cell's NetworkId to its parent building plus its
 *     decoded SHARED/SHARED_NP fields.
 *
 * Returned by `buildBuildingCellIndex`. Both maps are scoped to objects for
 * which we observed at least the relevant baseline (BUIO SHARED for the
 * building side; SCLT SHARED for the cell side). Cells whose parent
 * containment was never linked via `UpdateContainmentMessage` are still
 * present in `cells` (with `buildingId = 0n`) so callers can detect them.
 *
 * Use this to:
 *   - Look up "what cells does this cantina have?" given a building's NetworkId
 *   - Look up "which building is this cell inside?" given a cell's NetworkId
 *   - Find the public main-entrance cell of a building (filter by `isPublic`)
 *
 * For walk-to-cell scripting, pair this with `ctx.walkToCell(cellId, ...)`
 * after pulling the right cell NetworkId from this index.
 */
export interface BuildingCellIndex {
  buildings: Map<NetworkId, BuildingIndexEntry>;
  cells: Map<NetworkId, CellIndexEntry>;
}

/**
 * Pick the best display name for a building from a decoded baseline. Mirrors
 * the pickName logic in ContainerView — `objectName` (Unicode free-text) wins
 * if non-empty, else fall back to the `nameStringId.text` lookup key.
 */
function pickBuildingName(
  shared: BuildingObjectSharedBaseline | TangibleObjectSharedBaseline,
): string | undefined {
  if (shared.objectName !== '') return shared.objectName;
  if (shared.nameStringId.text !== '') return shared.nameStringId.text;
  return undefined;
}

/**
 * Walk the transcript and build a `BuildingCellIndex` mapping every observed
 * BuildingObject and CellObject to its sibling.
 *
 * Algorithm:
 *   1. Pass 1: collect per-cell SHARED + SHARED_NP baseline data (the
 *      `cellNumber` / `isPublic` / `cellLabel` fields) plus per-building
 *      SHARED baseline data (the display name). Index by NetworkId.
 *   2. Pass 2: walk `UpdateContainmentMessage` events. For each cell, link
 *      it to its parent building via `containerId`. The cell list per
 *      building is built in observation order (== arrival order from the
 *      server's `BatchBaselinesMessage` flood, which mirrors the building's
 *      cell-table walk order).
 *
 * Cells whose SHARED baseline was never decoded are NOT included in the
 * `cells` map (we need at least the `cellNumber` to make the entry
 * meaningful). Buildings without any decoded baseline are still included
 * if at least one cell linked to them — the `name` is then `undefined`.
 *
 * Idempotent under reordering: every field uses the most-recent non-null
 * value observed, and the containment linkage walks the UpdateContainment
 * events in order so reorders only affect cell-list ordering.
 */
export function buildBuildingCellIndex(transcript: readonly TranscriptEvent[]): BuildingCellIndex {
  const buildings = new Map<NetworkId, BuildingIndexEntry>();
  const cells = new Map<NetworkId, CellIndexEntry>();

  // Pass 1: per-building names (from BUIO SHARED) and per-cell fields
  // (from SCLT SHARED + SCLT SHARED_NP).
  for (const event of transcript) {
    if (event.direction !== 'recv') continue;
    if (event.decoded === null || event.decoded === undefined) continue;

    if (event.decoded instanceof BaselinesMessage) {
      ingestBaseline(buildings, cells, event.decoded);
    } else if (event.decoded instanceof BatchBaselinesMessage) {
      for (const b of event.decoded.baselines) {
        ingestBaseline(buildings, cells, b);
      }
    }
  }

  // Pass 2: link cells to their parent buildings via UpdateContainmentMessage.
  // Track cells we've already linked so a re-containment event (rare, but
  // possible: cell unloaded then re-loaded) updates the buildingId without
  // duplicating the entry in the building's `cells` list.
  for (const event of transcript) {
    if (event.direction !== 'recv') continue;
    if (event.decoded === null || event.decoded === undefined) continue;
    if (!(event.decoded instanceof UpdateContainmentMessage)) continue;

    const cell = cells.get(event.decoded.networkId);
    if (cell === undefined) continue; // not a cell we know about
    const newParent = event.decoded.containerId;
    const oldParent = cell.buildingId;
    cell.buildingId = newParent;

    // If the parent actually changed (initial 0n → real, OR mid-flight move),
    // adjust the building → cells reverse index.
    if (oldParent !== newParent) {
      if (oldParent !== 0n) {
        const oldEntry = buildings.get(oldParent);
        if (oldEntry !== undefined) {
          const idx = oldEntry.cells.indexOf(event.decoded.networkId);
          if (idx >= 0) oldEntry.cells.splice(idx, 1);
        }
      }
      if (newParent !== 0n) {
        const entry = ensureBuildingEntry(buildings, newParent);
        if (!entry.cells.includes(event.decoded.networkId)) {
          entry.cells.push(event.decoded.networkId);
        }
      }
    }
  }

  return { buildings, cells };
}

function ensureBuildingEntry(
  buildings: Map<NetworkId, BuildingIndexEntry>,
  id: NetworkId,
): BuildingIndexEntry {
  let entry = buildings.get(id);
  if (entry === undefined) {
    entry = { cells: [] };
    buildings.set(id, entry);
  }
  return entry;
}

function ensureCellEntry(
  cells: Map<NetworkId, CellIndexEntry>,
  id: NetworkId,
): CellIndexEntry {
  let entry = cells.get(id);
  if (entry === undefined) {
    entry = { buildingId: 0n, cellNumber: -1 };
    cells.set(id, entry);
  }
  return entry;
}

function ingestBaseline(
  buildings: Map<NetworkId, BuildingIndexEntry>,
  cells: Map<NetworkId, CellIndexEntry>,
  b: BaselinesMessage,
): void {
  const decoded: DecodedBaseline | null = b.decodedBaseline;
  if (decoded === null) return;
  switch (decoded.kind) {
    case BuildingObjectSharedKind: {
      const entry = ensureBuildingEntry(buildings, b.target);
      const name = pickBuildingName(decoded.data as BuildingObjectSharedBaseline);
      if (name !== undefined) entry.name = name;
      break;
    }
    case CellObjectSharedKind: {
      const entry = ensureCellEntry(cells, b.target);
      const data = decoded.data as CellObjectSharedBaseline;
      entry.cellNumber = data.cellNumber;
      entry.isPublic = data.isPublic;
      break;
    }
    case CellObjectSharedNpKind: {
      const entry = ensureCellEntry(cells, b.target);
      const data = decoded.data as CellObjectSharedNpBaseline;
      if (data.cellLabel !== '') entry.cellName = data.cellLabel;
      break;
    }
    default:
      // Other baselines are irrelevant for this index.
      break;
  }
}
