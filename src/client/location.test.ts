/**
 * Unit tests for `createLocationView`, `resolvePlayerCell`, `findCellByName`,
 * `findFirstPublicCell`.
 *
 * We construct a synthetic WorldModel by hand-feeding BUIO + SCLT baselines
 * and UpdateContainmentMessage events through the dispatcher subscribers
 * (rather than via the WorldModel's internal `touch()` API). This mirrors how
 * the real server's wire flood populates the model.
 */
import { describe, expect, it } from 'vitest';

import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
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
} from '../messages/game/baselines/index.js';
import { UpdateContainmentMessage } from '../messages/game/update-containment-message.js';
import { createFakeContext } from './script/test-helpers.js';
import {
  createLocationView,
  findCellByName,
  findFirstPublicCell,
  resolvePlayerCell,
} from './location.js';

import '../messages/game/baselines/index.js'; // side-effect register

function buildingBaseline(id: bigint, name: string): BaselinesMessage {
  const data: BuildingObjectSharedBaseline = {
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
  return new BaselinesMessage(
    id,
    ObjectTypeTags.BUIO,
    BaselinePackageIds.SHARED,
    new Uint8Array(0),
    { kind: BuildingObjectSharedKind, data },
  );
}

function cellSharedBaseline(
  id: bigint,
  cellNumber: number,
  isPublic = true,
): BaselinesMessage {
  const data: CellObjectSharedBaseline = {
    complexity: 0,
    nameStringId: { table: '', textIndex: 0, text: '' },
    objectName: '',
    volume: 0,
    isPublic,
    cellNumber,
  };
  return new BaselinesMessage(
    id,
    ObjectTypeTags.SCLT,
    BaselinePackageIds.SHARED,
    new Uint8Array(0),
    { kind: CellObjectSharedKind, data },
  );
}

function cellSharedNpBaseline(id: bigint, cellLabel: string): BaselinesMessage {
  const data: CellObjectSharedNpBaseline = {
    authServerProcessId: 0,
    descriptionStringId: { table: '', textIndex: 0, text: '' },
    cellLabel,
    labelLocationOffset: { x: 0, y: 0, z: 0 },
  };
  return new BaselinesMessage(
    id,
    ObjectTypeTags.SCLT,
    BaselinePackageIds.SHARED_NP,
    new Uint8Array(0),
    { kind: CellObjectSharedNpKind, data },
  );
}

function playerCreoBaseline(playerId: bigint): BaselinesMessage {
  // A minimal CREO SHARED baseline is enough to set typeId === CREO on the
  // player WorldObject. The CharacterSheet decoder needs decodedBaseline.data
  // to be non-null but we don't read fields here.
  return new BaselinesMessage(
    playerId,
    ObjectTypeTags.CREO,
    BaselinePackageIds.SHARED,
    new Uint8Array(0),
    null, // undecoded — WorldModel still typeId-tags the object
  );
}

describe('location.ts', () => {
  describe('resolvePlayerCell', () => {
    it('returns null when player not tracked', () => {
      const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: 0xaaaan });
      void simulateRecv; // unused — we don't seed the player
      expect(resolvePlayerCell(ctx.world, 0xaaaan)).toBeNull();
    });

    it('returns null when player containerId === 0n (outdoors)', () => {
      const playerId = 0xaaaan;
      const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
      simulateRecv(playerCreoBaseline(playerId));
      expect(resolvePlayerCell(ctx.world, playerId)).toBeNull();
    });

    it('returns null when containerId points to a non-SCLT object', () => {
      const playerId = 0xaaaan;
      const inventoryId = 0xbbbbn;
      const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
      simulateRecv(playerCreoBaseline(playerId));
      // Inventory is a TANO — a tangible container, not a cell.
      simulateRecv(
        new BaselinesMessage(
          inventoryId,
          ObjectTypeTags.TANO,
          BaselinePackageIds.SHARED,
          new Uint8Array(0),
          null,
        ),
      );
      // Containment puts the player inside the inventory (not realistic but
      // exercises the type-check).
      simulateRecv(new UpdateContainmentMessage(playerId, inventoryId, -1));
      expect(resolvePlayerCell(ctx.world, playerId)).toBeNull();
    });

    it('populates the cell descriptor when player is in a cell', () => {
      const playerId = 0xaaaan;
      const buildingId = 0xb00n;
      const cellId = 0xc00n;
      const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: playerId });

      simulateRecv(playerCreoBaseline(playerId));
      simulateRecv(buildingBaseline(buildingId, 'Player House'));
      simulateRecv(cellSharedBaseline(cellId, 1, true));
      simulateRecv(cellSharedNpBaseline(cellId, 'Foyer'));
      simulateRecv(new UpdateContainmentMessage(cellId, buildingId, -1));
      simulateRecv(new UpdateContainmentMessage(playerId, cellId, -1));

      const result = resolvePlayerCell(ctx.world, playerId);
      expect(result).not.toBeNull();
      expect(result!.buildingId).toBe(buildingId);
      expect(result!.cellName).toBe('Foyer');
      expect(result!.cellNumber).toBe(1);
      expect(result!.isPublic).toBe(true);
    });

    it('handles a labelless cell (cellName === "")', () => {
      const playerId = 0x1n;
      const buildingId = 0x2n;
      const cellId = 0x3n;
      const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
      simulateRecv(playerCreoBaseline(playerId));
      simulateRecv(buildingBaseline(buildingId, 'B'));
      simulateRecv(cellSharedBaseline(cellId, 2, false));
      // No SHARED_NP baseline — cellLabel will be empty.
      simulateRecv(new UpdateContainmentMessage(cellId, buildingId, -1));
      simulateRecv(new UpdateContainmentMessage(playerId, cellId, -1));
      const result = resolvePlayerCell(ctx.world, playerId);
      expect(result?.cellName).toBe('');
      expect(result?.cellNumber).toBe(2);
      expect(result?.isPublic).toBe(false);
    });
  });

  describe('createLocationView', () => {
    it('surfaces planet from sceneStart.sceneName', () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const view = createLocationView({
        world: ctx.world,
        playerId: 0x1n,
        planet: 'naboo',
        position: () => ({ x: 0, y: 0, z: 0 }),
      });
      expect(view.planet).toBe('naboo');
    });

    it('returns position via the supplied accessor', () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      let cursor = { x: 100, y: 5, z: 200 };
      const view = createLocationView({
        world: ctx.world,
        playerId: 0x1n,
        planet: 'tatooine',
        position: () => cursor,
      });
      expect(view.position).toEqual({ x: 100, y: 5, z: 200 });
      cursor = { x: 50, y: 6, z: 51 };
      expect(view.position).toEqual({ x: 50, y: 6, z: 51 });
    });

    it('cell reflects the most-recent WorldModel state', () => {
      const playerId = 0xaan;
      const buildingId = 0xb00n;
      const cellId = 0xc00n;
      const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
      const view = createLocationView({
        world: ctx.world,
        playerId,
        planet: 'tatooine',
        position: () => ({ x: 0, y: 0, z: 0 }),
      });
      // Initially outdoors.
      expect(view.cell).toBeNull();
      // Server pushes the building + cell + containment for player → cell.
      simulateRecv(playerCreoBaseline(playerId));
      simulateRecv(buildingBaseline(buildingId, 'B'));
      simulateRecv(cellSharedBaseline(cellId, 1, true));
      simulateRecv(cellSharedNpBaseline(cellId, 'Living Room'));
      simulateRecv(new UpdateContainmentMessage(cellId, buildingId, -1));
      simulateRecv(new UpdateContainmentMessage(playerId, cellId, -1));
      // Re-read — should now show the cell.
      const cell = view.cell;
      expect(cell).not.toBeNull();
      expect(cell?.cellName).toBe('Living Room');
      expect(cell?.buildingId).toBe(buildingId);
    });

    it('cell goes back to null when player walks out (containment to 0n)', () => {
      const playerId = 0xaan;
      const buildingId = 0xb00n;
      const cellId = 0xc00n;
      const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
      const view = createLocationView({
        world: ctx.world,
        playerId,
        planet: 'tatooine',
        position: () => ({ x: 0, y: 0, z: 0 }),
      });
      simulateRecv(playerCreoBaseline(playerId));
      simulateRecv(buildingBaseline(buildingId, 'B'));
      simulateRecv(cellSharedBaseline(cellId, 1, true));
      simulateRecv(new UpdateContainmentMessage(cellId, buildingId, -1));
      simulateRecv(new UpdateContainmentMessage(playerId, cellId, -1));
      expect(view.cell).not.toBeNull();
      simulateRecv(new UpdateContainmentMessage(playerId, 0n, -1));
      expect(view.cell).toBeNull();
    });
  });

  describe('findCellByName', () => {
    it('matches on cellLabel (SHARED_NP)', () => {
      const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: 0x1n });
      const buildingId = 0xb00n;
      const cellA = 0xc01n;
      const cellB = 0xc02n;
      simulateRecv(buildingBaseline(buildingId, 'House'));
      simulateRecv(cellSharedBaseline(cellA, 1));
      simulateRecv(cellSharedNpBaseline(cellA, 'Kitchen'));
      simulateRecv(cellSharedBaseline(cellB, 2));
      simulateRecv(cellSharedNpBaseline(cellB, 'Bedroom'));
      simulateRecv(new UpdateContainmentMessage(cellA, buildingId, -1));
      simulateRecv(new UpdateContainmentMessage(cellB, buildingId, -1));
      expect(findCellByName(ctx.world, buildingId, 'Kitchen')).toBe(cellA);
      expect(findCellByName(ctx.world, buildingId, 'Bedroom')).toBe(cellB);
      expect(findCellByName(ctx.world, buildingId, 'Garage')).toBeNull();
    });

    it('falls back to cellN naming when no SHARED_NP label matches', () => {
      const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: 0x1n });
      const buildingId = 0xb00n;
      const cell1 = 0xc01n;
      const cell2 = 0xc02n;
      simulateRecv(buildingBaseline(buildingId, 'House'));
      simulateRecv(cellSharedBaseline(cell1, 1));
      simulateRecv(cellSharedBaseline(cell2, 2));
      simulateRecv(new UpdateContainmentMessage(cell1, buildingId, -1));
      simulateRecv(new UpdateContainmentMessage(cell2, buildingId, -1));
      expect(findCellByName(ctx.world, buildingId, 'cell1')).toBe(cell1);
      expect(findCellByName(ctx.world, buildingId, 'cell2')).toBe(cell2);
      expect(findCellByName(ctx.world, buildingId, 'cell3')).toBeNull();
    });

    it('returns null when buildingId is unknown', () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      expect(findCellByName(ctx.world, 0xdeadn, 'Kitchen')).toBeNull();
    });
  });

  describe('findFirstPublicCell', () => {
    it('returns the lowest-cellNumber public cell', () => {
      const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: 0x1n });
      const buildingId = 0xb00n;
      const cellPub1 = 0xc01n;
      const cellPriv = 0xc02n;
      const cellPub2 = 0xc03n;
      simulateRecv(buildingBaseline(buildingId, 'House'));
      simulateRecv(cellSharedBaseline(cellPub2, 3, true));
      simulateRecv(cellSharedBaseline(cellPub1, 1, true));
      simulateRecv(cellSharedBaseline(cellPriv, 2, false));
      simulateRecv(new UpdateContainmentMessage(cellPub1, buildingId, -1));
      simulateRecv(new UpdateContainmentMessage(cellPriv, buildingId, -1));
      simulateRecv(new UpdateContainmentMessage(cellPub2, buildingId, -1));
      expect(findFirstPublicCell(ctx.world, buildingId)).toBe(cellPub1);
    });

    it('returns null when no cells are public', () => {
      const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: 0x1n });
      const buildingId = 0xb00n;
      const cellPriv = 0xc01n;
      simulateRecv(buildingBaseline(buildingId, 'House'));
      simulateRecv(cellSharedBaseline(cellPriv, 1, false));
      simulateRecv(new UpdateContainmentMessage(cellPriv, buildingId, -1));
      expect(findFirstPublicCell(ctx.world, buildingId)).toBeNull();
    });

    it('returns null when buildingId has no cells', () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      expect(findFirstPublicCell(ctx.world, 0xb00n)).toBeNull();
    });
  });
});
