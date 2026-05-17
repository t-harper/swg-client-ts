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
 */

import type { ScriptContext } from './script/context.js';
import type { Vector3 } from '../types.js';
import type { NetworkId } from '../types.js';
import {
  findCellByName,
  findFirstPublicCell,
  resolvePlayerCell,
} from './location.js';
import type { WorldModel, WorldObject } from './world-model.js';
import {
  BaselinePackageIds,
  ObjectTypeTags,
} from '../messages/game/baselines/registry.js';

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
  /** Walking speed cap (m/s). Default 4 on foot; mount cap when mounted. */
  speed?: number;
  /**
   * Distance (m) from the building's outdoor anchor to dismount at when
   * approaching an interior target. Default 8m — close enough to walk to
   * the door, far enough that the dismount animation doesn't clip into
   * the building. Only used for interior targets.
   */
  dismountDistanceM?: number;
}

/**
 * Inspectable plan for a navigate call. Returned by `planNavigate` for unit
 * tests; the executor `navigate()` runs the plan in-order.
 *
 * The plan is one or more sequential steps:
 *   - `callVehicle` / `mount` / `dismount` (motion-state changes)
 *   - `walkTo` (outdoor walk to an x/z)
 *   - `walkToCell` (cell-relative walk inside a cell)
 *
 * The executor stops at the first step that throws.
 */
export type NavigateStep =
  | { kind: 'callVehicle'; vehiclePcdId: NetworkId }
  | { kind: 'mount'; vehicleId: NetworkId }
  | { kind: 'dismount' }
  | { kind: 'walkTo'; x: number; z: number; y?: number; speed?: number }
  | {
      kind: 'walkToCell';
      cellId: NetworkId;
      x: number;
      z: number;
      y?: number;
      speed?: number;
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

/**
 * Build a step-by-step plan for the navigation. Pure — no side effects, no
 * dispatcher I/O. Exposed for unit tests that want to assert the planning
 * decisions without running the walk loop.
 *
 * Throws on:
 *   - Interior target whose `buildingId` isn't tracked in the WorldModel
 *     (the BUIO baseline wasn't observed yet; without it we can't resolve
 *     the building's anchor position).
 *   - Interior target whose `cellName` doesn't match any SCLT child of the
 *     building (no door / no such cell).
 */
export function planNavigate(
  pc: PlanContext,
  target: NavigateTarget,
  opts: NavigateOptions = {},
): NavigatePlan {
  const useMount = opts.useMount ?? 'auto';
  const mountThresholdM = opts.mountThresholdM ?? DEFAULT_MOUNT_THRESHOLD_M;
  const dismountDistanceM = opts.dismountDistanceM ?? DEFAULT_DISMOUNT_DISTANCE_M;
  const speed = opts.speed;

  const isInterior = 'buildingId' in target;

  // Resolve the outdoor anchor — this is where we'll stop, dismount (if
  // mounted), and switch to the cell-relative walk path (interior) OR just
  // call it done (outdoor).
  let outdoorAnchor: { x: number; z: number };
  let cellId: NetworkId | null = null;
  let cellLocalTarget: { x: number; z: number; y?: number } | null = null;
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
  if (
    !approxEqual(walkAnchor.x, pc.position.x) ||
    !approxEqual(walkAnchor.z, pc.position.z)
  ) {
    const step: NavigateStep = {
      kind: 'walkTo',
      x: walkAnchor.x,
      z: walkAnchor.z,
    };
    if (speed !== undefined) step.speed = speed;
    steps.push(step);
  }

  if (isInterior) {
    // Dismount before the cell entry. Both the server (dismounts you on cell
    // entry anyway) and the client (server-side dismount script doesn't
    // always echo back fast enough) prefer an explicit dismount first.
    if (pc.mountCapMps !== null || shouldMount) {
      steps.push({ kind: 'dismount' });
    }
    // Walk to the building's anchor (last leg on foot).
    if (
      !approxEqual(walkAnchor.x, outdoorAnchor.x) ||
      !approxEqual(walkAnchor.z, outdoorAnchor.z)
    ) {
      const step: NavigateStep = {
        kind: 'walkTo',
        x: outdoorAnchor.x,
        z: outdoorAnchor.z,
      };
      if (speed !== undefined) step.speed = speed;
      steps.push(step);
    }
    // Cell-relative walk into the interior position.
    const cellStep: NavigateStep = {
      kind: 'walkToCell',
      cellId: cellId!,
      x: cellLocalTarget!.x,
      z: cellLocalTarget!.z,
    };
    if (cellLocalTarget!.y !== undefined) cellStep.y = cellLocalTarget!.y;
    if (speed !== undefined) cellStep.speed = speed;
    steps.push(cellStep);
  }

  return { steps, cellId, outdoorAnchor };
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
 * step failure (no soft-fail).
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
    currentCell: playerCellNow === null ? null : playerCellNow.buildingId === 0n ? null : null,
    mountCapMps: ctx.mountedSpeedCap(),
    vehiclePcdIds: ctx.datapad.vehicles().map((v) => v.networkId),
  };
  // Set currentCell from the resolved cell descriptor (we discard the
  // buildingId in the assignment above to keep the type tight). Reassign
  // here using the cell id from the WorldModel.
  if (playerCellNow !== null) {
    const player = ctx.world.get(playerId);
    if (player !== undefined && player.containerId !== 0n) {
      pc.currentCell = player.containerId;
    }
  }

  const plan = planNavigate(pc, target, opts);
  await runPlan(ctx, plan, opts);
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
        const walkOpts: { speed?: number; y?: number } = {};
        if (step.speed !== undefined) walkOpts.speed = step.speed;
        if (step.y !== undefined) walkOpts.y = step.y;
        const target: { x: number; z: number; y?: number } = { x: step.x, z: step.z };
        if (step.y !== undefined) target.y = step.y;
        await ctx.walkTo(target, walkOpts);
        break;
      }
      case 'walkToCell': {
        const walkOpts: { speed?: number; y?: number } = {};
        if (step.speed !== undefined) walkOpts.speed = step.speed;
        if (step.y !== undefined) walkOpts.y = step.y;
        const target: { x: number; z: number; y?: number } = { x: step.x, z: step.z };
        if (step.y !== undefined) target.y = step.y;
        await ctx.walkToCell(step.cellId, target, walkOpts);
        break;
      }
    }
  }
  // Touch opts to keep the param meaningful when future callers want to wire
  // extra runtime behaviors through (e.g. per-step retry counts).
  void opts;
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
