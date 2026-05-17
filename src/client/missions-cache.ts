/**
 * MissionsCache — live cache of active MissionObjects.
 *
 * Wraps a `WorldModel` and filters for objects with `typeId === MISO`,
 * absorbing their SHARED baseline (package 3, `MissionObjectSharedBaseline`)
 * into a flat `Mission` shape:
 *
 *   { id, type, payout, location, target, description }
 *
 * The cache stays current via WorldModel events — when a new MISO baseline
 * arrives (e.g. after the player calls `ctx.requestMissionList`), the entry
 * shows up; when the mission's SceneDestroyObject fires (abandon / complete),
 * it disappears.
 *
 * `type` is the lowercase string form of the `missionType` u32 CRC. The
 * server hashes the type name via `CrcLowerString::calculateCrc`, which
 * uses the same custom CRC32 table as the wire-format CRCs (see
 * `src/crc/constcrc.ts`). We pre-compute hashes for the known mission types
 * (destroy, recon, deliver, escort, bounty, survey, crafting, hunting,
 * musician, dancer, plus the space_* variants) and fall back to the
 * hex form when an unknown CRC arrives.
 */

import { constcrc } from '../crc/constcrc.js';
import {
  type MissionObjectSharedBaseline,
  ObjectTypeTags,
} from '../messages/game/baselines/index.js';
import { BaselinePackageIds } from '../messages/game/baselines/registry.js';
import type { NetworkId, Vector3 } from '../types.js';
import type { WorldModel, WorldObject } from './world-model.js';

/** One mission entry — the spec's required shape. */
export interface Mission {
  /** MissionObject NetworkId. */
  id: NetworkId;
  /**
   * Lowercase mission-type name (e.g. `"destroy"`, `"recon"`, `"deliver"`).
   * Falls back to `"0x<hex>"` when the wire CRC isn't in our known table —
   * lets scripts still filter / log without losing data.
   */
  type: string;
  /** Credits paid on completion. */
  payout: number;
  /**
   * Mission destination (the `endLocation` coordinates from the baseline).
   * `y` is included for completeness even though survey/destroy missions
   * usually use `y=0` (the server snaps to terrain server-side).
   */
  location: Vector3;
  /** Server template name of the target (e.g. `object/mobile/.../monster.iff`). */
  target: string;
  /** Mission description StringId text (the body text shown in the browser). */
  description: string;
}

/** Public surface exposed on `ctx.missions`. */
export interface MissionsCacheView {
  /** Live snapshot of every active mission. Recomputed on each access. */
  readonly active: Mission[];
  /**
   * Filter active missions whose `type` matches the regex.
   *   `findByCategory(/destroy|hunt/i)` ⇒ destroy + hunting missions.
   */
  findByCategory(re: RegExp): Mission[];
  /** Active mission with the highest `payout`, or `undefined` if none. */
  bestPayout(): Mission | undefined;
}

/**
 * CRC → lowercase name table for the mission types defined in
 * `MissionObject.cpp:280-307`. The C++ uses `CrcLowerString::calculateCrc`,
 * which is the same algorithm as `constcrc` in this client. Pre-compute
 * once at module load — these are small, stable, and zero-runtime-cost.
 */
const MISSION_TYPE_NAMES: ReadonlyArray<string> = [
  'destroy',
  'recon',
  'deliver',
  'escorttocreator',
  'escort',
  'bounty',
  'survey',
  'crafting',
  'musician',
  'dancer',
  'hunting',
  'space_assassination',
  'space_delivery',
  'space_delivery_duty',
  'space_destroy',
  'space_destroy_duty',
  'space_surprise_attack',
  'space_escort',
  'space_escort_duty',
  'space_inspection',
  'space_patrol',
  'space_recovery',
  'space_recovery_duty',
  'space_rescue',
  'space_rescue_duty',
  'space_battle',
  'space_survival',
  'space_mining_destroy',
];

const MISSION_TYPE_CRC_TO_NAME = new Map<number, string>(
  MISSION_TYPE_NAMES.map((name) => [constcrc(name), name]),
);

/** Look up a mission-type CRC; falls back to `"0x<hex>"` for unknown values. */
export function missionTypeName(crc: number): string {
  const known = MISSION_TYPE_CRC_TO_NAME.get(crc);
  if (known !== undefined) return known;
  return `0x${(crc >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Implementation. Pure derived state over the `WorldModel` — `active`
 * recomputes on every access by filtering for MISO objects with a typed
 * SHARED baseline. `attach`/`detach` are no-ops (kept for symmetry with
 * the other caches' lifecycle convention).
 */
export class MissionsCacheImpl implements MissionsCacheView {
  constructor(private readonly world: WorldModel) {}

  attach(): void {
    // Pure derived state — nothing to subscribe to. The `WorldModel`
    // already absorbs MISO baselines; we just filter on read.
  }

  detach(): void {
    // No subscription to release.
  }

  get active(): Mission[] {
    const out: Mission[] = [];
    for (const obj of this.world.byType(ObjectTypeTags.MISO)) {
      const m = this.toMission(obj);
      if (m !== null) out.push(m);
    }
    return out;
  }

  findByCategory(re: RegExp): Mission[] {
    return this.active.filter((m) => re.test(m.type));
  }

  bestPayout(): Mission | undefined {
    let best: Mission | undefined;
    for (const m of this.active) {
      if (best === undefined || m.payout > best.payout) {
        best = m;
      }
    }
    return best;
  }

  /**
   * Convert a `WorldObject` (which must already be a MISO) into a `Mission`,
   * or return `null` if the SHARED baseline hasn't been decoded yet.
   */
  private toMission(obj: WorldObject): Mission | null {
    const shared = obj.baselines.get(BaselinePackageIds.SHARED);
    if (shared === undefined) return null;
    if (shared instanceof Uint8Array) return null; // opaque — no typed fields
    const baseline = shared as Partial<MissionObjectSharedBaseline>;
    if (
      baseline.endLocation === undefined ||
      typeof baseline.reward !== 'number' ||
      baseline.description === undefined ||
      typeof baseline.missionType !== 'number'
    ) {
      return null;
    }
    return {
      id: obj.id,
      type: missionTypeName(baseline.missionType),
      payout: baseline.reward,
      location: {
        x: baseline.endLocation.coordinates.x,
        y: baseline.endLocation.coordinates.y,
        z: baseline.endLocation.coordinates.z,
      },
      target: baseline.targetName ?? '',
      description: baseline.description.text,
    };
  }
}
