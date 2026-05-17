/**
 * LocationView — high-level live location of the player (planet, position, and
 * cell, if any).
 *
 * Where `ctx.position()` returns just the orchestrator's pose cursor (updated
 * by `walkTo` etc.) and `ctx.parentCell()` returns the cell cursor (only set
 * by `walkToCell` / `setCellPose` on the client side), `LocationView` reads
 * from the `WorldModel` — which is updated by the server's transform broadcasts
 * AND containment updates. So it reflects what the server *thinks* about us.
 *
 * Computed live:
 *   - `planet`   from `sceneStart.sceneName` (immutable per zone-in)
 *   - `position` from the orchestrator's pose cursor (the closest available
 *                proxy for "where the player currently is" — the player CREO's
 *                WorldModel position lags behind by one server broadcast)
 *   - `cell`     from the player's CREO `containerId`, if it points to a known
 *                CELL object (CELL has `typeId === SCLT`). Populated with the
 *                cell's SHARED + SHARED_NP baseline fields when available.
 *
 * Lifetime: created in `createScriptContext`, no async subscriptions of its
 * own — it just queries the WorldModel on every read. Cheap because `world.get`
 * is `O(1)`.
 *
 * No live tear-down required.
 */

import {
  BaselinePackageIds,
  ObjectTypeTags,
} from '../messages/game/baselines/registry.js';
import type { CellObjectSharedBaseline } from '../messages/game/baselines/cell-object-baseline-3.js';
import type { CellObjectSharedNpBaseline } from '../messages/game/baselines/cell-object-baseline-6.js';
import type { NetworkId, Vector3 } from '../types.js';
import type { WorldModel } from './world-model.js';

/**
 * Live cell descriptor surfaced on `ctx.location.cell`. Populated when the
 * player's CREO container points to a CELL object (SCLT) in the WorldModel.
 *
 * The cell's `cellName` and `isPublic` fields come from the SCLT SHARED +
 * SHARED_NP baselines — they're typically present when the cell's parent
 * building is visible to the client. The `cellName` field is the
 * player-assigned label (e.g. "Travis's Library"); `isPublic` is the
 * any-player-can-enter flag.
 */
export interface LocationCell {
  /** NetworkId of the cell's parent building (BUIO). */
  buildingId: NetworkId;
  /** Cell label (from SHARED_NP); `''` if not labelled. */
  cellName: string;
  /** Index into the building's cell table (from SHARED). */
  cellNumber: number;
  /** True if anyone can enter; false if ACL-gated. */
  isPublic: boolean;
}

/**
 * Live location view exposed on `ctx.location`. Reads the most-current values
 * from the WorldModel + orchestrator pose cursor on every property access.
 */
export interface LocationView {
  /** Planet name (e.g. `'tatooine'`, `'naboo'`) — from `sceneStart.sceneName`. */
  readonly planet: string;
  /** Current world position from the orchestrator's pose cursor. */
  readonly position: Readonly<Vector3>;
  /**
   * Cell descriptor when the player's CREO is parented inside a CELL object,
   * `null` when outdoors. Populated by walking the player → CREO `containerId`
   * chain through the WorldModel.
   */
  readonly cell: LocationCell | null;
}

export interface LocationViewOptions {
  /** Reactive world model. */
  world: WorldModel;
  /** Player's CREO NetworkId. */
  playerId: NetworkId;
  /** Planet name from CmdStartScene. */
  planet: string;
  /** Function that returns the current world-pose cursor. */
  position: () => Readonly<Vector3>;
}

/**
 * Build a getter-based `LocationView`. Every property read walks the
 * WorldModel — no caching, so the view always reflects the latest state.
 *
 * `opts.planet` is normalized via `normalizePlanetName` — the wire delivers
 * `sceneStart.sceneName` as the full asset path (`'terrain/tatooine.trn'`),
 * but consumers want just the planet stem.
 */
export function createLocationView(opts: LocationViewOptions): LocationView {
  const planet = normalizePlanetName(opts.planet);
  return {
    get planet(): string {
      return planet;
    },
    get position(): Readonly<Vector3> {
      return opts.position();
    },
    get cell(): LocationCell | null {
      return resolvePlayerCell(opts.world, opts.playerId);
    },
  };
}

/**
 * Strip the `terrain/` prefix and `.trn` suffix from the wire's
 * `sceneStart.sceneName`. The server delivers the planet as the full asset
 * path (`'terrain/tatooine.trn'`); strings like `'tatooine'` are more useful
 * for scripts. Anything that doesn't match the expected wrapper is returned
 * as-is (e.g. a synthetic test input like `'naboo'` already-normalized).
 */
export function normalizePlanetName(raw: string): string {
  const m = raw.match(/^(?:terrain\/)?(.+?)(?:\.trn)?$/i);
  return m?.[1] ?? raw;
}

/**
 * Resolve the player's current cell from the WorldModel. Returns `null` if:
 *   - the player CREO isn't tracked yet (no baseline observed),
 *   - the player's `containerId === 0n` (outdoors),
 *   - the container exists but isn't a SCLT type (e.g. inventory),
 *   - the container's SCLT SHARED baseline wasn't observed (very rare —
 *     would happen on a stale or partial baseline flood).
 *
 * Exposed for unit tests; callers should normally use `LocationView.cell`.
 */
export function resolvePlayerCell(
  world: WorldModel,
  playerId: NetworkId,
): LocationCell | null {
  const player = world.get(playerId);
  if (player === undefined) return null;
  if (player.containerId === 0n) return null;
  const container = world.get(player.containerId);
  if (container === undefined) return null;
  // The container has to be a CELL object. Either:
  //   - the WorldModel saw a SCLT baseline and tagged typeId === SCLT, or
  //   - typeId is still 0 (no baseline yet) but a SHARED baseline shape we
  //     recognize sits on the object. We pick the strict path: require
  //     typeId === SCLT.
  if (container.typeId !== ObjectTypeTags.SCLT) return null;
  const shared = container.baselines.get(BaselinePackageIds.SHARED) as
    | CellObjectSharedBaseline
    | undefined;
  const sharedNp = container.baselines.get(BaselinePackageIds.SHARED_NP) as
    | CellObjectSharedNpBaseline
    | undefined;
  // The cell's parent building (BUIO) — UpdateContainmentMessage on the cell
  // populates the cell object's own `containerId`. If we never observed the
  // cell's containment, `buildingId` is `0n` — still useful to know we're
  // in a cell, just not which building.
  const buildingId = container.containerId;
  return {
    buildingId,
    cellName: sharedNp?.cellLabel ?? '',
    cellNumber: shared?.cellNumber ?? -1,
    isPublic: shared?.isPublic ?? false,
  };
}

/**
 * Find a cell inside a building by its label (e.g. `'cell1'`, `'living_room'`).
 *
 * Walks the WorldModel for the building's containment children — every SCLT
 * whose `containerId === buildingId`. Matches `cellLabel === wantedName` from
 * the cell's SHARED_NP baseline; for backwards compatibility with cells whose
 * label is just `'cellN'` we also accept `cellNumber === Number(wantedName.slice(4))`
 * when the label-match fails.
 *
 * Returns the cell's NetworkId or `null` if no match. Used by
 * `navigate({ buildingId, cellName })` to resolve the cellId to walk to.
 */
export function findCellByName(
  world: WorldModel,
  buildingId: NetworkId,
  wantedName: string,
): NetworkId | null {
  // Pass 1: try exact label match on SHARED_NP `cellLabel`.
  for (const obj of world.objects()) {
    if (obj.typeId !== ObjectTypeTags.SCLT) continue;
    if (obj.containerId !== buildingId) continue;
    const sharedNp = obj.baselines.get(BaselinePackageIds.SHARED_NP) as
      | CellObjectSharedNpBaseline
      | undefined;
    if (sharedNp?.cellLabel === wantedName) return obj.id;
  }
  // Pass 2: fall back to cellN naming. `wantedName === 'cell1'` → cellNumber === 1.
  const m = wantedName.match(/^cell(\d+)$/i);
  if (m !== null) {
    const wantedNumber = Number(m[1]);
    for (const obj of world.objects()) {
      if (obj.typeId !== ObjectTypeTags.SCLT) continue;
      if (obj.containerId !== buildingId) continue;
      const shared = obj.baselines.get(BaselinePackageIds.SHARED) as
        | CellObjectSharedBaseline
        | undefined;
      if (shared?.cellNumber === wantedNumber) return obj.id;
    }
  }
  return null;
}

/**
 * Find the first public cell in a building (the typical "main entrance" cell).
 * Used by `navigate()` as a fallback when the caller doesn't know the cell
 * name but wants any reachable interior cell.
 *
 * Returns the cell's NetworkId or `null` if no public cell observed for this
 * building.
 */
export function findFirstPublicCell(
  world: WorldModel,
  buildingId: NetworkId,
): NetworkId | null {
  // Iterate in cellNumber-ascending order — cellNumber === 1 is conventionally
  // the main entrance / public lobby. Collect first, then sort.
  const cells: Array<{ id: NetworkId; cellNumber: number }> = [];
  for (const obj of world.objects()) {
    if (obj.typeId !== ObjectTypeTags.SCLT) continue;
    if (obj.containerId !== buildingId) continue;
    const shared = obj.baselines.get(BaselinePackageIds.SHARED) as
      | CellObjectSharedBaseline
      | undefined;
    if (shared?.isPublic !== true) continue;
    cells.push({ id: obj.id, cellNumber: shared.cellNumber });
  }
  if (cells.length === 0) return null;
  cells.sort((a, b) => a.cellNumber - b.cellNumber);
  return cells[0]?.id ?? null;
}
