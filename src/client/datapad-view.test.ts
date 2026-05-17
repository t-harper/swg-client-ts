/**
 * DatapadView unit tests — verify auto-discovery from transcripts,
 * live updates as world objects appear, kind-classification helpers,
 * and the auto-open OpenContainer dispatch from the orchestrator.
 *
 * The dispatcher fake is the same shape used by world-model.test.ts and
 * test-helpers.ts: a small in-memory listener registry + a `recv()`
 * injector. We don't go through a real SOE socket.
 */
import { describe, expect, it } from 'vitest';

import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import { BaselinePackageIds, ObjectTypeTags } from '../messages/game/baselines/registry.js';
import '../messages/game/baselines/index.js'; // side-effect: register decoders
import { ClientOpenContainerMessage } from '../messages/game/client-open-container.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import { UpdateContainmentMessage } from '../messages/game/update-containment-message.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import type { MessageDispatcher, TranscriptEvent } from './dispatcher.js';
import {
  DatapadViewImpl,
  classifyDatapadItem,
  findDatapadContainerId,
} from './script/datapad-view.js';
import { createFakeContext } from './script/test-helpers.js';
import { WorldModel } from './world-model.js';

const IDENTITY_TRANSFORM = {
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  position: { x: 0, y: 0, z: 0 },
};

/** Minimal fake dispatcher mirroring world-model.test.ts's pattern. */
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
    transcript: [] as TranscriptEvent[],
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

describe('classifyDatapadItem', () => {
  it('maps vehicle PCD templates → vehicle-pcd', () => {
    expect(classifyDatapadItem('object/intangible/vehicle/vehicle_speeder_swoop_pcd.iff')).toBe(
      'vehicle-pcd',
    );
    expect(classifyDatapadItem('object/intangible/vehicle/vehicle_speederbike_pcd.iff')).toBe(
      'vehicle-pcd',
    );
  });

  it('maps pet PCD templates → pet-pcd', () => {
    expect(classifyDatapadItem('object/intangible/pet/pet_rancor_pcd.iff')).toBe('pet-pcd');
  });

  it('maps waypoint templates → waypoint', () => {
    expect(classifyDatapadItem('object/waypoint/world_waypoint_blue.iff')).toBe('waypoint');
  });

  it('maps mission_data templates → mission', () => {
    expect(classifyDatapadItem('object/mission/mission_data.iff')).toBe('mission');
  });

  it('maps ship templates → ship', () => {
    expect(classifyDatapadItem('object/intangible/ship/ship_starter_z95.iff')).toBe('ship');
  });

  it('maps manuf_schematic templates → manufacturing-schematic', () => {
    expect(classifyDatapadItem('object/manufacture_schematic/manuf_schematic.iff')).toBe(
      'manufacturing-schematic',
    );
  });

  it('falls back to other for everything else', () => {
    expect(classifyDatapadItem('object/tangible/component/weapon/some_component.iff')).toBe(
      'other',
    );
    expect(classifyDatapadItem(null)).toBe('other');
    expect(classifyDatapadItem('')).toBe('other');
  });

  it('classifies known template CRCs when no templateName is available', () => {
    // CRCs computed from `Crc::calculate` over the SHARED IFF path; verified
    // against the wire-format snapshot from `live-datapad-auto`.
    expect(classifyDatapadItem(null, 0xaa2d5b0e)).toBe('vehicle-pcd'); // shared_vehicle_speeder_swoop_pcd
    expect(classifyDatapadItem(null, 0xe0452bf5)).toBe('vehicle-pcd'); // shared_landspeeder_av21_pcd
    expect(classifyDatapadItem(null, 0x2ac68039)).toBe('pet-pcd'); // shared_pet_control_device
    expect(classifyDatapadItem(null, 0xb514401e)).toBe('waypoint'); // shared_world_waypoint_blue
    expect(classifyDatapadItem(null, 0xd67b04a8)).toBe('mission'); // shared_mission_data
  });

  it('prefers templateName when both signals are available', () => {
    // A name that says "vehicle-pcd" should win over a CRC that says "other".
    expect(
      classifyDatapadItem('object/intangible/vehicle/vehicle_swoop_pcd.iff', 0xdeadbeef),
    ).toBe('vehicle-pcd');
    // Conversely, an unknown name doesn't get downgraded — it just falls
    // through to the CRC lookup.
    expect(classifyDatapadItem('object/somewhere/else.iff', 0xaa2d5b0e)).toBe('vehicle-pcd');
  });

  it('returns other when neither name nor CRC matches', () => {
    expect(classifyDatapadItem(null, 0xdeadbeef)).toBe('other');
    expect(classifyDatapadItem('object/some/other.iff', 0xdeadbeef)).toBe('other');
  });
});

describe('DatapadViewImpl', () => {
  it('starts with containerId = null and ready = false', () => {
    const { dispatcher } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });
    const view = new DatapadViewImpl(world);
    expect(view.containerId).toBeNull();
    expect(view.ready).toBe(false);
    expect(view.items).toEqual([]);
  });

  it('exposes items once containerId is set and children appear in the WorldModel', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });
    const view = new DatapadViewImpl(world);

    const datapadId = 0xd47a9adn;
    view.setContainerId(datapadId);
    expect(view.containerId).toBe(datapadId);
    expect(view.ready).toBe(true);

    // Drop a vehicle PCD into the world & parent it to the datapad.
    const vehicleId = 0xbeefn;
    recv(
      new SceneCreateObjectByName(
        vehicleId,
        IDENTITY_TRANSFORM,
        'object/intangible/vehicle/vehicle_speeder_swoop_pcd.iff',
        false,
      ),
    );
    recv(new UpdateContainmentMessage(vehicleId, datapadId, -1));

    expect(view.items).toHaveLength(1);
    const item = view.items[0]!;
    expect(item.networkId).toBe(vehicleId);
    expect(item.templateName).toBe(
      'object/intangible/vehicle/vehicle_speeder_swoop_pcd.iff',
    );
    expect(item.kind).toBe('vehicle-pcd');
    expect(item.containerId).toBe(datapadId);
  });

  it('vehicles() returns only entries whose template matches the vehicle PCD pattern', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });
    const view = new DatapadViewImpl(world);

    const datapadId = 0xd47a9adn;
    view.setContainerId(datapadId);

    // Two vehicles, one waypoint, one mission.
    recv(
      new SceneCreateObjectByName(
        1n,
        IDENTITY_TRANSFORM,
        'object/intangible/vehicle/vehicle_speeder_swoop_pcd.iff',
        false,
      ),
    );
    recv(new UpdateContainmentMessage(1n, datapadId, -1));
    recv(
      new SceneCreateObjectByName(
        2n,
        IDENTITY_TRANSFORM,
        'object/intangible/vehicle/vehicle_landspeeder_av21_pcd.iff',
        false,
      ),
    );
    recv(new UpdateContainmentMessage(2n, datapadId, -1));
    recv(
      new SceneCreateObjectByName(
        3n,
        IDENTITY_TRANSFORM,
        'object/waypoint/world_waypoint_blue.iff',
        false,
      ),
    );
    recv(new UpdateContainmentMessage(3n, datapadId, -1));
    recv(
      new SceneCreateObjectByName(
        4n,
        IDENTITY_TRANSFORM,
        'object/mission/mission_data.iff',
        false,
      ),
    );
    recv(new UpdateContainmentMessage(4n, datapadId, -1));

    const vehicles = view.vehicles();
    expect(vehicles).toHaveLength(2);
    expect(new Set(vehicles.map((v) => v.networkId))).toEqual(new Set([1n, 2n]));
    expect(view.waypoints()).toHaveLength(1);
    expect(view.missions()).toHaveLength(1);
    expect(view.pets()).toHaveLength(0);
  });

  it('findByTemplate uses regex matching against templateName', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });
    const view = new DatapadViewImpl(world);
    const datapadId = 0xd47a9adn;
    view.setContainerId(datapadId);

    recv(
      new SceneCreateObjectByName(
        1n,
        IDENTITY_TRANSFORM,
        'object/intangible/vehicle/vehicle_speeder_swoop_pcd.iff',
        false,
      ),
    );
    recv(new UpdateContainmentMessage(1n, datapadId, -1));
    recv(
      new SceneCreateObjectByName(
        2n,
        IDENTITY_TRANSFORM,
        'object/intangible/vehicle/vehicle_landspeeder_av21_pcd.iff',
        false,
      ),
    );
    recv(new UpdateContainmentMessage(2n, datapadId, -1));

    expect(view.findByTemplate(/swoop/)).toHaveLength(1);
    expect(view.findByTemplate(/swoop/)[0]!.networkId).toBe(1n);
    expect(view.findByTemplate(/landspeeder/)).toHaveLength(1);
    expect(view.findByTemplate(/nonexistent/)).toHaveLength(0);
  });

  it('findById returns the matching item or undefined', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });
    const view = new DatapadViewImpl(world);
    const datapadId = 0xd47a9adn;
    view.setContainerId(datapadId);

    recv(
      new SceneCreateObjectByName(
        0xbeefn,
        IDENTITY_TRANSFORM,
        'object/intangible/vehicle/vehicle_speeder_swoop_pcd.iff',
        false,
      ),
    );
    recv(new UpdateContainmentMessage(0xbeefn, datapadId, -1));

    expect(view.findById(0xbeefn)?.networkId).toBe(0xbeefn);
    expect(view.findById(0xc0den)).toBeUndefined();
  });

  it('prefers objectName from SHARED baseline as the display name', () => {
    const { dispatcher, recv } = makeFakeDispatcher();
    const world = new WorldModel({ dispatcher });
    const view = new DatapadViewImpl(world);
    const datapadId = 0xd47a9adn;
    view.setContainerId(datapadId);

    const vehicleId = 0xbeefn;
    recv(
      new SceneCreateObjectByName(
        vehicleId,
        IDENTITY_TRANSFORM,
        'object/intangible/vehicle/vehicle_speeder_swoop_pcd.iff',
        false,
      ),
    );
    recv(new UpdateContainmentMessage(vehicleId, datapadId, -1));

    // Inject a TANO SHARED baseline carrying objectName="My Swoop".
    recv(
      new BaselinesMessage(
        vehicleId,
        ObjectTypeTags.TANO,
        BaselinePackageIds.SHARED,
        new Uint8Array(0),
        {
          kind: 'TangibleObjectShared',
          data: {
            objectName: 'My Swoop',
            nameStringId: { table: '', text: '' },
          },
        },
      ),
    );

    expect(view.items[0]!.name).toBe('My Swoop');
  });
});

describe('findDatapadContainerId', () => {
  it('returns the datapad id from a transcript with a matching SceneCreateObjectByName', () => {
    const datapadId = 0xd47a9adn;
    const transcript: TranscriptEvent[] = [
      {
        direction: 'recv',
        messageName: 'SceneCreateObjectByName',
        typeCrc: SceneCreateObjectByName.typeCrc,
        bytes: 0,
        at: 0,
        decoded: new SceneCreateObjectByName(
          datapadId,
          IDENTITY_TRANSFORM,
          'object/tangible/datapad/shared_character_datapad.iff',
          false,
        ),
      } as TranscriptEvent,
    ];
    expect(findDatapadContainerId(transcript)).toBe(datapadId);
  });

  it('returns null when no matching event is present', () => {
    expect(findDatapadContainerId([])).toBeNull();
  });
});

describe('ScriptContext.datapad integration', () => {
  it('exposes a DatapadView on ctx; auto-discovers id from inbound SceneCreateObjectByName', () => {
    const { ctx, simulateRecv } = createFakeContext();

    expect(ctx.datapad).toBeDefined();
    expect(ctx.datapad.containerId).toBeNull();
    expect(ctx.datapad.ready).toBe(false);

    const datapadId = 0xd47a9adn;
    simulateRecv(
      new SceneCreateObjectByName(
        datapadId,
        IDENTITY_TRANSFORM,
        'object/tangible/datapad/shared_character_datapad.iff',
        false,
      ),
    );

    expect(ctx.datapad.containerId).toBe(datapadId);
    expect(ctx.datapad.ready).toBe(true);
  });

  it('items reflect WorldModel objects whose containerId matches the datapad', () => {
    const { ctx, simulateRecv } = createFakeContext();

    const datapadId = 0xd47a9adn;
    simulateRecv(
      new SceneCreateObjectByName(
        datapadId,
        IDENTITY_TRANSFORM,
        'object/tangible/datapad/shared_character_datapad.iff',
        false,
      ),
    );

    // Drop a vehicle PCD into the datapad.
    const vehicleId = 0xbeefn;
    simulateRecv(
      new SceneCreateObjectByName(
        vehicleId,
        IDENTITY_TRANSFORM,
        'object/intangible/vehicle/vehicle_speeder_swoop_pcd.iff',
        false,
      ),
    );
    simulateRecv(new UpdateContainmentMessage(vehicleId, datapadId, -1));

    expect(ctx.datapad.items).toHaveLength(1);
    expect(ctx.datapad.vehicles()).toHaveLength(1);
    expect(ctx.datapad.vehicles()[0]!.networkId).toBe(vehicleId);
  });
});

describe('game-stage auto-open dispatch', () => {
  it('runGameStage sends ClientOpenContainerMessage(playerId, "datapad") once per zone-in', async () => {
    const { runGameStage } = await import('./game-stage.js');
    const { CmdStartScene } = await import('../messages/game/cmd-start-scene.js');
    const { SceneEndBaselines } = await import('../messages/game/scene-end-baselines.js');

    const sent: GameNetworkMessage[] = [];
    const playerId = 0x1234n;

    // Mock dispatcher that records sends and lets us inject inbound messages
    // via the registered listeners. Same shape as `makeFakeDispatcher`
    // above; we extend it with `send()` capture + a `waitFor` that fires on
    // injected messages.
    const listeners = new Map<number, Array<(m: GameNetworkMessage) => void>>();
    const waiters: Array<{
      typeCrc: number;
      predicate: (m: GameNetworkMessage) => boolean;
      resolve: (m: GameNetworkMessage) => void;
      reject: (e: Error) => void;
    }> = [];

    const fake = {
      send(msg: GameNetworkMessage): void {
        sent.push(msg);
      },
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
      waitFor<T extends GameNetworkMessage>(
        ctor: { typeCrc: number; messageName: string },
        opts: { timeoutMs?: number; predicate?: (m: T) => boolean } = {},
      ): Promise<T> {
        return new Promise((resolve, reject) => {
          waiters.push({
            typeCrc: ctor.typeCrc,
            predicate: (opts.predicate ?? (() => true)) as (m: GameNetworkMessage) => boolean,
            resolve: resolve as (m: GameNetworkMessage) => void,
            reject,
          });
        });
      },
      onAny(): () => void {
        return () => undefined;
      },
      handleAppMessage(): void {},
      cancelAllWaiters(): void {},
      transcript: [] as TranscriptEvent[],
      stageLabel: 'game-test',
    } as unknown as MessageDispatcher;

    const recv = (msg: GameNetworkMessage): void => {
      const ctor = msg.constructor as unknown as { typeCrc: number };
      // Fire matching listeners.
      const list = listeners.get(ctor.typeCrc);
      if (list !== undefined) {
        for (const h of list.slice()) h(msg);
      }
      // Fulfill matching waiters.
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]!;
        if (w.typeCrc !== ctor.typeCrc) continue;
        if (w.predicate(msg)) {
          waiters.splice(i, 1);
          w.resolve(msg);
        }
      }
    };

    // Kick off the game stage with a very short hold so the test resolves
    // quickly — we don't care about the dwell, only about the auto-open
    // dispatch.
    const stagePromise = runGameStage({
      dispatcher: fake,
      holdZonedInMs: 50,
      heartbeatMs: 0,
    });

    // Wait a tick for runGameStage to register its waiters before injecting.
    await new Promise((r) => setImmediate(r));

    recv(
      new CmdStartScene({
        playerNetworkId: playerId,
        sceneName: 'tatooine',
        templateName: 'object/creature/player/human_male.iff',
        startPosition: { x: 0, y: 0, z: 0 },
        startYaw: 0,
        serverTimeSeconds: 0n,
        serverEpoch: 0,
        disableWorldSnapshot: false,
      }),
    );

    await new Promise((r) => setImmediate(r));

    recv(new SceneEndBaselines(playerId));

    const result = await stagePromise;
    expect(result.sceneStart.playerNetworkId).toBe(playerId);

    // The orchestrator must have sent exactly one ClientOpenContainerMessage
    // for slot 'datapad'.
    const datapadOpens = sent.filter(
      (m): m is ClientOpenContainerMessage =>
        m instanceof ClientOpenContainerMessage && m.slot === 'datapad',
    );
    expect(datapadOpens).toHaveLength(1);
    expect(datapadOpens[0]!.containerId).toBe(playerId);
  });
});
