#!/usr/bin/env node --import tsx
/**
 * One-off live capture for the Player Handbook. Logs in as tslive01, zones in,
 * walks toward the Mos Eisley starport so terminals/buildings come into baseline
 * range, then dumps every readable view (character, inventory, datapad, world)
 * to stdout as JSON. The handbook uses the dump for real-world examples.
 *
 *   LIVE=1 pnpm exec tsx scripts/capture-handbook-data.ts > /tmp/handbook-snapshot.json
 */

import { writeFileSync } from 'node:fs';
import { ObjectTypeTags, type ScenarioFn, SwgClient, type WorldObject } from '../src/index.js';

const HOST = '10.254.0.253';
const PORT = 44453;
const ACCOUNT = 'tslive01';
const CHARACTER = 'TsHandbook';
const STARPORT_X = 3528;
const STARPORT_Z = -4806;

function bigintReplacer(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return `0x${v.toString(16)}`;
  if (v instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of v.entries()) out[String(k)] = val;
    return out;
  }
  if (v instanceof Set) return [...v];
  return v;
}

function summarizeObject(o: WorldObject): Record<string, unknown> {
  return {
    id: `0x${o.id.toString(16)}`,
    typeIdString: o.typeIdString,
    templateName: o.templateName ?? null,
    templateCrc:
      o.templateCrc !== undefined ? `0x${o.templateCrc.toString(16).padStart(8, '0')}` : null,
    position: {
      x: Math.round(o.position.x),
      y: Math.round(o.position.y),
      z: Math.round(o.position.z),
    },
    containerId: o.containerId !== 0n ? `0x${o.containerId.toString(16)}` : null,
    name: (() => {
      const np = o.baselines.get(6) as { name?: string } | undefined;
      return np?.name ?? null;
    })(),
  };
}

const scenario: ScenarioFn = async (ctx) => {
  process.stderr.write('scenario entered\n');
  try {
    return await runScenario(ctx);
  } catch (err) {
    process.stderr.write(
      `scenario THREW: ${err instanceof Error ? `${err.message}\n${err.stack}` : String(err)}\n`,
    );
    throw err;
  }
};

async function runScenario(ctx: Parameters<ScenarioFn>[0]): Promise<void> {
  const snapshot: Record<string, unknown> = {};

  snapshot.sceneStart = {
    playerNetworkId: `0x${ctx.sceneStart.playerNetworkId.toString(16)}`,
    sceneName: ctx.sceneStart.sceneName,
    startPosition: ctx.sceneStart.startPosition,
    startYaw: ctx.sceneStart.startYaw,
    templateName: ctx.sceneStart.templateName,
    serverTime: ctx.sceneStart.serverTime,
  };
  snapshot.location = {
    planet: ctx.location.planet,
    position: ctx.location.position,
    cell: ctx.location.cell,
  };

  await ctx.wait(2_500);

  snapshot.characterReady = ctx.character.ready;
  snapshot.character = {
    name: ctx.character.name,
    level: ctx.character.level,
    posture: ctx.character.posture,
    mood: ctx.character.mood,
    faction: ctx.character.faction,
    factionDetails: ctx.character.factionDetails,
    species: ctx.character.species,
    gender: ctx.character.gender,
    health: ctx.character.health,
    action: ctx.character.action,
    mind: ctx.character.mind,
    bankBalance: ctx.character.bankBalance,
    cashBalance: ctx.character.cashBalance,
    playedTime: ctx.character.playedTime,
    skillCount: ctx.character.skills?.length ?? 0,
    skillsSample: ctx.character.skills?.slice(0, 12) ?? [],
    skillMods: ctx.character.skillMods ? [...ctx.character.skillMods.entries()].slice(0, 15) : null,
    xpByType: ctx.character.xp ? [...ctx.character.xp.entries()] : null,
    effectsCount: ctx.character.effects?.length ?? 0,
    effectsSample: ctx.character.effects?.slice(0, 5) ?? [],
    currentWeapon:
      ctx.character.currentWeapon !== null && ctx.character.currentWeapon !== undefined
        ? `0x${ctx.character.currentWeapon.toString(16)}`
        : null,
    weapon: ctx.character.weapon ?? null,
    groupId:
      ctx.character.groupId !== null &&
      ctx.character.groupId !== undefined &&
      ctx.character.groupId !== 0n
        ? `0x${ctx.character.groupId.toString(16)}`
        : null,
    roadmap: ctx.character.roadmap ?? null,
  };

  snapshot.inventoryReady = ctx.inventory.ready;
  snapshot.inventory = {
    containerId:
      ctx.inventory.containerId !== null ? `0x${ctx.inventory.containerId.toString(16)}` : null,
    totalSlots: ctx.inventory.totalSlots,
    usedSlots: ctx.inventory.usedSlots,
    freeSlots: ctx.inventory.freeSlots,
    items: ctx.inventory.items.map((i: Record<string, unknown>) => ({
      id: i.id !== undefined ? `0x${(i.id as bigint).toString(16)}` : null,
      templateName: (i.templateName as string | undefined) ?? null,
      name: (i.name as string | undefined) ?? null,
      arrangementId: (i.arrangementId as number | undefined) ?? null,
      containerId:
        i.containerId !== undefined && i.containerId !== null
          ? `0x${(i.containerId as bigint).toString(16)}`
          : null,
      raw: Object.keys(i),
    })),
    resourceContainers: ctx.inventory.resources().map((r) => ({
      containerId: `0x${r.containerId.toString(16)}`,
      resourceType:
        r.resourceType !== null && r.resourceType !== undefined
          ? `0x${r.resourceType.toString(16)}`
          : null,
      quantity: r.quantity,
    })),
  };

  snapshot.datapadReady = ctx.datapad?.ready ?? null;
  snapshot.datapad = {
    containerId:
      ctx.datapad?.containerId !== null && ctx.datapad?.containerId !== undefined
        ? `0x${ctx.datapad.containerId.toString(16)}`
        : null,
    itemCount: ctx.datapad?.items?.length ?? 0,
    vehicles:
      ctx.datapad?.vehicles().map((v) => ({
        id: `0x${v.networkId.toString(16)}`,
        templateName: v.templateName ?? null,
        name: v.name ?? null,
        linkedCreatureId:
          v.linkedCreatureId !== null && v.linkedCreatureId !== undefined
            ? `0x${v.linkedCreatureId.toString(16)}`
            : null,
        state: v.state ?? null,
        condition: v.condition ?? null,
      })) ?? [],
    pets:
      ctx.datapad?.pets().map((p) => ({
        id: `0x${p.networkId.toString(16)}`,
        templateName: p.templateName ?? null,
        name: p.name ?? null,
      })) ?? [],
    waypoints:
      ctx.datapad?.waypoints().map((w) => ({
        id: `0x${w.networkId.toString(16)}`,
        name: w.name ?? null,
        templateName: w.templateName ?? null,
      })) ?? [],
    missions:
      ctx.datapad?.missions().map((m) => ({
        id: `0x${m.networkId.toString(16)}`,
        name: m.name ?? null,
        templateName: m.templateName ?? null,
      })) ?? [],
  };

  snapshot.worldBeforeWalk = {
    total: ctx.world.filter(() => true).length,
    creo: ctx.world.byType(ObjectTypeTags.CREO).length,
    play: ctx.world.byType(ObjectTypeTags.PLAY).length,
    tano: ctx.world.byType(ObjectTypeTags.TANO).length,
    buio: ctx.world.byType(ObjectTypeTags.BUIO).length,
    sclt: ctx.world.byType(ObjectTypeTags.SCLT).length,
    inso: ctx.world.byType(ObjectTypeTags.INSO).length,
    nearestSample: ctx.world.nearby(80).slice(0, 12).map(summarizeObject),
  };

  try {
    await ctx.walkTo({ x: STARPORT_X, z: STARPORT_Z });
  } catch (err) {
    snapshot.walkError = err instanceof Error ? err.message : String(err);
  }
  await ctx.wait(3_000);

  snapshot.worldAfterWalk = {
    total: ctx.world.filter(() => true).length,
    creo: ctx.world.byType(ObjectTypeTags.CREO).length,
    play: ctx.world.byType(ObjectTypeTags.PLAY).length,
    tano: ctx.world.byType(ObjectTypeTags.TANO).length,
    buio: ctx.world.byType(ObjectTypeTags.BUIO).length,
    sclt: ctx.world.byType(ObjectTypeTags.SCLT).length,
    inso: ctx.world.byType(ObjectTypeTags.INSO).length,
  };

  const nearby = ctx.world.nearby(150);
  snapshot.terminals = nearby
    .filter((o) => o.templateName?.includes('terminal') ?? false)
    .slice(0, 20)
    .map(summarizeObject);
  snapshot.buildings = nearby
    .filter((o) => o.typeIdString === 'BUIO')
    .slice(0, 20)
    .map((o) => ({
      ...summarizeObject(o),
      childCells: ctx.world
        .filter((c) => c.containerId === o.id && c.typeIdString === 'SCLT')
        .map((c) => `0x${c.id.toString(16)}`),
    }));
  snapshot.creatures = nearby
    .filter((o) => o.typeIdString === 'CREO' && o.id !== ctx.sceneStart.playerNetworkId)
    .slice(0, 20)
    .map(summarizeObject);
  snapshot.players = ctx.world
    .byType(ObjectTypeTags.PLAY)
    .filter((o) => o.id !== ctx.sceneStart.playerNetworkId)
    .slice(0, 10)
    .map(summarizeObject);
  snapshot.resourceContainersNearby = nearby
    .filter((o) => o.typeIdString === 'RCNO')
    .slice(0, 5)
    .map(summarizeObject);

  const vendor = ctx.travel.findTicketVendor({ maxRadiusM: 250 });
  const collector = ctx.travel.findTicketCollector({ maxRadiusM: 250 });
  snapshot.travel = {
    nearestVendor: vendor !== undefined ? summarizeObject(vendor) : null,
    nearestCollector: collector !== undefined ? summarizeObject(collector) : null,
    currentTicketsCount: ctx.travel.currentTickets().length,
  };

  writeFileSync('/tmp/handbook-snapshot.json', `${JSON.stringify(snapshot, bigintReplacer, 2)}\n`);
  process.stderr.write(
    `Captured ${Object.keys(snapshot).length} top-level keys to /tmp/handbook-snapshot.json\n`,
  );

  await ctx.logout();
}

async function main(): Promise<void> {
  process.stderr.write(`Connecting to ${HOST}:${PORT} as ${ACCOUNT}/${CHARACTER}...\n`);
  const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });
  try {
    const result = await client.fullLifecycle({
      account: ACCOUNT,
      characterName: CHARACTER,
      holdZonedInMs: 0,
      script: scenario,
    });
    process.stderr.write(
      `Lifecycle ok. baseline=${result.baselineObjectCount}, zonedIn=${result.zonedInAt}\n`,
    );
  } catch (err) {
    process.stderr.write(`Lifecycle FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

await main();
