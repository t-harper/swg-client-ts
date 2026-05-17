/**
 * Unit tests for the reconnect-verification harness.
 *
 * The harness wraps `SwgClient.fullLifecycle` + `snapshot()` + `diffSnapshots()`.
 * We don't need real wire I/O — we inject a mock client factory that returns
 * two crafted `LifecycleResult`s, then verify the snapshot/diff/filter
 * pipeline reports what we expect.
 *
 * Fixture-builder shapes mirror `snapshot.test.ts` so a future reader can
 * cross-reference both files.
 */

import { describe, expect, it } from 'vitest';

import type { Transform } from '../archive/transform.js';
import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import {
  BaselinePackageIds,
  type CreatureObjectSharedBaseline,
  CreatureObjectSharedKind,
  EMPTY_STRING_ID,
  ObjectTypeTags,
  type PlayerObjectSharedBaseline,
  PlayerObjectSharedKind,
} from '../messages/game/baselines/index.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import type { CharacterInfo, ClusterInfo, SceneStart, ServerEndpoint } from '../types.js';
import type { TranscriptEvent } from './dispatcher.js';
import { reconnectVerify } from './reconnect-harness.js';
import type { FullLifecycleOptions, LifecycleResult, SwgClient } from './swg-client.js';

const IDENT_TRANSFORM: Transform = {
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  position: { x: 0, y: 0, z: 0 },
};
// Used only for documentation completeness — the harness fixtures below
// don't currently exercise transform-bearing transcript events, but the
// constant keeps the shape parallel to snapshot.test.ts so a reader who
// jumps between them sees the same baseline tooling.
void IDENT_TRANSFORM;

function recv(decoded: GameNetworkMessage, name: string): TranscriptEvent {
  return { direction: 'recv', messageName: name, typeCrc: 0, bytes: 0, at: 0, decoded };
}

function makeCreatureShared(
  partial: Partial<CreatureObjectSharedBaseline> = {},
): CreatureObjectSharedBaseline {
  return {
    complexity: 1,
    nameStringId: EMPTY_STRING_ID,
    objectName: 'Hero',
    volume: 1,
    pvpFaction: 0,
    pvpType: 0,
    appearanceData: '',
    components: [],
    condition: 0,
    count: 0,
    damageTaken: 0,
    maxHitPoints: 1000,
    visible: true,
    posture: 0,
    rank: 0,
    masterId: 0n,
    scaleFactor: 1.0,
    shockWounds: 0,
    states: 0n,
    ...partial,
  };
}

function makePlayerShared(
  partial: Partial<PlayerObjectSharedBaseline> = {},
): PlayerObjectSharedBaseline {
  return {
    complexity: 1,
    nameStringId: EMPTY_STRING_ID,
    objectName: '',
    volume: 1,
    count: 0,
    matchMakingCharacterProfileId: { ints: [0, 0, 0, 0] },
    matchMakingPersonalProfileId: { ints: [0, 0, 0, 0] },
    skillTitle: 'novice_brawler',
    bornDate: 1500,
    playedTime: 3600,
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
    ...partial,
  };
}

interface FixtureOpts {
  playerId?: bigint;
  characterName?: string;
  creature?: CreatureObjectSharedBaseline;
  player?: PlayerObjectSharedBaseline;
  spawnPosition?: { x: number; y: number; z: number };
}

function buildLifecycle(opts: FixtureOpts = {}): LifecycleResult {
  const playerId = opts.playerId ?? 0x4242n;
  const characterName = opts.characterName ?? 'Persister';
  const transcript: TranscriptEvent[] = [];

  if (opts.creature !== undefined) {
    transcript.push(
      recv(
        new BaselinesMessage(
          playerId,
          ObjectTypeTags.CREO,
          BaselinePackageIds.SHARED,
          new Uint8Array(0),
          { kind: CreatureObjectSharedKind, data: opts.creature },
        ),
        'BaselinesMessage',
      ),
    );
  }
  if (opts.player !== undefined) {
    transcript.push(
      recv(
        new BaselinesMessage(
          playerId + 1n,
          ObjectTypeTags.PLAY,
          BaselinePackageIds.SHARED,
          new Uint8Array(0),
          { kind: PlayerObjectSharedKind, data: opts.player },
        ),
        'BaselinesMessage',
      ),
    );
  }

  const cluster: ClusterInfo = { id: 1, name: 'swg', timeZone: 0 };
  const character: CharacterInfo = {
    networkId: playerId,
    name: characterName,
    objectTemplateId: 0,
    clusterId: 1,
    characterType: 1,
  };
  const sceneStart: SceneStart = {
    playerNetworkId: playerId,
    sceneName: 'tatooine',
    startPosition: opts.spawnPosition ?? { x: 100, y: 0, z: 200 },
    startYaw: 1.57,
    templateName: 'object/creature/player/shared_human_male.iff',
    serverTimeSeconds: 0n,
    serverEpoch: 0,
    disableWorldSnapshot: false,
  };
  return {
    stages: { login: 1, connection: 1, game: 1, logout: 1 },
    clusters: [cluster],
    chosenCluster: cluster,
    character,
    characterWasCreated: false,
    sceneStart,
    baselineObjectCount: 0,
    zonedInAt: new Date(),
    logoutAt: new Date(),
    transcript,
    stationId: 0,
    receivedErrorMessage: false,
    latency: null,
  };
}

/**
 * Build a mock `clientFactory` that returns the two supplied LifecycleResults
 * in order — first call → `first`, second call → `second`. Records the
 * options each `fullLifecycle` saw so tests can assert script wiring.
 */
function makeFactory(
  first: LifecycleResult,
  second: LifecycleResult,
): {
  factory: (endpoint: ServerEndpoint) => Pick<SwgClient, 'fullLifecycle'>;
  calls: FullLifecycleOptions[];
} {
  const calls: FullLifecycleOptions[] = [];
  const queue = [first, second];
  const factory = (_endpoint: ServerEndpoint): Pick<SwgClient, 'fullLifecycle'> => {
    return {
      fullLifecycle: async (lopts: FullLifecycleOptions): Promise<LifecycleResult> => {
        calls.push(lopts);
        const next = queue.shift();
        if (next === undefined) throw new Error('mock fullLifecycle queue exhausted');
        return next;
      },
    };
  };
  return { factory, calls };
}

describe('reconnectVerify()', () => {
  const loginServer: ServerEndpoint = { host: '127.0.0.1', port: 44_453 };

  it('happy path: identical snapshots → succeeded=true with empty unexpectedDrift', async () => {
    const fx = buildLifecycle({
      creature: makeCreatureShared({ posture: 0 }),
      player: makePlayerShared({ skillTitle: 'novice_brawler', playedTime: 3600 }),
    });
    const { factory } = makeFactory(fx, fx);
    const result = await reconnectVerify({
      loginServer,
      account: 'acct',
      characterName: 'Persister',
      mutate: async () => undefined,
      postSettleMs: 0,
      clientFactory: factory,
    });
    expect(result.succeeded).toBe(true);
    expect(result.diff.identical).toBe(true);
    expect(result.diff.differences).toEqual([]);
    expect(result.unexpectedDrift.identical).toBe(true);
    expect(result.unexpectedDrift.differences).toEqual([]);
    expect(result.firstSnapshot.hash).toBe(result.secondSnapshot.hash);
    expect(result.timings.total).toBeGreaterThanOrEqual(0);
  });

  it('expected drift only (playedTime) → succeeded=true with raw diff non-empty', async () => {
    const first = buildLifecycle({
      player: makePlayerShared({ skillTitle: 'novice_brawler', playedTime: 1000 }),
    });
    const second = buildLifecycle({
      player: makePlayerShared({ skillTitle: 'novice_brawler', playedTime: 1060 }),
    });
    const { factory } = makeFactory(first, second);
    const result = await reconnectVerify({
      loginServer,
      account: 'acct',
      characterName: 'Persister',
      mutate: async () => undefined,
      postSettleMs: 0,
      clientFactory: factory,
    });
    // Raw diff sees the playedTime change.
    expect(result.diff.identical).toBe(false);
    expect(result.diff.differences.find((d) => d.field === 'playedTime')).toBeDefined();
    // But it's in the default expectedDrift list, so unexpectedDrift is empty.
    expect(result.unexpectedDrift.identical).toBe(true);
    expect(result.unexpectedDrift.differences).toEqual([]);
    expect(result.succeeded).toBe(true);
  });

  it('custom expectedDrift (regex) consumes additional fields', async () => {
    const first = buildLifecycle({
      creature: makeCreatureShared({ scaleFactor: 1.0 }),
      player: makePlayerShared({ playedTime: 100 }),
    });
    const second = buildLifecycle({
      creature: makeCreatureShared({ scaleFactor: 1.05 }),
      player: makePlayerShared({ playedTime: 160 }),
    });
    const { factory } = makeFactory(first, second);
    const result = await reconnectVerify({
      loginServer,
      account: 'acct',
      characterName: 'Persister',
      mutate: async () => undefined,
      postSettleMs: 0,
      clientFactory: factory,
      // `scaleFactor` is now also tolerated alongside the default `playedTime`.
      expectedDrift: [/^scaleFactor$/],
    });
    expect(result.diff.identical).toBe(false);
    expect(result.diff.differences.length).toBeGreaterThanOrEqual(2);
    expect(result.unexpectedDrift.identical).toBe(true);
    expect(result.succeeded).toBe(true);
  });

  it('unexpected drift: succeeded=false and the offending field is reported', async () => {
    const first = buildLifecycle({
      player: makePlayerShared({ skillTitle: 'novice_brawler', playedTime: 100 }),
    });
    const second = buildLifecycle({
      // skillTitle CHANGED — a real persistence regression would look like this.
      player: makePlayerShared({ skillTitle: 'master_marksman', playedTime: 100 }),
    });
    const { factory } = makeFactory(first, second);
    const result = await reconnectVerify({
      loginServer,
      account: 'acct',
      characterName: 'Persister',
      mutate: async () => undefined,
      postSettleMs: 0,
      clientFactory: factory,
    });
    expect(result.succeeded).toBe(false);
    expect(result.unexpectedDrift.identical).toBe(false);
    const skill = result.unexpectedDrift.differences.find((d) => d.field === 'skillTitle');
    expect(skill?.before).toBe('novice_brawler');
    expect(skill?.after).toBe('master_marksman');
  });

  it('wires mutate + observe scenarios into the two lifecycles in order', async () => {
    const fx = buildLifecycle();
    const { factory, calls } = makeFactory(fx, fx);
    const mutate = async (): Promise<void> => undefined;
    const observe = async (): Promise<void> => undefined;
    await reconnectVerify({
      loginServer,
      account: 'acct',
      characterName: 'Persister',
      mutate,
      observe,
      postSettleMs: 0,
      clientFactory: factory,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.script).toBe(mutate);
    expect(calls[1]?.script).toBe(observe);
    expect(calls[0]?.account).toBe('acct');
    expect(calls[1]?.account).toBe('acct');
    expect(calls[0]?.characterName).toBe('Persister');
    expect(calls[1]?.characterName).toBe('Persister');
  });

  it('uses a no-op observe scenario when none supplied', async () => {
    const fx = buildLifecycle();
    const { factory, calls } = makeFactory(fx, fx);
    await reconnectVerify({
      loginServer,
      account: 'acct',
      characterName: 'Persister',
      mutate: async () => undefined,
      postSettleMs: 0,
      clientFactory: factory,
    });
    expect(calls[1]?.script).toBeTypeOf('function');
    // The injected no-op resolves to undefined.
    const observeResult = await calls[1]?.script?.({} as never);
    expect(observeResult).toBeUndefined();
  });

  it('forwards optional password + clusterName to both lifecycles', async () => {
    const fx = buildLifecycle();
    const { factory, calls } = makeFactory(fx, fx);
    await reconnectVerify({
      loginServer,
      account: 'acct',
      password: 'hunter2',
      clusterName: 'swg',
      characterName: 'Persister',
      mutate: async () => undefined,
      postSettleMs: 0,
      clientFactory: factory,
    });
    expect(calls[0]?.password).toBe('hunter2');
    expect(calls[0]?.clusterName).toBe('swg');
    expect(calls[1]?.password).toBe('hunter2');
    expect(calls[1]?.clusterName).toBe('swg');
  });

  it('honors postSettleMs as a real wall-clock pause', async () => {
    const fx = buildLifecycle();
    const { factory } = makeFactory(fx, fx);
    const t0 = Date.now();
    await reconnectVerify({
      loginServer,
      account: 'acct',
      characterName: 'Persister',
      mutate: async () => undefined,
      postSettleMs: 60,
      clientFactory: factory,
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});
