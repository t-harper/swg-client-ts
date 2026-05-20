import { describe, expect, it } from 'vitest';
import type { CombatView } from '../combat-helpers.js';
import type { InventoryView } from '../inventory-view.js';
import type { Knowledge } from '../knowledge.js';
import type { LocationView } from '../location.js';
import type { CooldownView } from '../timing.js';
import type { WorldModel, WorldSnapshot, WorldSnapshotObject } from '../world-model.js';
import {
  projectCombat,
  projectCooldowns,
  projectInventory,
  projectKnowledge,
  projectLocation,
  projectWorld,
} from './projections.js';

describe('projections — view JSON-safety', () => {
  it('projectInventory renders NetworkIds as decimal strings', () => {
    const inv = {
      containerId: 42n,
      ready: true,
      usedSlots: 1,
      totalSlots: 80,
      freeSlots: 79,
      items: [
        {
          networkId: 7n,
          templateName: 't.iff',
          name: 'thing',
          arrangementId: -1,
          containerId: 42n,
        },
      ],
      resources: () => [{ containerId: 9n, resourceType: 3n, quantity: 100 }],
      findByTemplate: () => [],
      findById: () => undefined,
    } as unknown as InventoryView;
    const out = projectInventory(inv) as Record<string, unknown>;
    expect(out.containerId).toBe('42');
    expect(JSON.stringify(out)).toContain('"networkId":"7"');
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('projectLocation includes planet, position, and a null cell', () => {
    const loc = {
      planet: 'naboo',
      position: { x: 1, y: 2, z: 3 },
      cell: null,
    } as unknown as LocationView;
    const out = projectLocation(loc) as Record<string, unknown>;
    expect(out.planet).toBe('naboo');
    expect(out.cell).toBeNull();
  });

  it('projectCombat renders target + damaged ids as strings', () => {
    const combat = {
      engaged: true,
      autoLoot: false,
      timeSinceLastHitMs: 100,
      targets: () => [{ id: 55n, distance: 3, ham: null }],
      damagedSet: () => new Set([55n]),
    } as unknown as CombatView;
    const out = projectCombat(combat) as { targets: Array<{ id: string }>; damaged: string[] };
    expect(out.targets[0]?.id).toBe('55');
    expect(out.damaged).toEqual(['55']);
  });

  it('projectCooldowns snapshots the cooldown table', () => {
    const cd = {
      all: () => new Map([['mount', { msUntilReady: 500, isReady: () => false }]]),
    } as unknown as CooldownView;
    const out = projectCooldowns(cd) as { cooldowns: Record<string, { msUntilReady: number }> };
    expect(out.cooldowns.mount?.msUntilReady).toBe(500);
  });
});

describe('projections — projectWorld filters', () => {
  function fakeObject(id: string, type: string, x: number, z: number): WorldSnapshotObject {
    return {
      id,
      typeId: 0,
      typeIdString: type,
      position: { x, y: 0, z },
      yaw: 0,
      parentCell: '0',
      cellPosition: { x: 0, y: 0, z: 0 },
      containerId: '0',
      slotArrangement: -1,
      hyperspace: false,
      baselinePackageIds: [],
      firstSeenAt: 0,
      lastUpdatedAt: 0,
    };
  }

  function fakeWorld(objects: WorldSnapshotObject[]): WorldModel {
    const snapshot: WorldSnapshot = {
      takenAt: 0,
      playerId: '1',
      objectCount: objects.length,
      objects,
    };
    return {
      toSnapshot: () => snapshot,
      playerPosition: () => ({ x: 0, y: 0, z: 0 }),
    } as unknown as WorldModel;
  }

  it('filters by 4-char type tag', () => {
    const world = fakeWorld([fakeObject('1', 'CREO', 0, 0), fakeObject('2', 'TANO', 0, 0)]);
    const out = projectWorld(world, { type: 'creo' }) as { matchedObjects: number };
    expect(out.matchedObjects).toBe(1);
  });

  it('limits the object count and flags truncation', () => {
    const world = fakeWorld(
      Array.from({ length: 10 }, (_, i) => fakeObject(String(i), 'CREO', 0, 0)),
    );
    const out = projectWorld(world, { limit: 3 }) as {
      returnedObjects: number;
      truncated: boolean;
      totalObjects: number;
    };
    expect(out.returnedObjects).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.totalObjects).toBe(10);
  });

  it('filters by distance from the player', () => {
    const world = fakeWorld([
      fakeObject('near', 'CREO', 1, 1),
      fakeObject('far', 'CREO', 500, 500),
    ]);
    const out = projectWorld(world, { near: 10 }) as { matchedObjects: number };
    expect(out.matchedObjects).toBe(1);
  });
});

describe('projections — projectKnowledge', () => {
  const knowledge = {
    terrain: { appearanceFor: async () => ({ getHeight: () => 12.5 }) },
    strings: { resolve: async () => 'localized' },
    buildings: { portalLayoutFor: async () => ({ cellCount: 3 }) },
  } as unknown as Knowledge;

  it('lists the lenses when none is requested', async () => {
    const out = (await projectKnowledge(knowledge)) as { lenses: string[] };
    expect(out.lenses).toContain('terrain');
  });

  it('terrain lens returns a ground height', async () => {
    const out = (await projectKnowledge(knowledge, {
      lens: 'terrain',
      planet: 'naboo',
      x: 0,
      z: 0,
    })) as { height: number };
    expect(out.height).toBe(12.5);
  });

  it('string lens resolves a localized value', async () => {
    const out = (await projectKnowledge(knowledge, {
      lens: 'string',
      file: 'city/city',
      key: 'declared',
    })) as { value: string };
    expect(out.value).toBe('localized');
  });

  it('rejects an unknown lens', async () => {
    await expect(projectKnowledge(knowledge, { lens: 'bogus' })).rejects.toThrow(
      /unknown knowledge lens/,
    );
  });

  it('rejects a terrain lens missing coordinates', async () => {
    await expect(projectKnowledge(knowledge, { lens: 'terrain' })).rejects.toThrow(/requires/);
  });
});
