import { describe, expect, it } from 'vitest';

import type { Transform } from '../archive/transform.js';
import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import { BatchBaselinesMessage } from '../messages/game/baselines/batch-baselines-message.js';
import {
  BaselinePackageIds,
  EMPTY_STRING_ID,
  ObjectTypeTags,
  type TangibleObjectSharedBaseline,
  TangibleObjectSharedKind,
} from '../messages/game/baselines/index.js';
import { SceneCreateObjectByCrc } from '../messages/game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import { UpdateContainmentMessage } from '../messages/game/update-containment-message.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import { ContainerView, buildContainerIndex, containerView } from './container-view.js';
import type { TranscriptEvent } from './dispatcher.js';

const IDENT_TRANSFORM: Transform = {
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  position: { x: 0, y: 0, z: 0 },
};

function recv(decoded: GameNetworkMessage, name: string): TranscriptEvent {
  return {
    direction: 'recv',
    messageName: name,
    typeCrc: 0,
    bytes: 0,
    at: 0,
    decoded,
  };
}

/** Build a TANO SHARED baseline with the given (objectName, nameStringId.text, count). */
function tanoSharedBaseline(
  networkId: bigint,
  opts: {
    objectName?: string;
    nameStringIdText?: string;
    count?: number;
    complexity?: number;
    maxHitPoints?: number;
  } = {},
): BaselinesMessage {
  const data: TangibleObjectSharedBaseline = {
    complexity: opts.complexity ?? 1,
    nameStringId:
      opts.nameStringIdText !== undefined
        ? { table: 'item_n', textIndex: 0, text: opts.nameStringIdText }
        : EMPTY_STRING_ID,
    objectName: opts.objectName ?? '',
    volume: 1,
    pvpFaction: 0,
    pvpType: 0,
    appearanceData: '',
    components: [],
    condition: 0,
    count: opts.count ?? 1,
    damageTaken: 0,
    maxHitPoints: opts.maxHitPoints ?? 1000,
    visible: true,
  };
  return new BaselinesMessage(
    networkId,
    ObjectTypeTags.TANO,
    BaselinePackageIds.SHARED,
    new Uint8Array(0),
    { kind: TangibleObjectSharedKind, data },
  );
}

/**
 * Build a 3-event "create + baseline + containment" tuple for a single item.
 * Returns events in the typical wire order: create, baseline, containment.
 */
function itemEvents(args: {
  networkId: bigint;
  parentId: bigint;
  templateName?: string;
  templateCrc?: number;
  arrangementId?: number;
  baselineOpts?: Parameters<typeof tanoSharedBaseline>[1];
}): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  if (args.templateName !== undefined) {
    events.push(
      recv(
        new SceneCreateObjectByName(args.networkId, IDENT_TRANSFORM, args.templateName, false),
        'SceneCreateObjectByName',
      ),
    );
  }
  if (args.templateCrc !== undefined) {
    events.push(
      recv(
        new SceneCreateObjectByCrc(args.networkId, IDENT_TRANSFORM, args.templateCrc, false),
        'SceneCreateObjectByCrc',
      ),
    );
  }
  events.push(recv(tanoSharedBaseline(args.networkId, args.baselineOpts), 'BaselinesMessage'));
  events.push(
    recv(
      new UpdateContainmentMessage(args.networkId, args.parentId, args.arrangementId ?? -1),
      'UpdateContainmentMessage',
    ),
  );
  return events;
}

describe('ContainerView', () => {
  describe('empty container', () => {
    it('reports size 0 and empty items() when no children were observed', () => {
      const view = containerView([], 1234n);
      expect(view.containerId).toBe(1234n);
      expect(view.size()).toBe(0);
      expect(view.items()).toEqual([]);
      expect(view.hasItems()).toBe(false);
      expect(view.findFirst(() => true)).toBeNull();
      expect(view.findAll(() => true)).toEqual([]);
      expect(view.findByName('anything')).toEqual([]);
      expect(view.findByTemplate('anything')).toEqual([]);
    });

    it('reports empty when the transcript has unrelated containment events', () => {
      const transcript: TranscriptEvent[] = [
        ...itemEvents({
          networkId: 100n,
          parentId: 999n, // different parent
          templateName: 'object/tangible/loot/sword.iff',
        }),
      ];
      const view = containerView(transcript, 1234n);
      expect(view.size()).toBe(0);
    });
  });

  describe('3-item container', () => {
    const INV = 0xabc0n;

    function buildTranscript(): TranscriptEvent[] {
      return [
        ...itemEvents({
          networkId: 0x100n,
          parentId: INV,
          templateName: 'object/tangible/loot/survival_kit.iff',
          arrangementId: 0,
          baselineOpts: {
            objectName: 'My Survival Kit',
            nameStringIdText: 'survival_kit',
          },
        }),
        ...itemEvents({
          networkId: 0x101n,
          parentId: INV,
          templateName: 'object/tangible/food/bread.iff',
          arrangementId: 1,
          baselineOpts: { objectName: '', nameStringIdText: 'bread' },
        }),
        ...itemEvents({
          networkId: 0x102n,
          parentId: INV,
          templateName: 'object/weapon/melee/sword/sword_basic.iff',
          arrangementId: 2,
          baselineOpts: { objectName: 'Trusty Blade' },
        }),
      ];
    }

    it('lists all 3 children with networkId/templateName/name/arrangementId populated', () => {
      const view = containerView(buildTranscript(), INV);
      expect(view.size()).toBe(3);
      const items = view.items();
      const byId = new Map(items.map((it) => [it.networkId, it]));

      const survival = byId.get(0x100n);
      expect(survival).toBeDefined();
      expect(survival?.templateName).toBe('object/tangible/loot/survival_kit.iff');
      expect(survival?.name).toBe('My Survival Kit');
      expect(survival?.arrangementId).toBe(0);
      expect(survival?.shared?.maxHitPoints).toBe(1000);
      expect(survival?.typeId).toBe(ObjectTypeTags.TANO);

      const bread = byId.get(0x101n);
      // No objectName → falls back to nameStringId.text
      expect(bread?.name).toBe('bread');

      const sword = byId.get(0x102n);
      expect(sword?.name).toBe('Trusty Blade');
      expect(sword?.arrangementId).toBe(2);
    });

    it('findByName substring is case-sensitive and matches across the inventory', () => {
      const view = containerView(buildTranscript(), INV);
      expect(view.findByName('Survival').map((it) => it.networkId)).toEqual([0x100n]);
      // case-sensitive
      expect(view.findByName('survival')).toEqual([]);
    });

    it('findByName regex matches the underlying name (objectName or fallback)', () => {
      const view = containerView(buildTranscript(), INV);
      expect(view.findByName(/blade/i).map((it) => it.networkId)).toEqual([0x102n]);
      // matches both objectName 'My Survival Kit' and fallback 'bread'
      expect(
        view
          .findByName(/.+/)
          .map((it) => it.networkId)
          .sort(),
      ).toEqual([0x100n, 0x101n, 0x102n].sort());
    });

    it('findByTemplate matches the template path', () => {
      const view = containerView(buildTranscript(), INV);
      expect(view.findByTemplate('weapon/melee').map((it) => it.networkId)).toEqual([0x102n]);
      expect(view.findByTemplate(/survival_kit\.iff$/).map((it) => it.networkId)).toEqual([0x100n]);
    });

    it('findFirst returns the first matching item or null', () => {
      const view = containerView(buildTranscript(), INV);
      const sword = view.findFirst((it) => it.templateName?.includes('sword') ?? false);
      expect(sword?.networkId).toBe(0x102n);
      expect(view.findFirst(() => false)).toBeNull();
    });

    it('items() returns a defensive copy (mutating it does not affect the view)', () => {
      const view = containerView(buildTranscript(), INV);
      const items = view.items();
      items.push({
        networkId: 999n,
        templateName: null,
        templateCrc: null,
        typeId: null,
        name: null,
        arrangementId: -1,
        shared: null,
      });
      expect(view.size()).toBe(3);
      expect(view.items().some((it) => it.networkId === 999n)).toBe(false);
    });

    it('accepts the LifecycleResult-like wrapper as input', () => {
      const view = containerView({ transcript: buildTranscript() }, INV);
      expect(view.size()).toBe(3);
    });

    it('does not leak the empty objectName as a name (falls back to nameStringId)', () => {
      const view = containerView(buildTranscript(), INV);
      const bread = view.findFirst((it) => it.networkId === 0x101n);
      // Both objectName and the picked name string differ here, so verify the
      // fallback path: objectName is empty, name is the string id text.
      expect(bread?.shared?.objectName).toBe('');
      expect(bread?.name).toBe('bread');
    });
  });

  describe('nested containers', () => {
    const INV = 0x10n;
    const BACKPACK = 0x20n;
    const HEALTH_POT = 0x30n;
    const SWORD = 0x40n;

    function buildTranscript(): TranscriptEvent[] {
      return [
        // Backpack lives in the inventory
        ...itemEvents({
          networkId: BACKPACK,
          parentId: INV,
          templateName: 'object/tangible/container/general/backpack.iff',
          arrangementId: 4,
          baselineOpts: { objectName: 'My Backpack' },
        }),
        // Sword lives in the inventory (sibling of the backpack, not inside it)
        ...itemEvents({
          networkId: SWORD,
          parentId: INV,
          templateName: 'object/weapon/melee/sword/sword_basic.iff',
          arrangementId: 5,
          baselineOpts: { objectName: 'Sword' },
        }),
        // Health potion is inside the backpack, not the inventory
        ...itemEvents({
          networkId: HEALTH_POT,
          parentId: BACKPACK,
          templateName: 'object/tangible/medpack/medpack_t1.iff',
          arrangementId: 0,
          baselineOpts: { objectName: 'Medpack' },
        }),
      ];
    }

    it('inventory contains backpack + sword (NOT the health potion)', () => {
      const inv = containerView(buildTranscript(), INV);
      expect(inv.size()).toBe(2);
      const ids = inv
        .items()
        .map((it) => it.networkId)
        .sort();
      expect(ids).toEqual([BACKPACK, SWORD].sort());
      // The potion is NOT directly inside the inventory
      expect(inv.findFirst((it) => it.networkId === HEALTH_POT)).toBeNull();
    });

    it('backpack contains the health potion', () => {
      const backpack = containerView(buildTranscript(), BACKPACK);
      expect(backpack.size()).toBe(1);
      expect(backpack.items()[0]?.networkId).toBe(HEALTH_POT);
      expect(backpack.items()[0]?.name).toBe('Medpack');
    });

    it('buildContainerIndex returns both parent groupings', () => {
      const index = buildContainerIndex(buildTranscript());
      expect(index.size).toBe(2);
      expect(index.get(INV)?.length).toBe(2);
      expect(index.get(BACKPACK)?.length).toBe(1);
    });
  });

  describe('BatchBaselinesMessage flattening', () => {
    const INV = 0x55n;

    it('sees items whose baselines arrived inside a BatchBaselinesMessage', () => {
      // The Scene-create + Containment events arrive standalone, but the
      // baseline arrives inside a Batch envelope.
      const baselineA = tanoSharedBaseline(0x600n, { objectName: 'Item A' });
      const baselineB = tanoSharedBaseline(0x601n, { objectName: 'Item B' });
      const batch = new BatchBaselinesMessage([baselineA, baselineB]);

      const transcript: TranscriptEvent[] = [
        recv(
          new SceneCreateObjectByName(0x600n, IDENT_TRANSFORM, 'object/tangible/a.iff', false),
          'SceneCreateObjectByName',
        ),
        recv(
          new SceneCreateObjectByName(0x601n, IDENT_TRANSFORM, 'object/tangible/b.iff', false),
          'SceneCreateObjectByName',
        ),
        recv(batch, 'BatchBaselinesMessage'),
        recv(new UpdateContainmentMessage(0x600n, INV, 0), 'UpdateContainmentMessage'),
        recv(new UpdateContainmentMessage(0x601n, INV, 1), 'UpdateContainmentMessage'),
      ];
      const view = containerView(transcript, INV);
      expect(view.size()).toBe(2);
      const names = view
        .items()
        .map((it) => it.name)
        .sort();
      expect(names).toEqual(['Item A', 'Item B']);
    });
  });

  describe('templateCrc fallback', () => {
    it('exposes templateCrc when only SceneCreateObjectByCrc was observed', () => {
      const INV = 1n;
      const transcript: TranscriptEvent[] = itemEvents({
        networkId: 0x77n,
        parentId: INV,
        templateCrc: 0xdeadbeef,
        arrangementId: 3,
        baselineOpts: { objectName: 'CRC-only item' },
      });
      const view = containerView(transcript, INV);
      expect(view.size()).toBe(1);
      const item = view.items()[0];
      expect(item).toBeDefined();
      expect(item?.templateName).toBeNull();
      expect(item?.templateCrc).toBe(0xdeadbeef);
      expect(item?.name).toBe('CRC-only item');
    });
  });

  describe('tolerates out-of-order events', () => {
    it('Containment arriving before Create/Baseline still produces a complete item', () => {
      const INV = 1n;
      const transcript: TranscriptEvent[] = [
        recv(new UpdateContainmentMessage(0x500n, INV, 2), 'UpdateContainmentMessage'),
        recv(
          new SceneCreateObjectByName(0x500n, IDENT_TRANSFORM, 'object/tangible/c.iff', false),
          'SceneCreateObjectByName',
        ),
        recv(tanoSharedBaseline(0x500n, { objectName: 'After-Order' }), 'BaselinesMessage'),
      ];
      const view = containerView(transcript, INV);
      expect(view.size()).toBe(1);
      const it = view.items()[0];
      expect(it?.name).toBe('After-Order');
      expect(it?.templateName).toBe('object/tangible/c.iff');
      expect(it?.arrangementId).toBe(2);
    });
  });

  describe('items without a parent are excluded', () => {
    it('drops objects whose UpdateContainmentMessage was never observed', () => {
      // A baseline + create arrived but no containment — treat as world object.
      const transcript: TranscriptEvent[] = [
        recv(
          new SceneCreateObjectByName(0x900n, IDENT_TRANSFORM, 'object/world/tree.iff', false),
          'SceneCreateObjectByName',
        ),
        recv(tanoSharedBaseline(0x900n, { objectName: 'Tree' }), 'BaselinesMessage'),
      ];
      const index = buildContainerIndex(transcript);
      expect(index.size).toBe(0);
    });

    it('drops objects whose containerId is 0n (no container / world)', () => {
      // m_containerId == NetworkId(0) means "no container" per
      // ServerObject_Synchronization.cpp:891.
      const transcript: TranscriptEvent[] = [
        recv(new UpdateContainmentMessage(0x111n, 0n, -1), 'UpdateContainmentMessage'),
      ];
      const index = buildContainerIndex(transcript);
      expect(index.size).toBe(0);
    });
  });

  describe('send events and non-decoded recvs are ignored', () => {
    it('skips send-direction events', () => {
      const INV = 1n;
      const transcript: TranscriptEvent[] = [
        {
          direction: 'send',
          messageName: 'UpdateContainmentMessage',
          typeCrc: 0,
          bytes: 0,
          at: 0,
        },
        ...itemEvents({
          networkId: 0x200n,
          parentId: INV,
          templateName: 'object/x.iff',
        }),
      ];
      const view = containerView(transcript, INV);
      expect(view.size()).toBe(1);
    });

    it('skips recv events with decoded === null', () => {
      const INV = 1n;
      const transcript: TranscriptEvent[] = [
        {
          direction: 'recv',
          messageName: 'unknown',
          typeCrc: 0,
          bytes: 0,
          at: 0,
          decoded: null,
        },
      ];
      expect(containerView(transcript, INV).size()).toBe(0);
    });
  });

  describe('ContainerView constructor (low-level)', () => {
    it('can be built directly from a known item list', () => {
      const it: import('./container-view.js').ContainerItem = {
        networkId: 1n,
        templateName: 'x',
        templateCrc: null,
        typeId: null,
        name: 'X',
        arrangementId: 0,
        shared: null,
      };
      const view = new ContainerView(99n, [it]);
      expect(view.containerId).toBe(99n);
      expect(view.size()).toBe(1);
      expect(view.items()[0]?.networkId).toBe(1n);
    });
  });
});
