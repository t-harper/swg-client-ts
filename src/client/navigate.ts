/**
 * `ctx.navigate(target, opts?)` — multi-segment "go there" primitive that
 * handles mounting, dismounting, and cell entry automatically.
 *
 * Why this exists: outside of the simplest "walkTo a nearby point" case, the
 * real flow for getting somewhere in SWG involves a fair amount of glue:
 *
 *   1. Distance check — should we mount up first?
 *   2. If yes: find a vehicle PCD in the datapad, call it, wait, mount it.
 *   3. Walk to the destination (or near it, if going indoors).
 *   4. If destination is interior: dismount, then walkToCell into the cell.
 *
 * Scripts that do this ad-hoc end up with 30-40 lines of glue per "go to that
 * resident's house". `navigate()` collapses it to one call.
 *
 * Planning is deterministic and observable via the returned `NavigatePlan`
 * (great for unit tests; the test plans without needing to simulate the
 * walk loop). The actual walking is delegated to the same primitives
 * (`walkTo` / `walkToCell` / `mount` / `dismount` / `callVehicle`) the rest
 * of the script-context uses.
 *
 * # Portal-aware interior pathing (Track D)
 *
 * For interior targets the planner now (when possible) reads the building's
 * `.pob` portal layout via `ctx.knowledge.buildings` and walks the player
 * THROUGH the portal — issuing a transform a meter past the doorway in
 * world coords first (to satisfy the server's anti-cheat clamps), then
 * immediately re-parenting via `CM_netUpdateTransformWithParent` two meters
 * inside the destination cell along the portal's inward normal. For deep
 * interior cells the planner emits one `walkThroughPortal` step per hop
 * along the BFS path produced by `findCellPath`, finishing with a
 * `verifyCellEntry` step that polls `LocationView.cell` to log a warning
 * if the server didn't accept the re-parent.
 *
 * The portal path is best-effort. When the building's template info isn't
 * available (Track B not yet landed, or asset missing), when the `.pob`
 * itself can't be loaded, or when `findCellPath` returns null, the planner
 * falls back to today's `walkTo(anchor) + walkToCell({0,0})` shape with a
 * one-time `console.warn` so the operator sees the degradation.
 */

import { ByteStream } from '../archive/byte-stream.js';
import type { Cell, CellPortal, PortalLayout } from '../iff/portal-layout-reader.js';
import {
  BaselinePackageIds,
  type CellObjectSharedBaseline,
  ObjectTypeTags,
} from '../messages/game/baselines/index.js';
import { CLIENT_TO_AUTH_SERVER_FLAGS } from '../messages/game/command-queue/command-queue-enqueue.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import {
  type NetUpdateTransformData,
  NetUpdateTransformKind,
  ObjControllerSubtypeIds,
  type TeleportAckData,
  TeleportAckDecoder,
} from '../messages/game/obj-controller/index.js';
import type { Vector3 } from '../types.js';
import type { NetworkId } from '../types.js';
import { type CellPathHop, findCellPath } from './cell-graph.js';
import type { Knowledge } from './knowledge.js';
import { findCellByName, findFirstPublicCell, resolvePlayerCell } from './location.js';
import type { ScriptContext } from './script/context.js';
import type { WorldModel, WorldObject } from './world-model.js';

/** Outdoor coordinate target. */
export interface OutdoorTarget {
  x: number;
  z: number;
  /** Optional y override; otherwise hold current y. */
  y?: number;
}

/** Interior-cell target. */
export interface InteriorTarget {
  buildingId: NetworkId;
  /**
   * Cell label or `cellN` shorthand. The cell must be a SCLT child of
   * `buildingId` whose SHARED_NP `cellLabel` matches OR whose SHARED
   * `cellNumber` matches the `N` in `cellN`. If `cellName` is `''` the first
   * public cell in the building is used as the entry point.
   */
  cellName: string;
  /**
   * Cell-relative target inside the cell. Defaults to `{x:0, z:0}` (cell
   * origin — typically the entry point).
   */
  position?: { x: number; z: number; y?: number };
}

export type NavigateTarget = OutdoorTarget | InteriorTarget;

export interface NavigateOptions {
  /**
   * Mount usage policy:
   *   - `'auto'` (default): mount up if (a) distance > `mountThresholdM` AND
   *     (b) the datapad has a vehicle PCD.
   *   - `'never'`: walk the whole way on foot.
   */
  useMount?: 'auto' | 'never';
  /**
   * Distance threshold for `useMount: 'auto'`. Default 50m.
   */
  mountThresholdM?: number;
  /**
   * Distance (m) from the building's outdoor anchor to dismount at when
   * approaching an interior target. Default 8m — close enough to walk to
   * the door, far enough that the dismount animation doesn't clip into
   * the building. Only used for interior targets.
   */
  dismountDistanceM?: number;
  /**
   * Timeout (ms) for the post-traversal `verifyCellEntry` step that polls
   * `LocationView.cell` to confirm the server accepted the re-parent.
   * Default 3000. The verify step does NOT throw on timeout — it logs a
   * warning and the plan continues — so this is just an upper bound on
   * how long we'll wait before giving up on a definitive confirmation.
   */
  verifyCellEntryTimeoutMs?: number;
}

/**
 * Inspectable plan for a navigate call. Returned by `planNavigate` for unit
 * tests; the executor `navigate()` runs the plan in-order.
 *
 * The plan is one or more sequential steps:
 *   - `callVehicle` / `mount` / `dismount` (motion-state changes)
 *   - `walkTo` (outdoor walk to an x/z)
 *   - `walkToCell` (cell-relative walk inside a cell)
 *   - `walkThroughPortal` (one cell-graph hop — uses portal-layout data
 *     to walk to the door and then re-parent past it)
 *   - `verifyCellEntry` (poll LocationView.cell to confirm the re-parent)
 *
 * The executor stops at the first step that throws.
 */
export type NavigateStep =
  | { kind: 'callVehicle'; vehiclePcdId: NetworkId }
  | { kind: 'mount'; vehicleId: NetworkId }
  | { kind: 'dismount' }
  | { kind: 'walkTo'; x: number; z: number; y?: number }
  | {
      kind: 'walkToCell';
      cellId: NetworkId;
      x: number;
      z: number;
      y?: number;
    }
  | {
      /**
       * Traverse one cell-graph hop. The executor walks the player to
       * `portalWorld` (when `fromCellId === null`, i.e. we are coming from
       * outdoors) OR to `fromCellLocalDoor` inside `fromCellId` (when
       * `fromCellId !== null`, i.e. we are crossing from one interior cell
       * to another), then IMMEDIATELY issues a `walkToCell` to
       * `toCellLocalEntry` inside `toCellId` — the same async frame, no
       * `wait` in between. Sequencing is the entire point.
       */
      kind: 'walkThroughPortal';
      /** `null` = exterior → first interior; non-null = cell → cell. */
      fromCellId: NetworkId | null;
      /** Destination cell's NetworkId. */
      toCellId: NetworkId;
      /**
       * World coords for the on-the-doormat run-up. Only present when
       * `fromCellId === null` (exterior approach). Computed as
       * `building.position + rotateY(door_in_fromCell_frame + outwardNormal*1m, building.yaw)`.
       */
      portalWorld?: { x: number; z: number; y?: number };
      /**
       * Door position in `fromCellId`'s local frame. Only present when
       * `fromCellId !== null` (interior cell → interior cell). Taken from
       * the source-cell entry in the portal layout.
       */
      fromCellLocalDoor?: { x: number; z: number; y?: number };
      /**
       * Robust "deep inside the destination cell" point. The server's
       * `PortalProperty::findContainingCell` iterates the building's
       * child cells and picks the one whose floor mesh has the closest
       * point — so the cell-local position must clearly belong to the
       * destination cell, not just be "past the door."
       *
       * Computed by `computeCellLocalEntry` (see its JSDoc): the
       * arithmetic mean of all passable portal door positions in the
       * destination cell when it has 2+ portals (the centroid sits in
       * the interior), or the door position offset 2m away from the
       * source-cell portal centroid for single-portal alcoves.
       */
      toCellLocalEntry: { x: number; z: number; y?: number };
    }
  | {
      /**
       * Poll the LocationView until `ctx.location.cell?.id === cellId` (or
       * timeout). Does NOT throw on mismatch — emits a `console.warn`. The
       * plan continues either way; this is purely diagnostic.
       */
      kind: 'verifyCellEntry';
      cellId: NetworkId;
      timeoutMs: number;
    };

export interface NavigatePlan {
  steps: NavigateStep[];
  /**
   * Resolved interior cellId when the target was interior — `null` for an
   * outdoor target. Surfaced so callers can use it post-walk.
   */
  cellId: NetworkId | null;
  /**
   * Final outdoor anchor for the walk. For interior targets this is the
   * building's anchor (we dismount and walk to the door here); for outdoor
   * targets it's the target coord.
   */
  outdoorAnchor: { x: number; z: number };
  /**
   * Diagnostic: filled when the portal-aware path bailed out and the planner
   * fell back to the legacy `walkTo(anchor) + walkToCell({0,0})` shape.
   * `null` when the portal-aware path was taken (or the target is outdoor).
   * `undefined` when the planner produced the legacy shape directly without
   * an attempted portal lookup (the default for outdoor targets and for
   * `planNavigateSync` callers that supplied no portal layout).
   */
  fallbackReason?: string | null;
}

interface PlanContext {
  world: WorldModel;
  position: Vector3;
  /** Currently-resolved cell of the player (`null` outdoors). */
  currentCell: NetworkId | null;
  /** Currently-mounted state from `ctx.mountedSpeedCap()`. */
  mountCapMps: number | null;
  /** Vehicle PCDs in the datapad (NetworkIds in datapad-order). */
  vehiclePcdIds: NetworkId[];
}

const DEFAULT_MOUNT_THRESHOLD_M = 50;
const DEFAULT_DISMOUNT_DISTANCE_M = 8;
const DEFAULT_VERIFY_CELL_ENTRY_TIMEOUT_MS = 3000;

/** How far past the doorway (m) the run-up world point sits. */
const PORTAL_OUTWARD_RUNUP_M = 1.0;
/** How far inside the destination cell (m) the entry point sits. */
const PORTAL_INWARD_ENTRY_M = 2.0;

/**
 * Async outer wrapper: resolves the building template → portal layout →
 * cell path, then delegates to `planNavigateSync` which does the pure plan
 * generation. For outdoor targets and for "best-effort failed" interior
 * targets it falls straight through (with a `fallbackReason` populated on
 * the returned plan so the caller can `console.warn` it once).
 *
 * The pure inner `planNavigateSync` is exposed too so tests can build plans
 * deterministically without the async lookups.
 *
 * Throws (no soft-fail) when the target building isn't in the WorldModel
 * or the target cell can't be resolved — those are programmer errors, not
 * "data not available yet" cases. The portal-layout/cell-path lookups, by
 * contrast, are best-effort and degrade silently to the fallback path.
 */
export async function planNavigate(
  pc: PlanContext,
  target: NavigateTarget,
  opts: NavigateOptions = {},
  knowledge?: Knowledge,
): Promise<NavigatePlan> {
  if (!isInteriorTarget(target) || knowledge === undefined) {
    return planNavigateSync(pc, target, opts);
  }

  // Resolve the building's template name from the WorldModel. The BUIO
  // baseline is required for outdoorAnchor anyway, so this lookup will
  // also be retried by planNavigateSync below; we just need a clean
  // string to pass to templateInfoFor().
  const buildingObj = pc.world.get(target.buildingId);
  let templateName = buildingObj?.templateName;
  if (templateName === undefined || templateName === '') {
    // Buildout objects (the cantina, every static building) arrive via
    // `SceneCreateObjectByCrc` which carries only the templateCrc. The
    // friendlier templateName lookup falls through to `BuildingKB.templateNameForCrc`
    // — a CRC string table loaded once per process and shared by every
    // navigate call.
    const templateCrc = buildingObj?.templateCrc;
    if (templateCrc !== undefined) {
      const resolved = await knowledge.buildings.templateNameForCrc(templateCrc);
      if (resolved !== null && resolved !== '') {
        templateName = resolved;
      }
    }
    if (templateName === undefined || templateName === '') {
      const crcSuffix =
        templateCrc !== undefined
          ? ` (templateCrc=0x${(templateCrc >>> 0).toString(16).padStart(8, '0')} not in CRC string table)`
          : ' (no templateCrc either)';
      return planNavigateSync(
        pc,
        target,
        opts,
        undefined,
        null,
        `navigate: building has no templateName on its WorldObject${crcSuffix} — falling back, cell entry may not register`,
      );
    }
  }

  let layout: PortalLayout | undefined;
  try {
    const info = await knowledge.buildings.templateInfoFor(templateName);
    if (info.portalLayoutFilename === null || info.portalLayoutFilename === '') {
      return planNavigateSync(
        pc,
        target,
        opts,
        undefined,
        null,
        `navigate: template ${templateName} has no portalLayoutFilename — falling back, cell entry may not register`,
      );
    }
    layout = await knowledge.buildings.portalLayoutFor(info.portalLayoutFilename);
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';
    return planNavigateSync(
      pc,
      target,
      opts,
      undefined,
      null,
      `navigate: portal-layout lookup failed for ${templateName} (${reason}) — falling back, cell entry may not register`,
    );
  }

  // Resolve the target cell number via the same SCLT-child scan
  // findCellByName/findFirstPublicCell use, but pull the cellNumber out so
  // we can hand it to findCellPath.
  const targetCellNumber = resolveTargetCellNumber(pc.world, target);
  if (targetCellNumber === null) {
    // Cell not in the WorldModel yet OR named cell doesn't exist; let
    // planNavigateSync surface the canonical error via the same path the
    // legacy planner used (it throws synchronously).
    return planNavigateSync(pc, target, opts);
  }
  const cellPath = findCellPath(layout, 0, targetCellNumber);
  if (cellPath === null) {
    return planNavigateSync(
      pc,
      target,
      opts,
      undefined,
      null,
      `navigate: no portal-graph path from exterior to cell ${targetCellNumber} in ${templateName} — falling back, cell entry may not register`,
    );
  }
  return planNavigateSync(pc, target, opts, layout, cellPath);
}

/**
 * Pure planner. When `portalLayout` is provided AND `cellPath` is non-null
 * (and non-empty), emits a sequence of `walkThroughPortal` steps + a final
 * `verifyCellEntry`. Otherwise emits today's legacy `walkTo + walkToCell`
 * shape.
 *
 * Exposed so tests can build plans without exercising the async portal
 * lookup. Callers that want the full portal-aware behavior should use
 * `planNavigate` (the async wrapper) instead.
 */
export function planNavigateSync(
  pc: PlanContext,
  target: NavigateTarget,
  opts: NavigateOptions = {},
  portalLayout?: PortalLayout,
  cellPath?: CellPathHop[] | null,
  fallbackReason?: string,
): NavigatePlan {
  const useMount = opts.useMount ?? 'auto';
  const mountThresholdM = opts.mountThresholdM ?? DEFAULT_MOUNT_THRESHOLD_M;
  const dismountDistanceM = opts.dismountDistanceM ?? DEFAULT_DISMOUNT_DISTANCE_M;
  const verifyTimeoutMs = opts.verifyCellEntryTimeoutMs ?? DEFAULT_VERIFY_CELL_ENTRY_TIMEOUT_MS;

  const isInterior = isInteriorTarget(target);

  // Resolve the outdoor anchor — this is where we'll stop, dismount (if
  // mounted), and switch to the cell-relative walk path (interior) OR just
  // call it done (outdoor).
  let outdoorAnchor: { x: number; z: number };
  let cellId: NetworkId | null = null;
  let cellLocalTarget: { x: number; z: number; y?: number } | null = null;
  let buildingObjForPortal: WorldObject | null = null;
  if (isInterior) {
    const buildingObj = pc.world.get(target.buildingId);
    if (buildingObj === undefined) {
      throw new Error(
        `navigate: building ${target.buildingId.toString()} is not in the WorldModel — ` +
          'the BUIO baseline must have been observed before navigation. ' +
          'Walk to a place where the building is visible first, or wait for the baseline flood.',
      );
    }
    if (buildingObj.typeId !== ObjectTypeTags.BUIO) {
      throw new Error(
        `navigate: object ${target.buildingId.toString()} is not a building ` +
          `(typeId=${buildingObj.typeIdString}); refusing to treat it as one`,
      );
    }
    outdoorAnchor = { x: buildingObj.position.x, z: buildingObj.position.z };
    buildingObjForPortal = buildingObj;
    // Resolve the cellId we'll walk into.
    const resolved =
      target.cellName === ''
        ? findFirstPublicCell(pc.world, target.buildingId)
        : findCellByName(pc.world, target.buildingId, target.cellName);
    if (resolved === null) {
      throw new Error(
        `navigate: building ${target.buildingId.toString()} has no cell matching ` +
          `'${target.cellName || '(first public)'}' — either the SCLT baselines for ` +
          'this building have not arrived yet, or the building genuinely lacks that ' +
          'cell. Check `ctx.world.filter(o => o.containerId === buildingId)` to ' +
          'inspect what cells are visible.',
      );
    }
    cellId = resolved;
    cellLocalTarget = target.position ?? { x: 0, z: 0 };
  } else {
    outdoorAnchor = { x: target.x, z: target.z };
  }

  // Distance from where we are now to the outdoor anchor.
  const dx = outdoorAnchor.x - pc.position.x;
  const dz = outdoorAnchor.z - pc.position.z;
  const distance = Math.hypot(dx, dz);

  // Decide whether to mount. Conditions:
  //   - useMount === 'auto'
  //   - we're not already mounted
  //   - distance > threshold
  //   - we have at least one vehicle PCD in the datapad
  //   - we're outdoors (can't call a vehicle from inside a cell)
  const shouldMount =
    useMount === 'auto' &&
    pc.mountCapMps === null &&
    distance > mountThresholdM &&
    pc.vehiclePcdIds.length > 0 &&
    pc.currentCell === null;

  const steps: NavigateStep[] = [];

  if (shouldMount) {
    const vehiclePcdId = pc.vehiclePcdIds[0]!;
    steps.push({ kind: 'callVehicle', vehiclePcdId });
    // The "vehicleId" we hand to mount() is the same as the PCD — the
    // ScriptContext.mount() wraps useAbility('mount', id) and the server's
    // mount script accepts either the PCD or the live vehicle creature
    // (the PCD's OnObjectMenuSelect proxies through to the called vehicle).
    // Empirically tests use either; we use the PCD because we already have
    // its id.
    steps.push({ kind: 'mount', vehicleId: vehiclePcdId });
  }

  // Walk outdoors to the anchor. For interior targets, stop at
  // `dismountDistanceM` from the building so we dismount with room to spare.
  // For outdoor targets, walk straight to the anchor.
  const walkAnchor = isInterior
    ? approachAnchor(pc.position, outdoorAnchor, dismountDistanceM)
    : outdoorAnchor;
  if (!approxEqual(walkAnchor.x, pc.position.x) || !approxEqual(walkAnchor.z, pc.position.z)) {
    steps.push({
      kind: 'walkTo',
      x: walkAnchor.x,
      z: walkAnchor.z,
    });
  }

  if (!isInterior) {
    return { steps, cellId, outdoorAnchor };
  }

  // Interior target. Dismount before the cell entry. Both the server
  // (dismounts you on cell entry anyway) and the client (server-side
  // dismount script doesn't always echo back fast enough) prefer an
  // explicit dismount first.
  if (pc.mountCapMps !== null || shouldMount) {
    steps.push({ kind: 'dismount' });
  }

  // Cell-id map from `cellNumber` → NetworkId for the building. Used by the
  // portal path to translate cell-graph indices (which are
  // `Cell.index` === wire `cellNumber`) into the NetworkIds the cell-relative
  // transform messages take.
  const cellIdByNumber = buildCellIdMap(pc.world, target.buildingId);

  // Portal-aware path requires: a loaded layout, a non-empty cell path, a
  // building world position+yaw (which we have via buildingObjForPortal),
  // AND we must be able to resolve every hop's cellNumber → NetworkId.
  // We bind concrete locals after each guard so TypeScript can narrow each
  // one without `!` non-null assertions sprinkled through the loop body.
  if (
    portalLayout !== undefined &&
    cellPath !== undefined &&
    cellPath !== null &&
    cellPath.length > 0 &&
    buildingObjForPortal !== null &&
    cellId !== null &&
    cellLocalTarget !== null &&
    cellPath.every((hop) => cellIdByNumber.has(hop.toCellIndex))
  ) {
    const building = buildingObjForPortal;
    const path = cellPath;
    const targetCellId = cellId;
    const targetCellLocal = cellLocalTarget;
    const layout = portalLayout;
    for (let i = 0; i < path.length; ++i) {
      const hop = path[i];
      if (hop === undefined) continue; // unreachable: index in range
      const toCellNetworkId = cellIdByNumber.get(hop.toCellIndex);
      if (toCellNetworkId === undefined) {
        // Shouldn't happen given the .every() check above; fall back.
        return planNavigateSync(
          pc,
          target,
          opts,
          undefined,
          null,
          `navigate: cell ${hop.toCellIndex} has no NetworkId in WorldModel — falling back, cell entry may not register`,
        );
      }
      if (i === 0) {
        // Exterior → first interior cell. Walk to the world-coord run-up
        // first, then re-parent.
        const entry = computeExteriorPortalEntry(
          { x: building.position.x, y: building.position.y, z: building.position.z },
          building.yaw,
          hop,
          layout,
        );
        steps.push({
          kind: 'walkThroughPortal',
          fromCellId: null,
          toCellId: toCellNetworkId,
          portalWorld: entry.portalWorld,
          toCellLocalEntry: entry.toCellLocalEntry,
        });
      } else {
        // Cell → cell. Walk to the door inside the source cell, then
        // re-parent into the destination cell.
        const prevHop = path[i - 1];
        if (prevHop === undefined) continue; // unreachable: loop invariant
        const fromCellNetworkId = cellIdByNumber.get(prevHop.toCellIndex);
        if (fromCellNetworkId === undefined) {
          return planNavigateSync(
            pc,
            target,
            opts,
            undefined,
            null,
            `navigate: cell ${prevHop.toCellIndex} has no NetworkId in WorldModel — falling back, cell entry may not register`,
          );
        }
        const entry = computeInteriorPortalEntry(hop, layout);
        steps.push({
          kind: 'walkThroughPortal',
          fromCellId: fromCellNetworkId,
          toCellId: toCellNetworkId,
          fromCellLocalDoor: entry.fromCellLocalDoor,
          toCellLocalEntry: entry.toCellLocalEntry,
        });
      }
    }

    // Final cell-local target inside the destination cell. We always emit a
    // walkToCell to the requested `cellLocalTarget` (default {0,0}) — the
    // last hop's `toCellLocalEntry` is just a safe interior point, not the
    // user's requested position.
    const cellStep: NavigateStep = {
      kind: 'walkToCell',
      cellId: targetCellId,
      x: targetCellLocal.x,
      z: targetCellLocal.z,
    };
    if (targetCellLocal.y !== undefined) cellStep.y = targetCellLocal.y;
    steps.push(cellStep);

    // Diagnostic: poll the LocationView to see if the server accepted the
    // re-parent. Logs a warn on mismatch; does NOT throw.
    steps.push({ kind: 'verifyCellEntry', cellId: targetCellId, timeoutMs: verifyTimeoutMs });

    return { steps, cellId, outdoorAnchor, fallbackReason: null };
  }

  // Legacy fallback path — walk to the building anchor, then walkToCell({0,0})
  // and hope the server's findContainingCell accepts it (it usually doesn't,
  // hence the whole portal-aware rework above).
  if (!approxEqual(walkAnchor.x, outdoorAnchor.x) || !approxEqual(walkAnchor.z, outdoorAnchor.z)) {
    steps.push({
      kind: 'walkTo',
      x: outdoorAnchor.x,
      z: outdoorAnchor.z,
    });
  }
  const cellStep: NavigateStep = {
    kind: 'walkToCell',
    cellId: cellId!,
    x: cellLocalTarget!.x,
    z: cellLocalTarget!.z,
  };
  if (cellLocalTarget!.y !== undefined) cellStep.y = cellLocalTarget!.y;
  steps.push(cellStep);

  const plan: NavigatePlan = { steps, cellId, outdoorAnchor };
  if (fallbackReason !== undefined) plan.fallbackReason = fallbackReason;
  return plan;
}

function isInteriorTarget(target: NavigateTarget): target is InteriorTarget {
  return 'buildingId' in target;
}

/**
 * Walk the WorldModel for the building's SCLT children and build a
 * `cellNumber → NetworkId` map. Used to translate cell-graph indices into
 * the NetworkIds the cell-relative transform messages take. Returns an
 * empty map if no SCLT children are visible yet (caller should fall back).
 */
function buildCellIdMap(world: WorldModel, buildingId: NetworkId): Map<number, NetworkId> {
  const map = new Map<number, NetworkId>();
  for (const obj of world.objects()) {
    if (obj.typeId !== ObjectTypeTags.SCLT) continue;
    if (obj.containerId !== buildingId) continue;
    const shared = obj.baselines.get(BaselinePackageIds.SHARED) as
      | CellObjectSharedBaseline
      | undefined;
    if (shared === undefined) continue;
    map.set(shared.cellNumber, obj.id);
  }
  return map;
}

/**
 * Find the wire-`cellNumber` for an interior target. Returns null if the
 * cell isn't in the WorldModel yet — caller falls through to the legacy
 * error-surfacing path.
 */
function resolveTargetCellNumber(world: WorldModel, target: InteriorTarget): number | null {
  if (target.cellName === '') {
    const firstPublic = findFirstPublicCell(world, target.buildingId);
    if (firstPublic === null) return null;
    const obj = world.get(firstPublic);
    const shared = obj?.baselines.get(BaselinePackageIds.SHARED) as
      | CellObjectSharedBaseline
      | undefined;
    return shared?.cellNumber ?? null;
  }
  const byName = findCellByName(world, target.buildingId, target.cellName);
  if (byName === null) return null;
  const obj = world.get(byName);
  const shared = obj?.baselines.get(BaselinePackageIds.SHARED) as
    | CellObjectSharedBaseline
    | undefined;
  return shared?.cellNumber ?? null;
}

/**
 * Compute the world-coord run-up point (a meter past the door on the
 * outside) AND the cell-local entry point inside the destination cell for
 * a cell 0 → interior hop.
 *
 * The run-up offset uses the portal plane's outward normal (computed from
 * the geometry quad's first two edges via a cross product, sign flipped
 * when `windingClockwise === false` so "outward" is consistent).
 *
 * The world-coord transform is:
 *   `portalWorld = building.position + rotateY(door_in_fromCell_frame + outwardNormal*1m, building.yaw)`
 *
 * Cell 0 is the exterior, so its "local frame" coincides with world space
 * AFTER applying the building's transform. The +1m run-up keeps the
 * server's anti-cheat distance/speed checks happy when the next message
 * is the cell-relative transform.
 *
 * The cell-local entry on the destination side is computed by
 * `computeCellLocalEntry` — see its JSDoc for the centroid heuristic.
 */
function computeExteriorPortalEntry(
  buildingPos: Vector3,
  buildingYaw: number,
  hop: CellPathHop,
  layout: PortalLayout,
): {
  portalWorld: { x: number; y: number; z: number };
  toCellLocalEntry: { x: number; y: number; z: number };
} {
  // The hop's portal is the OUTGOING portal on cell 0 (exterior). Its
  // geometry is expressed in cell 0's local frame, which is the building's
  // local frame.
  const outwardNormal = portalOutwardNormal(hop.portal);

  // Door midpoint + 1m along the outward normal (in cell 0's local frame).
  const doorWithRunUp: Vector3 = {
    x: hop.fromCellLocalDoor.x + outwardNormal.x * PORTAL_OUTWARD_RUNUP_M,
    y: hop.fromCellLocalDoor.y,
    z: hop.fromCellLocalDoor.z + outwardNormal.z * PORTAL_OUTWARD_RUNUP_M,
  };

  // Rotate by the building's yaw and translate by its world position.
  const rotated = rotateY(doorWithRunUp, buildingYaw);
  const portalWorld = {
    x: buildingPos.x + rotated.x,
    y: buildingPos.y + doorWithRunUp.y,
    z: buildingPos.z + rotated.z,
  };

  // Cell-local entry on the destination side: door + inwardNormal * 2m,
  // computed in the DESTINATION cell's frame from the mirror portal.
  const toCellLocalEntry = computeCellLocalEntry(hop, layout);

  return { portalWorld, toCellLocalEntry };
}

/**
 * Interior → interior hop. Computes the door position in `fromCell`'s
 * local frame (from the outgoing portal) AND the entry point in
 * `toCell`'s local frame via `computeCellLocalEntry` (centroid heuristic
 * — see its JSDoc).
 */
function computeInteriorPortalEntry(
  hop: CellPathHop,
  layout: PortalLayout,
): {
  fromCellLocalDoor: { x: number; y: number; z: number };
  toCellLocalEntry: { x: number; y: number; z: number };
} {
  return {
    fromCellLocalDoor: {
      x: hop.fromCellLocalDoor.x,
      y: hop.fromCellLocalDoor.y,
      z: hop.fromCellLocalDoor.z,
    },
    toCellLocalEntry: computeCellLocalEntry(hop, layout),
  };
}

/**
 * Compute the entry point in the destination cell's local frame for one
 * portal hop. The position MUST be closest to the destination cell's floor
 * (per `PortalProperty::findContainingCell` → `FloorMesh::findClosestLocation`)
 * for the server to accept the re-parent — being merely "past the door" is
 * not enough; the position must clearly belong to the destination cell when
 * the server iterates the building's child cells and picks the one whose
 * floor is closest.
 *
 * # Why a centroid heuristic (and not the door + inward normal)
 *
 * Door positions sit AT the cell boundary. The mirror-portal's "inward
 * normal" is supposed to point from the door into the destination cell —
 * but the .pob's winding flag is unreliable: for the cantina's front portal,
 * the source-side winding flag and the destination-side winding flag both
 * encode the same physical quad, and the sign of the "outward normal"
 * resolved by `portalOutwardNormal` ends up pointing INTO the source cell
 * instead of out of it. Negating to get "inward on dest" then takes us
 * back toward the source, which is exactly where we don't want to land.
 *
 * Rather than try to disambiguate the winding sign — which would require
 * floor-mesh data we don't yet read — we use the destination cell's portal
 * door positions directly:
 *
 *   - **2+ portals**: arithmetic mean of all passable door positions in the
 *     destination cell. The centroid is robustly inside any convex-ish cell
 *     (which all SWG cells are — they're authored as polygonal rooms with
 *     doors on the perimeter). For the cantina's foyer1 (cell 1), this gives
 *     `((47.80+35.63)/2, (0.10+2.10)/2, (-3.70-7.05)/2) = (41.72, 1.10,
 *     -5.38)` which sits in the middle of the foyer, far from foyer2's floor.
 *
 *   - **1 portal** (e.g. an alcove): no centroid available. Take the door
 *     position and offset 2m AWAY from the source cell's portal-centroid.
 *     "Away from where we came in" is a reliable proxy for "into the cell."
 *     For the cantina's alcove2 (cell 5) reached from the main floor (cell 3,
 *     11 portals), the source centroid is roughly (-0.92, 0.6, 0.57) and the
 *     alcove door is (17.22, 1.08, 13.27); offset direction is (+0.82, +0.57)
 *     (xz-normalized) and the entry lands at (18.86, 1.08, 14.42) — well
 *     inside alcove2.
 *
 *   - **Single-portal dest with single-portal source** (e.g. a one-room
 *     building entered from exterior — exterior has no useful centroid in
 *     this fallback path): preserve the old mirror-portal-inward-normal
 *     behavior with the same 2m offset. This case is rare and matches the
 *     existing unit-test fixture; we keep it working for forward-compat with
 *     callers that build hand-crafted test layouts.
 *
 *   - **0 portals**: shouldn't happen (an isolated cell can't be reached).
 *     Falls back to the raw door position.
 */
function computeCellLocalEntry(
  hop: CellPathHop,
  layout: PortalLayout,
): { x: number; y: number; z: number } {
  const destCell = layout.cells.find((c) => c.index === hop.toCellIndex);
  if (destCell !== undefined) {
    const destPassable = destCell.portals.filter((p) => p.passable && !p.disabled);
    if (destPassable.length >= 2) {
      return portalDoorCentroid(destPassable);
    }
  }

  // Single-portal (or no-portal) destination. Try the source-cell-centroid
  // direction as a more-robust proxy for "into the destination cell."
  const sourceCell = layout.cells.find((c) => c.index === hop.fromCellIndex);
  if (sourceCell !== undefined) {
    const sourcePassable = sourceCell.portals.filter((p) => p.passable && !p.disabled);
    if (sourcePassable.length >= 2) {
      const sourceCentroid = portalDoorCentroid(sourcePassable);
      const dx = hop.toCellLocalDoor.x - sourceCentroid.x;
      const dz = hop.toCellLocalDoor.z - sourceCentroid.z;
      const mag = Math.hypot(dx, dz);
      if (mag > 1e-6) {
        const nx = dx / mag;
        const nz = dz / mag;
        return {
          x: hop.toCellLocalDoor.x + nx * PORTAL_INWARD_ENTRY_M,
          y: hop.toCellLocalDoor.y,
          z: hop.toCellLocalDoor.z + nz * PORTAL_INWARD_ENTRY_M,
        };
      }
    }
  }

  // Fallback: mirror-portal inward-normal (preserved for the
  // single-portal-source-and-dest edge case and as a last resort when the
  // destination cell isn't in the layout — should be unreachable in practice
  // for a well-formed .pob).
  const mirror = findMirrorPortal(destCell, hop.fromCellIndex, hop.portal);
  if (mirror === null) {
    return {
      x: hop.toCellLocalDoor.x,
      y: hop.toCellLocalDoor.y,
      z: hop.toCellLocalDoor.z,
    };
  }
  const outwardOnDest = portalOutwardNormal(mirror);
  const inwardOnDest = { x: -outwardOnDest.x, y: 0, z: -outwardOnDest.z };
  return {
    x: hop.toCellLocalDoor.x + inwardOnDest.x * PORTAL_INWARD_ENTRY_M,
    y: hop.toCellLocalDoor.y,
    z: hop.toCellLocalDoor.z + inwardOnDest.z * PORTAL_INWARD_ENTRY_M,
  };
}

/**
 * Arithmetic mean of the door positions of the given portals. Used to derive
 * a "deep inside the cell" point for multi-portal destinations.
 */
function portalDoorCentroid(portals: readonly CellPortal[]): {
  x: number;
  y: number;
  z: number;
} {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const p of portals) {
    sx += p.doorPosition.x;
    sy += p.doorPosition.y;
    sz += p.doorPosition.z;
  }
  const n = portals.length;
  return { x: sx / n, y: sy / n, z: sz / n };
}

/**
 * Find the mirror portal on `destCell` — the entry with the same
 * `geometryIndex` pointing back at `sourceCellIndex`. Falls back to "any
 * portal with the same geometryIndex" if no direct mirror is found.
 */
function findMirrorPortal(
  destCell: Cell | undefined,
  sourceCellIndex: number,
  outgoing: CellPortal,
): CellPortal | null {
  if (!destCell) return null;
  for (const candidate of destCell.portals) {
    if (
      candidate.geometryIndex === outgoing.geometryIndex &&
      candidate.targetCellIndex === sourceCellIndex
    ) {
      return candidate;
    }
  }
  for (const candidate of destCell.portals) {
    if (candidate.geometryIndex === outgoing.geometryIndex) return candidate;
  }
  return null;
}

/**
 * Compute the outward-pointing portal-plane normal in the portal's owning
 * cell frame. The quad's first three vertices span two edges; the cross
 * product gives the plane normal. Direction is flipped when
 * `windingClockwise === false` so "outward" is consistent.
 *
 * We project onto the XZ plane (y=0) for the navigate use case — the
 * server's findContainingCell ignores y when classifying which cell a
 * position belongs to (it only checks the floor footprint), and movement
 * primitives hold y constant. Y-component of the cross is preserved on
 * the return so callers that want the full 3D normal can have it; only
 * the XZ projection is normalized for the run-up math.
 */
function portalOutwardNormal(portal: CellPortal): { x: number; y: number; z: number } {
  const v = portal.geometry.vertices;
  // Two edges from vertex 0.
  const e1 = { x: v[1].x - v[0].x, y: v[1].y - v[0].y, z: v[1].z - v[0].z };
  const e2 = { x: v[2].x - v[0].x, y: v[2].y - v[0].y, z: v[2].z - v[0].z };
  // Cross product e1 × e2.
  const nx = e1.y * e2.z - e1.z * e2.y;
  const ny = e1.z * e2.x - e1.x * e2.z;
  const nz = e1.x * e2.y - e1.y * e2.x;
  // Flip if winding is anticlockwise on the wire side.
  const sign = portal.windingClockwise ? 1 : -1;
  // Normalize on the XZ plane.
  const xz = Math.hypot(nx * sign, nz * sign);
  if (xz < 1e-9) {
    // Degenerate quad — return a small +x default so the offsets are
    // non-zero. Caller will still produce a walkToCell; the verify step
    // will surface a warning if the server rejects.
    return { x: 1, y: ny * sign, z: 0 };
  }
  return { x: (nx * sign) / xz, y: ny * sign, z: (nz * sign) / xz };
}

/**
 * Rotate (x, z) by `yaw` radians about the y axis. Mirrors the convention
 * used elsewhere in the client (`yawToQuat` etc.). The translation is
 * applied by the caller.
 */
function rotateY(p: { x: number; y?: number; z: number }, yaw: number): { x: number; z: number } {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return {
    x: p.x * c + p.z * s,
    z: -p.x * s + p.z * c,
  };
}

/**
 * Compute the point along the line from `from` to `to` that is `stopDistance`
 * meters short of `to`. If the line is shorter than `stopDistance`, returns
 * `from` (we don't need to walk at all to get within the dismount range).
 */
function approachAnchor(
  from: Vector3,
  to: { x: number; z: number },
  stopDistance: number,
): { x: number; z: number } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d <= stopDistance) return { x: from.x, z: from.z };
  const t = (d - stopDistance) / d;
  return { x: from.x + dx * t, z: from.z + dz * t };
}

function approxEqual(a: number, b: number, eps = 1e-3): boolean {
  return Math.abs(a - b) <= eps;
}

/**
 * Execute the navigate plan via the ScriptContext primitives. Public entry
 * point invoked by `ctx.navigate(...)`.
 *
 * Resolves when the player has arrived at the final target. Throws on any
 * step failure (no soft-fail) — except the `verifyCellEntry` step, which
 * is purely diagnostic and never throws.
 */
export async function navigate(
  ctx: ScriptContext,
  target: NavigateTarget,
  opts: NavigateOptions = {},
): Promise<void> {
  const playerId = ctx.sceneStart.playerNetworkId;
  const playerCellNow = resolvePlayerCell(ctx.world, playerId);
  const pc: PlanContext = {
    world: ctx.world,
    position: ctx.position(),
    currentCell: null,
    mountCapMps: ctx.mountedSpeedCap(),
    vehiclePcdIds: ctx.datapad.vehicles().map((v) => v.networkId),
  };
  // Set currentCell from the resolved cell descriptor. We use the player
  // CREO's containerId directly (the LocationCell type holds the building
  // id, not the cell id).
  if (playerCellNow !== null) {
    const player = ctx.world.get(playerId);
    if (player !== undefined && player.containerId !== 0n) {
      pc.currentCell = player.containerId;
    }
  }

  // Clear any outstanding server-initiated teleports (positive AND negative
  // sequence numbers) before kicking off the plan. `ctx.ackPendingTeleports`
  // — invoked by `walkTo`/`walkToCell` further down — only ACKs negative-
  // seq broadcasts (zone-in `resyncMovementUpdates`); but
  // `PlayerCreatureController::teleport` (called by every admin warp,
  // shuttle transition, NPC teleport, etc.) uses POSITIVE seqs from
  // `getAndIncrementMoveSequenceNumber()`. Until each pending positive seq
  // is ACKed, `isTeleporting()` stays true server-side and every
  // client-sourced transform is silently dropped at `handleMove`'s
  // `isTeleporting()` gate — including by gods (no god short-circuit on
  // `handleMove`). Doing this scan from inside `navigate` keeps the change
  // scoped to where it's needed (post-warp interior entries) without
  // altering the global ack semantics elsewhere.

  // Subscribe to NEW inbound teleports FIRST so anything that arrives
  // between our initial scan and the plan's first transform is ACKed
  // by the listener (otherwise there's a race window where late
  // broadcasts arrive after the transcript-scan but before walkToCell
  // fires its first transform).
  const liveAckUnsub = ctx.dispatcher.onMessage(ObjControllerMessage, (m) => {
    if (m.message !== ObjControllerSubtypeIds.CM_netUpdateTransform) return;
    if (m.networkId !== playerId) return;
    if (m.decodedSubtype?.kind !== NetUpdateTransformKind) return;
    const td = m.decodedSubtype.data as NetUpdateTransformData;
    if (td.sequenceNumber === 0) return;
    const acked = navigateAckedSeqs.get(ctx);
    if (acked !== undefined && acked.has(td.sequenceNumber)) return;
    acked?.add(td.sequenceNumber);
    sendTeleportAck(ctx, playerId, td.sequenceNumber);
  });
  // Initial scan + ack of anything already in the transcript.
  ackAllInboundTeleportSeqs(ctx, playerId);
  // Settle window: wait long enough for any in-flight teleport broadcasts
  // (e.g. from a recent admin_planetwarp whose UDP packet hasn't reached
  // the client yet) to arrive AND for the server to process our ACKs.
  // 500ms covers a typical LAN round-trip + a couple of server frames.
  // The live listener above catches anything that arrives during the wait;
  // a final 50ms tail gives the server time to process those last ACKs
  // before the plan's first transform.
  await ctx.wait(1500);
  ackAllInboundTeleportSeqs(ctx, playerId);
  await ctx.wait(100);

  try {
    const plan = await planNavigate(pc, target, opts, ctx.knowledge);
    if (plan.fallbackReason !== undefined && plan.fallbackReason !== null) {
      console.warn(plan.fallbackReason);
    }
    await runPlan(ctx, plan, opts);
  } finally {
    liveAckUnsub();
  }
}

/**
 * Scan the dispatcher transcript for every inbound
 * `ObjControllerMessage(CM_netUpdateTransform=113)` directed at `playerId`,
 * pull its `sequenceNumber`, and fire a `CM_teleportAck` for any value we
 * haven't already ACKed via this helper. Idempotent within one navigate
 * call via a process-local memo.
 *
 * Server-side `m_teleportIds` stores both signs:
 *   - Negative seqs: `resyncMovementUpdates` zone-in lockout
 *     (`PlayerCreatureController.cpp:285`).
 *   - Positive seqs: `teleport()` direct teleports
 *     (`PlayerCreatureController.cpp:307`, invoked by admin warp, shuttle,
 *     NPC teleport, etc. via `getAndIncrementMoveSequenceNumber()`).
 *
 * `ctx.ackPendingTeleports` filters strictly on `< 0`, so positive-seq
 * teleports leak through and pin `isTeleporting()` to true. Acking the
 * same id twice is a server-side no-op (`m_teleportIds.erase` of an
 * absent id is silent), so re-firing any seq we see is safe.
 */
function ackAllInboundTeleportSeqs(ctx: ScriptContext, playerId: NetworkId): void {
  let acked = navigateAckedSeqs.get(ctx);
  if (acked === undefined) {
    acked = new Set<number>();
    navigateAckedSeqs.set(ctx, acked);
  }
  const seqsToAck: number[] = [];
  for (const e of ctx.dispatcher.transcript) {
    if (e.direction !== 'recv') continue;
    const decoded = e.decoded;
    if (!(decoded instanceof ObjControllerMessage)) continue;
    if (decoded.message !== ObjControllerSubtypeIds.CM_netUpdateTransform) continue;
    if (decoded.networkId !== playerId) continue;
    if (decoded.decodedSubtype?.kind !== NetUpdateTransformKind) continue;
    const td = decoded.decodedSubtype.data as NetUpdateTransformData;
    const seq = td.sequenceNumber;
    if (seq === 0) continue;
    if (acked.has(seq)) continue;
    acked.add(seq);
    seqsToAck.push(seq);
  }
  for (const seq of seqsToAck) {
    sendTeleportAck(ctx, playerId, seq);
  }
}

/** Per-ScriptContext memo of teleport seqs ACKed by navigate's helper. */
const navigateAckedSeqs = new WeakMap<ScriptContext, Set<number>>();

function sendTeleportAck(ctx: ScriptContext, playerId: NetworkId, sequenceId: number): void {
  const data: TeleportAckData = { sequenceId };
  const stream = new ByteStream();
  TeleportAckDecoder.encode(stream, data);
  ctx.send(
    new ObjControllerMessage(
      CLIENT_TO_AUTH_SERVER_FLAGS,
      ObjControllerSubtypeIds.CM_teleportAck,
      playerId,
      0,
      stream.toBytes(),
      { kind: TeleportAckDecoder.kind, data },
    ),
  );
}

/**
 * Execute a pre-built plan. Exposed so callers (and tests) can plan then
 * re-use the plan, or splice in additional steps before running.
 */
export async function runPlan(
  ctx: ScriptContext,
  plan: NavigatePlan,
  opts: NavigateOptions = {},
): Promise<void> {
  for (const step of plan.steps) {
    switch (step.kind) {
      case 'callVehicle': {
        ctx.callVehicle(step.vehiclePcdId);
        // Give the server a moment to spawn the vehicle creature. The
        // mount step below races against this — if we mount too soon the
        // server's `mount` script fails its `validateMountable` check.
        await ctx.wait(1_500);
        // Resolve the actual vehicle creature OID — the PCD spawns a CREO
        // child whose creature template was set during PCD construction.
        // We look for a fresh creature whose template matches the vehicle
        // class. If we can't find one, fall back to mounting the PCD id
        // (some server builds accept that).
        const live = findLiveVehicleNear(ctx, step.vehiclePcdId, ctx.position());
        if (live !== null) {
          // Replace this step's mount-id with the live creature id.
          // We mutate the next step in-place — safe because we run
          // sequentially and no one else holds a reference to the array.
          const nextIdx = plan.steps.indexOf(step) + 1;
          const next = plan.steps[nextIdx];
          if (next !== undefined && next.kind === 'mount') {
            next.vehicleId = live.id;
          }
        }
        break;
      }
      case 'mount':
        ctx.mount(step.vehicleId);
        // Brief settle — the server side `mount` script-trigger runs JNI calls
        // that need a tick to complete. Movement primitives queued immediately
        // after sometimes race against `States::RidingMount` not being set yet.
        await ctx.wait(800);
        break;
      case 'dismount':
        ctx.dismount();
        await ctx.wait(500);
        break;
      case 'walkTo': {
        const walkOpts: { y?: number } = {};
        if (step.y !== undefined) walkOpts.y = step.y;
        const target: { x: number; z: number; y?: number } = { x: step.x, z: step.z };
        if (step.y !== undefined) target.y = step.y;
        await ctx.walkTo(target, walkOpts);
        break;
      }
      case 'walkToCell': {
        const walkOpts: { y?: number } = {};
        if (step.y !== undefined) walkOpts.y = step.y;
        const target: { x: number; z: number; y?: number } = { x: step.x, z: step.z };
        if (step.y !== undefined) target.y = step.y;
        await ctx.walkToCell(step.cellId, target, walkOpts);
        break;
      }
      case 'walkThroughPortal': {
        // Sequencing matters: the world-coord walk (or interior cell walk)
        // must FLOW directly into the cell-relative re-parent with no `wait`
        // in between. Anything else gives the server a chance to broadcast
        // a clamped position back at us between the two messages, which the
        // walkToCell then has to reconcile.
        if (step.fromCellId === null) {
          // Exterior → first interior. Walk to the world-coord run-up.
          if (step.portalWorld !== undefined) {
            const walkOpts: { y?: number } = {};
            if (step.portalWorld.y !== undefined) walkOpts.y = step.portalWorld.y;
            const portalTarget: { x: number; z: number; y?: number } = {
              x: step.portalWorld.x,
              z: step.portalWorld.z,
            };
            if (step.portalWorld.y !== undefined) portalTarget.y = step.portalWorld.y;
            await ctx.walkTo(portalTarget, walkOpts);
          }
        } else {
          // Interior → interior. Walk to the door inside the source cell.
          if (step.fromCellLocalDoor !== undefined) {
            const walkOpts: { y?: number } = {};
            if (step.fromCellLocalDoor.y !== undefined) walkOpts.y = step.fromCellLocalDoor.y;
            const doorTarget: { x: number; z: number; y?: number } = {
              x: step.fromCellLocalDoor.x,
              z: step.fromCellLocalDoor.z,
            };
            if (step.fromCellLocalDoor.y !== undefined) doorTarget.y = step.fromCellLocalDoor.y;
            await ctx.walkToCell(step.fromCellId, doorTarget, walkOpts);
          }
        }
        // Immediate re-parent into the destination cell.
        const entryOpts: { y?: number } = {};
        if (step.toCellLocalEntry.y !== undefined) entryOpts.y = step.toCellLocalEntry.y;
        const entryTarget: { x: number; z: number; y?: number } = {
          x: step.toCellLocalEntry.x,
          z: step.toCellLocalEntry.z,
        };
        if (step.toCellLocalEntry.y !== undefined) entryTarget.y = step.toCellLocalEntry.y;
        await ctx.walkToCell(step.toCellId, entryTarget, entryOpts);
        break;
      }
      case 'verifyCellEntry': {
        await verifyCellEntry(ctx, step.cellId, step.timeoutMs);
        break;
      }
    }
  }
  // Touch opts to keep the param meaningful when future callers want to wire
  // extra runtime behaviors through (e.g. per-step retry counts).
  void opts;
}

/**
 * Poll the player CREO's `containerId` until it equals `expectedCellId`, or
 * until `timeoutMs` elapses. Diagnostic only — never throws. On timeout (or
 * mismatch) emits a `console.warn` so the operator sees the server didn't
 * accept the re-parent.
 *
 * We compare against `containerId` directly rather than `LocationView.cell`
 * because the latter returns a descriptor without the cell's NetworkId; the
 * raw `containerId` IS the cell id when the player is in a cell.
 */
async function verifyCellEntry(
  ctx: ScriptContext,
  expectedCellId: NetworkId,
  timeoutMs: number,
): Promise<void> {
  const playerId = ctx.sceneStart.playerNetworkId;
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 200;
  while (Date.now() < deadline) {
    const player = ctx.world.get(playerId);
    if (player !== undefined && player.containerId === expectedCellId) {
      return;
    }
    if (ctx.signal.aborted) return;
    await ctx.wait(pollIntervalMs);
  }
  // Final check post-deadline.
  const player = ctx.world.get(playerId);
  if (player !== undefined && player.containerId === expectedCellId) {
    return;
  }
  const observedContainerId = player?.containerId.toString() ?? '<unknown>';
  console.warn(
    `navigate.verifyCellEntry: expected player ${playerId.toString()} to be in cell ` +
      `${expectedCellId.toString()} after ${timeoutMs}ms but containerId=${observedContainerId}`,
  );
}

/**
 * Try to find the live vehicle creature spawned by a PCD. The PCD's
 * `pet_control_device.OnObjectMenuSelect(PET_CALL=45)` script spawns a CREO
 * child near the player (typically within 5m). We scan the WorldModel for a
 * recently-created CREO of the vehicle class near the player.
 *
 * Returns `null` if nothing convincing is found — caller should fall back to
 * mounting the PCD id itself.
 */
function findLiveVehicleNear(
  ctx: ScriptContext,
  _pcdId: NetworkId,
  near: Vector3,
): WorldObject | null {
  const r2 = 100; // 10m radius squared
  let best: WorldObject | null = null;
  let bestAge = Number.POSITIVE_INFINITY;
  for (const obj of ctx.world.objects()) {
    if (obj.typeId !== ObjectTypeTags.CREO) continue;
    if (obj.id === ctx.sceneStart.playerNetworkId) continue;
    // Heuristic: vehicle creatures have templates under
    // object/mobile/vehicle/ or carry the SHARED nameStringId pointing to a
    // vehicle entry. Templates aren't always known when CREO is created via
    // baselines (no Scene* observed), so allow either path.
    const template = obj.templateName ?? '';
    const isVehicleTemplate = /\/mobile\/vehicle\//.test(template) || template.endsWith('_pcd.iff');
    if (!isVehicleTemplate) {
      // Fall back to checking the SHARED nameStringId.text for a vehicle hint.
      const shared = obj.baselines.get(BaselinePackageIds.SHARED) as
        | { nameStringId?: { table?: string; text?: string } }
        | undefined;
      const tableHint = shared?.nameStringId?.table ?? '';
      if (!/vehicle/.test(tableHint)) continue;
    }
    const dx = obj.position.x - near.x;
    const dz = obj.position.z - near.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > r2) continue;
    const age = Date.now() - obj.firstSeenAt;
    if (age < bestAge) {
      best = obj;
      bestAge = age;
    }
  }
  return best;
}
