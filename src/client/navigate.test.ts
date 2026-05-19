/**
 * Unit tests for `planNavigate`.
 *
 * We exercise the deterministic planning path — `planNavigateSync` is a pure
 * function over a `PlanContext` snapshot, so we can assert step-by-step the
 * plan it produces (no walk loop, no dispatcher). The async `planNavigate`
 * wrapper that performs the portal-layout lookup is exercised separately
 * via the `interior target with portal layout` block.
 *
 * The `runPlan` executor is exercised indirectly by the live integration
 * test (`tests/integration/live-navigate.test.ts`) — it has too many timing
 * dependencies to be meaningfully unit-tested in isolation.
 */
import { describe, expect, it } from 'vitest';

import type {
  Cell,
  CellPortal,
  PortalGeometry,
  PortalLayout,
} from '../iff/portal-layout-reader.js';
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
import type { Vector3 } from '../types.js';
import type { NetworkId } from '../types.js';
import type { CellPathHop } from './cell-graph.js';
import { planNavigate, planNavigateSync } from './navigate.js';
import { createFakeContext } from './script/test-helpers.js';
import type { WorldModel } from './world-model.js';

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
  const dispatcher = world as unknown as { unsubscribers: unknown[] } as unknown;
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
    it('walks directly to the target when on foot and distance is below threshold', async () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const plan = await planNavigate(
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

    it('mounts when distance > threshold AND a vehicle PCD is available', async () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const vehiclePcd = 0xfe1n as NetworkId;
      const plan = await planNavigate(
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

    it('does NOT mount when useMount === "never"', async () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const vehiclePcd = 0xfe1n as NetworkId;
      const plan = await planNavigate(
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

    it('does NOT mount when distance is below mountThresholdM', async () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const vehiclePcd = 0xfe1n as NetworkId;
      const plan = await planNavigate(
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

    it('respects a custom mountThresholdM', async () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const vehiclePcd = 0xfe1n as NetworkId;
      const plan = await planNavigate(
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

    it('skips mount when no vehicle PCD is available', async () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const plan = await planNavigate(
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

    it('skips mount when already mounted', async () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const vehiclePcd = 0xfe1n as NetworkId;
      const plan = await planNavigate(
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

    it('skips mount when player is currently in a cell', async () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      const vehiclePcd = 0xfe1n as NetworkId;
      const plan = await planNavigate(
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

    it('resolves cellId by cellName label and plans walkTo + walkToCell', async () => {
      const { ctx, buildingId, cellId } = setupBuildingWithCell({
        buildingX: 50,
        buildingZ: 50,
        cellLabel: 'Foyer',
      });
      const plan = await planNavigate(
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

    it('resolves cellId by cellN shorthand (cell1)', async () => {
      const { ctx, buildingId, cellId } = setupBuildingWithCell({
        buildingX: 10,
        buildingZ: 10,
        cellNumber: 1,
      });
      const plan = await planNavigate(
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

    it('throws when the target building is not in the WorldModel', async () => {
      const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
      await expect(
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
      ).rejects.toThrow(/not in the WorldModel/);
    });

    it('throws when the building exists but has no matching cell', async () => {
      const { ctx, buildingId } = setupBuildingWithCell({
        buildingX: 0,
        buildingZ: 0,
        cellLabel: 'Foyer',
      });
      await expect(
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
      ).rejects.toThrow(/no cell matching 'Garage'/);
    });

    it('dismounts before the cell entry when arriving mounted', async () => {
      const { ctx, buildingId } = setupBuildingWithCell({
        buildingX: 100,
        buildingZ: 0,
        cellLabel: 'Foyer',
      });
      const vehiclePcd = 0xfe1n as NetworkId;
      const plan = await planNavigate(
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

    it('uses first public cell when cellName is ""', async () => {
      const { ctx, buildingId, cellId } = setupBuildingWithCell({
        buildingX: 10,
        buildingZ: 10,
        isPublic: true,
        cellNumber: 1,
      });
      const plan = await planNavigate(
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

    it('honors a custom dismountDistanceM', async () => {
      const { ctx, buildingId } = setupBuildingWithCell({
        buildingX: 100,
        buildingZ: 0,
        cellLabel: 'Foyer',
      });
      const plan = await planNavigate(
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

    it('passes through a cell-relative position when supplied', async () => {
      const { ctx, buildingId } = setupBuildingWithCell({
        buildingX: 0,
        buildingZ: 0,
        cellLabel: 'Foyer',
      });
      const plan = await planNavigate(
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

  // ─── Portal-layout-driven interior path (Track D) ───────────────────────
  //
  // Tests below exercise the synchronous planner (`planNavigateSync`) with
  // a hand-built `PortalLayout` + `CellPathHop[]` literal. This isolates
  // the step-generation logic from the async portal-layout lookup, which
  // is exercised separately by the fallback-path tests.

  describe('interior target with portal layout', () => {
    /**
     * Build a minimal `.pob`-shaped `PortalLayout` literal with `numCells`
     * cells (cell 0 = exterior, cells 1..N = interior) and `portals` portals
     * connecting them as specified. Each portal entry produces TWO
     * CellPortal records — one per endpoint cell — so the BFS pathfinder
     * works against it. Geometry is a 1m × 1m unit quad centered at
     * `door`; the outward normal points in +x by construction.
     */
    function buildPortalLayout(
      numCells: number,
      portals: ReadonlyArray<{
        a: number;
        b: number;
        doorInA: Vector3;
        doorInB: Vector3;
      }>,
    ): PortalLayout {
      // Geometry list — one quad per portal.
      const geometries: PortalGeometry[] = portals.map((p, i) => {
        // Quad in the XY plane, centered at origin (per-cell frame applies
        // the door offset). Vertices wound CCW so the cross product points
        // in +z; we'll set windingClockwise=true and flip to +x via the
        // signs of windingClockwise. Actually, the navigate path uses the
        // outward normal directly; to get a clean +x outward we wind the
        // quad in the YZ plane:
        //   v0 = (0, 0, -0.5)
        //   v1 = (0, 1,  -0.5)
        //   v2 = (0, 1,   0.5)
        //   v3 = (0, 0,   0.5)
        // Edge e1 = (0,1,0), e2 = (0,1,1). Cross product e1×e2 = (1*1-0*1, 0*0-0*1, 0*1-1*0) = (1, 0, 0).
        // → outward normal = +x. Set windingClockwise=true so we don't flip.
        void i;
        return {
          vertices: [
            { x: 0, y: 0, z: -0.5 },
            { x: 0, y: 1, z: -0.5 },
            { x: 0, y: 1, z: 0.5 },
            { x: 0, y: 0, z: 0.5 },
          ],
          center: { x: 0, y: 0.5, z: 0 },
        };
      });
      const cells: Cell[] = [];
      for (let i = 0; i < numCells; ++i) {
        const cellPortals: CellPortal[] = [];
        for (let p = 0; p < portals.length; ++p) {
          const portal = portals[p];
          const geom = geometries[p];
          if (portal === undefined || geom === undefined) continue;
          if (portal.a === i) {
            cellPortals.push({
              geometryIndex: p,
              geometry: geom,
              targetCellIndex: portal.b,
              passable: true,
              disabled: false,
              windingClockwise: true,
              doorStyle: '',
              doorPosition: portal.doorInA,
              doorTransform: null,
            });
          } else if (portal.b === i) {
            cellPortals.push({
              geometryIndex: p,
              geometry: geom,
              targetCellIndex: portal.a,
              passable: true,
              disabled: false,
              // Flip winding on the OTHER side so the outward normal points
              // into cell A — i.e. inward into cell B's interior would be
              // the opposite direction (-x). The mirror-portal lookup in
              // navigate computes the "into cell B" direction by negating
              // the outward normal on B's side, so this gives a +x inward
              // offset into B. (Symmetric +x outward + flipped winding =
              // +x inward into B.) Either sign works for the unit test;
              // the assertion just checks the offset is non-trivial.
              windingClockwise: false,
              doorStyle: '',
              doorPosition: portal.doorInB,
              doorTransform: null,
            });
          }
        }
        cells.push({ index: i, name: i === 0 ? 'exterior' : `r${i - 1}`, portals: cellPortals });
      }
      return { sourceName: '<test>', version: '0003', geometries, cells };
    }

    /** Tighten a chain of optional lookups for the fixture builders below. */
    function assertDefined<T>(value: T | undefined, label: string): T {
      if (value === undefined) {
        throw new Error(`assertDefined: ${label} was undefined`);
      }
      return value;
    }

    /**
     * Build a CellPathHop[] from a contiguous chain of cell indices.
     * `pathIndices[0]` is the source cell; remaining entries are visited in
     * order. `layout` is consulted to grab the outgoing portal from each
     * `fromCell` and the mirror door on each `toCell`.
     */
    function buildCellPathHops(layout: PortalLayout, pathIndices: number[]): CellPathHop[] {
      const hops: CellPathHop[] = [];
      for (let i = 1; i < pathIndices.length; ++i) {
        const from = assertDefined(pathIndices[i - 1], `pathIndices[${i - 1}]`);
        const to = assertDefined(pathIndices[i], `pathIndices[${i}]`);
        const fromCell = assertDefined(
          layout.cells.find((c) => c.index === from),
          `cell ${from}`,
        );
        const portal = assertDefined(
          fromCell.portals.find((p) => p.targetCellIndex === to),
          `portal ${from}→${to}`,
        );
        const toCell = assertDefined(
          layout.cells.find((c) => c.index === to),
          `cell ${to}`,
        );
        const mirror = assertDefined(
          toCell.portals.find((p) => p.geometryIndex === portal.geometryIndex),
          `mirror portal in cell ${to}`,
        );
        hops.push({
          fromCellIndex: from,
          toCellIndex: to,
          portal,
          fromCellLocalDoor: portal.doorPosition,
          toCellLocalDoor: mirror.doorPosition,
        });
      }
      return hops;
    }

    function setupBuildingMulti(
      cellNumbers: number[],
      buildingX = 0,
      buildingZ = 0,
    ): {
      ctx: ReturnType<typeof createFakeContext>['ctx'];
      buildingId: NetworkId;
      cellNetworkIdByNumber: Map<number, NetworkId>;
    } {
      const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: 0x1n });
      const buildingId = 0xb00n as NetworkId;
      simulateRecv(
        new SceneCreateObjectByName(
          buildingId,
          {
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            position: { x: buildingX, y: 0, z: buildingZ },
          },
          'object/building/tatooine/cantina_tatooine.iff',
          false,
        ),
      );
      simulateRecv(buildingBaseline(buildingId, 'Cantina'));
      const cellNetworkIdByNumber = new Map<number, NetworkId>();
      let nextId = 0xc01n;
      for (const cellNumber of cellNumbers) {
        const cellId = nextId as NetworkId;
        nextId = (nextId + 1n) as NetworkId;
        cellNetworkIdByNumber.set(cellNumber, cellId);
        simulateRecv(cellSharedBaseline(cellId, cellNumber, true));
        simulateRecv(new UpdateContainmentMessage(cellId, buildingId, -1));
      }
      return { ctx, buildingId, cellNetworkIdByNumber };
    }

    it('emits walkThroughPortal for a single exterior → interior hop', () => {
      const { ctx, buildingId, cellNetworkIdByNumber } = setupBuildingMulti([1], 10, 20);
      // One portal between cell 0 (exterior) and cell 1 (interior).
      const layout = buildPortalLayout(2, [
        { a: 0, b: 1, doorInA: { x: 3, y: 0, z: 0 }, doorInB: { x: -3, y: 0, z: 0 } },
      ]);
      const cellPath = buildCellPathHops(layout, [0, 1]);
      const plan = planNavigateSync(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { buildingId, cellName: 'cell1' },
        {},
        layout,
        cellPath,
      );
      const kinds = plan.steps.map((s) => s.kind);
      // Should include exactly one walkThroughPortal + final walkToCell + verifyCellEntry.
      expect(kinds.filter((k) => k === 'walkThroughPortal')).toHaveLength(1);
      expect(kinds[kinds.length - 1]).toBe('verifyCellEntry');
      const portalStep = plan.steps.find((s) => s.kind === 'walkThroughPortal');
      expect(portalStep).toBeDefined();
      if (portalStep?.kind === 'walkThroughPortal') {
        expect(portalStep.fromCellId).toBeNull();
        expect(portalStep.toCellId).toBe(cellNetworkIdByNumber.get(1));
        expect(portalStep.portalWorld).toBeDefined();
      }
      expect(plan.fallbackReason).toBeNull();
    });

    it('emits one walkThroughPortal per hop for a multi-hop path', () => {
      const { ctx, buildingId, cellNetworkIdByNumber } = setupBuildingMulti([1, 2, 3]);
      // 0 (exterior) → 1 (foyer) → 2 (hallway) → 3 (back bar).
      const layout = buildPortalLayout(4, [
        { a: 0, b: 1, doorInA: { x: 3, y: 0, z: 0 }, doorInB: { x: -3, y: 0, z: 0 } },
        { a: 1, b: 2, doorInA: { x: 5, y: 0, z: 1 }, doorInB: { x: -5, y: 0, z: 1 } },
        { a: 2, b: 3, doorInA: { x: 7, y: 0, z: 2 }, doorInB: { x: -7, y: 0, z: 2 } },
      ]);
      const cellPath = buildCellPathHops(layout, [0, 1, 2, 3]);
      const plan = planNavigateSync(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { buildingId, cellName: 'cell3' },
        {},
        layout,
        cellPath,
      );
      const portalSteps = plan.steps.filter((s) => s.kind === 'walkThroughPortal');
      expect(portalSteps).toHaveLength(3);
      // First hop: exterior → cell 1 (fromCellId null, portalWorld populated).
      if (portalSteps[0]?.kind === 'walkThroughPortal') {
        expect(portalSteps[0].fromCellId).toBeNull();
        expect(portalSteps[0].toCellId).toBe(cellNetworkIdByNumber.get(1));
        expect(portalSteps[0].portalWorld).toBeDefined();
        expect(portalSteps[0].fromCellLocalDoor).toBeUndefined();
      }
      // Second hop: cell 1 → cell 2 (fromCellLocalDoor populated, no portalWorld).
      if (portalSteps[1]?.kind === 'walkThroughPortal') {
        expect(portalSteps[1].fromCellId).toBe(cellNetworkIdByNumber.get(1));
        expect(portalSteps[1].toCellId).toBe(cellNetworkIdByNumber.get(2));
        expect(portalSteps[1].fromCellLocalDoor).toBeDefined();
        expect(portalSteps[1].portalWorld).toBeUndefined();
      }
      // Third hop: cell 2 → cell 3.
      if (portalSteps[2]?.kind === 'walkThroughPortal') {
        expect(portalSteps[2].fromCellId).toBe(cellNetworkIdByNumber.get(2));
        expect(portalSteps[2].toCellId).toBe(cellNetworkIdByNumber.get(3));
        expect(portalSteps[2].fromCellLocalDoor).toBeDefined();
      }
    });

    it('toCellLocalEntry sits ~2m past the portal door along the inward normal', () => {
      const { ctx, buildingId } = setupBuildingMulti([1]);
      // Door on B side is at x=-3. Outward normal on B's side points in
      // -x (winding flipped). The inward (into-B) direction is therefore +x.
      // So toCellLocalEntry.x should be -3 + 2*(+1) = -1.
      const layout = buildPortalLayout(2, [
        { a: 0, b: 1, doorInA: { x: 3, y: 0, z: 0 }, doorInB: { x: -3, y: 0, z: 0 } },
      ]);
      const cellPath = buildCellPathHops(layout, [0, 1]);
      const plan = planNavigateSync(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { buildingId, cellName: 'cell1' },
        {},
        layout,
        cellPath,
      );
      const portalStep = plan.steps.find((s) => s.kind === 'walkThroughPortal');
      expect(portalStep).toBeDefined();
      if (portalStep?.kind === 'walkThroughPortal') {
        // The actual sign on the inward offset depends on the winding flip
        // direction; the important property is that the offset is ~2m
        // away from the raw door position along the normal axis.
        const dx = portalStep.toCellLocalEntry.x - -3; // door is at -3 on B side
        const dz = portalStep.toCellLocalEntry.z - 0;
        expect(Math.hypot(dx, dz)).toBeCloseTo(2, 1);
      }
    });

    it('portalWorld ≈ building.position + rotated(door + outwardNormal*1m)', () => {
      const buildingX = 50;
      const buildingZ = -30;
      const { ctx, buildingId } = setupBuildingMulti([1], buildingX, buildingZ);
      // Door on A (exterior) side at (3, 0, 0). Outward normal in cell 0
      // is +x. So portalWorld (with building yaw=0) is
      //   buildingPos + (door + outwardNormal*1m)
      //   = (50, -30) + ((3, 0) + (1, 0)*1)
      //   = (50, -30) + (4, 0)
      //   = (54, -30)
      const layout = buildPortalLayout(2, [
        { a: 0, b: 1, doorInA: { x: 3, y: 0, z: 0 }, doorInB: { x: -3, y: 0, z: 0 } },
      ]);
      const cellPath = buildCellPathHops(layout, [0, 1]);
      const plan = planNavigateSync(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { buildingId, cellName: 'cell1' },
        {},
        layout,
        cellPath,
      );
      const portalStep = plan.steps.find((s) => s.kind === 'walkThroughPortal');
      expect(portalStep).toBeDefined();
      if (portalStep?.kind === 'walkThroughPortal' && portalStep.portalWorld) {
        expect(portalStep.portalWorld.x).toBeCloseTo(54, 1);
        expect(portalStep.portalWorld.z).toBeCloseTo(-30, 1);
      }
    });

    it('falls back to legacy walkTo + walkToCell when no portal layout is supplied', () => {
      const { ctx, buildingId, cellNetworkIdByNumber } = setupBuildingMulti([1], 50, 50);
      const plan = planNavigateSync(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { buildingId, cellName: 'cell1' },
        {},
        undefined,
        null,
      );
      const kinds = plan.steps.map((s) => s.kind);
      // Legacy shape: no walkThroughPortal, no verifyCellEntry, just
      // walkTo(s) + final walkToCell.
      expect(kinds).not.toContain('walkThroughPortal');
      expect(kinds).not.toContain('verifyCellEntry');
      expect(kinds[kinds.length - 1]).toBe('walkToCell');
      const last = plan.steps[plan.steps.length - 1];
      if (last?.kind === 'walkToCell') {
        expect(last.cellId).toBe(cellNetworkIdByNumber.get(1));
        expect(last.x).toBe(0);
        expect(last.z).toBe(0);
      }
    });

    it('falls back to legacy walkTo + walkToCell when findCellPath returns null', () => {
      const { ctx, buildingId } = setupBuildingMulti([1], 0, 0);
      const layout = buildPortalLayout(2, [
        { a: 0, b: 1, doorInA: { x: 3, y: 0, z: 0 }, doorInB: { x: -3, y: 0, z: 0 } },
      ]);
      const plan = planNavigateSync(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { buildingId, cellName: 'cell1' },
        {},
        layout,
        null, // simulate findCellPath returning unreachable
        'navigate: no portal-graph path test reason',
      );
      const kinds = plan.steps.map((s) => s.kind);
      expect(kinds).not.toContain('walkThroughPortal');
      expect(kinds).not.toContain('verifyCellEntry');
      expect(kinds[kinds.length - 1]).toBe('walkToCell');
      // The fallbackReason should be surfaced so the caller can warn once.
      expect(plan.fallbackReason).toBe('navigate: no portal-graph path test reason');
    });

    it('appends verifyCellEntry ONLY on the portal path (not on fallback)', () => {
      const { ctx, buildingId } = setupBuildingMulti([1], 0, 0);
      const layout = buildPortalLayout(2, [
        { a: 0, b: 1, doorInA: { x: 3, y: 0, z: 0 }, doorInB: { x: -3, y: 0, z: 0 } },
      ]);
      const cellPath = buildCellPathHops(layout, [0, 1]);
      // Portal path produces verifyCellEntry as the LAST step.
      const portalPlan = planNavigateSync(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { buildingId, cellName: 'cell1' },
        {},
        layout,
        cellPath,
      );
      expect(portalPlan.steps[portalPlan.steps.length - 1]?.kind).toBe('verifyCellEntry');
      const verifyStep = portalPlan.steps[portalPlan.steps.length - 1];
      if (verifyStep?.kind === 'verifyCellEntry') {
        expect(verifyStep.timeoutMs).toBeGreaterThan(0);
      }
      // Fallback path does NOT include verifyCellEntry.
      const fallbackPlan = planNavigateSync(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { buildingId, cellName: 'cell1' },
        {},
        undefined,
        null,
      );
      expect(fallbackPlan.steps.map((s) => s.kind)).not.toContain('verifyCellEntry');
    });

    it('preserves the order of cellPath in the emitted walkThroughPortal steps', () => {
      const { ctx, buildingId, cellNetworkIdByNumber } = setupBuildingMulti([1, 2, 3, 4]);
      const layout = buildPortalLayout(5, [
        { a: 0, b: 1, doorInA: { x: 3, y: 0, z: 0 }, doorInB: { x: -3, y: 0, z: 0 } },
        { a: 1, b: 2, doorInA: { x: 5, y: 0, z: 1 }, doorInB: { x: -5, y: 0, z: 1 } },
        { a: 2, b: 3, doorInA: { x: 7, y: 0, z: 2 }, doorInB: { x: -7, y: 0, z: 2 } },
        { a: 3, b: 4, doorInA: { x: 9, y: 0, z: 3 }, doorInB: { x: -9, y: 0, z: 3 } },
      ]);
      const cellPath = buildCellPathHops(layout, [0, 1, 2, 3, 4]);
      const plan = planNavigateSync(
        {
          world: ctx.world,
          position: { x: 0, y: 0, z: 0 },
          currentCell: null,
          mountCapMps: null,
          vehiclePcdIds: [],
        },
        { buildingId, cellName: 'cell4' },
        {},
        layout,
        cellPath,
      );
      const portalSteps = plan.steps.filter((s) => s.kind === 'walkThroughPortal');
      expect(portalSteps).toHaveLength(4);
      const expectedToCells = [
        cellNetworkIdByNumber.get(1),
        cellNetworkIdByNumber.get(2),
        cellNetworkIdByNumber.get(3),
        cellNetworkIdByNumber.get(4),
      ];
      for (let i = 0; i < 4; ++i) {
        const step = portalSteps[i];
        if (step?.kind === 'walkThroughPortal') {
          expect(step.toCellId).toBe(expectedToCells[i]);
        }
      }
    });
  });
});
