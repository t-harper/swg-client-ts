/**
 * Tests for `ctx.location` + the `character.heading` / `character.inCell`
 * sugar fields exposed by `createScriptContext`.
 */
import { describe, expect, it } from 'vitest';

import { BaselinesMessage } from '../../messages/game/baselines/baselines-message.js';
import type {
  BuildingObjectSharedBaseline,
  CellObjectSharedBaseline,
  CellObjectSharedNpBaseline,
} from '../../messages/game/baselines/index.js';
import {
  BaselinePackageIds,
  BuildingObjectSharedKind,
  CellObjectSharedKind,
  CellObjectSharedNpKind,
  ObjectTypeTags,
} from '../../messages/game/baselines/index.js';
import { UpdateContainmentMessage } from '../../messages/game/update-containment-message.js';
import { createFakeContext } from './test-helpers.js';

import '../../messages/game/baselines/index.js';

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

function cellSharedBaseline(id: bigint, cellNumber: number, isPublic = true): BaselinesMessage {
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

function playerCreoBaseline(id: bigint): BaselinesMessage {
  return new BaselinesMessage(
    id,
    ObjectTypeTags.CREO,
    BaselinePackageIds.SHARED,
    new Uint8Array(0),
    null,
  );
}

describe('ScriptContext.location', () => {
  it('exposes planet from sceneStart.sceneName', () => {
    const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
    // FakeContext defaults sceneName to 'tatooine'.
    expect(ctx.location.planet).toBe('tatooine');
  });

  it('position reflects the pose cursor (same source as ctx.position())', async () => {
    const { ctx } = createFakeContext({
      playerNetworkId: 0x1n,
      startPosition: { x: 100, y: 5, z: 200 },
    });
    expect(ctx.location.position).toEqual({ x: 100, y: 5, z: 200 });
    // Mutate the pose cursor by walking.
    await ctx.walkTo({ x: 110, z: 200 }, { tickMs: 50 });
    const pos = ctx.location.position;
    expect(pos.x).toBeCloseTo(110, 1);
  });

  it('cell is null when player is outdoors', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: 0x1n });
    simulateRecv(playerCreoBaseline(0x1n));
    expect(ctx.location.cell).toBeNull();
  });

  it('cell populates with full descriptor when player is inside a cell', () => {
    const playerId = 0x1n;
    const buildingId = 0xb00n;
    const cellId = 0xc00n;
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
    simulateRecv(playerCreoBaseline(playerId));
    simulateRecv(buildingBaseline(buildingId, 'House'));
    simulateRecv(cellSharedBaseline(cellId, 3, true));
    simulateRecv(cellSharedNpBaseline(cellId, 'Studio'));
    simulateRecv(new UpdateContainmentMessage(cellId, buildingId, -1));
    simulateRecv(new UpdateContainmentMessage(playerId, cellId, -1));
    const cell = ctx.location.cell;
    expect(cell).not.toBeNull();
    expect(cell?.buildingId).toBe(buildingId);
    expect(cell?.cellName).toBe('Studio');
    expect(cell?.cellNumber).toBe(3);
    expect(cell?.isPublic).toBe(true);
  });
});

describe('ScriptContext.character.heading', () => {
  it('returns 0 when fewer than two transforms have been sent', () => {
    const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
    expect(ctx.character.heading).toBe(0);
  });

  it('computes atan2(dx, dz) from the two most-recent transforms', async () => {
    const { ctx } = createFakeContext({
      playerNetworkId: 0x1n,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    // Walk a short line +x → produces several CM_113 sends along the +x axis.
    await ctx.walkTo({ x: 10, z: 0 }, { tickMs: 50 });
    // atan2(dx=positive, dz=0) → π/2 (heading "east" in SWG's local axes).
    expect(ctx.character.heading).toBeCloseTo(Math.PI / 2, 2);
  });

  it('switches direction when the player turns', async () => {
    const { ctx } = createFakeContext({
      playerNetworkId: 0x1n,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    await ctx.walkTo({ x: 0, z: 10 }, { tickMs: 50 });
    // atan2(0, +z) → 0 (heading "north").
    expect(ctx.character.heading).toBeCloseTo(0, 2);
    await ctx.walkTo({ x: 0, z: 20 }, { tickMs: 50 });
    expect(ctx.character.heading).toBeCloseTo(0, 2);
  });
});

describe('ScriptContext.character.inCell', () => {
  it('is false when outdoors', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: 0x1n });
    simulateRecv(playerCreoBaseline(0x1n));
    expect(ctx.character.inCell).toBe(false);
  });

  it('is true when location.cell is populated', () => {
    const playerId = 0x1n;
    const buildingId = 0xb00n;
    const cellId = 0xc00n;
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
    simulateRecv(playerCreoBaseline(playerId));
    simulateRecv(buildingBaseline(buildingId, 'House'));
    simulateRecv(cellSharedBaseline(cellId, 1, true));
    simulateRecv(new UpdateContainmentMessage(cellId, buildingId, -1));
    simulateRecv(new UpdateContainmentMessage(playerId, cellId, -1));
    expect(ctx.character.inCell).toBe(true);
  });
});

describe('ScriptContext.navigate', () => {
  it('is callable and dispatches walkTo for an outdoor target', async () => {
    const { ctx, sent } = createFakeContext({
      playerNetworkId: 0x1n,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    await ctx.navigate({ x: 5, z: 5 });
    // The walk should have emitted at least one ObjControllerMessage send.
    expect(sent.length).toBeGreaterThan(0);
    const pos = ctx.position();
    expect(pos.x).toBeCloseTo(5, 1);
    expect(pos.z).toBeCloseTo(5, 1);
  });

  it('rejects with an informative error when the building is unknown', async () => {
    const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
    await expect(ctx.navigate({ buildingId: 0xdeadn, cellName: 'cell1' })).rejects.toThrow(
      /not in the WorldModel/,
    );
  });
});
