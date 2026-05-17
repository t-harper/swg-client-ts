import { describe, expect, it } from 'vitest';

import { ByteStream } from '../archive/byte-stream.js';
import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import { BatchBaselinesMessage } from '../messages/game/baselines/batch-baselines-message.js';
import { DeltasMessage } from '../messages/game/baselines/deltas-message.js';
import { BaselinePackageIds, ObjectTypeTags } from '../messages/game/baselines/registry.js';
// Side-effect: register all baseline + delta decoders.
import '../messages/game/baselines/index.js';
import type { TangibleObjectClientServerBaseline } from '../messages/game/baselines/tangible-object-baseline-1.js';
import { SceneCreateObjectByCrc } from '../messages/game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import { SceneDestroyObject } from '../messages/game/scene-destroy-object.js';
import { UpdateContainmentMessage } from '../messages/game/update-containment-message.js';
import { UpdateTransformMessage } from '../messages/game/update-transform-message.js';
import { UpdateTransformWithParentMessage } from '../messages/game/update-transform-with-parent-message.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import type { MessageDispatcher } from './dispatcher.js';
import { type WorldEvent, WorldModel } from './world-model.js';

/**
 * Minimal fake dispatcher — just the bits WorldModel uses (onMessage + a
 * way to inject inbound messages). Mirrors test-helpers' pattern but
 * scoped down because we don't need scripts/waitFor here.
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

describe('WorldModel', () => {
  it('creates an object on SceneCreateObjectByCrc and tracks its transform', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });

    const id = 0xabcdn;
    const transform = {
      rotation: { x: 0, y: 0, z: 0, w: 1 }, // identity → yaw 0
      position: { x: 100, y: 5, z: 200 },
    };
    recv(new SceneCreateObjectByCrc(id, transform, 0x12345678, false));

    const obj = world.get(id);
    expect(obj).toBeDefined();
    expect(obj?.templateCrc).toBe(0x12345678);
    expect(obj?.position).toEqual({ x: 100, y: 5, z: 200 });
    expect(obj?.yaw).toBeCloseTo(0, 5);
    expect(world.size()).toBe(1);
  });

  it('captures templateName from SceneCreateObjectByName', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });
    const id = 0x10n;
    recv(
      new SceneCreateObjectByName(
        id,
        { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } },
        'object/creature/npc/imperial_stormtrooper.iff',
        false,
      ),
    );
    const obj = world.get(id);
    expect(obj?.templateName).toBe('object/creature/npc/imperial_stormtrooper.iff');
  });

  it('decodes UpdateTransformMessage with i16/4 fixed-point quantization', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });

    // Pre-seed the object so the transform has something to update.
    const id = 0x42n;
    recv(
      new SceneCreateObjectByCrc(
        id,
        { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } },
        0,
        false,
      ),
    );

    // x=400 → wire 1600 (400 * 4); yaw=1.5 rad → wire 24 (1.5 * 16); etc.
    recv(new UpdateTransformMessage(id, 1600, 4, -800, 7, 0, 24, 0, 0));

    const obj = world.get(id);
    expect(obj?.position).toEqual({ x: 400, y: 1, z: -200 });
    expect(obj?.yaw).toBe(1.5);
    expect(obj?.parentCell).toBe(0n);
  });

  it('decodes UpdateTransformWithParentMessage with i16/8 cell quantization', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });
    const cellId = 0xce11n;
    const id = 0x42n;

    // Cell wire uses * 8 quantization (0.125m resolution).
    recv(new UpdateTransformWithParentMessage(cellId, id, 80, 8, 16, 3, 0, 16, 0, 0));

    const obj = world.get(id);
    expect(obj?.parentCell).toBe(cellId);
    expect(obj?.cellPosition).toEqual({ x: 10, y: 1, z: 2 });
    expect(obj?.yaw).toBe(1);
  });

  it('absorbs a BaselinesMessage and records the typed decoded data', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });

    // Build a TANO p1 baseline payload (2 i32 fields):
    //   [u16 memberCount=2][i32 bankBalance][i32 cashBalance]
    const inner = new ByteStream();
    inner.writeU16(2); // memberCount
    inner.writeI32(10_000);
    inner.writeI32(250);
    const id = 0x999n;
    // Need to use the decoded form so BaselinesMessage's decodePayload runs.
    // The cleanest way: construct manually, supply decodedBaseline ourselves.
    const baseline = new BaselinesMessage(
      id,
      ObjectTypeTags.TANO,
      BaselinePackageIds.CLIENT_SERVER,
      inner.toBytes(),
      { kind: 'TangibleObjectClientServer', data: { bankBalance: 10_000, cashBalance: 250 } },
    );
    recv(baseline);

    const obj = world.get(id);
    expect(obj).toBeDefined();
    expect(obj?.typeId).toBe(ObjectTypeTags.TANO);
    expect(obj?.typeIdString).toBe('TANO');
    const state = obj?.baselines.get(BaselinePackageIds.CLIENT_SERVER) as
      | TangibleObjectClientServerBaseline
      | undefined;
    expect(state).toEqual({ bankBalance: 10_000, cashBalance: 250 });
  });

  it('merges a DeltasMessage sparse-update into the existing baseline state', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });
    const id = 0x55n;

    // Seed with a baseline
    recv(
      new BaselinesMessage(
        id,
        ObjectTypeTags.TANO,
        BaselinePackageIds.CLIENT_SERVER,
        new Uint8Array(0),
        {
          kind: 'TangibleObjectClientServer',
          data: { bankBalance: 1000, cashBalance: 500 },
        },
      ),
    );

    // Now apply a delta that only touches bankBalance
    recv(
      new DeltasMessage(
        id,
        ObjectTypeTags.TANO,
        BaselinePackageIds.CLIENT_SERVER,
        new Uint8Array(0),
        {
          kind: 'TangibleObjectClientServerDelta',
          data: { bankBalance: 2500 },
        },
      ),
    );

    const obj = world.get(id);
    const state = obj?.baselines.get(BaselinePackageIds.CLIENT_SERVER) as
      | TangibleObjectClientServerBaseline
      | undefined;
    // bankBalance updated; cashBalance preserved from the baseline
    expect(state).toEqual({ bankBalance: 2500, cashBalance: 500 });
  });

  it('absorbs every entry in a BatchBaselinesMessage', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });

    const a = new BaselinesMessage(0x1n, ObjectTypeTags.TANO, 1, new Uint8Array(0), {
      kind: 'TangibleObjectClientServer',
      data: { bankBalance: 1, cashBalance: 2 },
    });
    const b = new BaselinesMessage(0x2n, ObjectTypeTags.TANO, 1, new Uint8Array(0), {
      kind: 'TangibleObjectClientServer',
      data: { bankBalance: 3, cashBalance: 4 },
    });
    recv(new BatchBaselinesMessage([a, b]));

    expect(world.size()).toBe(2);
    expect(world.get(0x1n)?.baselines.get(1)).toEqual({ bankBalance: 1, cashBalance: 2 });
    expect(world.get(0x2n)?.baselines.get(1)).toEqual({ bankBalance: 3, cashBalance: 4 });
  });

  it('records containment changes and emits a containment event', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });
    const id = 0x7n;
    const inventoryId = 0xfn;

    const events: WorldEvent[] = [];
    world.on((e) => events.push(e));

    recv(new UpdateContainmentMessage(id, inventoryId, 5));

    const obj = world.get(id);
    expect(obj?.containerId).toBe(inventoryId);
    expect(obj?.slotArrangement).toBe(5);

    const containmentEvent = events.find((e) => e.kind === 'containment');
    expect(containmentEvent).toBeDefined();
    if (containmentEvent?.kind !== 'containment') throw new Error('typeguard');
    expect(containmentEvent.containerId).toBe(inventoryId);
    expect(containmentEvent.slotArrangement).toBe(5);
  });

  it('removes an object on SceneDestroyObject and emits a destroy event', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });
    const id = 0x99n;
    recv(
      new SceneCreateObjectByCrc(
        id,
        { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } },
        0,
        false,
      ),
    );
    expect(world.has(id)).toBe(true);

    const events: WorldEvent[] = [];
    world.on((e) => events.push(e));

    recv(new SceneDestroyObject(id, false));
    expect(world.has(id)).toBe(false);

    const destroyEvent = events.find((e) => e.kind === 'destroy');
    expect(destroyEvent).toBeDefined();
    if (destroyEvent?.kind !== 'destroy') throw new Error('typeguard');
    expect(destroyEvent.objectId).toBe(id);
    expect(destroyEvent.hyperspace).toBe(false);
    expect(destroyEvent.lastKnown.id).toBe(id);
  });

  it('ignores SceneDestroyObject for an unknown id (no spurious event)', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });
    const events: WorldEvent[] = [];
    world.on((e) => events.push(e));
    recv(new SceneDestroyObject(0xdeadn, false));
    expect(events.length).toBe(0);
  });

  it('byType filters to objects of a given Tag', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });

    recv(new BaselinesMessage(0x1n, ObjectTypeTags.TANO, 1, new Uint8Array(0), null));
    recv(new BaselinesMessage(0x2n, ObjectTypeTags.CREO, 1, new Uint8Array(0), null));
    recv(new BaselinesMessage(0x3n, ObjectTypeTags.TANO, 1, new Uint8Array(0), null));

    const tangibles = world.byType(ObjectTypeTags.TANO);
    expect(tangibles.map((o) => o.id).sort()).toEqual([0x1n, 0x3n]);
  });

  it('nearby() returns objects within the radius sorted by distance', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const playerId = 0xb01en;
    const world = new WorldModel({ dispatcher, playerId });

    // Player at (0, 0, 0)
    recv(
      new SceneCreateObjectByCrc(
        playerId,
        { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } },
        0,
        false,
      ),
    );
    // Three objects at varying distances
    recv(
      new SceneCreateObjectByCrc(
        0x10n,
        { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 5, y: 0, z: 0 } },
        0,
        false,
      ),
    );
    recv(
      new SceneCreateObjectByCrc(
        0x20n,
        { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 50, y: 0, z: 0 } },
        0,
        false,
      ),
    );
    recv(
      new SceneCreateObjectByCrc(
        0x30n,
        { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 15, y: 0, z: 0 } },
        0,
        false,
      ),
    );

    // Within 20m of the player: 0x10 (5m) and 0x30 (15m), sorted ascending.
    // Player itself (distance 0) is also in range.
    const near = world.nearby(20);
    expect(near.map((o) => o.id)).toEqual([playerId, 0x10n, 0x30n]);
  });

  it('nearby() honors an explicit center when supplied', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });
    recv(
      new SceneCreateObjectByCrc(
        0x10n,
        { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 100, y: 0, z: 100 } },
        0,
        false,
      ),
    );
    const near = world.nearby(50, { x: 110, y: 0, z: 90 });
    expect(near.map((o) => o.id)).toEqual([0x10n]);
  });

  it('detach() stops further mutation but keeps the snapshot queryable', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });
    const id = 0x77n;
    recv(
      new SceneCreateObjectByCrc(
        id,
        { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 1, y: 2, z: 3 } },
        0,
        false,
      ),
    );

    world.detach();

    // Subsequent events are no-ops
    recv(new SceneDestroyObject(id, false));
    expect(world.has(id)).toBe(true);
    expect(world.get(id)?.position).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('fires create and transform events on first scene-create', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });
    const events: WorldEvent[] = [];
    world.on((e) => events.push(e));

    recv(
      new SceneCreateObjectByCrc(
        0x1n,
        { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } },
        0,
        false,
      ),
    );
    expect(events.map((e) => e.kind)).toEqual(['create', 'transform']);
  });

  describe('toSnapshot', () => {
    it('returns an empty snapshot for a fresh world', () => {
      const { dispatcher } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });

      const snap = world.toSnapshot();
      expect(snap.objectCount).toBe(0);
      expect(snap.objects).toEqual([]);
      expect(snap.playerId).toBeNull();
      expect(typeof snap.takenAt).toBe('number');
      // Round-trips through JSON without throwing.
      expect(() => JSON.stringify(snap)).not.toThrow();
    });

    it('serializes NetworkIds (player + objects + parents + containers) as strings, never bigint', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const playerId = 0xdeadbeefn;
      const world = new WorldModel({ dispatcher, playerId });

      // Player + a containing cell + an item parented inside that cell, in a container.
      recv(
        new SceneCreateObjectByCrc(
          playerId,
          { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 10, y: 0, z: 20 } },
          0x12345678,
          false,
        ),
      );
      const cellId = 0xce11n;
      recv(new UpdateTransformWithParentMessage(cellId, 0x101n, 80, 8, 16, 3, 0, 16, 0, 0));
      // Containment: 0x101 is contained in some container 0xc0n at slot 5.
      recv(new UpdateContainmentMessage(0x101n, 0xc0n, 5));

      const snap = world.toSnapshot();
      expect(snap.objectCount).toBe(2);
      expect(snap.playerId).toBe(playerId.toString());
      expect(typeof snap.playerId).toBe('string');

      const player = snap.objects.find((o) => o.id === playerId.toString());
      expect(player).toBeDefined();
      expect(typeof player?.id).toBe('string');
      expect(player?.templateCrc).toBe(0x12345678);
      expect(player?.position).toEqual({ x: 10, y: 0, z: 20 });
      expect(player?.parentCell).toBe('0');

      const child = snap.objects.find((o) => o.id === '257'); // 0x101
      expect(child).toBeDefined();
      expect(typeof child?.parentCell).toBe('string');
      expect(child?.parentCell).toBe(cellId.toString());
      expect(typeof child?.containerId).toBe('string');
      expect(child?.containerId).toBe(0xc0n.toString());
      expect(child?.slotArrangement).toBe(5);
      expect(child?.cellPosition).toEqual({ x: 10, y: 1, z: 2 });

      // Verify no bigint leaks anywhere (JSON.stringify throws on bigint).
      const json = JSON.stringify(snap);
      expect(json).toContain(playerId.toString());
      expect(json).toContain(cellId.toString());
    });

    it('captures multiple objects with type tags and baseline package ids (no data by default)', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });

      recv(
        new BaselinesMessage(
          0x1n,
          ObjectTypeTags.TANO,
          BaselinePackageIds.CLIENT_SERVER,
          new Uint8Array(0),
          { kind: 'TangibleObjectClientServer', data: { bankBalance: 100, cashBalance: 50 } },
        ),
      );
      recv(
        new BaselinesMessage(
          0x1n,
          ObjectTypeTags.TANO,
          BaselinePackageIds.SHARED,
          new Uint8Array(0),
          null,
        ),
      );
      recv(
        new BaselinesMessage(0x2n, ObjectTypeTags.CREO, 1, new Uint8Array(0), {
          kind: 'TangibleObjectClientServer',
          data: { bankBalance: 1, cashBalance: 2 },
        }),
      );
      recv(
        new SceneCreateObjectByName(
          0x3n,
          { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } },
          'object/creature/npc/foo.iff',
          false,
        ),
      );

      const snap = world.toSnapshot();
      expect(snap.objectCount).toBe(3);

      const o1 = snap.objects.find((o) => o.id === '1');
      expect(o1?.typeIdString).toBe('TANO');
      // Two baselines arrived for 0x1: CLIENT_SERVER and SHARED — keys sorted ascending.
      expect(o1?.baselinePackageIds).toEqual(
        [BaselinePackageIds.CLIENT_SERVER, BaselinePackageIds.SHARED].sort((a, b) => a - b),
      );
      // Default mode: no baseline data field at all.
      expect(o1?.baselines).toBeUndefined();

      const o2 = snap.objects.find((o) => o.id === '2');
      expect(o2?.typeIdString).toBe('CREO');

      const o3 = snap.objects.find((o) => o.id === '3');
      expect(o3?.templateName).toBe('object/creature/npc/foo.iff');
      expect(o3?.baselinePackageIds).toEqual([]); // Scene-create only, no baselines.
    });

    it('includeBaselineData=true round-trips the per-package data with bigint/Uint8Array normalized', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });

      recv(
        new BaselinesMessage(
          0xfn,
          ObjectTypeTags.TANO,
          BaselinePackageIds.CLIENT_SERVER,
          new Uint8Array(0),
          {
            kind: 'TangibleObjectClientServer',
            data: { bankBalance: 1234, cashBalance: 5678 },
          },
        ),
      );
      // A second package whose data is the raw bytes (no decoder match).
      const opaqueBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      recv(
        new BaselinesMessage(
          0xfn,
          ObjectTypeTags.TANO,
          BaselinePackageIds.SHARED,
          opaqueBytes,
          null,
        ),
      );

      const snap = world.toSnapshot({ includeBaselineData: true });
      const obj = snap.objects.find((o) => o.id === '15');
      expect(obj).toBeDefined();
      expect(obj?.baselines).toBeDefined();
      // Typed decoded data is preserved as-is for plain-object payloads.
      expect(obj?.baselines?.[BaselinePackageIds.CLIENT_SERVER]).toEqual({
        bankBalance: 1234,
        cashBalance: 5678,
      });
      // Uint8Array → hex string.
      expect(obj?.baselines?.[BaselinePackageIds.SHARED]).toBe('deadbeef');

      // The full snapshot must round-trip through JSON cleanly.
      const json = JSON.stringify(snap);
      const parsed = JSON.parse(json);
      expect(parsed.objects[0].baselines[BaselinePackageIds.CLIENT_SERVER]).toEqual({
        bankBalance: 1234,
        cashBalance: 5678,
      });
      expect(parsed.objects[0].baselines[BaselinePackageIds.SHARED]).toBe('deadbeef');
    });

    it('normalizes nested bigint / Uint8Array / Map values inside baseline data', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });

      // Synthesize a baseline whose decoded data contains nested complexity:
      // bigint, Uint8Array, Map<string, ...>, Map<number, bigint>, and a Date.
      recv(
        new BaselinesMessage(
          0x42n,
          ObjectTypeTags.TANO,
          BaselinePackageIds.CLIENT_SERVER,
          new Uint8Array(0),
          {
            kind: 'TangibleObjectClientServer',
            data: {
              ownerId: 0x123456789abcdefn,
              bytes: new Uint8Array([0x01, 0x02, 0x03]),
              stringKeyedMap: new Map<string, unknown>([
                ['a', 1n],
                ['b', new Uint8Array([0xff])],
              ]),
              numericKeyedMap: new Map<number, bigint>([
                [1, 100n],
                [2, 200n],
              ]),
              when: new Date('2026-05-17T12:00:00.000Z'),
              nested: { deepBigInt: 999n },
            },
          },
        ),
      );

      const snap = world.toSnapshot({ includeBaselineData: true });
      const data = snap.objects[0]?.baselines?.[BaselinePackageIds.CLIENT_SERVER] as Record<
        string,
        unknown
      >;
      expect(data.ownerId).toBe('81985529216486895');
      expect(data.bytes).toBe('010203');
      expect(data.stringKeyedMap).toEqual({ a: '1', b: 'ff' });
      expect(data.numericKeyedMap).toEqual([
        [1, '100'],
        [2, '200'],
      ]);
      expect(data.when).toBe('2026-05-17T12:00:00.000Z');
      expect(data.nested).toEqual({ deepBigInt: '999' });

      // JSON.stringify must not throw.
      expect(() => JSON.stringify(snap)).not.toThrow();
    });

    it('preserves first-seen ordering and reflects scene-destroy removals', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const ident = { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } };

      recv(new SceneCreateObjectByCrc(0x1n, ident, 1, false));
      recv(new SceneCreateObjectByCrc(0x2n, ident, 2, false));
      recv(new SceneCreateObjectByCrc(0x3n, ident, 3, false));
      recv(new SceneDestroyObject(0x2n, false));

      const snap = world.toSnapshot();
      expect(snap.objectCount).toBe(2);
      // Insertion order: 0x1, 0x3 (0x2 was destroyed).
      expect(snap.objects.map((o) => o.id)).toEqual(['1', '3']);
    });
  });
});
