import { describe, expect, it } from 'vitest';

import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import {
  BaselinePackageIds,
  ObjectTypeTags,
  PlayerObjectSharedKind,
  TangibleObjectSharedKind,
} from '../messages/game/baselines/index.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import {
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
  decoded: BaselinesMessage | SceneCreateObjectByName,
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
});
