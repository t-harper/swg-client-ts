import { describe, expect, it } from 'vitest';

import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import { BatchBaselinesMessage } from '../messages/game/baselines/batch-baselines-message.js';
import type {
  BuildingObjectSharedBaseline,
  CellObjectSharedBaseline,
  CellObjectSharedNpBaseline,
} from '../messages/game/baselines/index.js';
import {
  BaselinePackageIds,
  BuildingObjectSharedKind,
  CellObjectSharedKind,
  CellObjectSharedNpKind,
  ObjectTypeTags,
  PlayerObjectSharedKind,
  TangibleObjectSharedKind,
} from '../messages/game/baselines/index.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import { UpdateContainmentMessage } from '../messages/game/update-containment-message.js';
import {
  buildBuildingCellIndex,
  creatureObjectIds,
  extractBaselinesForObject,
  extractInventoryContainerId,
  extractPlayerObjectBaseline,
  findBaselinesByKind,
  networkIdsByObjectType,
  playerObjectIds,
  tangibleObjectIds,
} from './baseline-helpers.js';
import type { TranscriptEvent } from './dispatcher.js';

import '../messages/game/baselines/index.js'; // side-effect register

function recvEvent(
  decoded: BaselinesMessage | SceneCreateObjectByName | UpdateContainmentMessage,
  name: string,
): TranscriptEvent {
  return {
    direction: 'recv',
    messageName: name,
    typeCrc: 0,
    bytes: 0,
    at: 0,
    decoded,
  };
}

/** Build a synthetic BuildingObjectSharedBaseline with the given name override. */
function buildingShared(name: string): BuildingObjectSharedBaseline {
  return {
    complexity: 0,
    nameStringId: { table: '', textIndex: 0, text: '' },
    objectName: name,
    volume: 0,
    pvpFaction: 0,
    pvpType: 0,
    appearanceData: '',
    components: [],
    condition: 0,
    count: 0,
    damageTaken: 0,
    maxHitPoints: 0,
    visible: true,
  };
}

function cellShared(cellNumber: number, isPublic = true): CellObjectSharedBaseline {
  return {
    complexity: 0,
    nameStringId: { table: '', textIndex: 0, text: '' },
    objectName: '',
    volume: 0,
    isPublic,
    cellNumber,
  };
}

function cellSharedNp(label: string): CellObjectSharedNpBaseline {
  return {
    authServerProcessId: 0,
    descriptionStringId: { table: '', textIndex: 0, text: '' },
    cellLabel: label,
    labelLocationOffset: { x: 0, y: 0, z: 0 },
  };
}

describe('baseline-helpers', () => {
  describe('extractBaselinesForObject', () => {
    it('returns all baselines matching a given networkId, in order', () => {
      const baselineA1 = new BaselinesMessage(100n, ObjectTypeTags.TANO, BaselinePackageIds.SHARED);
      const baselineA2 = new BaselinesMessage(
        100n,
        ObjectTypeTags.TANO,
        BaselinePackageIds.SHARED_NP,
      );
      const baselineB = new BaselinesMessage(200n, ObjectTypeTags.PLAY, BaselinePackageIds.SHARED);
      const transcript: TranscriptEvent[] = [
        recvEvent(baselineA1, 'BaselinesMessage'),
        recvEvent(baselineB, 'BaselinesMessage'),
        recvEvent(baselineA2, 'BaselinesMessage'),
      ];
      const result = extractBaselinesForObject(transcript, 100n);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(baselineA1);
      expect(result[1]).toBe(baselineA2);
    });

    it('also accepts an object with a `transcript` field', () => {
      const baseline = new BaselinesMessage(42n, ObjectTypeTags.TANO, 1);
      const fake = { transcript: [recvEvent(baseline, 'BaselinesMessage')] };
      const result = extractBaselinesForObject(fake, 42n);
      expect(result).toHaveLength(1);
    });

    it('returns empty if no baselines match', () => {
      const baseline = new BaselinesMessage(1n, ObjectTypeTags.TANO, 1);
      const result = extractBaselinesForObject([recvEvent(baseline, 'BaselinesMessage')], 999n);
      expect(result).toHaveLength(0);
    });

    it('skips send events and non-BaselinesMessage recvs', () => {
      const transcript: TranscriptEvent[] = [
        {
          direction: 'send',
          messageName: 'BaselinesMessage',
          typeCrc: 0,
          bytes: 0,
          at: 0,
        },
        {
          direction: 'recv',
          messageName: 'OtherMessage',
          typeCrc: 0,
          bytes: 0,
          at: 0,
          decoded: null,
        },
      ];
      expect(extractBaselinesForObject(transcript, 0n)).toHaveLength(0);
    });
  });

  describe('findBaselinesByKind', () => {
    it('filters by decodedBaseline.kind', () => {
      const m1 = new BaselinesMessage(1n, ObjectTypeTags.TANO, 3, new Uint8Array(0), {
        kind: TangibleObjectSharedKind,
        data: {},
      });
      const m2 = new BaselinesMessage(2n, ObjectTypeTags.PLAY, 3, new Uint8Array(0), {
        kind: PlayerObjectSharedKind,
        data: {},
      });
      const m3 = new BaselinesMessage(3n, ObjectTypeTags.TANO, 3, new Uint8Array(0), null);
      const transcript: TranscriptEvent[] = [
        recvEvent(m1, 'BaselinesMessage'),
        recvEvent(m2, 'BaselinesMessage'),
        recvEvent(m3, 'BaselinesMessage'),
      ];
      expect(findBaselinesByKind(transcript, TangibleObjectSharedKind)).toEqual([m1]);
      expect(findBaselinesByKind(transcript, PlayerObjectSharedKind)).toEqual([m2]);
      expect(findBaselinesByKind(transcript, 'NotARealKind')).toEqual([]);
    });
  });

  describe('extractPlayerObjectBaseline', () => {
    it('returns the first PlayerObjectShared decoded baseline', () => {
      const playerData = {
        complexity: 1,
        nameStringId: { table: '', textIndex: 0, text: '' },
        objectName: 'TestPlayer',
        volume: 1,
        count: 0,
        matchMakingCharacterProfileId: { ints: [0, 0, 0, 0] },
        matchMakingPersonalProfileId: { ints: [0, 0, 0, 0] },
        skillTitle: 'novice_brawler',
        bornDate: 1500,
        playedTime: 100,
        roleIconChoice: 0,
        skillTemplate: '',
        currentGcwPoints: 0,
        currentPvpKills: 0,
        lifetimeGcwPoints: 0n,
        lifetimePvpKills: 0,
        collections: { numInUseBits: 0, bytes: new Uint8Array(0) },
        collections2: { numInUseBits: 0, bytes: new Uint8Array(0) },
        showBackpack: false,
        showHelmet: true,
      };
      const baseline = new BaselinesMessage(
        12345n,
        ObjectTypeTags.PLAY,
        BaselinePackageIds.SHARED,
        new Uint8Array(0),
        { kind: PlayerObjectSharedKind, data: playerData },
      );
      const transcript = [recvEvent(baseline, 'BaselinesMessage')];
      const result = extractPlayerObjectBaseline(transcript);
      expect(result).not.toBeNull();
      expect(result?.networkId).toBe(12345n);
      expect(result?.data.skillTitle).toBe('novice_brawler');
    });

    it('returns null if no PlayerObject baselines were decoded', () => {
      const transcript: TranscriptEvent[] = [];
      expect(extractPlayerObjectBaseline(transcript)).toBeNull();
    });
  });

  describe('extractInventoryContainerId', () => {
    it('finds the inventory by template name (shared_character_inventory.iff)', () => {
      const sceneEvent = new SceneCreateObjectByName(
        0xabc123n,
        { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } },
        'object/tangible/inventory/shared_character_inventory.iff',
        false,
      );
      const transcript = [recvEvent(sceneEvent, 'SceneCreateObjectByName')];
      const id = extractInventoryContainerId(transcript);
      expect(id).toBe(0xabc123n);
    });

    it('also matches the bare character_inventory.iff path (server-side variant)', () => {
      const sceneEvent = new SceneCreateObjectByName(
        0xdef456n,
        { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } },
        'object/tangible/inventory/character_inventory.iff',
        false,
      );
      const transcript = [recvEvent(sceneEvent, 'SceneCreateObjectByName')];
      expect(extractInventoryContainerId(transcript)).toBe(0xdef456n);
    });

    it('returns null if no inventory create was observed', () => {
      const sceneEvent = new SceneCreateObjectByName(
        1n,
        { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } },
        'object/tangible/loot/sword.iff',
        false,
      );
      const transcript = [recvEvent(sceneEvent, 'SceneCreateObjectByName')];
      expect(extractInventoryContainerId(transcript)).toBeNull();
    });

    it('returns the first match if multiple inventories appear', () => {
      const first = new SceneCreateObjectByName(
        1n,
        { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } },
        'object/tangible/inventory/shared_character_inventory.iff',
        false,
      );
      const second = new SceneCreateObjectByName(
        2n,
        { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } },
        'object/tangible/inventory/shared_character_inventory.iff',
        false,
      );
      const transcript = [
        recvEvent(first, 'SceneCreateObjectByName'),
        recvEvent(second, 'SceneCreateObjectByName'),
      ];
      expect(extractInventoryContainerId(transcript)).toBe(1n);
    });
  });

  describe('networkIdsByObjectType', () => {
    it('returns dedup-by-id NetworkIds for a given Tag', () => {
      const m1 = new BaselinesMessage(0x10n, ObjectTypeTags.TANO, 3);
      const m2 = new BaselinesMessage(0x10n, ObjectTypeTags.TANO, 6); // same id, different package
      const m3 = new BaselinesMessage(0x20n, ObjectTypeTags.TANO, 3);
      const m4 = new BaselinesMessage(0x30n, ObjectTypeTags.PLAY, 3);
      const transcript = [
        recvEvent(m1, 'BaselinesMessage'),
        recvEvent(m2, 'BaselinesMessage'),
        recvEvent(m3, 'BaselinesMessage'),
        recvEvent(m4, 'BaselinesMessage'),
      ];
      expect(networkIdsByObjectType(transcript, ObjectTypeTags.TANO)).toEqual([0x10n, 0x20n]);
      expect(networkIdsByObjectType(transcript, ObjectTypeTags.PLAY)).toEqual([0x30n]);
      expect(networkIdsByObjectType(transcript, ObjectTypeTags.CREO)).toEqual([]);
    });

    it('convenience helpers wrap by-type', () => {
      const t = new BaselinesMessage(1n, ObjectTypeTags.TANO, 3);
      const p = new BaselinesMessage(2n, ObjectTypeTags.PLAY, 3);
      const c = new BaselinesMessage(3n, ObjectTypeTags.CREO, 3);
      const transcript = [
        recvEvent(t, 'BaselinesMessage'),
        recvEvent(p, 'BaselinesMessage'),
        recvEvent(c, 'BaselinesMessage'),
      ];
      expect(tangibleObjectIds(transcript)).toEqual([1n]);
      expect(playerObjectIds(transcript)).toEqual([2n]);
      expect(creatureObjectIds(transcript)).toEqual([3n]);
    });
  });

  describe('buildBuildingCellIndex', () => {
    it('links cells to their parent building and surfaces SHARED fields', () => {
      const BUILDING = 100n;
      const CELL_A = 201n;
      const CELL_B = 202n;
      const buildingBaseline = new BaselinesMessage(
        BUILDING,
        ObjectTypeTags.BUIO,
        BaselinePackageIds.SHARED,
        new Uint8Array(0),
        { kind: BuildingObjectSharedKind, data: buildingShared('Mos Eisley Cantina') },
      );
      const cellABaseline = new BaselinesMessage(
        CELL_A,
        ObjectTypeTags.SCLT,
        BaselinePackageIds.SHARED,
        new Uint8Array(0),
        { kind: CellObjectSharedKind, data: cellShared(1, true) },
      );
      const cellBBaseline = new BaselinesMessage(
        CELL_B,
        ObjectTypeTags.SCLT,
        BaselinePackageIds.SHARED,
        new Uint8Array(0),
        { kind: CellObjectSharedKind, data: cellShared(2, false) },
      );
      const transcript: TranscriptEvent[] = [
        recvEvent(buildingBaseline, 'BaselinesMessage'),
        recvEvent(cellABaseline, 'BaselinesMessage'),
        recvEvent(cellBBaseline, 'BaselinesMessage'),
        recvEvent(new UpdateContainmentMessage(CELL_A, BUILDING, -1), 'UpdateContainmentMessage'),
        recvEvent(new UpdateContainmentMessage(CELL_B, BUILDING, -1), 'UpdateContainmentMessage'),
      ];
      const index = buildBuildingCellIndex(transcript);
      expect(index.buildings.size).toBe(1);
      const building = index.buildings.get(BUILDING);
      expect(building?.name).toBe('Mos Eisley Cantina');
      expect(building?.cells).toEqual([CELL_A, CELL_B]);
      expect(index.cells.size).toBe(2);
      const cellA = index.cells.get(CELL_A);
      expect(cellA?.buildingId).toBe(BUILDING);
      expect(cellA?.cellNumber).toBe(1);
      expect(cellA?.isPublic).toBe(true);
      const cellB = index.cells.get(CELL_B);
      expect(cellB?.buildingId).toBe(BUILDING);
      expect(cellB?.cellNumber).toBe(2);
      expect(cellB?.isPublic).toBe(false);
    });

    it('captures the cell label from SHARED_NP when present', () => {
      const BUILDING = 0xb00n;
      const CELL = 0xc00n;
      const transcript: TranscriptEvent[] = [
        recvEvent(
          new BaselinesMessage(BUILDING, ObjectTypeTags.BUIO, BaselinePackageIds.SHARED, new Uint8Array(0), {
            kind: BuildingObjectSharedKind,
            data: buildingShared('Player House'),
          }),
          'BaselinesMessage',
        ),
        recvEvent(
          new BaselinesMessage(CELL, ObjectTypeTags.SCLT, BaselinePackageIds.SHARED, new Uint8Array(0), {
            kind: CellObjectSharedKind,
            data: cellShared(3, false),
          }),
          'BaselinesMessage',
        ),
        recvEvent(
          new BaselinesMessage(
            CELL,
            ObjectTypeTags.SCLT,
            BaselinePackageIds.SHARED_NP,
            new Uint8Array(0),
            { kind: CellObjectSharedNpKind, data: cellSharedNp("Travis's Library") },
          ),
          'BaselinesMessage',
        ),
        recvEvent(new UpdateContainmentMessage(CELL, BUILDING, -1), 'UpdateContainmentMessage'),
      ];
      const index = buildBuildingCellIndex(transcript);
      const cell = index.cells.get(CELL);
      expect(cell?.cellName).toBe("Travis's Library");
      expect(cell?.cellNumber).toBe(3);
      expect(cell?.isPublic).toBe(false);
      expect(cell?.buildingId).toBe(BUILDING);
    });

    it('falls back to nameStringId.text for the building name when objectName is empty', () => {
      const BUILDING = 1n;
      const baseline = new BaselinesMessage(
        BUILDING,
        ObjectTypeTags.BUIO,
        BaselinePackageIds.SHARED,
        new Uint8Array(0),
        {
          kind: BuildingObjectSharedKind,
          data: {
            ...buildingShared(''),
            nameStringId: { table: 'building_name', textIndex: 0, text: 'cantina_mos_eisley' },
          },
        },
      );
      const transcript = [recvEvent(baseline, 'BaselinesMessage')];
      const index = buildBuildingCellIndex(transcript);
      expect(index.buildings.get(BUILDING)?.name).toBe('cantina_mos_eisley');
    });

    it('handles building without a decoded baseline if a cell linked to it', () => {
      const BUILDING = 5n;
      const CELL = 6n;
      const transcript: TranscriptEvent[] = [
        recvEvent(
          new BaselinesMessage(CELL, ObjectTypeTags.SCLT, BaselinePackageIds.SHARED, new Uint8Array(0), {
            kind: CellObjectSharedKind,
            data: cellShared(1, true),
          }),
          'BaselinesMessage',
        ),
        recvEvent(new UpdateContainmentMessage(CELL, BUILDING, -1), 'UpdateContainmentMessage'),
      ];
      const index = buildBuildingCellIndex(transcript);
      // The building is referenced by the cell's containment even though we
      // never decoded a BUIO baseline for it — it still appears in the map.
      const entry = index.buildings.get(BUILDING);
      expect(entry).toBeDefined();
      expect(entry?.name).toBeUndefined();
      expect(entry?.cells).toEqual([CELL]);
    });

    it('keeps cells without containment events with buildingId=0n', () => {
      const CELL = 9n;
      const transcript: TranscriptEvent[] = [
        recvEvent(
          new BaselinesMessage(CELL, ObjectTypeTags.SCLT, BaselinePackageIds.SHARED, new Uint8Array(0), {
            kind: CellObjectSharedKind,
            data: cellShared(7, true),
          }),
          'BaselinesMessage',
        ),
      ];
      const index = buildBuildingCellIndex(transcript);
      const cell = index.cells.get(CELL);
      expect(cell?.buildingId).toBe(0n);
      expect(cell?.cellNumber).toBe(7);
      expect(index.buildings.size).toBe(0);
    });

    it('treats reordered transcript events idempotently', () => {
      // Containment arrives before the SHARED baselines (rare but legal).
      const BUILDING = 10n;
      const CELL = 20n;
      const transcript: TranscriptEvent[] = [
        recvEvent(new UpdateContainmentMessage(CELL, BUILDING, -1), 'UpdateContainmentMessage'),
        recvEvent(
          new BaselinesMessage(CELL, ObjectTypeTags.SCLT, BaselinePackageIds.SHARED, new Uint8Array(0), {
            kind: CellObjectSharedKind,
            data: cellShared(4, true),
          }),
          'BaselinesMessage',
        ),
        recvEvent(
          new BaselinesMessage(BUILDING, ObjectTypeTags.BUIO, BaselinePackageIds.SHARED, new Uint8Array(0), {
            kind: BuildingObjectSharedKind,
            data: buildingShared('Tatooine Hut'),
          }),
          'BaselinesMessage',
        ),
      ];
      const index = buildBuildingCellIndex(transcript);
      expect(index.buildings.get(BUILDING)?.name).toBe('Tatooine Hut');
      expect(index.buildings.get(BUILDING)?.cells).toEqual([CELL]);
      expect(index.cells.get(CELL)?.cellNumber).toBe(4);
      expect(index.cells.get(CELL)?.buildingId).toBe(BUILDING);
    });

    it('a cell re-containment moves the cell entry between buildings', () => {
      const BUILDING_A = 1n;
      const BUILDING_B = 2n;
      const CELL = 11n;
      const transcript: TranscriptEvent[] = [
        recvEvent(
          new BaselinesMessage(CELL, ObjectTypeTags.SCLT, BaselinePackageIds.SHARED, new Uint8Array(0), {
            kind: CellObjectSharedKind,
            data: cellShared(1, true),
          }),
          'BaselinesMessage',
        ),
        recvEvent(new UpdateContainmentMessage(CELL, BUILDING_A, -1), 'UpdateContainmentMessage'),
        recvEvent(new UpdateContainmentMessage(CELL, BUILDING_B, -1), 'UpdateContainmentMessage'),
      ];
      const index = buildBuildingCellIndex(transcript);
      expect(index.cells.get(CELL)?.buildingId).toBe(BUILDING_B);
      expect(index.buildings.get(BUILDING_A)?.cells).toEqual([]);
      expect(index.buildings.get(BUILDING_B)?.cells).toEqual([CELL]);
    });

    it('ignores send events and irrelevant baseline kinds', () => {
      const transcript: TranscriptEvent[] = [
        {
          direction: 'send',
          messageName: 'BaselinesMessage',
          typeCrc: 0,
          bytes: 0,
          at: 0,
        },
        recvEvent(
          new BaselinesMessage(1n, ObjectTypeTags.TANO, BaselinePackageIds.SHARED),
          'BaselinesMessage',
        ),
      ];
      const index = buildBuildingCellIndex(transcript);
      expect(index.buildings.size).toBe(0);
      expect(index.cells.size).toBe(0);
    });

    it('returns empty maps for an empty transcript', () => {
      const index = buildBuildingCellIndex([]);
      expect(index.buildings.size).toBe(0);
      expect(index.cells.size).toBe(0);
    });

    it('flattens cell baselines from a BatchBaselinesMessage', () => {
      // We rebuild a transcript that mixes a BatchBaselinesMessage envelope
      // with a top-level UpdateContainmentMessage to confirm the helper
      // peers into the batch.
      const BUILDING = 50n;
      const CELL = 51n;
      const buildingBaseline = new BaselinesMessage(
        BUILDING,
        ObjectTypeTags.BUIO,
        BaselinePackageIds.SHARED,
        new Uint8Array(0),
        { kind: BuildingObjectSharedKind, data: buildingShared('Theed Palace') },
      );
      const cellBaseline = new BaselinesMessage(
        CELL,
        ObjectTypeTags.SCLT,
        BaselinePackageIds.SHARED,
        new Uint8Array(0),
        { kind: CellObjectSharedKind, data: cellShared(1, true) },
      );
      // Synthetic BatchBaselinesMessage: in production the wire flood is
      // batched for efficiency. We construct one with two child baselines.
      const batch = new BatchBaselinesMessage([buildingBaseline, cellBaseline]);
      const transcript: TranscriptEvent[] = [
        {
          direction: 'recv',
          messageName: 'BatchBaselinesMessage',
          typeCrc: 0,
          bytes: 0,
          at: 0,
          decoded: batch,
        },
        recvEvent(new UpdateContainmentMessage(CELL, BUILDING, -1), 'UpdateContainmentMessage'),
      ];
      const index = buildBuildingCellIndex(transcript);
      expect(index.buildings.get(BUILDING)?.name).toBe('Theed Palace');
      expect(index.cells.get(CELL)?.buildingId).toBe(BUILDING);
    });
  });
});
