/**
 * Unit tests for the snapshot/diff helpers. Builds synthetic
 * LifecycleResults with a handful of decoded baselines + a SceneStart and
 * asserts the projection plus the hash-equality and diff semantics.
 *
 * The synthetic LifecycleResult is deliberately minimal — we only fill the
 * fields the snapshot function reads (`character.name`, `sceneStart`,
 * `transcript`). The other LifecycleResult fields can be left zeroed.
 */

import { describe, expect, it } from 'vitest';

import type { Transform } from '../archive/transform.js';
import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import {
  BaselinePackageIds,
  type CreatureObjectClientServerBaseline,
  CreatureObjectClientServerKind,
  type CreatureObjectSharedBaseline,
  CreatureObjectSharedKind,
  EMPTY_STRING_ID,
  ObjectTypeTags,
  type PlayerObjectClientServerBaseline,
  PlayerObjectClientServerKind,
  type PlayerObjectSharedBaseline,
  PlayerObjectSharedKind,
  type TangibleObjectSharedBaseline,
  TangibleObjectSharedKind,
} from '../messages/game/baselines/index.js';
import { SceneCreateObjectByCrc } from '../messages/game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import { UpdateContainmentMessage } from '../messages/game/update-containment-message.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import type { CharacterInfo, ClusterInfo, SceneStart } from '../types.js';
import type { TranscriptEvent } from './dispatcher.js';
import { diffSnapshots, snapshot } from './snapshot.js';
import type { LifecycleResult } from './swg-client.js';

// ── helpers ────────────────────────────────────────────────────────────────

const IDENT_TRANSFORM: Transform = {
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  position: { x: 0, y: 0, z: 0 },
};

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

function makePlayerAuth(): PlayerObjectClientServerBaseline {
  return { bankBalance: 1000, cashBalance: 500 };
}

function makeCreatureAuth(): CreatureObjectClientServerBaseline {
  return {
    bankBalance: 250,
    cashBalance: 25,
    maxAttributes: [100, 100, 100, 100, 100, 100],
    skills: [],
  };
}

function makeTangibleShared(
  partial: Partial<TangibleObjectSharedBaseline> = {},
): TangibleObjectSharedBaseline {
  return {
    complexity: 1,
    nameStringId: EMPTY_STRING_ID,
    objectName: '',
    volume: 1,
    pvpFaction: 0,
    pvpType: 0,
    appearanceData: '',
    components: [],
    condition: 0,
    count: 1,
    damageTaken: 0,
    maxHitPoints: 100,
    visible: true,
    ...partial,
  };
}

interface SyntheticOptions {
  playerId?: bigint;
  characterName?: string;
  sceneStart?: Partial<SceneStart>;
  /** Extra transcript events to append (in addition to the implicit baselines below). */
  extraEvents?: TranscriptEvent[];
  /** If non-null, push a CREO p3 baseline for the player. */
  creatureShared?: CreatureObjectSharedBaseline | null;
  /** If non-null, push a CREO p1 baseline for the player. */
  creatureAuth?: CreatureObjectClientServerBaseline | null;
  /** If non-null, push a PLAY p3 baseline. */
  playerShared?: PlayerObjectSharedBaseline | null;
  /** If non-null, push a PLAY p1 baseline. */
  playerAuth?: PlayerObjectClientServerBaseline | null;
}

/**
 * Build a minimum-viable `LifecycleResult` with the requested baselines +
 * scene start. All the non-snapshot fields are filled with sensible defaults
 * so the type checks but the snapshot function only cares about three of
 * them (character.name, sceneStart, transcript).
 */
function buildResult(opts: SyntheticOptions = {}): LifecycleResult {
  const playerId = opts.playerId ?? 0x1234n;
  const characterName = opts.characterName ?? 'TestHero';

  const transcript: TranscriptEvent[] = [];
  if (opts.creatureShared !== undefined && opts.creatureShared !== null) {
    transcript.push(
      recv(
        new BaselinesMessage(
          playerId,
          ObjectTypeTags.CREO,
          BaselinePackageIds.SHARED,
          new Uint8Array(0),
          { kind: CreatureObjectSharedKind, data: opts.creatureShared },
        ),
        'BaselinesMessage',
      ),
    );
  }
  if (opts.creatureAuth !== undefined && opts.creatureAuth !== null) {
    transcript.push(
      recv(
        new BaselinesMessage(
          playerId,
          ObjectTypeTags.CREO,
          BaselinePackageIds.CLIENT_SERVER,
          new Uint8Array(0),
          { kind: CreatureObjectClientServerKind, data: opts.creatureAuth },
        ),
        'BaselinesMessage',
      ),
    );
  }
  if (opts.playerShared !== undefined && opts.playerShared !== null) {
    transcript.push(
      recv(
        new BaselinesMessage(
          // PlayerObject has its own NetworkId (it's the IntangibleObject child).
          // Different from the CREO; the snapshot's PLAY-p3 search doesn't
          // need to match the playerId.
          playerId + 1n,
          ObjectTypeTags.PLAY,
          BaselinePackageIds.SHARED,
          new Uint8Array(0),
          { kind: PlayerObjectSharedKind, data: opts.playerShared },
        ),
        'BaselinesMessage',
      ),
    );
  }
  if (opts.playerAuth !== undefined && opts.playerAuth !== null) {
    transcript.push(
      recv(
        new BaselinesMessage(
          playerId + 1n,
          ObjectTypeTags.PLAY,
          BaselinePackageIds.CLIENT_SERVER,
          new Uint8Array(0),
          { kind: PlayerObjectClientServerKind, data: opts.playerAuth },
        ),
        'BaselinesMessage',
      ),
    );
  }
  if (opts.extraEvents !== undefined) transcript.push(...opts.extraEvents);

  const cluster: ClusterInfo = {
    id: 1,
    name: 'swg',
    timeZone: 0,
  };
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
    startPosition: { x: 100, y: 0, z: 200 },
    startYaw: 1.57,
    templateName: 'object/creature/player/shared_human_male.iff',
    serverTimeSeconds: 0n,
    serverEpoch: 0,
    disableWorldSnapshot: false,
    ...opts.sceneStart,
  };

  return {
    stages: { login: 0, connection: 0, game: 0, logout: 0 },
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
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('snapshot()', () => {
  it('extracts CREO p3 fields (posture, scale, states, objectName)', () => {
    const result = buildResult({
      creatureShared: makeCreatureShared({
        posture: 1, // crouched
        scaleFactor: 1.05,
        states: 0x100n,
        objectName: 'Hero of Mos Eisley',
      }),
    });
    const snap = snapshot(result);
    expect(snap.posture).toBe(1);
    expect(snap.scaleFactor).toBeCloseTo(1.05);
    expect(snap.states).toBe(0x100n);
    expect(snap.objectName).toBe('Hero of Mos Eisley');
    expect(snap.characterName).toBe('TestHero');
    expect(snap.playerNetworkId).toBe(0x1234n);
    expect(snap.sceneName).toBe('tatooine');
    expect(snap.spawnPosition).toEqual({ x: 100, y: 0, z: 200 });
    expect(snap.spawnYaw).toBeCloseTo(1.57);
  });

  it('defaults optional fields to null when their baselines did not flow', () => {
    const result = buildResult({}); // no baselines at all
    const snap = snapshot(result);
    expect(snap.posture).toBeNull();
    expect(snap.scaleFactor).toBeNull();
    expect(snap.states).toBeNull();
    expect(snap.objectName).toBeNull();
    expect(snap.bankBalance).toBeNull();
    expect(snap.cashBalance).toBeNull();
    expect(snap.skillTitle).toBeNull();
    expect(snap.playedTime).toBeNull();
    expect(snap.inventory).toEqual([]);
    // Required fields are still present.
    expect(snap.characterName).toBe('TestHero');
    expect(snap.playerNetworkId).toBe(0x1234n);
  });

  it('extracts bank/cash from PLAY p1 when present', () => {
    const result = buildResult({ playerAuth: makePlayerAuth() });
    const snap = snapshot(result);
    expect(snap.bankBalance).toBe(1000);
    expect(snap.cashBalance).toBe(500);
  });

  it('falls back to CREO p1 bank/cash when PLAY p1 absent', () => {
    const result = buildResult({ creatureAuth: makeCreatureAuth() });
    const snap = snapshot(result);
    expect(snap.bankBalance).toBe(250);
    expect(snap.cashBalance).toBe(25);
  });

  it('prefers PLAY p1 over CREO p1 when both are present', () => {
    const result = buildResult({ playerAuth: makePlayerAuth(), creatureAuth: makeCreatureAuth() });
    const snap = snapshot(result);
    expect(snap.bankBalance).toBe(1000); // PLAY p1
  });

  it('extracts skillTitle and playedTime from PLAY p3', () => {
    const result = buildResult({
      playerShared: makePlayerShared({ skillTitle: 'master_marksman', playedTime: 86_400 }),
    });
    const snap = snapshot(result);
    expect(snap.skillTitle).toBe('master_marksman');
    expect(snap.playedTime).toBe(86_400);
  });

  it('treats empty objectName as null (vs "" — server uses "" for "no override")', () => {
    const result = buildResult({
      creatureShared: makeCreatureShared({ objectName: '' }),
    });
    const snap = snapshot(result);
    expect(snap.objectName).toBeNull();
  });

  it('populates inventory from containerView rooted at the player', () => {
    const playerId = 0xaaaan;
    const itemA: TranscriptEvent[] = [
      recv(
        new SceneCreateObjectByName(
          0x100n,
          IDENT_TRANSFORM,
          'object/tangible/loot/survival_kit.iff',
          false,
        ),
        'SceneCreateObjectByName',
      ),
      recv(
        new BaselinesMessage(
          0x100n,
          ObjectTypeTags.TANO,
          BaselinePackageIds.SHARED,
          new Uint8Array(0),
          {
            kind: TangibleObjectSharedKind,
            data: makeTangibleShared({ objectName: 'Survival Kit' }),
          },
        ),
        'BaselinesMessage',
      ),
      recv(new UpdateContainmentMessage(0x100n, playerId, 0), 'UpdateContainmentMessage'),
    ];
    const itemB: TranscriptEvent[] = [
      recv(
        new SceneCreateObjectByCrc(0x200n, IDENT_TRANSFORM, 0xdeadbeef, false),
        'SceneCreateObjectByCrc',
      ),
      recv(new UpdateContainmentMessage(0x200n, playerId, 1), 'UpdateContainmentMessage'),
    ];
    const result = buildResult({ playerId, extraEvents: [...itemA, ...itemB] });
    const snap = snapshot(result);

    expect(snap.inventory).toHaveLength(2);
    // Sorted by templateCrc asc (null last). The ByCrc item (0xdeadbeef) has a
    // templateCrc, the ByName item has templateCrc=null, so the ByCrc comes first.
    expect(snap.inventory[0]?.templateCrc).toBe(0xdeadbeef);
    expect(snap.inventory[0]?.networkId).toBe('512'); // 0x200n
    expect(snap.inventory[1]?.templateCrc).toBeNull();
    expect(snap.inventory[1]?.networkId).toBe('256'); // 0x100n
    expect(snap.inventory[1]?.templateName).toBe('object/tangible/loot/survival_kit.iff');
    expect(snap.inventory[1]?.name).toBe('Survival Kit');
  });

  it('produces a stable SHA-256 hash that ignores takenAt', async () => {
    const result = buildResult({
      creatureShared: makeCreatureShared({ posture: 2, scaleFactor: 1.5, states: 0xdeadn }),
      playerShared: makePlayerShared({ skillTitle: 'apprentice', playedTime: 60 }),
    });
    const snapA = snapshot(result);
    // Small delay so takenAt differs.
    await new Promise((r) => setTimeout(r, 5));
    const snapB = snapshot(result);
    expect(snapA.hash).toBe(snapB.hash);
    expect(snapA.takenAt.getTime()).not.toBe(snapB.takenAt.getTime());
    // SHA-256 = 64 hex chars.
    expect(snapA.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash changes when any tracked field changes', () => {
    const a = snapshot(buildResult({ creatureShared: makeCreatureShared({ posture: 0 }) }));
    const b = snapshot(buildResult({ creatureShared: makeCreatureShared({ posture: 1 }) }));
    expect(a.hash).not.toBe(b.hash);
  });

  it('hash is invariant under inventory re-ordering (deterministic sort)', () => {
    const playerId = 0xaaaan;
    const buildWithOrder = (firstCrc: number, secondCrc: number): LifecycleResult => {
      const eventsForCrc = (id: bigint, crc: number, parent: bigint): TranscriptEvent[] => [
        recv(new SceneCreateObjectByCrc(id, IDENT_TRANSFORM, crc, false), 'SceneCreateObjectByCrc'),
        recv(new UpdateContainmentMessage(id, parent, -1), 'UpdateContainmentMessage'),
      ];
      return buildResult({
        playerId,
        extraEvents: [
          ...eventsForCrc(BigInt(firstCrc), firstCrc, playerId),
          ...eventsForCrc(BigInt(secondCrc), secondCrc, playerId),
        ],
      });
    };
    const a = snapshot(buildWithOrder(100, 200));
    const b = snapshot(buildWithOrder(200, 100));
    expect(a.hash).toBe(b.hash);
  });
});

describe('diffSnapshots()', () => {
  it('returns identical=true with no differences for two equal snapshots', () => {
    const result = buildResult({
      creatureShared: makeCreatureShared({ posture: 0 }),
      playerAuth: makePlayerAuth(),
      playerShared: makePlayerShared(),
    });
    const a = snapshot(result);
    const b = snapshot(result);
    const diff = diffSnapshots(a, b);
    expect(diff.identical).toBe(true);
    expect(diff.differences).toEqual([]);
  });

  it('reports single-field change with before/after values', () => {
    const a = snapshot(
      buildResult({ playerShared: makePlayerShared({ skillTitle: 'apprentice' }) }),
    );
    const b = snapshot(buildResult({ playerShared: makePlayerShared({ skillTitle: 'master' }) }));
    const diff = diffSnapshots(a, b);
    expect(diff.identical).toBe(false);
    const skillDiff = diff.differences.find((d) => d.field === 'skillTitle');
    expect(skillDiff?.before).toBe('apprentice');
    expect(skillDiff?.after).toBe('master');
  });

  it('reports playerNetworkId difference as stringified bigints', () => {
    const a = snapshot(buildResult({ playerId: 100n }));
    const b = snapshot(buildResult({ playerId: 200n }));
    const diff = diffSnapshots(a, b);
    const idDiff = diff.differences.find((d) => d.field === 'playerNetworkId');
    expect(idDiff?.before).toBe('100');
    expect(idDiff?.after).toBe('200');
  });

  it('reports a states bitmap difference as stringified bigints', () => {
    const a = snapshot(buildResult({ creatureShared: makeCreatureShared({ states: 0xaan }) }));
    const b = snapshot(buildResult({ creatureShared: makeCreatureShared({ states: 0xbbn }) }));
    const diff = diffSnapshots(a, b);
    const statesDiff = diff.differences.find((d) => d.field === 'states');
    expect(statesDiff?.before).toBe('170');
    expect(statesDiff?.after).toBe('187');
  });

  it('reports an inventory change when an item is added/removed/altered', () => {
    const playerId = 0xaaaan;
    const ev = (id: bigint, crc: number): TranscriptEvent[] => [
      recv(new SceneCreateObjectByCrc(id, IDENT_TRANSFORM, crc, false), 'SceneCreateObjectByCrc'),
      recv(new UpdateContainmentMessage(id, playerId, -1), 'UpdateContainmentMessage'),
    ];
    const a = snapshot(buildResult({ playerId, extraEvents: ev(0x10n, 100) }));
    const b = snapshot(
      buildResult({ playerId, extraEvents: [...ev(0x10n, 100), ...ev(0x11n, 200)] }),
    );
    const diff = diffSnapshots(a, b);
    expect(diff.identical).toBe(false);
    const invDiff = diff.differences.find((d) => d.field === 'inventory');
    expect(invDiff).toBeDefined();
  });

  it('reports a spawnPosition shift', () => {
    const a = snapshot(buildResult({ sceneStart: { startPosition: { x: 100, y: 0, z: 200 } } }));
    const b = snapshot(buildResult({ sceneStart: { startPosition: { x: 101, y: 0, z: 200 } } }));
    const diff = diffSnapshots(a, b);
    expect(diff.differences.find((d) => d.field === 'spawnPosition')).toBeDefined();
  });

  it('does NOT report differences for hash or takenAt (metadata)', () => {
    const result = buildResult({ creatureShared: makeCreatureShared() });
    const a = snapshot(result);
    // Force a different takenAt; hash should match anyway since fields are equal.
    const b: ReturnType<typeof snapshot> = { ...a, takenAt: new Date(0) };
    const diff = diffSnapshots(a, b);
    // No diff entries for hash or takenAt — even though takenAt differs.
    expect(diff.differences.find((d) => d.field === 'hash')).toBeUndefined();
    expect(diff.differences.find((d) => d.field === 'takenAt')).toBeUndefined();
  });
});
