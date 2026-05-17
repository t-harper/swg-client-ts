/**
 * Unit tests for `planNavigate`.
 *
 * We exercise the deterministic planning path — `planNavigate` is a pure
 * function over a `PlanContext` snapshot, so we can assert step-by-step the
 * plan it produces (no walk loop, no dispatcher).
 *
 * The `runPlan` executor is exercised indirectly by the live integration
 * test (`tests/integration/live-navigate.test.ts`) — it has too many timing
 * dependencies to be meaningfully unit-tested in isolation.
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
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import { UpdateContainmentMessage } from '../messages/game/update-containment-message.js';
import type { WorldModel } from './world-model.js';
import { createFakeContext } from './script/test-helpers.js';
import { planNavigate } from './navigate.js';
import type { NetworkId } from '../types.js';

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

function spawnBuilding(world: WorldModel, id: bigint, x: number, z: number, name = 'B'): void {
  // SceneCreateObjectByName populates the WorldModel's `position`. We use it
  // rather than a manual touch so position propagates to navigate's anchor.
  const dispatcher = (world as unknown as { unsubscribers: unknown[] }) as unknown;
  void dispatcher;
  // Indirect via a fake-context dispatcher path is the cleanest — but since
  // the WorldModel was constructed with that dispatcher, we can't simulate
  // without going through it. Caller must use simulateRecv directly; this
  // helper just builds the message.
  void id;
  void x;
  void z;
  void name;
}
void spawnBuilding;

describe('planNavigate', () => {
  describe('outdoor target', () => {
    it('walks directly to the target when on foot and distance is below threshold', () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const plan = planNavigate(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { x: 10, z: 10 },
      );
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]).toMatchObject({ kind: 'walkTo', x: 10, z: 10 });
      expect(plan.cellId).toBeNull();
      expect(plan.outdoorAnchor).toEqual({ x: 10, z: 10 });
    });

    it('mounts when distance > threshold AND a vehicle PCD is available', () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const vehiclePcd = 0xfe1n as NetworkId;
      const plan = planNavigate(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [vehiclePcd],
        },
        { x: 100, z: 0 },
      );
      // Expected: callVehicle → mount → walkTo
      expect(plan.steps).toHaveLength(3);
      expect(plan.steps[0]).toMatchObject({ kind: 'callVehicle', vehiclePcdId: vehiclePcd });
      expect(plan.steps[1]).toMatchObject({ kind: 'mount', vehicleId: vehiclePcd });
      expect(plan.steps[2]).toMatchObject({ kind: 'walkTo', x: 100, z: 0 });
    });

    it('does NOT mount when useMount === "never"', () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const vehiclePcd = 0xfe1n as NetworkId;
      const plan = planNavigate(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [vehiclePcd],
        },
        { x: 100, z: 0 },
        { useMount: 'never' },
      );
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]).toMatchObject({ kind: 'walkTo' });
    });

    it('does NOT mount when distance is below mountThresholdM', () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const vehiclePcd = 0xfe1n as NetworkId;
      const plan = planNavigate(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [vehiclePcd],
        },
        { x: 30, z: 0 },
        { mountThresholdM: 50 },
      );
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]).toMatchObject({ kind: 'walkTo' });
    });

    it('respects a custom mountThresholdM', () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const vehiclePcd = 0xfe1n as NetworkId;
      const plan = planNavigate(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [vehiclePcd],
        },
        { x: 25, z: 0 },
        { mountThresholdM: 20 },
      );
      // Distance is 25 > 20 threshold → mount.
      expect(plan.steps).toHaveLength(3);
      expect(plan.steps[0]?.kind).toBe('callVehicle');
    });

    it('skips mount when no vehicle PCD is available', () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const plan = planNavigate(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { x: 200, z: 0 },
      );
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]).toMatchObject({ kind: 'walkTo' });
    });

    it('skips mount when already mounted', () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const vehiclePcd = 0xfe1n as NetworkId;
      const plan = planNavigate(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: 12,
          vehiclePcdIds: [vehiclePcd],
        },
        { x: 200, z: 0 },
      );
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]).toMatchObject({ kind: 'walkTo' });
    });

    it('skips mount when player is currently in a cell', () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const vehiclePcd = 0xfe1n as NetworkId;
      const plan = planNavigate(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: 0xc00n,
          mountCapMps: null,
          vehiclePcdIds: [vehiclePcd],
        },
        { x: 200, z: 0 },
      );
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]).toMatchObject({ kind: 'walkTo' });
    });
  });

  describe('interior target', () => {
    function setupBuildingWithCell(opts: {
      buildingX: number;
      buildingZ: number;
      cellLabel?: string;
      cellNumber?: number;
      isPublic?: boolean;
    }): {
      ctx: ReturnType<typeof createFakeContext>['ctx'];
      buildingId: NetworkId;
      cellId: NetworkId;
    } {
      const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: 0x1n });
      const buildingId = 0xb00n as NetworkId;
      const cellId = 0xc01n as NetworkId;
      // SceneCreateObjectByName sets the building's position in the WorldModel.
      simulateRecv(
        new SceneCreateObjectByName(
          buildingId,
          {
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            position: { x: opts.buildingX, y: 0, z: opts.buildingZ },
          },
          'object/building/naboo/naboo_house_small.iff',
          false,
        ),
      );
      simulateRecv(buildingBaseline(buildingId, 'House'));
      simulateRecv(cellSharedBaseline(cellId, opts.cellNumber ?? 1, opts.isPublic ?? true));
      if (opts.cellLabel !== undefined) {
        simulateRecv(cellSharedNpBaseline(cellId, opts.cellLabel));
      }
      simulateRecv(new UpdateContainmentMessage(cellId, buildingId, -1));
      return { ctx, buildingId, cellId };
    }

    it('resolves cellId by cellName label and plans walkTo + walkToCell', () => {
      const { ctx, buildingId, cellId } = setupBuildingWithCell({
        buildingX: 50,
        buildingZ: 50,
        cellLabel: 'Foyer',
      });
      const plan = planNavigate(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { buildingId, cellName: 'Foyer' },
      );
      expect(plan.cellId).toBe(cellId);
      expect(plan.outdoorAnchor).toEqual({ x: 50, z: 50 });
      // Plan: walkTo(approach) → walkTo(buildingAnchor) → walkToCell
      const kinds = plan.steps.map((s) => s.kind);
      expect(kinds).toContain('walkTo');
      expect(kinds[kinds.length - 1]).toBe('walkToCell');
      const last = plan.steps[plan.steps.length - 1];
      if (last?.kind === 'walkToCell') {
        expect(last.cellId).toBe(cellId);
        expect(last.x).toBe(0);
        expect(last.z).toBe(0);
      }
    });

    it('resolves cellId by cellN shorthand (cell1)', () => {
      const { ctx, buildingId, cellId } = setupBuildingWithCell({
        buildingX: 10,
        buildingZ: 10,
        cellNumber: 1,
      });
      const plan = planNavigate(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { buildingId, cellName: 'cell1' },
      );
      expect(plan.cellId).toBe(cellId);
    });

    it('throws when the target building is not in the WorldModel', () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      expect(() =>
        planNavigate(
          {
            world: ctx.world,
            position: { x: 0, y: 0, z: 0 },
            currentCell: null,
            mountCapMps: null,
            vehiclePcdIds: [],
          },
          { buildingId: 0xdeadn as NetworkId, cellName: 'cell1' },
        ),
      ).toThrow(/not in the WorldModel/);
    });

    it('throws when the building exists but has no matching cell', () => {
      const { ctx, buildingId } = setupBuildingWithCell({
        buildingX: 0,
        buildingZ: 0,
        cellLabel: 'Foyer',
      });
      expect(() =>
        planNavigate(
          {
            world: ctx.world,
            position: { x: 0, y: 0, z: 0 },
            currentCell: null,
            mountCapMps: null,
            vehiclePcdIds: [],
          },
          { buildingId, cellName: 'Garage' },
        ),
      ).toThrow(/no cell matching 'Garage'/);
    });

    it('dismounts before the cell entry when arriving mounted', () => {
      const { ctx, buildingId } = setupBuildingWithCell({
        buildingX: 100,
        buildingZ: 0,
        cellLabel: 'Foyer',
      });
      const vehiclePcd = 0xfe1n as NetworkId;
      const plan = planNavigate(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null, // we'll be on foot when planning, but mount up below
          vehiclePcdIds: [vehiclePcd],
        },
        { buildingId, cellName: 'Foyer' },
      );
      const kinds = plan.steps.map((s) => s.kind);
      // Expect: callVehicle → mount → walkTo(approach) → dismount → walkTo(anchor) → walkToCell
      expect(kinds.indexOf('callVehicle')).toBeLessThan(kinds.indexOf('mount'));
      expect(kinds.indexOf('mount')).toBeLessThan(kinds.indexOf('walkTo'));
      expect(kinds.indexOf('dismount')).toBeLessThan(kinds.indexOf('walkToCell'));
      const dismountIdx = kinds.indexOf('dismount');
      const walkToCellIdx = kinds.indexOf('walkToCell');
      expect(dismountIdx).toBeGreaterThanOrEqual(0);
      expect(walkToCellIdx).toBe(kinds.length - 1);
    });

    it('uses first public cell when cellName is ""', () => {
      const { ctx, buildingId, cellId } = setupBuildingWithCell({
        buildingX: 10,
        buildingZ: 10,
        isPublic: true,
        cellNumber: 1,
      });
      const plan = planNavigate(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { buildingId, cellName: '' },
      );
      expect(plan.cellId).toBe(cellId);
    });

    it('honors a custom dismountDistanceM', () => {
      const { ctx, buildingId } = setupBuildingWithCell({
        buildingX: 100,
        buildingZ: 0,
        cellLabel: 'Foyer',
      });
      const plan = planNavigate(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { buildingId, cellName: 'Foyer' },
        { dismountDistanceM: 20 },
      );
      // Approach should stop at 100 - 20 = 80 along the line from 0,0 to 100,0.
      const firstWalk = plan.steps.find((s) => s.kind === 'walkTo');
      expect(firstWalk).toBeDefined();
      if (firstWalk?.kind === 'walkTo') {
        expect(firstWalk.x).toBeCloseTo(80, 1);
      }
    });

    it('passes through a cell-relative position when supplied', () => {
      const { ctx, buildingId } = setupBuildingWithCell({
        buildingX: 0,
        buildingZ: 0,
        cellLabel: 'Foyer',
      });
      const plan = planNavigate(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { buildingId, cellName: 'Foyer', position: { x: 3, z: -2 } },
      );
      const last = plan.steps[plan.steps.length - 1];
      if (last?.kind === 'walkToCell') {
        expect(last.x).toBe(3);
        expect(last.z).toBe(-2);
      } else {
        expect.fail('expected the last step to be walkToCell');
      }
    });
  });
});
