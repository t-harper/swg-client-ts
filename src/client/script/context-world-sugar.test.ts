import { describe, expect, it } from 'vitest';

import { BaselinesMessage } from '../../messages/game/baselines/baselines-message.js';
import { BaselinePackageIds, ObjectTypeTags } from '../../messages/game/baselines/registry.js';
import { SceneCreateObjectByCrc } from '../../messages/game/scene-create-object-by-crc.js';
import { UpdateContainmentMessage } from '../../messages/game/update-containment-message.js';
// Side-effect: register all baseline + delta decoders.
import '../../messages/game/baselines/index.js';
import { createFakeContext } from './test-helpers.js';

const IDENTITY = { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } };

describe('ScriptContext world sugar', () => {
  describe('findNearest', () => {
    it('returns the closest matching object by 2D distance', () => {
      const playerId = 0x1n;
      const { ctx, simulateRecv } = createFakeContext({
        playerNetworkId: playerId,
        startPosition: { x: 0, y: 0, z: 0 },
      });

      // Seed three CREOs; tag each as CREO via a baseline so byType matches.
      const tagAsCreo = (id: bigint, x: number, z: number): void => {
        simulateRecv(
          new SceneCreateObjectByCrc(
            id,
            { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x, y: 0, z } },
            0,
            false,
          ),
        );
        simulateRecv(
          new BaselinesMessage(id, ObjectTypeTags.CREO, BaselinePackageIds.SHARED, new Uint8Array(0), null),
        );
      };
      tagAsCreo(0x10n, 5, 0); // 5m away
      tagAsCreo(0x20n, 30, 0); // 30m away
      tagAsCreo(0x30n, 15, 0); // 15m away

      const nearest = ctx.findNearest(ObjectTypeTags.CREO);
      expect(nearest?.id).toBe(0x10n);
    });

    it('honors maxRadiusM', () => {
      const { ctx, simulateRecv } = createFakeContext({
        playerNetworkId: 0x1n,
        startPosition: { x: 0, y: 0, z: 0 },
      });
      simulateRecv(
        new SceneCreateObjectByCrc(
          0x10n,
          { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 50, y: 0, z: 0 } },
          0,
          false,
        ),
      );
      simulateRecv(
        new BaselinesMessage(0x10n, ObjectTypeTags.CREO, BaselinePackageIds.SHARED, new Uint8Array(0), null),
      );

      expect(ctx.findNearest(ObjectTypeTags.CREO, { maxRadiusM: 10 })).toBeUndefined();
      expect(ctx.findNearest(ObjectTypeTags.CREO, { maxRadiusM: 100 })?.id).toBe(0x10n);
    });

    it('excludes the player by default; including self with excludeSelf=false', () => {
      const playerId = 0xaan;
      const { ctx, simulateRecv } = createFakeContext({
        playerNetworkId: playerId,
        startPosition: { x: 0, y: 0, z: 0 },
      });
      // Self as a CREO at the player position
      simulateRecv(
        new SceneCreateObjectByCrc(playerId, IDENTITY, 0, false),
      );
      simulateRecv(
        new BaselinesMessage(playerId, ObjectTypeTags.CREO, BaselinePackageIds.SHARED, new Uint8Array(0), null),
      );

      expect(ctx.findNearest(ObjectTypeTags.CREO)).toBeUndefined();
      expect(ctx.findNearest(ObjectTypeTags.CREO, { excludeSelf: false })?.id).toBe(playerId);
    });
  });

  describe('nearestHostile', () => {
    it('returns the nearest CREO with inCombat=true that is not us', () => {
      const playerId = 0x1n;
      const { ctx, simulateRecv } = createFakeContext({
        playerNetworkId: playerId,
        startPosition: { x: 0, y: 0, z: 0 },
      });

      // A non-hostile CREO at 5m — no inCombat flag
      simulateRecv(
        new SceneCreateObjectByCrc(
          0x10n,
          { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 5, y: 0, z: 0 } },
          0,
          false,
        ),
      );
      simulateRecv(
        new BaselinesMessage(
          0x10n,
          ObjectTypeTags.CREO,
          BaselinePackageIds.SHARED_NP,
          new Uint8Array(0),
          {
            kind: 'CreatureObjectSharedNp',
            data: { inCombat: false, mood: 0, level: 1 },
          },
        ),
      );
      // A hostile CREO at 10m — inCombat=true
      simulateRecv(
        new SceneCreateObjectByCrc(
          0x20n,
          { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 10, y: 0, z: 0 } },
          0,
          false,
        ),
      );
      simulateRecv(
        new BaselinesMessage(
          0x20n,
          ObjectTypeTags.CREO,
          BaselinePackageIds.SHARED_NP,
          new Uint8Array(0),
          {
            kind: 'CreatureObjectSharedNp',
            data: { inCombat: true, mood: 0, level: 5 },
          },
        ),
      );

      // Even though 0x10 is closer, only 0x20 is in combat
      expect(ctx.nearestHostile()?.id).toBe(0x20n);
    });

    it('returns undefined when nothing is hostile', () => {
      const { ctx, simulateRecv } = createFakeContext({});
      simulateRecv(
        new SceneCreateObjectByCrc(0x10n, IDENTITY, 0, false),
      );
      simulateRecv(
        new BaselinesMessage(
          0x10n,
          ObjectTypeTags.CREO,
          BaselinePackageIds.SHARED_NP,
          new Uint8Array(0),
          { kind: 'CreatureObjectSharedNp', data: { inCombat: false } },
        ),
      );
      expect(ctx.nearestHostile()).toBeUndefined();
    });
  });

  describe('findInContainer', () => {
    it('returns every object whose containerId matches', () => {
      const { ctx, simulateRecv } = createFakeContext({});
      const inventoryId = 0xbeefn;
      const otherId = 0xdeadn;

      simulateRecv(new UpdateContainmentMessage(0xa1n, inventoryId, 1));
      simulateRecv(new UpdateContainmentMessage(0xa2n, inventoryId, 2));
      simulateRecv(new UpdateContainmentMessage(0xa3n, otherId, 3)); // different container

      const items = ctx.findInContainer(inventoryId);
      expect(items.map((o) => o.id).sort()).toEqual([0xa1n, 0xa2n]);
    });
  });

  describe('playersInRange', () => {
    it('returns nearby PLAY-type objects sorted by distance, excludes self', () => {
      const playerId = 0xfaden;
      const { ctx, simulateRecv } = createFakeContext({
        playerNetworkId: playerId,
        startPosition: { x: 0, y: 0, z: 0 },
      });

      // Self
      simulateRecv(new SceneCreateObjectByCrc(playerId, IDENTITY, 0, false));
      simulateRecv(
        new BaselinesMessage(playerId, ObjectTypeTags.PLAY, BaselinePackageIds.SHARED, new Uint8Array(0), null),
      );

      // Other players at various distances
      const spawn = (id: bigint, x: number): void => {
        simulateRecv(
          new SceneCreateObjectByCrc(
            id,
            { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x, y: 0, z: 0 } },
            0,
            false,
          ),
        );
        simulateRecv(
          new BaselinesMessage(id, ObjectTypeTags.PLAY, BaselinePackageIds.SHARED, new Uint8Array(0), null),
        );
      };
      spawn(0x100n, 8); // in range
      spawn(0x200n, 25); // out of range
      spawn(0x300n, 3); // in range, closer

      const near = ctx.playersInRange(10);
      expect(near.map((o) => o.id)).toEqual([0x300n, 0x100n]);
    });
  });
});
