import { describe, expect, it } from 'vitest';

import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import { BaselinePackageIds, ObjectTypeTags } from '../messages/game/baselines/registry.js';
// Side-effect: register all baseline decoders.
import '../messages/game/baselines/index.js';
import { ClientOpenContainerMessage } from '../messages/game/client-open-container.js';
import { SceneCreateObjectByCrc } from '../messages/game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import { SceneDestroyObject } from '../messages/game/scene-destroy-object.js';
import { UpdateContainmentMessage } from '../messages/game/update-containment-message.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import type { MessageDispatcher } from './dispatcher.js';
import { InventoryViewImpl } from './inventory-view.js';
import { createFakeContext } from './script/test-helpers.js';
import { WorldModel } from './world-model.js';

const IDENTITY = { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } };
const INVENTORY_TEMPLATE = 'object/tangible/inventory/shared_character_inventory.iff';

/**
 * Minimal fake dispatcher — same shape as world-model.test.ts. Lets us
 * construct a `WorldModel` directly and inject inbound messages.
 */
function makeFakeDispatcher(): {
  dispatcher: MessageDispatcher;
  recv: (msg: GameNetworkMessage) => void;
} {
  const listeners = new Map<number, Array<(m: GameNetworkMessage) => void>>();
  const fake = {
    onMessage<T extends GameNetworkMessage>(
      ctor: { typeCrc: number },
      handler: (m: T) => void,
    ): () => void {
      let arr = listeners.get(ctor.typeCrc);
      if (arr === undefined) {
        arr = [];
        listeners.set(ctor.typeCrc, arr);
      }
      arr.push(handler as (m: GameNetworkMessage) => void);
      return () => {
        const list = listeners.get(ctor.typeCrc);
        if (list === undefined) return;
        const idx = list.indexOf(handler as (m: GameNetworkMessage) => void);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    send(): void {},
    waitFor(): Promise<GameNetworkMessage> {
      return new Promise(() => undefined);
    },
    onAny(): () => void {
      return () => undefined;
    },
    handleAppMessage(): void {},
    cancelAllWaiters(): void {},
    transcript: [],
    stageLabel: 'test',
  };
  const recv = (msg: GameNetworkMessage): void => {
    const ctor = msg.constructor as unknown as { typeCrc: number };
    const list = listeners.get(ctor.typeCrc);
    if (list === undefined) return;
    for (const h of list.slice()) h(msg);
  };
  return { dispatcher: fake as unknown as MessageDispatcher, recv };
}

describe('InventoryView', () => {
  describe('basic discovery + reactivity', () => {
    it('containerId starts null and becomes set after a synthetic SceneCreateObjectByName fires', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const inv = new InventoryViewImpl(world, 0x1n);
      inv.attach();

      // Before any inbound, the inventory container is unknown.
      expect(inv.containerId).toBeNull();
      expect(inv.ready).toBe(false);
      expect(inv.items).toEqual([]);

      // Server pushes the inventory SceneCreate by name.
      const invId = 0xc0ffeen;
      recv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));

      expect(inv.containerId).toBe(invId);
      expect(inv.ready).toBe(true);
    });

    it('items reflects WorldModel objects with matching containerId', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const inv = new InventoryViewImpl(world, 0x1n);
      inv.attach();

      const invId = 0xc0ffeen;
      recv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));

      // Two children in the inventory + one in a different container.
      recv(new UpdateContainmentMessage(0xa1n, invId, 1));
      recv(new UpdateContainmentMessage(0xa2n, invId, 2));
      recv(new UpdateContainmentMessage(0xa3n, 0xdeadn, 3));

      const ids = inv.items.map((it) => it.networkId).sort();
      expect(ids).toEqual([0xa1n, 0xa2n]);

      // Items hold the correct containerId + arrangementId.
      const itemA1 = inv.findById(0xa1n);
      expect(itemA1).toBeDefined();
      expect(itemA1?.containerId).toBe(invId);
      expect(itemA1?.arrangementId).toBe(1);
      expect(itemA1?.templateName).toBeNull();
      expect(itemA1?.name).toBeNull();
    });

    it('captures templateName + name from inbound scene-create + SHARED baseline', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const inv = new InventoryViewImpl(world, 0x1n);
      inv.attach();

      const invId = 0xc0ffeen;
      recv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));

      // A child item, name-created so we have its templateName.
      const itemId = 0xa1n;
      recv(
        new SceneCreateObjectByName(
          itemId,
          IDENTITY,
          'object/tangible/food/shared_dish_travel_biscuits.iff',
          false,
        ),
      );
      recv(new UpdateContainmentMessage(itemId, invId, 1));
      // SHARED baseline — gives us the display name.
      recv(
        new BaselinesMessage(
          itemId,
          ObjectTypeTags.TANO,
          BaselinePackageIds.SHARED,
          new Uint8Array(0),
          {
            kind: 'TangibleObjectShared',
            data: {
              complexity: 0,
              nameStringId: { table: '', text: 'travel_biscuits' },
              objectName: '',
              volume: 1,
            } as unknown as Record<string, unknown>,
          },
        ),
      );

      const item = inv.findById(itemId);
      expect(item).toBeDefined();
      expect(item?.templateName).toBe('object/tangible/food/shared_dish_travel_biscuits.iff');
      expect(item?.name).toBe('travel_biscuits');
    });
  });

  describe('queries', () => {
    it('findByTemplate returns items whose templateName matches the regex', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const inv = new InventoryViewImpl(world, 0x1n);
      inv.attach();

      const invId = 0xc0ffeen;
      recv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));

      // Three items: two foods, one weapon.
      const foods: [bigint, string][] = [
        [0xa1n, 'object/tangible/food/shared_dish_travel_biscuits.iff'],
        [0xa2n, 'object/tangible/food/shared_drink_blue_milk.iff'],
      ];
      const weapon: [bigint, string] = [0xa3n, 'object/weapon/melee/sword/shared_sword_curved.iff'];
      for (const [id, tpl] of [...foods, weapon]) {
        recv(new SceneCreateObjectByName(id, IDENTITY, tpl, false));
        recv(new UpdateContainmentMessage(id, invId, 1));
      }

      const matched = inv.findByTemplate(/\/food\//i);
      const matchedIds = matched.map((it) => it.networkId).sort();
      expect(matchedIds).toEqual([0xa1n, 0xa2n]);

      // Tighter pattern returns just one.
      const onlyMilk = inv.findByTemplate(/blue_milk/);
      expect(onlyMilk.map((it) => it.networkId)).toEqual([0xa2n]);
    });

    it('findById returns undefined for items not in the inventory', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const inv = new InventoryViewImpl(world, 0x1n);
      inv.attach();

      const invId = 0xc0ffeen;
      recv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));

      const inInv = 0xa1n;
      const elsewhere = 0xa2n;
      recv(new UpdateContainmentMessage(inInv, invId, 1));
      recv(new UpdateContainmentMessage(elsewhere, 0xdeadn, 2));

      expect(inv.findById(inInv)).toBeDefined();
      expect(inv.findById(elsewhere)).toBeUndefined();
      expect(inv.findById(0x99999n)).toBeUndefined();
    });

    it('items is recomputed (snapshot) on each access — reflects subsequent containment changes', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const inv = new InventoryViewImpl(world, 0x1n);
      inv.attach();

      const invId = 0xc0ffeen;
      recv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));
      recv(new UpdateContainmentMessage(0xa1n, invId, 1));

      // First snapshot.
      expect(inv.items.map((it) => it.networkId)).toEqual([0xa1n]);

      // Add another item.
      recv(new UpdateContainmentMessage(0xa2n, invId, 2));
      expect(inv.items.map((it) => it.networkId).sort()).toEqual([0xa1n, 0xa2n]);

      // Move 0xa1 out of the inventory.
      recv(new UpdateContainmentMessage(0xa1n, 0xdeadn, 99));
      expect(inv.items.map((it) => it.networkId)).toEqual([0xa2n]);

      // Destroy 0xa2 entirely.
      recv(new SceneDestroyObject(0xa2n, false));
      expect(inv.items).toEqual([]);
    });
  });

  describe('lifecycle', () => {
    it('handles SceneCreateObjectByCrc-only inventories (template-by-name never arrives)', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const inv = new InventoryViewImpl(world, 0x1n);
      inv.attach();

      // SceneCreate by CRC — no template path. The view can't auto-discover.
      recv(new SceneCreateObjectByCrc(0xc0ffeen, IDENTITY, 0x12345678, false));
      expect(inv.containerId).toBeNull();
      expect(inv.ready).toBe(false);
    });

    it('setContainerId lets callers pin the inventory manually (admin API)', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const inv = new InventoryViewImpl(world, 0x1n);
      inv.attach();

      const invId = 0xbeefn;
      recv(new UpdateContainmentMessage(0xa1n, invId, 1));
      inv.setContainerId(invId);

      expect(inv.containerId).toBe(invId);
      expect(inv.ready).toBe(true);
      expect(inv.items.map((it) => it.networkId)).toEqual([0xa1n]);
    });

    it('detach() unsubscribes from the WorldModel', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const inv = new InventoryViewImpl(world, 0x1n);
      inv.attach();
      const invId = 0xc0ffeen;
      recv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));
      expect(inv.containerId).toBe(invId);

      // Detach — further inbound messages don't bump `ready` for new ids
      // (no test for this directly; just sanity-checking detach() doesn't
      // throw and is idempotent).
      inv.detach();
      inv.detach();

      // Items still read from WorldModel because we held the containerId.
      recv(new UpdateContainmentMessage(0xa1n, invId, 1));
      // The view's containerId is still set; even though we detached, the
      // items() getter just filters the WorldModel — which still observes
      // events from the dispatcher. So `items` reflects the latest state.
      expect(inv.items.map((it) => it.networkId)).toEqual([0xa1n]);
    });

    it('SHARED-baseline nameStringId discovery: picks the player-child whose TANO SHARED baseline says nameStringId={item_n,inventory}', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const playerId = 0xfeedn;
      const inv = new InventoryViewImpl(world, playerId);
      inv.attach();

      // Three player-direct children: datapad, mission_bag, inventory.
      // Inventory has the FEWEST items (so the heuristic alone would
      // pick the wrong one — proving the SHARED-baseline scan beats it).
      const datapadId = 0xa1n;
      const missionBagId = 0xa2n;
      const inventoryId = 0xa3n;
      for (const id of [datapadId, missionBagId, inventoryId]) {
        recv(new SceneCreateObjectByCrc(id, IDENTITY, 0xdeadbeef, false));
        recv(new UpdateContainmentMessage(id, playerId, 4));
      }
      // Datapad: 5 items, mission_bag: 10 items (these would win the heuristic),
      // inventory: 2 items.
      for (let i = 0; i < 5; i++) {
        recv(new UpdateContainmentMessage(BigInt(0xb00 + i) as bigint, datapadId, 1));
      }
      for (let i = 0; i < 10; i++) {
        recv(new UpdateContainmentMessage(BigInt(0xc00 + i) as bigint, missionBagId, 1));
      }
      for (let i = 0; i < 2; i++) {
        recv(new UpdateContainmentMessage(BigInt(0xd00 + i) as bigint, inventoryId, 1));
      }

      // Now feed each SHARED baseline — the inventory's wins.
      recv(
        new BaselinesMessage(
          datapadId,
          ObjectTypeTags.TANO,
          BaselinePackageIds.SHARED,
          new Uint8Array(0),
          {
            kind: 'TangibleObjectShared',
            data: {
              objectName: '',
              nameStringId: { table: 'item_n', text: 'datapad' },
            } as unknown as Record<string, unknown>,
          },
        ),
      );
      recv(
        new BaselinesMessage(
          missionBagId,
          ObjectTypeTags.TANO,
          BaselinePackageIds.SHARED,
          new Uint8Array(0),
          {
            kind: 'TangibleObjectShared',
            data: {
              objectName: '',
              nameStringId: { table: 'item_n', text: 'mission_bag' },
            } as unknown as Record<string, unknown>,
          },
        ),
      );
      recv(
        new BaselinesMessage(
          inventoryId,
          ObjectTypeTags.TANO,
          BaselinePackageIds.SHARED,
          new Uint8Array(0),
          {
            kind: 'TangibleObjectShared',
            data: {
              objectName: '',
              nameStringId: { table: 'item_n', text: 'inventory' },
            } as unknown as Record<string, unknown>,
          },
        ),
      );

      expect(inv.containerId, 'SHARED-baseline match beats the count-based heuristic').toBe(inventoryId);
      expect(inv.items.length).toBe(2);
    });

    it('heuristic fallback: when no ByName scene-create arrives, picks the player-direct-child with the most descendants', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const playerId = 0xfeedn;
      const inv = new InventoryViewImpl(world, playerId);
      inv.attach();

      // Five "slot 4" children of the player — same shape as a live wire
      // dump: inventory + datapad + bank + mission_bag + appearance inv.
      const inventoryGuess = 0xa1n;
      const datapad = 0xa2n;
      const bank = 0xa3n;
      const missionBag = 0xa4n;
      const appearance = 0xa5n;
      for (const child of [inventoryGuess, datapad, bank, missionBag, appearance]) {
        recv(new SceneCreateObjectByCrc(child, IDENTITY, 0xabcdef00, false));
        recv(new UpdateContainmentMessage(child, playerId, 4));
      }
      // The inventory has lots of items (5+); the others have 0-1.
      for (let i = 1; i <= 6; i++) {
        recv(new UpdateContainmentMessage(BigInt(0x100 + i) as bigint, inventoryGuess, 1));
      }
      recv(new UpdateContainmentMessage(0x200n, datapad, 1));
      recv(new UpdateContainmentMessage(0x300n, bank, 1));

      expect(inv.containerId, 'heuristic picked the inventory candidate').toBe(inventoryGuess);
      expect(inv.ready).toBe(true);
      expect(inv.items.length).toBe(6);
    });

    it('heuristic stays put once ready, even if a sibling later accumulates more children', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const playerId = 0xfeedn;
      const inv = new InventoryViewImpl(world, playerId);
      inv.attach();

      const a = 0xa1n;
      const b = 0xa2n;
      recv(new SceneCreateObjectByCrc(a, IDENTITY, 0xabcdef00, false));
      recv(new SceneCreateObjectByCrc(b, IDENTITY, 0xabcdef01, false));
      recv(new UpdateContainmentMessage(a, playerId, 4));
      recv(new UpdateContainmentMessage(b, playerId, 4));

      // A starts as the heaviest container.
      for (let i = 1; i <= 5; i++) {
        recv(new UpdateContainmentMessage(BigInt(0x100 + i) as bigint, a, 1));
      }
      expect(inv.containerId).toBe(a);
      expect(inv.ready).toBe(true);

      // Now B overtakes — heuristic stays pinned to A.
      for (let i = 1; i <= 20; i++) {
        recv(new UpdateContainmentMessage(BigInt(0x500 + i) as bigint, b, 1));
      }
      expect(inv.containerId, 'sticky pin once ready').toBe(a);
    });

    it('template-name match wins over the heuristic if it lands during the flood', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const playerId = 0xfeedn;
      const inv = new InventoryViewImpl(world, playerId);
      inv.attach();

      // Seed the heuristic: a candidate with 5 children.
      const heuristicPick = 0xa1n;
      recv(new SceneCreateObjectByCrc(heuristicPick, IDENTITY, 0, false));
      recv(new UpdateContainmentMessage(heuristicPick, playerId, 4));
      for (let i = 1; i <= 5; i++) {
        recv(new UpdateContainmentMessage(BigInt(0x100 + i) as bigint, heuristicPick, 1));
      }
      expect(inv.containerId).toBe(heuristicPick);

      // A late template-name scene-create overrides it.
      const realInventory = 0xb1n;
      recv(new SceneCreateObjectByName(realInventory, IDENTITY, INVENTORY_TEMPLATE, false));
      expect(inv.containerId, 'template-name override wins').toBe(realInventory);
    });

    it('pre-scan during attach() picks up an inventory that arrived before subscription', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });

      // Inventory arrives BEFORE the InventoryView is constructed.
      const invId = 0xc0ffeen;
      recv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));
      recv(new UpdateContainmentMessage(0xa1n, invId, 1));

      const inv = new InventoryViewImpl(world, 0x1n);
      inv.attach();

      // The pre-scan picked it up.
      expect(inv.containerId).toBe(invId);
      expect(inv.ready).toBe(true);
      expect(inv.items.map((it) => it.networkId)).toEqual([0xa1n]);
    });
  });

  describe('slot capacity', () => {
    it('totalSlots defaults to 80 (matches shared_character_inventory.iff containerVolumeLimit)', () => {
      const { dispatcher } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const inv = new InventoryViewImpl(world, 0x1n);
      expect(inv.totalSlots).toBe(80);
      expect(inv.usedSlots).toBe(0);
      expect(inv.freeSlots).toBe(80);
    });

    it('usedSlots counts items in the inventory; freeSlots = totalSlots - usedSlots', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const inv = new InventoryViewImpl(world, 0x1n);
      inv.attach();

      const invId = 0xc0ffeen;
      recv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));

      // Drop 3 items in.
      recv(new UpdateContainmentMessage(0xa1n, invId, 1));
      recv(new UpdateContainmentMessage(0xa2n, invId, 2));
      recv(new UpdateContainmentMessage(0xa3n, invId, 3));

      expect(inv.usedSlots).toBe(3);
      expect(inv.freeSlots).toBe(77);
      expect(inv.totalSlots).toBe(80);
    });

    it('setTotalSlots overrides the default capacity', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const inv = new InventoryViewImpl(world, 0x1n);
      inv.attach();
      inv.setTotalSlots(100);

      const invId = 0xc0ffeen;
      recv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));
      recv(new UpdateContainmentMessage(0xa1n, invId, 1));

      expect(inv.totalSlots).toBe(100);
      expect(inv.usedSlots).toBe(1);
      expect(inv.freeSlots).toBe(99);
    });

    it('freeSlots is clamped at 0 (never negative) even if usedSlots exceeds capacity', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const inv = new InventoryViewImpl(world, 0x1n);
      inv.attach();
      inv.setTotalSlots(2);

      const invId = 0xc0ffeen;
      recv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));
      // Drop 5 items in (over capacity — possible if an admin override).
      for (let i = 0; i < 5; i++) {
        recv(new UpdateContainmentMessage(BigInt(0xa0 + i) as bigint, invId, i));
      }

      expect(inv.usedSlots).toBe(5);
      expect(inv.freeSlots).toBe(0);
    });
  });

  describe('resources()', () => {
    it('returns an empty list when no resource crates are in the inventory', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const inv = new InventoryViewImpl(world, 0x1n);
      inv.attach();

      const invId = 0xc0ffeen;
      recv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));
      recv(new UpdateContainmentMessage(0xa1n, invId, 1));

      expect(inv.resources()).toEqual([]);
    });

    it('returns RCNO entries with their decoded quantity + resourceType', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const inv = new InventoryViewImpl(world, 0x1n);
      inv.attach();

      const invId = 0xc0ffeen;
      recv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));

      // Resource crate: RCNO baseline with quantity=1234, resourceType=0xc0n.
      const crateId = 0xa1n;
      recv(new UpdateContainmentMessage(crateId, invId, 1));
      recv(
        new BaselinesMessage(
          crateId,
          ObjectTypeTags.RCNO,
          BaselinePackageIds.SHARED,
          new Uint8Array(0),
          {
            kind: 'ResourceContainerObjectShared',
            data: {
              complexity: 0,
              nameStringId: { table: '', text: '' },
              objectName: '',
              volume: 1,
              pvpFaction: 0,
              pvpType: 0,
              appearanceData: '',
              components: [],
              condition: 0,
              count: 0,
              damageTaken: 0,
              maxHitPoints: 0,
              visible: true,
              quantity: 1234,
              resourceType: 0xc0n,
            },
          },
        ),
      );
      // A non-resource item also in inventory — must NOT show up in resources().
      recv(new UpdateContainmentMessage(0xa2n, invId, 2));
      recv(
        new BaselinesMessage(
          0xa2n,
          ObjectTypeTags.TANO,
          BaselinePackageIds.SHARED,
          new Uint8Array(0),
          {
            kind: 'TangibleObjectShared',
            data: {
              complexity: 0,
              nameStringId: { table: '', text: 'foo' },
              objectName: '',
              volume: 1,
              pvpFaction: 0,
              pvpType: 0,
              appearanceData: '',
              components: [],
              condition: 0,
              count: 0,
              damageTaken: 0,
              maxHitPoints: 0,
              visible: true,
            },
          },
        ),
      );

      const res = inv.resources();
      expect(res).toHaveLength(1);
      expect(res[0]).toEqual({
        containerId: crateId,
        resourceType: 0xc0n,
        quantity: 1234,
      });
    });
  });

  describe('ScriptContext integration', () => {
    it('ctx.inventory.items reflects WorldModel state after simulated baselines', () => {
      const playerId = 0x1n;
      const { ctx, simulateRecv } = createFakeContext({
        playerNetworkId: playerId,
      });
      const invId = 0xc0ffeen;
      simulateRecv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));
      simulateRecv(new UpdateContainmentMessage(0xa1n, invId, 1));
      simulateRecv(new UpdateContainmentMessage(0xa2n, invId, 2));

      expect(ctx.inventory.containerId).toBe(invId);
      expect(ctx.inventory.ready).toBe(true);
      const ids = ctx.inventory.items.map((it) => it.networkId).sort();
      expect(ids).toEqual([0xa1n, 0xa2n]);
    });

    it('ctx.inventory.findByTemplate returns matching items via the live view', () => {
      const { ctx, simulateRecv } = createFakeContext({});
      const invId = 0xc0ffeen;
      simulateRecv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));
      simulateRecv(
        new SceneCreateObjectByName(
          0xa1n,
          IDENTITY,
          'object/tangible/survey_tool/shared_survey_tool_mineral.iff',
          false,
        ),
      );
      simulateRecv(new UpdateContainmentMessage(0xa1n, invId, 1));
      simulateRecv(
        new SceneCreateObjectByName(
          0xa2n,
          IDENTITY,
          'object/tangible/food/shared_dish_travel_biscuits.iff',
          false,
        ),
      );
      simulateRecv(new UpdateContainmentMessage(0xa2n, invId, 2));

      const surveyTools = ctx.inventory.findByTemplate(/survey_tool/i);
      expect(surveyTools.map((it) => it.networkId)).toEqual([0xa1n]);

      const foods = ctx.inventory.findByTemplate(/\/food\//i);
      expect(foods.map((it) => it.networkId)).toEqual([0xa2n]);
    });
  });

  describe('game-stage auto-open wire send', () => {
    it('fires ClientOpenContainerMessage(playerNetworkId, "inventory") once per zone-in', async () => {
      // Import lazily to avoid pulling in the orchestrator at module-load time.
      // (Same import path the rest of the test file uses, but we delay the
      // call so vitest can register the spec without circular issues.)
      const { runGameStage } = await import('./game-stage.js');

      // Minimal fake dispatcher that buffers a CmdStartScene + SceneEndBaselines
      // response so runGameStage can complete its waitFor handshake.
      const sent: GameNetworkMessage[] = [];
      const listenersByCrc = new Map<number, Array<(m: GameNetworkMessage) => void>>();
      const waiters: Array<{
        typeCrc: number;
        predicate: (m: GameNetworkMessage) => boolean;
        resolve: (m: GameNetworkMessage) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }> = [];

      const fake = {
        send(msg: GameNetworkMessage): void {
          sent.push(msg);
        },
        waitFor<T extends GameNetworkMessage>(
          ctor: { messageName: string; typeCrc: number },
          waitOpts: { timeoutMs?: number; predicate?: (m: T) => boolean } = {},
        ): Promise<T> {
          const timeoutMs = waitOpts.timeoutMs ?? 5_000;
          const predicate = (waitOpts.predicate ?? (() => true)) as (
            m: GameNetworkMessage,
          ) => boolean;
          return new Promise<T>((resolve, reject) => {
            const w = {
              typeCrc: ctor.typeCrc,
              predicate,
              resolve: resolve as (m: GameNetworkMessage) => void,
              reject,
              timer: setTimeout(() => {
                const idx = waiters.indexOf(w);
                if (idx >= 0) waiters.splice(idx, 1);
                reject(new Error(`Timed out waiting for ${ctor.messageName}`));
              }, timeoutMs),
            };
            w.timer.unref?.();
            waiters.push(w);
          });
        },
        onMessage<T extends GameNetworkMessage>(
          ctor: { typeCrc: number },
          handler: (m: T) => void,
        ): () => void {
          let arr = listenersByCrc.get(ctor.typeCrc);
          if (arr === undefined) {
            arr = [];
            listenersByCrc.set(ctor.typeCrc, arr);
          }
          arr.push(handler as (m: GameNetworkMessage) => void);
          return () => {
            const list = listenersByCrc.get(ctor.typeCrc);
            if (list === undefined) return;
            const idx = list.indexOf(handler as (m: GameNetworkMessage) => void);
            if (idx >= 0) list.splice(idx, 1);
          };
        },
        onAny(): () => void {
          return () => undefined;
        },
        handleAppMessage(): void {},
        cancelAllWaiters(reason: string): void {
          const drained = waiters.splice(0);
          for (const w of drained) {
            clearTimeout(w.timer);
            w.reject(new Error(reason));
          }
        },
        transcript: [],
        stageLabel: 'test',
      };

      // Deliver an inbound message to the fake dispatcher (fires both
      // onMessage subscribers AND any matching waitFor waiter).
      const deliver = (msg: GameNetworkMessage): void => {
        const ctor = msg.constructor as unknown as { typeCrc: number };
        const list = listenersByCrc.get(ctor.typeCrc);
        if (list !== undefined) {
          for (const h of list.slice()) h(msg);
        }
        for (let i = waiters.length - 1; i >= 0; i--) {
          const w = waiters[i];
          if (w === undefined) continue;
          if (w.typeCrc !== ctor.typeCrc) continue;
          if (!w.predicate(msg)) continue;
          waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(msg);
        }
      };

      const { CmdStartScene } = await import('../messages/game/cmd-start-scene.js');
      const { SceneEndBaselines } = await import('../messages/game/scene-end-baselines.js');

      const playerNetworkId = 0x1234n;
      const stagePromise = runGameStage({
        dispatcher: fake as unknown as MessageDispatcher,
        startSceneTimeoutMs: 2_000,
        baselinesTimeoutMs: 2_000,
        holdZonedInMs: 0,
        heartbeatMs: 0,
      });

      // Drive the wait handshake. Deliver CmdStartScene first; once the
      // orchestrator has resolved that waiter and registered the next
      // (SceneEndBaselines), deliver that on a subsequent microtask tick.
      // We yield a few macrotasks between deliveries to give the orchestrator
      // a chance to register each waiter.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      deliver(
        new CmdStartScene({
          playerNetworkId,
          sceneName: 'tatooine',
          startPosition: { x: 0, y: 0, z: 0 },
          startYaw: 0,
          templateName: 'object/creature/player/human_male.iff',
          serverTimeSeconds: 0n,
          serverEpoch: 0,
          disableWorldSnapshot: false,
        }),
      );
      // Yield a couple of macrotask ticks so the orchestrator can register
      // its SceneEndBaselines waiter before we fire it.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      deliver(new SceneEndBaselines(playerNetworkId));

      await stagePromise;

      // Find the inventory-slot ClientOpenContainerMessage we sent during
      // auto-open. The game-stage also fires one for 'datapad' (handled by
      // datapad-view.test.ts) — filter by slot so this test stays focused.
      const opens = sent
        .filter((m): m is ClientOpenContainerMessage => m instanceof ClientOpenContainerMessage)
        .filter((m) => m.slot === 'inventory');
      expect(opens.length).toBe(1);
      expect(opens[0]?.containerId).toBe(playerNetworkId);
      expect(opens[0]?.slot).toBe('inventory');
    });
  });
});
