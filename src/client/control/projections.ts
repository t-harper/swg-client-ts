/**
 * Pure JSON projections of the live `ScriptContext` views, for the control
 * socket's read queries.
 *
 * `WorldModel.toSnapshot()` and `CharacterSheet.toJSON()` are already
 * JSON-safe; the other always-on views (`inventory`, `location`, `group`,
 * `combat`, `cooldowns`, `datapad`) are live getter objects with no
 * serializer, so each gets a small projection function here. Every function
 * is pure — it reads a view and returns a plain JSON-safe object
 * (`NetworkId` bigints rendered as decimal strings).
 */

import type { NetworkId } from '../../types.js';
import type { CombatView } from '../combat-helpers.js';
import type { GroupMember, GroupView } from '../group-view.js';
import type { InventoryView } from '../inventory-view.js';
import type { Knowledge } from '../knowledge.js';
import type { LocationView } from '../location.js';
import type { DatapadView } from '../script/datapad-view.js';
import type { CooldownView } from '../timing.js';
import type { ToSnapshotOptions, WorldModel } from '../world-model.js';

/** Render a `NetworkId` (or null) as a decimal string (or null). */
function nid(id: NetworkId | null | undefined): string | null {
  return id === null || id === undefined ? null : id.toString();
}

/** Read a numeric param, or `undefined` if absent / not a number. */
function numParam(params: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = params?.[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** Read a string param, or `undefined` if absent / not a string. */
function strParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = params?.[key];
  return typeof v === 'string' ? v : undefined;
}

/** Read a boolean param (accepts the string `"true"`). */
function boolParam(params: Record<string, unknown> | undefined, key: string): boolean {
  const v = params?.[key];
  return v === true || v === 'true';
}

/** Project the player's inventory. */
export function projectInventory(inv: InventoryView): unknown {
  return {
    containerId: nid(inv.containerId),
    ready: inv.ready,
    usedSlots: inv.usedSlots,
    totalSlots: inv.totalSlots,
    freeSlots: inv.freeSlots,
    items: inv.items.map((i) => ({
      networkId: i.networkId.toString(),
      templateName: i.templateName,
      name: i.name,
      arrangementId: i.arrangementId,
      containerId: i.containerId.toString(),
    })),
    resources: inv.resources().map((r) => ({
      containerId: r.containerId.toString(),
      resourceType: r.resourceType.toString(),
      quantity: r.quantity,
    })),
  };
}

/** Project the player's planet / position / cell. */
export function projectLocation(loc: LocationView): unknown {
  return {
    planet: loc.planet,
    position: { x: loc.position.x, y: loc.position.y, z: loc.position.z },
    cell:
      loc.cell === null
        ? null
        : {
            buildingId: loc.cell.buildingId.toString(),
            cellName: loc.cell.cellName,
            cellNumber: loc.cell.cellNumber,
            isPublic: loc.cell.isPublic,
          },
  };
}

function groupMemberJson(m: GroupMember): unknown {
  return {
    id: m.id.toString(),
    name: m.name,
    position: m.position === null ? null : { x: m.position.x, y: m.position.y, z: m.position.z },
    health: m.health,
    posture: m.posture,
    distance: m.distance,
  };
}

/** Project the player's group roster. */
export function projectGroup(group: GroupView): unknown {
  return {
    id: nid(group.id),
    size: group.size,
    leader: group.leader === null ? null : groupMemberJson(group.leader),
    members: group.members.map(groupMemberJson),
  };
}

/** Project current combat state. */
export function projectCombat(combat: CombatView): unknown {
  return {
    engaged: combat.engaged,
    autoLoot: combat.autoLoot,
    timeSinceLastHitMs: combat.timeSinceLastHitMs,
    targets: combat.targets().map((t) => ({
      id: t.id.toString(),
      distance: t.distance,
      ham: t.ham,
    })),
    damaged: [...combat.damagedSet()].map((id) => id.toString()),
  };
}

/** Project the per-command cooldown table. */
export function projectCooldowns(cd: CooldownView): unknown {
  const out: Record<string, { msUntilReady: number; isReady: boolean }> = {};
  for (const [name, entry] of cd.all()) {
    out[name] = { msUntilReady: entry.msUntilReady, isReady: entry.isReady() };
  }
  return { cooldowns: out };
}

/** Project the player's datapad contents. */
export function projectDatapad(dp: DatapadView): unknown {
  return {
    containerId: nid(dp.containerId),
    ready: dp.ready,
    items: dp.items.map((it) => ({
      networkId: it.networkId.toString(),
      templateName: it.templateName,
      templateCrc: it.templateCrc,
      name: it.name,
      kind: it.kind,
      containerId: it.containerId.toString(),
      linkedCreatureId: nid(it.linkedCreatureId),
      condition: it.condition,
      state: it.state,
    })),
  };
}

/**
 * Project the world model. Snapshots can carry hundreds of objects, so the
 * query supports size-limiting params:
 *  - `type`            — filter to one 4-char type tag (e.g. `CREO`).
 *  - `near`            — keep only objects within N metres of the player.
 *  - `limit`           — cap the object count (default 200).
 *  - `includeBaselines`— include each object's decoded baseline data.
 */
export function projectWorld(world: WorldModel, params?: Record<string, unknown>): unknown {
  const snapOpts: ToSnapshotOptions = {
    includeBaselineData: boolParam(params, 'includeBaselines'),
  };
  const snap = world.toSnapshot(snapOpts);
  let objects = snap.objects;

  const type = strParam(params, 'type');
  if (type !== undefined && type !== '') {
    const want = type.toUpperCase();
    objects = objects.filter((o) => o.typeIdString.toUpperCase() === want);
  }

  const near = numParam(params, 'near');
  if (near !== undefined && near > 0) {
    const pp = world.playerPosition();
    if (pp !== null) {
      const r2 = near * near;
      objects = objects.filter((o) => {
        const dx = o.position.x - pp.x;
        const dz = o.position.z - pp.z;
        return dx * dx + dz * dz <= r2;
      });
    }
  }

  const limitRaw = numParam(params, 'limit');
  const limit = limitRaw !== undefined && limitRaw > 0 ? Math.floor(limitRaw) : 200;
  const matched = objects.length;
  const truncated = matched > limit;
  if (truncated) objects = objects.slice(0, limit);

  return {
    takenAt: snap.takenAt,
    playerId: snap.playerId,
    totalObjects: snap.objectCount,
    matchedObjects: matched,
    returnedObjects: objects.length,
    truncated,
    objects,
  };
}

/**
 * Project a Knowledge lookup. `Knowledge` is an offline asset cache, not
 * live session state, so the query exposes specific lookups rather than a
 * full dump. `params.lens` selects:
 *  - `terrain`  — `{ planet, x, z }` → ground height.
 *  - `string`  — `{ file, key }` → localized STF string.
 *  - `building`— `{ pob }` → portal layout (cells + portals).
 */
export async function projectKnowledge(
  knowledge: Knowledge,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const lens = strParam(params, 'lens');
  if (lens === undefined) {
    return {
      lenses: ['terrain', 'string', 'building'],
      note: 'pass params.lens — terrain:{planet,x,z}  string:{file,key}  building:{pob}',
    };
  }
  if (lens === 'terrain') {
    const planet = strParam(params, 'planet');
    const x = numParam(params, 'x');
    const z = numParam(params, 'z');
    if (planet === undefined || x === undefined || z === undefined) {
      throw new Error('terrain lens requires params.planet, params.x, params.z');
    }
    const appearance = await knowledge.terrain.appearanceFor(planet);
    return { lens, planet, x, z, height: appearance.getHeight(x, z) };
  }
  if (lens === 'string') {
    const file = strParam(params, 'file');
    const key = strParam(params, 'key');
    if (file === undefined || key === undefined) {
      throw new Error('string lens requires params.file and params.key');
    }
    return { lens, file, key, value: await knowledge.strings.resolve(file, key) };
  }
  if (lens === 'building') {
    const pob = strParam(params, 'pob');
    if (pob === undefined) {
      throw new Error('building lens requires params.pob');
    }
    return { lens, pob, layout: await knowledge.buildings.portalLayoutFor(pob) };
  }
  throw new Error(`unknown knowledge lens "${lens}" — expected terrain | string | building`);
}
