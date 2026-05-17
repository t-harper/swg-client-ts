/**
 * Unit tests for MissionsCacheImpl + ctx.missions wiring.
 */
import { describe, expect, it } from 'vitest';

import { constcrc } from '../crc/constcrc.js';
import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import {
  BaselinePackageIds,
  ObjectTypeTags,
} from '../messages/game/baselines/registry.js';
import {
  type MissionObjectSharedBaseline,
  MissionObjectSharedKind,
} from '../messages/game/baselines/index.js';
import { missionTypeName, MissionsCacheImpl } from './missions-cache.js';
import { createFakeContext } from './script/test-helpers.js';
import { WorldModel } from './world-model.js';

/** Build a synthetic MISO SHARED baseline for tests. */
function makeMissionBaseline(
  args: {
    targetName?: string;
    descriptionText?: string;
    reward?: number;
    missionTypeCrc?: number;
    endX?: number;
    endZ?: number;
  } = {},
): MissionObjectSharedBaseline {
  return {
    complexity: 1,
    nameStringId: { table: 'mission', textIndex: 0, text: 'mission_name' },
    objectName: '',
    volume: 1,
    count: 1,
    difficulty: 1,
    endLocation: {
      coordinates: { x: args.endX ?? 100, y: 0, z: args.endZ ?? 200 },
      cell: 0n,
      sceneIdCrc: 0,
    },
    missionCreator: 'GenericNPC',
    reward: args.reward ?? 1500,
    startLocation: {
      coordinates: { x: 0, y: 0, z: 0 },
      cell: 0n,
      sceneIdCrc: 0,
    },
    targetAppearance: 0,
    description: { table: 'mission/m1', textIndex: 0, text: args.descriptionText ?? 'kill_some_mobs' },
    title: { table: 'mission/m1', textIndex: 0, text: 'destroy_mission_title' },
    status: 0,
    missionType: args.missionTypeCrc ?? constcrc('destroy'),
    targetName: args.targetName ?? 'object/mobile/dewback.iff',
    waypoint: {
      appearanceNameCrc: 0,
      location: {
        coordinates: { x: 0, y: 0, z: 0 },
        cell: 0n,
        sceneIdCrc: 0,
      },
      name: '',
      networkId: 0n,
      color: 0,
      active: false,
    },
  };
}

/** Inject a MISO baseline into the WorldModel via a fake recv. */
function injectMission(
  simulateRecv: (m: BaselinesMessage) => void,
  id: bigint,
  baseline: MissionObjectSharedBaseline,
): void {
  simulateRecv(
    new BaselinesMessage(id, ObjectTypeTags.MISO, BaselinePackageIds.SHARED, new Uint8Array(0), {
      kind: MissionObjectSharedKind,
      data: baseline,
    }),
  );
}

describe('missionTypeName', () => {
  it('returns "destroy" for the destroy CRC', () => {
    expect(missionTypeName(constcrc('destroy'))).toBe('destroy');
  });

  it('returns "bounty" for the bounty CRC', () => {
    expect(missionTypeName(constcrc('bounty'))).toBe('bounty');
  });

  it('returns "hunting" for the hunting CRC', () => {
    expect(missionTypeName(constcrc('hunting'))).toBe('hunting');
  });

  it('falls back to a hex string for unknown CRCs', () => {
    expect(missionTypeName(0x12345678)).toBe('0x12345678');
  });
});

describe('MissionsCacheImpl', () => {
  it('active is empty when no MISO baselines have arrived', () => {
    const { ctx } = createFakeContext();
    expect(ctx.missions.active).toEqual([]);
  });

  it('reflects MISO SHARED baselines as Mission entries', () => {
    const { ctx, simulateRecv } = createFakeContext();
    injectMission(
      simulateRecv,
      0xdead001n,
      makeMissionBaseline({
        targetName: 'object/mobile/krayt_dragon.iff',
        descriptionText: 'kill_the_dragon',
        reward: 5000,
        missionTypeCrc: constcrc('destroy'),
        endX: 1000,
        endZ: 2000,
      }),
    );
    const active = ctx.missions.active;
    expect(active).toHaveLength(1);
    const m = active[0];
    if (m === undefined) throw new Error('unreachable');
    expect(m.id).toBe(0xdead001n);
    expect(m.type).toBe('destroy');
    expect(m.payout).toBe(5000);
    expect(m.target).toBe('object/mobile/krayt_dragon.iff');
    expect(m.description).toBe('kill_the_dragon');
    expect(m.location.x).toBe(1000);
    expect(m.location.z).toBe(2000);
  });

  it('findByCategory filters by regex', () => {
    const { ctx, simulateRecv } = createFakeContext();
    injectMission(simulateRecv, 0x1n, makeMissionBaseline({ missionTypeCrc: constcrc('destroy') }));
    injectMission(simulateRecv, 0x2n, makeMissionBaseline({ missionTypeCrc: constcrc('hunting') }));
    injectMission(simulateRecv, 0x3n, makeMissionBaseline({ missionTypeCrc: constcrc('deliver') }));
    const hunts = ctx.missions.findByCategory(/destroy|hunt/i);
    expect(hunts.map((m) => m.type).sort()).toEqual(['destroy', 'hunting']);
  });

  it('bestPayout returns the highest-paying mission', () => {
    const { ctx, simulateRecv } = createFakeContext();
    injectMission(simulateRecv, 0x1n, makeMissionBaseline({ reward: 100 }));
    injectMission(simulateRecv, 0x2n, makeMissionBaseline({ reward: 9999 }));
    injectMission(simulateRecv, 0x3n, makeMissionBaseline({ reward: 500 }));
    const best = ctx.missions.bestPayout();
    expect(best?.id).toBe(0x2n);
    expect(best?.payout).toBe(9999);
  });

  it('bestPayout returns undefined when there are no missions', () => {
    const { ctx } = createFakeContext();
    expect(ctx.missions.bestPayout()).toBeUndefined();
  });

  it('MissionsCacheImpl skips MISO objects with no decoded SHARED baseline', () => {
    const { ctx, simulateRecv } = createFakeContext();
    // Inject MISO with NO decodedBaseline (opaque bytes only).
    simulateRecv(
      new BaselinesMessage(
        0xbeefn,
        ObjectTypeTags.MISO,
        BaselinePackageIds.SHARED,
        new Uint8Array(0),
        null /* decodedBaseline */,
      ),
    );
    // No typed baseline ⇒ no Mission entry.
    expect(ctx.missions.active).toHaveLength(0);
  });

  it('MissionsCacheImpl can be used standalone over a WorldModel', () => {
    const { ctx, simulateRecv } = createFakeContext();
    // Pretty much pointless to construct another world, just verify the
    // class is importable + that it sees the same data ctx.missions sees.
    const cache = new MissionsCacheImpl(ctx.world);
    cache.attach();
    injectMission(simulateRecv, 0x77n, makeMissionBaseline({ reward: 4242 }));
    expect(cache.active).toHaveLength(1);
    expect(cache.active[0]?.payout).toBe(4242);
    cache.detach();
  });

  // Silence "imported but unused" for WorldModel — we import the type for
  // documentation even when only `ctx.world` is exercised in practice.
  void WorldModel;
});
