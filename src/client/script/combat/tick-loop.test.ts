import { describe, expect, it } from 'vitest';

import { ObjControllerMessage } from '../../../messages/game/obj-controller-message.js';
import type { GameNetworkMessage } from '../../../messages/interface.js';
import type { NetworkId, Vector3 } from '../../../types.js';
import type { CharacterSheet } from '../../character-sheet.js';
import type { CombatTargetEntry, CombatView } from '../../combat-helpers.js';
import type { CombatHitInfo, CombatTimerView, CooldownView } from '../../timing.js';
import type { WorldModel, WorldObject } from '../../world-model.js';
import {
  type TickLoopHost,
  type TickLoopOptions,
  classifyWeaponTemplate,
  createTickLoopState,
  resetTickLoopState,
  runSingleTick,
  runTickLoop,
} from './tick-loop.js';
import {
  DEFAULT_HEAL_POLICY,
  DEFAULT_TARGETING_POLICY,
  type Rotation,
  type WeaponKind,
} from './types.js';

const PLAYER_ID = 0xabcdn;

interface FakeWorld {
  objects: Map<NetworkId, WorldObject>;
}

function makeWorld(objects: Array<Partial<WorldObject> & { id: NetworkId }>): {
  world: WorldModel;
  fake: FakeWorld;
} {
  const map = new Map<NetworkId, WorldObject>();
  for (const o of objects) {
    map.set(o.id, {
      id: o.id,
      typeId: 0,
      typeIdString: '\0\0\0\0',
      position: o.position ?? ({ x: 0, y: 0, z: 0 } as Vector3),
      yaw: 0,
      parentCell: 0n,
      cellPosition: { x: 0, y: 0, z: 0 } as Vector3,
      containerId: 0n,
      slotArrangement: -1,
      hyperspace: false,
      baselines: new Map(),
      firstSeenAt: 0,
      lastUpdatedAt: 0,
      templateName: o.templateName,
    } as WorldObject);
  }
  const fake: FakeWorld = { objects: map };
  const world = {
    get(id: NetworkId): WorldObject | undefined {
      return map.get(id);
    },
    has(id: NetworkId): boolean {
      return map.has(id);
    },
  } as unknown as WorldModel;
  return { world, fake };
}

interface FakeHostState {
  position: Vector3;
  yaw: number;
  health: { current: number; max: number };
  targets: CombatTargetEntry[];
  hitTimerEngaged: boolean;
  lastHit: CombatHitInfo | null;
  cooldowns: Map<string, number>;
  weapon: WeaponKind;
}

interface FakeHostRecord {
  abilityCalls: Array<{ name: string; target: NetworkId | undefined; params: string | undefined }>;
  sentMessages: GameNetworkMessage[];
  syncStamps: number[];
  sequenceNumbers: number[];
}

function makeHost(
  stateOverrides: Partial<FakeHostState> = {},
  worldObjs: Array<Partial<WorldObject> & { id: NetworkId }> = [],
): {
  host: TickLoopHost;
  state: FakeHostState;
  rec: FakeHostRecord;
  classifyWeapon: (h: TickLoopHost) => WeaponKind;
} {
  const state: FakeHostState = {
    position: { x: 0, y: 0, z: 0 },
    yaw: 0,
    health: { current: 1000, max: 1000 },
    targets: [],
    hitTimerEngaged: false,
    lastHit: null,
    cooldowns: new Map(),
    weapon: 'rifle',
    ...stateOverrides,
  };
  const rec: FakeHostRecord = {
    abilityCalls: [],
    sentMessages: [],
    syncStamps: [],
    sequenceNumbers: [],
  };
  const { world } = makeWorld([{ id: PLAYER_ID }, ...worldObjs]);
  let seqCounter = 1;
  let syncCounter = 1_000;

  const host: TickLoopHost = {
    combat: {
      targets: () => state.targets,
      engaged: false,
      autoLoot: false,
      timeSinceLastHitMs: null,
      attackingNearest: () => Promise.resolve(),
      damagedSet: () => new Set<bigint>(),
    } as CombatView,
    hitTimer: {
      get engaged(): boolean {
        return state.hitTimerEngaged;
      },
      get timeSinceLastHitMs(): number {
        return state.lastHit === null ? Number.POSITIVE_INFINITY : 0;
      },
      lastHit: () => state.lastHit,
    } as CombatTimerView,
    cooldowns: {
      msUntil: (name: string): number => state.cooldowns.get(name) ?? 0,
      isReady: (name: string): boolean => (state.cooldowns.get(name) ?? 0) === 0,
      all: () => new Map(),
      rawExpiries: () => new Map(),
    } as CooldownView,
    character: {
      get health(): { current: number; max: number } {
        return state.health;
      },
    } as unknown as CharacterSheet,
    world,
    sceneStart: { playerNetworkId: PLAYER_ID },
    position: () => state.position,
    yaw: () => state.yaw,
    useAbility(commandName: string, targetId?: NetworkId, params?: string): number {
      rec.abilityCalls.push({ name: commandName, target: targetId, params });
      return 1;
    },
    send(msg: GameNetworkMessage): void {
      rec.sentMessages.push(msg);
    },
    nextSyncStamp: (): number => {
      const v = syncCounter++;
      rec.syncStamps.push(v);
      return v;
    },
    nextSequenceNumber: (): number => {
      const v = seqCounter++;
      rec.sequenceNumbers.push(v);
      return v;
    },
    setPose: (position: Vector3, yaw: number) => {
      state.position = position;
      state.yaw = yaw;
    },
  };

  const classifyWeapon = (_h: TickLoopHost): WeaponKind => state.weapon;
  return { host, state, rec, classifyWeapon };
}

const baseRotation: Rotation = {
  profession: 'bounty_hunter',
  opener: [{ id: 'open', ability: 'bh_dread_strike_5', fallbackCooldownMs: 30_000 }],
  combo: [{ id: 'combo-1', ability: 'bh_dm_8', fallbackCooldownMs: 3_000 }],
  filler: { id: 'filler', ability: 'attack', fallbackCooldownMs: 1_500 },
  panic: {
    heal: { id: 'heal', ability: 'bh_sh_3', fallbackCooldownMs: 25_000, target: 'self' },
  },
  signatureAbilities: ['attack'],
};

const opts: Pick<TickLoopOptions, 'rotation' | 'heal' | 'kite' | 'targeting'> = {
  rotation: baseRotation,
  heal: DEFAULT_HEAL_POLICY,
  kite: { kind: 'ranged', min: 18, max: 28, stepM: 6 },
  targeting: DEFAULT_TARGETING_POLICY,
};

describe('runSingleTick', () => {
  it('fires opener on first tick when engaged with a target', () => {
    const { host, state, rec, classifyWeapon } = makeHost(
      { targets: [{ id: 7n, distance: 20, ham: null }] },
      [
        {
          id: 7n,
          position: { x: 20, y: 0, z: 0 } as Vector3,
          templateName: 'object/mobile/imperial_trooper.iff',
        },
      ],
    );
    void state;
    const tickState = createTickLoopState();
    runSingleTick(
      host,
      tickState,
      opts,
      1_000,
      classifyWeapon,
      () => 'ranged',
      () => {},
    );
    expect(rec.abilityCalls).toHaveLength(1);
    expect(rec.abilityCalls[0]?.name).toBe('bh_dread_strike_5');
    expect(rec.abilityCalls[0]?.target).toBe(7n);
  });

  it('fires heal when HP below hard floor (preempts rotation)', () => {
    const { host, rec, classifyWeapon } = makeHost(
      {
        targets: [{ id: 7n, distance: 20, ham: null }],
        health: { current: 200, max: 1000 },
      },
      [{ id: 7n, position: { x: 20, y: 0, z: 0 } as Vector3 }],
    );
    const tickState = createTickLoopState();
    runSingleTick(
      host,
      tickState,
      opts,
      1_000,
      classifyWeapon,
      () => 'ranged',
      () => {},
    );
    expect(rec.abilityCalls).toHaveLength(1);
    expect(rec.abilityCalls[0]?.name).toBe('bh_sh_3');
    // Heal targets self → NetworkId 0n.
    expect(rec.abilityCalls[0]?.target).toBe(0n);
    expect(tickState.heal.lastHealAtMs).toBe(1_000);
  });

  it('respects local refire lock for heal across ticks', () => {
    const { host, rec, classifyWeapon } = makeHost(
      {
        targets: [{ id: 7n, distance: 20, ham: null }],
        health: { current: 200, max: 1000 },
      },
      [{ id: 7n, position: { x: 20, y: 0, z: 0 } as Vector3 }],
    );
    const tickState = createTickLoopState();
    runSingleTick(
      host,
      tickState,
      opts,
      1_000,
      classifyWeapon,
      () => 'ranged',
      () => {},
    );
    runSingleTick(
      host,
      tickState,
      opts,
      1_500,
      classifyWeapon,
      () => 'ranged',
      () => {},
    );
    // First tick heal; second tick rotation (refire lock blocks second heal).
    expect(rec.abilityCalls).toHaveLength(2);
    expect(rec.abilityCalls[0]?.name).toBe('bh_sh_3');
    expect(rec.abilityCalls[1]?.name).toBe('bh_dread_strike_5'); // opener
  });

  it('emits a movement transform when kite triggers (melee attacker inside min)', () => {
    const { host, rec, classifyWeapon } = makeHost(
      {
        position: { x: 100, y: 0, z: 100 },
        targets: [{ id: 7n, distance: 5, ham: null }],
      },
      [
        {
          id: 7n,
          position: { x: 105, y: 0, z: 100 } as Vector3,
          templateName: 'object/mobile/rancor.iff',
        },
      ],
    );
    const tickState = createTickLoopState();
    runSingleTick(
      host,
      tickState,
      opts,
      1_000,
      classifyWeapon,
      () => 'melee',
      () => {},
    );
    expect(rec.sentMessages).toHaveLength(1);
    expect(rec.sentMessages[0]).toBeInstanceOf(ObjControllerMessage);
    // Player position should have stepped to (94, 100).
    expect(host.position().x).toBeCloseTo(94, 5);
    // AND an ability should still have been fired (rotation runs after kite).
    expect(rec.abilityCalls).toHaveLength(1);
  });

  it('opener fires once per engagement; second tick moves to combo', () => {
    const { host, rec, classifyWeapon } = makeHost(
      { targets: [{ id: 7n, distance: 20, ham: null }] },
      [{ id: 7n, position: { x: 20, y: 0, z: 0 } as Vector3 }],
    );
    const tickState = createTickLoopState();
    runSingleTick(
      host,
      tickState,
      opts,
      1_000,
      classifyWeapon,
      () => 'ranged',
      () => {},
    );
    runSingleTick(
      host,
      tickState,
      opts,
      1_100,
      classifyWeapon,
      () => 'ranged',
      () => {},
    );
    expect(rec.abilityCalls.map((c) => c.name)).toEqual(['bh_dread_strike_5', 'bh_dm_8']);
  });

  it('folds incoming hit damage into the heal evaluator DPS window', () => {
    const lastHit: CombatHitInfo = {
      receivedAtMs: 900,
      attackerId: 7n,
      damageAmount: 150,
      defense: 0,
    };
    const { host, classifyWeapon, state } = makeHost(
      {
        targets: [{ id: 7n, distance: 20, ham: null }],
        hitTimerEngaged: true,
        lastHit,
      },
      [{ id: 7n, position: { x: 20, y: 0, z: 0 } as Vector3 }],
    );
    void state;
    const tickState = createTickLoopState();
    runSingleTick(
      host,
      tickState,
      opts,
      1_000,
      classifyWeapon,
      () => 'ranged',
      () => {},
    );
    expect(tickState.heal.dpsWindow).toHaveLength(1);
    expect(tickState.heal.dpsWindow[0]?.damage).toBe(150);
    expect(tickState.lastFoldedHitAtMs).toBe(900);
  });

  it('does not double-fold the same hit on consecutive ticks', () => {
    const lastHit: CombatHitInfo = {
      receivedAtMs: 900,
      attackerId: 7n,
      damageAmount: 150,
      defense: 0,
    };
    const { host, classifyWeapon } = makeHost(
      {
        targets: [{ id: 7n, distance: 20, ham: null }],
        hitTimerEngaged: true,
        lastHit,
      },
      [{ id: 7n, position: { x: 20, y: 0, z: 0 } as Vector3 }],
    );
    const tickState = createTickLoopState();
    runSingleTick(
      host,
      tickState,
      opts,
      1_000,
      classifyWeapon,
      () => 'ranged',
      () => {},
    );
    runSingleTick(
      host,
      tickState,
      opts,
      1_100,
      classifyWeapon,
      () => 'ranged',
      () => {},
    );
    expect(tickState.heal.dpsWindow).toHaveLength(1);
  });

  it('skips weapon-conditional combo slot when weapon mismatches', () => {
    const rotation: Rotation = {
      ...baseRotation,
      opener: [],
      combo: [
        {
          id: 'combo-hw',
          ability: 'co_hw_dm_6',
          fallbackCooldownMs: 3_000,
          when: (s) => s.weapon === 'heavy_directional',
        },
        { id: 'combo-fallback', ability: 'co_dm_8', fallbackCooldownMs: 3_000 },
      ],
    };
    const { host, rec, classifyWeapon } = makeHost(
      { targets: [{ id: 7n, distance: 20, ham: null }], weapon: 'rifle' },
      [{ id: 7n, position: { x: 20, y: 0, z: 0 } as Vector3 }],
    );
    const tickState = createTickLoopState();
    runSingleTick(
      host,
      tickState,
      { ...opts, rotation },
      1_000,
      classifyWeapon,
      () => 'ranged',
      () => {},
    );
    expect(rec.abilityCalls[0]?.name).toBe('co_dm_8');
  });

  it('does nothing when no targets and no engagement', () => {
    const { host, rec, classifyWeapon } = makeHost();
    const tickState = createTickLoopState();
    runSingleTick(
      host,
      tickState,
      opts,
      1_000,
      classifyWeapon,
      () => 'ranged',
      () => {},
    );
    expect(rec.abilityCalls).toHaveLength(0);
    expect(rec.sentMessages).toHaveLength(0);
  });
});

describe('runTickLoop', () => {
  it('exits cleanly when signal aborts after one tick', async () => {
    const { host, rec, classifyWeapon } = makeHost();
    const controller = new AbortController();
    const tickState = createTickLoopState();
    const loop = runTickLoop(host, tickState, {
      rotation: baseRotation,
      heal: DEFAULT_HEAL_POLICY,
      kite: { kind: 'ranged', min: 18, max: 28, stepM: 6 },
      targeting: DEFAULT_TARGETING_POLICY,
      tickMs: 10,
      signal: controller.signal,
      classifyWeapon,
    });
    // Abort almost immediately.
    setTimeout(() => controller.abort(), 35);
    const ticks = await loop;
    expect(ticks).toBeGreaterThanOrEqual(1);
    // No fires expected (no targets).
    expect(rec.abilityCalls).toHaveLength(0);
  });

  it('swallows per-tick errors (does not crash the loop)', async () => {
    const { host, rec, classifyWeapon } = makeHost();
    const original = host.combat.targets;
    let firstCall = true;
    host.combat.targets = () => {
      if (firstCall) {
        firstCall = false;
        throw new Error('boom');
      }
      return original.call(host.combat);
    };
    const controller = new AbortController();
    const tickState = createTickLoopState();
    const loop = runTickLoop(host, tickState, {
      rotation: baseRotation,
      heal: DEFAULT_HEAL_POLICY,
      kite: { kind: 'ranged', min: 18, max: 28, stepM: 6 },
      targeting: DEFAULT_TARGETING_POLICY,
      tickMs: 10,
      signal: controller.signal,
      classifyWeapon,
    });
    setTimeout(() => controller.abort(), 40);
    await expect(loop).resolves.toBeGreaterThanOrEqual(2);
    void rec;
  });
});

describe('classifyWeaponTemplate', () => {
  const cases: Array<[string | undefined, string]> = [
    ['object/weapon/melee/sword/shared_sword.iff', 'melee'],
    ['object/weapon/melee/2h_sword/shared_two_hand_sword.iff', 'melee'],
    ['object/weapon/melee/jedi/shared_lightsaber.iff', 'saber'],
    ['object/weapon/jedi/shared_one_hand_lightsaber.iff', 'saber'],
    ['object/weapon/ranged/pistol/shared_pistol_de_10.iff', 'pistol'],
    ['object/weapon/ranged/carbine/shared_carbine_e11_mk2.iff', 'carbine'],
    ['object/weapon/ranged/rifle/shared_rifle_t21.iff', 'rifle'],
    ['object/weapon/heavy/shared_flame_thrower.iff', 'heavy_directional'],
    ['object/weapon/heavy/shared_acid_rifle.iff', 'heavy_directional'],
    ['object/weapon/heavy/shared_lightning_rifle.iff', 'heavy_directional'],
    [undefined, 'unknown'],
    ['', 'unknown'],
    ['object/tangible/some_random_thing.iff', 'unknown'],
  ];
  for (const [template, expected] of cases) {
    it(`classifies ${template ?? '<undefined>'} as ${expected}`, () => {
      expect(classifyWeaponTemplate(template)).toBe(expected);
    });
  }
});

describe('resetTickLoopState', () => {
  it('clears all engagement-scoped state', () => {
    const state = createTickLoopState();
    state.heal.dpsWindow.push({ atMs: 0, damage: 100 });
    state.heal.lastHealAtMs = 1_000;
    state.rotation.firedOpeners.add('open');
    state.targeting.currentId = 5n;
    state.lastFoldedHitAtMs = 500;
    resetTickLoopState(state);
    expect(state.heal.dpsWindow).toHaveLength(0);
    expect(state.heal.lastHealAtMs).toBe(Number.NEGATIVE_INFINITY);
    expect(state.rotation.firedOpeners.size).toBe(0);
    expect(state.targeting.currentId).toBeNull();
    expect(state.lastFoldedHitAtMs).toBe(0);
  });
});
