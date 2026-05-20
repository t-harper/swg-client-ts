/**
 * CharacterSheet unit tests.
 *
 * Drives the live view through the same fake dispatcher used by the
 * scripting tests. We synthesize `BaselinesMessage` / `DeltasMessage`
 * instances with pre-decoded payloads (the dispatcher mock doesn't run
 * the real decoders, so we hand-build the `decodedBaseline` /
 * `decodedDelta` shapes the production code would produce).
 *
 * Coverage:
 *   - `ready` flips from false → true on the first CREO baseline.
 *   - `health.current` reflects the latest SHARED_NP delta.
 *   - `posture` flips on a SHARED delta.
 *   - `cashBalance` reads from CREO p1 (CLIENT_SERVER) baseline, and
 *     prefers PLAY p1 when present (the snapshot helper's contract).
 *   - `bankBalance` works via the same fallback path.
 *   - `skills` is populated by CREO p1; INSERT deltas append.
 *   - `level`, `mood`, `currentWeapon`, `group`, `groupInviter` populate
 *     from SHARED_NP baseline + delta updates.
 *   - `toJSON()` produces a JSON-safe projection (no bigint leaks).
 *   - `detach()` stops further updates.
 */
import { describe, expect, it } from 'vitest';

import { AttributeListMessage } from '../messages/game/attribute-list-message.js';
import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import type { CreatureObjectClientServerBaseline } from '../messages/game/baselines/creature-object-baseline-1.js';
import { CreatureObjectClientServerKind } from '../messages/game/baselines/creature-object-baseline-1.js';
import type { CreatureObjectSharedBaseline } from '../messages/game/baselines/creature-object-baseline-3.js';
import { CreatureObjectSharedKind } from '../messages/game/baselines/creature-object-baseline-3.js';
import type { CreatureObjectClientServerNpBaseline } from '../messages/game/baselines/creature-object-baseline-4.js';
import { CreatureObjectClientServerNpKind } from '../messages/game/baselines/creature-object-baseline-4.js';
import type { CreatureObjectSharedNpBaseline } from '../messages/game/baselines/creature-object-baseline-6.js';
import { CreatureObjectSharedNpKind } from '../messages/game/baselines/creature-object-baseline-6.js';
import { DeltasMessage } from '../messages/game/baselines/deltas-message.js';
import { EMPTY_STRING_ID, PlayerObjectSharedKind } from '../messages/game/baselines/index.js';
import type { PlayerObjectClientServerBaseline } from '../messages/game/baselines/player-object-baseline-1.js';
import type { PlayerObjectFirstParentClientServerBaseline } from '../messages/game/baselines/player-object-baseline-8.js';
import { PlayerObjectFirstParentClientServerKind } from '../messages/game/baselines/player-object-baseline-8.js';
import { PlayerObjectClientServerKind } from '../messages/game/baselines/player-object-baseline-1.js';
import type { PlayerObjectSharedBaseline } from '../messages/game/baselines/player-object-baseline-3.js';
import type { PlayerObjectSharedNpBaseline } from '../messages/game/baselines/player-object-baseline-6.js';
import { PlayerObjectSharedNpKind } from '../messages/game/baselines/player-object-baseline-6.js';
import { BaselinePackageIds, ObjectTypeTags } from '../messages/game/baselines/registry.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import {
  ObjControllerSubtypeIds,
  PostureChangeKind,
} from '../messages/game/obj-controller/index.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import { type CharacterSheetHandle, createCharacterSheet, postureName } from './character-sheet.js';
import type { MessageDispatcher } from './dispatcher.js';
import { WorldModel } from './world-model.js';

// Side-effect: register all baseline + delta decoders for tag/kind lookup. We
// don't rely on the registry to decode (we hand-build decodedBaseline), but
// having decoders registered ensures the typeCrc lookups on BaselinesMessage
// / DeltasMessage are stable.
import '../messages/game/baselines/index.js';

const PLAYER_ID = 0xabcdn;

/**
 * Minimal fake dispatcher: holds `onMessage` listeners keyed by typeCrc,
 * exposes `recv(msg)` to fire them. Mirrors the world-model.test fake;
 * scoped down because we don't need send/waitFor.
 */
function makeFakeDispatcher(): {
  dispatcher: MessageDispatcher;
  recv: (msg: GameNetworkMessage) => void;
} {
  const listeners = new Map<number, Array<(m: GameNetworkMessage) => void>>();

  const fake = {
    onMessage<T extends GameNetworkMessage>(
      ctor: { typeCrc: number },
      handler: (m: T) => void,
    ): () => void {
      let arr = listeners.get(ctor.typeCrc);
      if (arr === undefined) {
        arr = [];
        listeners.set(ctor.typeCrc, arr);
      }
      arr.push(handler as (m: GameNetworkMessage) => void);
      return () => {
        const list = listeners.get(ctor.typeCrc);
        if (list === undefined) return;
        const idx = list.indexOf(handler as (m: GameNetworkMessage) => void);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    send(): void {},
    waitFor(): Promise<GameNetworkMessage> {
      return new Promise(() => undefined);
    },
    onAny(): () => void {
      return () => undefined;
    },
    handleAppMessage(): void {},
    cancelAllWaiters(): void {},
    transcript: [],
    stageLabel: 'test',
  };

  const recv = (msg: GameNetworkMessage): void => {
    const ctor = msg.constructor as unknown as { typeCrc: number };
    const list = listeners.get(ctor.typeCrc);
    if (list === undefined) return;
    for (const h of list.slice()) h(msg);
  };

  return { dispatcher: fake as unknown as MessageDispatcher, recv };
}

// ── synthesizers ───────────────────────────────────────────────────

function makeCreoSharedBaseline(
  partial: Partial<CreatureObjectSharedBaseline> = {},
): CreatureObjectSharedBaseline {
  return {
    complexity: 1,
    nameStringId: EMPTY_STRING_ID,
    objectName: 'Hero',
    volume: 1,
    pvpFaction: 0,
    pvpType: 1,
    appearanceData: '',
    components: [],
    condition: 0,
    count: 0,
    damageTaken: 0,
    maxHitPoints: 1000,
    visible: true,
    posture: 0, // upright
    rank: 0,
    masterId: 0n,
    scaleFactor: 1.0,
    shockWounds: 0,
    states: 0n,
    ...partial,
  };
}

function makeCreoSharedNpBaseline(
  partial: Partial<CreatureObjectSharedNpBaseline> = {},
): CreatureObjectSharedNpBaseline {
  return {
    authServerProcessId: 0,
    descriptionStringId: EMPTY_STRING_ID,
    inCombat: false,
    passiveRevealPlayerCharacter: [],
    mapColorOverride: 0,
    accessList: [],
    guildAccessList: [],
    effects: [],
    level: 5,
    levelHealthGranted: 0,
    animatingSkillData: '',
    animationMood: '',
    currentWeapon: 0n,
    group: 0n,
    groupInviter: { inviter: 0n, inviterName: '', ship: 0n },
    guildId: 0,
    lookAtTarget: 0n,
    intendedTarget: 0n,
    mood: 0,
    performanceStartTime: 0,
    performanceType: 0,
    // Health, Constitution, Action, Stamina, Mind, Willpower
    totalAttributes: [800, 0, 700, 0, 600, 0],
    totalMaxAttributes: [1000, 0, 900, 0, 800, 0],
    wearableData: [],
    alternateAppearanceSharedObjectTemplateName: '',
    coverVisibility: false,
    buffs: [],
    clientUsesAnimationLocomotion: false,
    difficulty: 0,
    hologramType: 0,
    visibleOnMapAndRadar: true,
    isBeast: false,
    forceShowHam: false,
    wearableAppearanceData: [],
    decoyOrigin: 0n,
    ...partial,
  };
}

function makeCreoClientServerBaseline(
  partial: Partial<CreatureObjectClientServerBaseline> = {},
): CreatureObjectClientServerBaseline {
  return {
    bankBalance: 5000,
    cashBalance: 250,
    maxAttributes: [1000, 0, 900, 0, 800, 0],
    skills: ['combat_brawler_master'],
    ...partial,
  };
}

function makePlayClientServerBaseline(
  partial: Partial<PlayerObjectClientServerBaseline> = {},
): PlayerObjectClientServerBaseline {
  return { bankBalance: 0, cashBalance: 0, ...partial };
}

function makePlayObjectSharedBaseline(
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

function makePlayObjectSharedNpBaseline(
  partial: Partial<PlayerObjectSharedNpBaseline> = {},
): PlayerObjectSharedNpBaseline {
  return {
    authServerProcessId: 0,
    descriptionStringId: EMPTY_STRING_ID,
    privledgedTitle: 0,
    currentGcwRank: 0,
    currentGcwRankProgress: 0,
    maxGcwImperialRank: 0,
    maxGcwRebelRank: 0,
    gcwRatingActualCalcTime: 0,
    citizenshipCity: '',
    citizenshipType: 0,
    cityGcwDefenderRegion: { region: '', qualifiesForBonus: false, qualifiesForTitle: false },
    guildGcwDefenderRegion: { region: '', qualifiesForBonus: false, qualifiesForTitle: false },
    squelchedById: 0n,
    squelchedByName: '',
    squelchExpireTime: 0,
    environmentFlags: 0,
    defaultAttackOverride: '',
    ...partial,
  };
}

function creoSharedBaseline(target: bigint, data: CreatureObjectSharedBaseline): BaselinesMessage {
  return new BaselinesMessage(
    target,
    ObjectTypeTags.CREO,
    BaselinePackageIds.SHARED,
    new Uint8Array(0),
    { kind: CreatureObjectSharedKind, data },
  );
}

function creoSharedNpBaseline(
  target: bigint,
  data: CreatureObjectSharedNpBaseline,
): BaselinesMessage {
  return new BaselinesMessage(
    target,
    ObjectTypeTags.CREO,
    BaselinePackageIds.SHARED_NP,
    new Uint8Array(0),
    { kind: CreatureObjectSharedNpKind, data },
  );
}

function creoClientServerBaseline(
  target: bigint,
  data: CreatureObjectClientServerBaseline,
): BaselinesMessage {
  return new BaselinesMessage(
    target,
    ObjectTypeTags.CREO,
    BaselinePackageIds.CLIENT_SERVER,
    new Uint8Array(0),
    { kind: CreatureObjectClientServerKind, data },
  );
}

function playSharedBaseline(target: bigint, data: PlayerObjectSharedBaseline): BaselinesMessage {
  return new BaselinesMessage(
    target,
    ObjectTypeTags.PLAY,
    BaselinePackageIds.SHARED,
    new Uint8Array(0),
    { kind: PlayerObjectSharedKind, data },
  );
}

function playSharedNpBaseline(
  target: bigint,
  data: PlayerObjectSharedNpBaseline,
): BaselinesMessage {
  return new BaselinesMessage(
    target,
    ObjectTypeTags.PLAY,
    BaselinePackageIds.SHARED_NP,
    new Uint8Array(0),
    { kind: PlayerObjectSharedNpKind, data },
  );
}

function playClientServerBaseline(
  target: bigint,
  data: PlayerObjectClientServerBaseline,
): BaselinesMessage {
  return new BaselinesMessage(
    target,
    ObjectTypeTags.PLAY,
    BaselinePackageIds.CLIENT_SERVER,
    new Uint8Array(0),
    { kind: PlayerObjectClientServerKind, data },
  );
}

function makeCreoClientServerNpBaseline(
  partial: Partial<CreatureObjectClientServerNpBaseline> = {},
): CreatureObjectClientServerNpBaseline {
  return {
    accelPercent: 1,
    accelScale: 1,
    attribBonus: [0, 0, 0, 0, 0, 0],
    modMap: [],
    movementPercent: 1,
    movementScale: 1,
    performanceListenTarget: 0n,
    runSpeed: 7.3,
    slopeModAngle: 45,
    slopeModPercent: 0.5,
    turnScale: 1,
    walkSpeed: 1.65,
    waterModPercent: 0.5,
    groupMissionCriticalObjectSet: [],
    commands: [],
    totalLevelXp: 0,
    ...partial,
  };
}

function creoClientServerNpBaseline(
  target: bigint,
  data: CreatureObjectClientServerNpBaseline,
): BaselinesMessage {
  return new BaselinesMessage(
    target,
    ObjectTypeTags.CREO,
    BaselinePackageIds.CLIENT_SERVER_NP,
    new Uint8Array(0),
    { kind: CreatureObjectClientServerNpKind, data },
  );
}

function makePlayFirstParentBaseline(
  partial: Partial<PlayerObjectFirstParentClientServerBaseline> = {},
): PlayerObjectFirstParentClientServerBaseline {
  return {
    experiencePoints: [],
    waypoints: [],
    forcePower: 0,
    maxForcePower: 0,
    completedQuests: { numInUseBits: 0, bytes: new Uint8Array(0) },
    activeQuests: { numInUseBits: 0, bytes: new Uint8Array(0) },
    currentQuest: 0,
    quests: [],
    workingSkill: '',
    ...partial,
  };
}

function playFirstParentBaseline(
  target: bigint,
  data: PlayerObjectFirstParentClientServerBaseline,
): BaselinesMessage {
  return new BaselinesMessage(
    target,
    ObjectTypeTags.PLAY,
    BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER,
    new Uint8Array(0),
    { kind: PlayerObjectFirstParentClientServerKind, data },
  );
}

/**
 * Synthesize a DeltasMessage with a pre-decoded sparse payload. The
 * production deltas-message decoder calls `tryDecodeDelta` after parsing
 * the envelope; we shortcut and hand in `decodedDelta` directly.
 */
function makeDelta(
  target: bigint,
  typeId: number,
  packageId: number,
  data: Record<string, unknown>,
): DeltasMessage {
  return new DeltasMessage(target, typeId, packageId, new Uint8Array(0), {
    kind: `${typeId === ObjectTypeTags.CREO ? 'Creature' : 'Player'}Object/p${packageId}Delta`,
    data,
  });
}

// ── tests ──────────────────────────────────────────────────────────

describe('CharacterSheet', () => {
  let handle: CharacterSheetHandle;
  let recv: (m: GameNetworkMessage) => void;

  function setup(): void {
    const { dispatcher, recv: r } = makeFakeDispatcher();
    handle = createCharacterSheet({
      dispatcher,
      playerNetworkId: PLAYER_ID,
      templateName: 'object/creature/player/human_male.iff',
    });
    recv = r;
  }

  describe('ready flag', () => {
    it('starts false; flips to true after the first CREO baseline', () => {
      setup();
      expect(handle.view.ready).toBe(false);
      recv(creoSharedBaseline(PLAYER_ID, makeCreoSharedBaseline()));
      expect(handle.view.ready).toBe(true);
    });

    it('does NOT flip on a CREO baseline targeting a different actor', () => {
      setup();
      recv(creoSharedBaseline(0xdeadn, makeCreoSharedBaseline()));
      expect(handle.view.ready).toBe(false);
    });

    it('does NOT flip on a PLAY baseline alone (it might come before any CREO baseline)', () => {
      setup();
      recv(playSharedBaseline(0xabcdn, makePlayObjectSharedBaseline()));
      expect(handle.view.ready).toBe(false);
    });
  });

  describe('name + posture + faction (CREO SHARED)', () => {
    it('reads name from the SHARED baseline', () => {
      setup();
      expect(handle.view.name).toBeNull();
      recv(creoSharedBaseline(PLAYER_ID, makeCreoSharedBaseline({ objectName: 'Galad' })));
      expect(handle.view.name).toBe('Galad');
    });

    it('treats empty objectName as null (server uses "" to mean no override)', () => {
      setup();
      recv(creoSharedBaseline(PLAYER_ID, makeCreoSharedBaseline({ objectName: '' })));
      expect(handle.view.name).toBeNull();
    });

    it('reads posture from the SHARED baseline + delta', () => {
      setup();
      recv(creoSharedBaseline(PLAYER_ID, makeCreoSharedBaseline({ posture: 0 })));
      expect(handle.view.posture).toBe('standing');
      // Apply a delta switching posture to sitting (i8 = 8)
      recv(makeDelta(PLAYER_ID, ObjectTypeTags.CREO, BaselinePackageIds.SHARED, { posture: 8 }));
      expect(handle.view.posture).toBe('sitting');
      // And to prone (i8 = 2)
      recv(makeDelta(PLAYER_ID, ObjectTypeTags.CREO, BaselinePackageIds.SHARED, { posture: 2 }));
      expect(handle.view.posture).toBe('prone');
    });

    it('reads faction from CREO p3 m_pvpType', () => {
      setup();
      recv(creoSharedBaseline(PLAYER_ID, makeCreoSharedBaseline({ pvpType: 2 })));
      expect(handle.view.faction).toBe(2);
    });

    it('updates posture from a CM_setPosture ObjController message', () => {
      // The live server sometimes pushes posture changes as ObjController
      // CM_setPosture(305) rather than (or in addition to) a CREO p3
      // delta — particularly when the actor and observer are the same
      // client. The character sheet listens for both.
      setup();
      // Pre-seed posture via baseline so `ready` is true and posture starts known.
      recv(creoSharedBaseline(PLAYER_ID, makeCreoSharedBaseline({ posture: 0 })));
      expect(handle.view.posture).toBe('standing');
      // Send a CM_setPosture(8 = Sitting) targeting the player.
      recv(
        new ObjControllerMessage(
          0x23, // CLIENT_TO_AUTH_SERVER_FLAGS (any non-zero value works for tests)
          ObjControllerSubtypeIds.CM_setPosture,
          PLAYER_ID,
          0,
          new Uint8Array([8, 1]),
          { kind: PostureChangeKind, data: { posture: 8, isClientImmediate: true } },
        ),
      );
      expect(handle.view.posture).toBe('sitting');
    });

    it('ignores CM_setPosture targeting a different actor', () => {
      setup();
      recv(creoSharedBaseline(PLAYER_ID, makeCreoSharedBaseline({ posture: 0 })));
      recv(
        new ObjControllerMessage(
          0x23,
          ObjControllerSubtypeIds.CM_setPosture,
          0xbeefn, // not the player
          0,
          new Uint8Array([2, 0]),
          { kind: PostureChangeKind, data: { posture: 2, isClientImmediate: false } },
        ),
      );
      expect(handle.view.posture).toBe('standing');
    });
  });

  describe('level + mood + HAM (CREO SHARED_NP)', () => {
    it('reads level + mood from SHARED_NP baseline', () => {
      setup();
      recv(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNpBaseline({ level: 80, mood: 3 })));
      expect(handle.view.level).toBe(80);
      expect(handle.view.mood).toBe(3);
    });

    it('reads performance state from SHARED_NP baseline + delta', () => {
      setup();
      // Idle by default — no active performance.
      recv(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNpBaseline()));
      expect(handle.view.performance.performing).toBe(false);
      expect(handle.view.performance.type).toBe(0);
      // A SHARED_NP baseline carrying an active performance.
      recv(
        creoSharedNpBaseline(
          PLAYER_ID,
          makeCreoSharedNpBaseline({
            performanceType: 7,
            performanceStartTime: 1234,
            animatingSkillData: 'music_3',
            animationMood: 'happy',
          }),
        ),
      );
      expect(handle.view.performance.performing).toBe(true);
      expect(handle.view.performance.type).toBe(7);
      expect(handle.view.performance.startTime).toBe(1234);
      expect(handle.view.performance.animatingSkillData).toBe('music_3');
      expect(handle.view.performance.animationMood).toBe('happy');
      // A delta that clears performanceType flips `performing` back to false.
      recv(
        makeDelta(PLAYER_ID, ObjectTypeTags.CREO, BaselinePackageIds.SHARED_NP, {
          performanceType: 0,
        }),
      );
      expect(handle.view.performance.performing).toBe(false);
    });

    it('seeds level/mood from the WorldModel when constructed mid-session (reload)', () => {
      // Simulate a reload: the baseline flood already reached the (shared,
      // long-lived) WorldModel; a fresh CharacterSheet built afterwards must
      // back-fill from the world rather than start blank at level 0.
      const { dispatcher: d2, recv: recvW } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher: d2 });
      recvW(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNpBaseline({ level: 88, mood: 2 })));
      const reloaded = createCharacterSheet({ dispatcher: d2, playerNetworkId: PLAYER_ID, world });
      expect(reloaded.view.level).toBe(88);
      expect(reloaded.view.mood).toBe(2);
      expect(reloaded.view.ready).toBe(true);
    });

    it('reads HAM current/max from SHARED_NP totalAttributes/totalMaxAttributes', () => {
      setup();
      recv(
        creoSharedNpBaseline(
          PLAYER_ID,
          makeCreoSharedNpBaseline({
            totalAttributes: [950, 0, 850, 0, 750, 0],
            totalMaxAttributes: [1000, 0, 900, 0, 800, 0],
          }),
        ),
      );
      expect(handle.view.health).toEqual({ current: 950, max: 1000 });
      expect(handle.view.action).toEqual({ current: 850, max: 900 });
      expect(handle.view.mind).toEqual({ current: 750, max: 800 });
    });

    it('applies an AutoDeltaVector setAll delta to totalAttributes', () => {
      setup();
      recv(
        creoSharedNpBaseline(
          PLAYER_ID,
          makeCreoSharedNpBaseline({
            totalAttributes: [1000, 0, 900, 0, 800, 0],
            totalMaxAttributes: [1000, 0, 900, 0, 800, 0],
          }),
        ),
      );
      expect(handle.view.health.current).toBe(1000);
      // Simulate a tick-down: setAll replacing the vector
      recv(
        makeDelta(PLAYER_ID, ObjectTypeTags.CREO, BaselinePackageIds.SHARED_NP, {
          totalAttributes: [{ kind: 'setAll', values: [500, 0, 400, 0, 300, 0] }],
        }),
      );
      expect(handle.view.health.current).toBe(500);
      expect(handle.view.action.current).toBe(400);
      expect(handle.view.mind.current).toBe(300);
    });

    it('applies an AutoDeltaVector set delta (single index) to totalAttributes', () => {
      setup();
      recv(
        creoSharedNpBaseline(
          PLAYER_ID,
          makeCreoSharedNpBaseline({
            totalAttributes: [1000, 0, 900, 0, 800, 0],
            totalMaxAttributes: [1000, 0, 900, 0, 800, 0],
          }),
        ),
      );
      // Drop health to 200 via a SET at index 0
      recv(
        makeDelta(PLAYER_ID, ObjectTypeTags.CREO, BaselinePackageIds.SHARED_NP, {
          totalAttributes: [{ kind: 'set', index: 0, value: 200 }],
        }),
      );
      expect(handle.view.health.current).toBe(200);
      // Action / Mind unchanged.
      expect(handle.view.action.current).toBe(900);
      expect(handle.view.mind.current).toBe(800);
    });

    it('falls back to CREO p1 maxAttributes when totalMaxAttributes hasnt arrived', () => {
      setup();
      // SHARED_NP arrives with current but no max yet (server delay).
      recv(
        creoSharedNpBaseline(
          PLAYER_ID,
          makeCreoSharedNpBaseline({
            totalAttributes: [950, 0, 850, 0, 750, 0],
            totalMaxAttributes: [],
          }),
        ),
      );
      expect(handle.view.health.max).toBe(0);
      // CREO p1 baseline lands.
      recv(
        creoClientServerBaseline(
          PLAYER_ID,
          makeCreoClientServerBaseline({ maxAttributes: [1100, 0, 1000, 0, 900, 0] }),
        ),
      );
      expect(handle.view.health.max).toBe(1100);
      expect(handle.view.action.max).toBe(1000);
      expect(handle.view.mind.max).toBe(900);
    });

    it('reads currentWeapon as a NetworkId (null when unarmed)', () => {
      setup();
      expect(handle.view.currentWeapon).toBeNull();
      recv(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNpBaseline({ currentWeapon: 0x1234n })));
      expect(handle.view.currentWeapon).toBe(0x1234n);
      // Clear to unarmed (0n)
      recv(
        makeDelta(PLAYER_ID, ObjectTypeTags.CREO, BaselinePackageIds.SHARED_NP, {
          currentWeapon: 0n,
        }),
      );
      expect(handle.view.currentWeapon).toBeNull();
    });

    it('reads group + groupInviter from SHARED_NP', () => {
      setup();
      expect(handle.view.groupId).toBeNull();
      expect(handle.view.group).toBeNull();
      expect(handle.view.groupInviter).toBeNull();
      recv(
        creoSharedNpBaseline(
          PLAYER_ID,
          makeCreoSharedNpBaseline({
            group: 0xa1b2n,
            groupInviter: { inviter: 0xc3d4n, inviterName: 'Leader', ship: 0n },
          }),
        ),
      );
      expect(handle.view.groupId).toBe(0xa1b2n);
      expect(handle.view.group?.id).toBe(0xa1b2n);
      expect(handle.view.groupInviter).toEqual({ id: 0xc3d4n, name: 'Leader' });
      // Server clears inviter to 0n once invite resolves.
      recv(
        makeDelta(PLAYER_ID, ObjectTypeTags.CREO, BaselinePackageIds.SHARED_NP, {
          groupInviter: { inviter: 0n, inviterName: '', ship: 0n },
        }),
      );
      expect(handle.view.groupInviter).toBeNull();
    });
  });

  describe('skills + bank/cash (CREO p1)', () => {
    it('reads skills from CREO p1 baseline; INSERT delta appends', () => {
      setup();
      expect(handle.view.skills).toEqual([]);
      recv(
        creoClientServerBaseline(
          PLAYER_ID,
          makeCreoClientServerBaseline({
            skills: ['combat_brawler_master', 'science_medic_novice'],
          }),
        ),
      );
      expect(handle.view.skills).toEqual(['combat_brawler_master', 'science_medic_novice']);
      // INSERT delta on the set: training a new skill.
      recv(
        makeDelta(PLAYER_ID, ObjectTypeTags.CREO, BaselinePackageIds.CLIENT_SERVER, {
          skills: [{ kind: 'insert', value: 'crafting_artisan_novice' }],
        }),
      );
      expect(handle.view.skills).toContain('crafting_artisan_novice');
      // ERASE delta removes the named skill.
      recv(
        makeDelta(PLAYER_ID, ObjectTypeTags.CREO, BaselinePackageIds.CLIENT_SERVER, {
          skills: [{ kind: 'erase', value: 'science_medic_novice' }],
        }),
      );
      expect(handle.view.skills).not.toContain('science_medic_novice');
    });

    it('reads bank/cash from CREO p1 baseline', () => {
      setup();
      recv(
        creoClientServerBaseline(
          PLAYER_ID,
          makeCreoClientServerBaseline({ bankBalance: 50_000, cashBalance: 1234 }),
        ),
      );
      expect(handle.view.bankBalance).toBe(50_000);
      expect(handle.view.cashBalance).toBe(1234);
    });

    it('updates cashBalance on a CREO p1 delta', () => {
      setup();
      recv(
        creoClientServerBaseline(
          PLAYER_ID,
          makeCreoClientServerBaseline({ bankBalance: 50_000, cashBalance: 1234 }),
        ),
      );
      recv(
        makeDelta(PLAYER_ID, ObjectTypeTags.CREO, BaselinePackageIds.CLIENT_SERVER, {
          cashBalance: 999,
        }),
      );
      expect(handle.view.cashBalance).toBe(999);
      expect(handle.view.bankBalance).toBe(50_000);
    });

    it('prefers PLAY p1 over CREO p1 for bank/cash when both are present', () => {
      setup();
      // CREO p1 lands first.
      recv(
        creoClientServerBaseline(
          PLAYER_ID,
          makeCreoClientServerBaseline({ bankBalance: 1, cashBalance: 1 }),
        ),
      );
      // PLAY p1 lands second with a different value (the canonical source).
      recv(
        playClientServerBaseline(
          PLAYER_ID,
          makePlayClientServerBaseline({ bankBalance: 100, cashBalance: 100 }),
        ),
      );
      expect(handle.view.bankBalance).toBe(100);
      expect(handle.view.cashBalance).toBe(100);
    });
  });

  describe('PLAY p3 (skillTitle, playedTime)', () => {
    it('reads skillTitle + playedTime from PLAY SHARED baseline', () => {
      setup();
      recv(
        playSharedBaseline(
          PLAYER_ID,
          makePlayObjectSharedBaseline({
            skillTitle: 'master_brawler',
            playedTime: 86400,
          }),
        ),
      );
      expect(handle.view.skillTitle).toBe('master_brawler');
      expect(handle.view.playedTime).toBe(86400);
    });

    it('updates playedTime on a PLAY p3 delta', () => {
      setup();
      recv(playSharedBaseline(PLAYER_ID, makePlayObjectSharedBaseline({ playedTime: 100 })));
      recv(
        makeDelta(PLAYER_ID, ObjectTypeTags.PLAY, BaselinePackageIds.SHARED, {
          playedTime: 200,
        }),
      );
      expect(handle.view.playedTime).toBe(200);
    });
  });

  describe('citizenship (PLAY p6 m_citizenshipCity / m_citizenshipType)', () => {
    it('starts null/0 before any PLAY p6 baseline lands', () => {
      setup();
      expect(handle.view.cityName).toBeNull();
      expect(handle.view.citizenType).toBe(0);
    });

    it('reads cityName + citizenType from a PLAY p6 baseline', () => {
      setup();
      recv(
        playSharedNpBaseline(
          PLAYER_ID,
          makePlayObjectSharedNpBaseline({
            citizenshipCity: 'TsHarbor50661',
            citizenshipType: 1,
          }),
        ),
      );
      expect(handle.view.cityName).toBe('TsHarbor50661');
      expect(handle.view.citizenType).toBe(1);
    });

    it('treats empty citizenshipCity as null', () => {
      setup();
      recv(
        playSharedNpBaseline(
          PLAYER_ID,
          makePlayObjectSharedNpBaseline({ citizenshipCity: '', citizenshipType: 0 }),
        ),
      );
      expect(handle.view.cityName).toBeNull();
      expect(handle.view.citizenType).toBe(0);
    });

    it('updates from a PLAY p6 delta (declareresidence path)', () => {
      setup();
      // Start with no citizenship.
      recv(playSharedNpBaseline(PLAYER_ID, makePlayObjectSharedNpBaseline()));
      expect(handle.view.cityName).toBeNull();
      // Server pushes a delta after city.addCitizen fires.
      recv(
        makeDelta(PLAYER_ID, ObjectTypeTags.PLAY, BaselinePackageIds.SHARED_NP, {
          citizenshipCity: 'TsHarbor50661',
          citizenshipType: 1,
        }),
      );
      expect(handle.view.cityName).toBe('TsHarbor50661');
      expect(handle.view.citizenType).toBe(1);
    });

    it('a PLAY SHARED_NP delta on a different package does NOT clobber citizenship', () => {
      setup();
      recv(
        playSharedNpBaseline(
          PLAYER_ID,
          makePlayObjectSharedNpBaseline({ citizenshipCity: 'TsHarbor50661' }),
        ),
      );
      // PLAY p3 (skillTitle) delta should not touch citizenship.
      recv(
        makeDelta(PLAYER_ID, ObjectTypeTags.PLAY, BaselinePackageIds.SHARED, {
          skillTitle: 'master_brawler',
        }),
      );
      expect(handle.view.cityName).toBe('TsHarbor50661');
    });
  });

  describe('templateName + networkId', () => {
    it('seeds templateName from the construction option', () => {
      setup();
      expect(handle.view.templateName).toBe('object/creature/player/human_male.iff');
    });

    it('returns the pinned playerNetworkId', () => {
      setup();
      expect(handle.view.networkId).toBe(PLAYER_ID);
    });
  });

  describe('toJSON()', () => {
    it('produces a JSON-safe projection (no bigint leaks)', () => {
      setup();
      recv(
        creoSharedBaseline(
          PLAYER_ID,
          makeCreoSharedBaseline({ objectName: 'Hero', posture: 1, pvpType: 3 }),
        ),
      );
      recv(
        creoSharedNpBaseline(
          PLAYER_ID,
          makeCreoSharedNpBaseline({
            level: 90,
            currentWeapon: 0xfeedn,
            group: 0xbeefn,
            totalAttributes: [500, 0, 400, 0, 300, 0],
            totalMaxAttributes: [1000, 0, 900, 0, 800, 0],
          }),
        ),
      );
      recv(
        creoClientServerBaseline(
          PLAYER_ID,
          makeCreoClientServerBaseline({
            bankBalance: 1_000_000,
            cashBalance: 500,
            skills: ['s1', 's2'],
          }),
        ),
      );

      const json = handle.view.toJSON();
      // Round-trip through JSON.stringify — must not throw.
      expect(() => JSON.stringify(json)).not.toThrow();
      expect(json.networkId).toBe(PLAYER_ID.toString());
      expect(json.name).toBe('Hero');
      expect(json.posture).toBe('crouched');
      expect(json.level).toBe(90);
      expect(json.skills).toEqual(['s1', 's2']);
      expect(json.bankBalance).toBe(1_000_000);
      expect(json.cashBalance).toBe(500);
      expect(json.health).toEqual({ current: 500, max: 1000 });
      expect(json.currentWeapon).toBe(0xfeedn.toString());
      expect(json.groupId).toBe(0xbeefn.toString());
    });
  });

  describe('skillMods (CREO p4 m_modMap)', () => {
    it('starts empty until the first CREO p4 baseline lands', () => {
      setup();
      expect(handle.view.skillMods.size).toBe(0);
    });

    it('populates `base + bonus` from a CREO p4 baseline', () => {
      setup();
      recv(
        creoClientServerNpBaseline(
          PLAYER_ID,
          makeCreoClientServerNpBaseline({
            modMap: [
              { name: 'pistol_accuracy', base: 75, bonus: 12 },
              { name: 'strength_modified', base: 100, bonus: 0 },
              { name: 'agility_modified', base: 50, bonus: 25 },
            ],
          }),
        ),
      );
      expect(handle.view.skillMods.get('pistol_accuracy')).toBe(87);
      expect(handle.view.skillMods.get('strength_modified')).toBe(100);
      expect(handle.view.skillMods.get('agility_modified')).toBe(75);
      expect(handle.view.skillMods.size).toBe(3);
    });

    it('applies an ADD delta on m_modMap', () => {
      setup();
      recv(
        creoClientServerNpBaseline(
          PLAYER_ID,
          makeCreoClientServerNpBaseline({
            modMap: [{ name: 'pistol_accuracy', base: 75, bonus: 0 }],
          }),
        ),
      );
      recv(
        makeDelta(PLAYER_ID, ObjectTypeTags.CREO, BaselinePackageIds.CLIENT_SERVER_NP, {
          modMap: [
            { kind: 'add', key: 'pistol_speed', value: { base: 50, bonus: 0 } },
            { kind: 'set', key: 'pistol_accuracy', value: { base: 75, bonus: 25 } },
          ],
        }),
      );
      expect(handle.view.skillMods.get('pistol_accuracy')).toBe(100);
      expect(handle.view.skillMods.get('pistol_speed')).toBe(50);
    });

    it('ERASE delta removes the named mod', () => {
      setup();
      recv(
        creoClientServerNpBaseline(
          PLAYER_ID,
          makeCreoClientServerNpBaseline({
            modMap: [{ name: 'pistol_accuracy', base: 75, bonus: 0 }],
          }),
        ),
      );
      recv(
        makeDelta(PLAYER_ID, ObjectTypeTags.CREO, BaselinePackageIds.CLIENT_SERVER_NP, {
          modMap: [{ kind: 'erase', key: 'pistol_accuracy', value: { base: 0, bonus: 0 } }],
        }),
      );
      expect(handle.view.skillMods.has('pistol_accuracy')).toBe(false);
    });
  });

  describe('xp (PLAY p8 m_experiencePoints)', () => {
    it('starts empty until first PLAY p8 baseline lands', () => {
      setup();
      expect(handle.view.xp.size).toBe(0);
    });

    it('populates from a PLAY p8 baseline', () => {
      setup();
      recv(
        playFirstParentBaseline(
          PLAYER_ID,
          makePlayFirstParentBaseline({
            experiencePoints: [
              { category: 'combat_general', amount: 12345 },
              { category: 'crafting_artisan', amount: 6789 },
            ],
          }),
        ),
      );
      expect(handle.view.xp.get('combat_general')).toBe(12345);
      expect(handle.view.xp.get('crafting_artisan')).toBe(6789);
    });

    it('applies an ADD delta to add a new category', () => {
      setup();
      recv(playFirstParentBaseline(PLAYER_ID, makePlayFirstParentBaseline()));
      recv(
        makeDelta(PLAYER_ID, ObjectTypeTags.PLAY, BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER, {
          experiencePoints: [{ kind: 'add', key: 'combat_brawler', value: 100 }],
        }),
      );
      expect(handle.view.xp.get('combat_brawler')).toBe(100);
    });

    it('applies a SET delta to update an existing category', () => {
      setup();
      recv(
        playFirstParentBaseline(
          PLAYER_ID,
          makePlayFirstParentBaseline({
            experiencePoints: [{ category: 'combat_general', amount: 100 }],
          }),
        ),
      );
      recv(
        makeDelta(PLAYER_ID, ObjectTypeTags.PLAY, BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER, {
          experiencePoints: [{ kind: 'set', key: 'combat_general', value: 500 }],
        }),
      );
      expect(handle.view.xp.get('combat_general')).toBe(500);
    });
  });

  describe('effects (CREO p6 m_buffs)', () => {
    it('starts empty until first CREO p6 baseline lands', () => {
      setup();
      expect(handle.view.effects).toEqual([]);
    });

    it('decodes buffs into the {name, magnitude, durationSec, expiresAt} shape', () => {
      setup();
      recv(
        creoSharedNpBaseline(
          PLAYER_ID,
          makeCreoSharedNpBaseline({
            buffs: [
              {
                buffNameCrc: 0xdeadbeef,
                buff: {
                  endtime: 1_700_000_000,
                  value: 250,
                  duration: 600,
                  caster: 0n,
                  stackCount: 1,
                },
              },
            ],
          }),
        ),
      );
      expect(handle.view.effects).toHaveLength(1);
      const e = handle.view.effects[0];
      expect(e?.name).toBe('deadbeef');
      expect(e?.magnitude).toBe(250);
      expect(e?.durationSec).toBe(600);
      expect(e?.expiresAt).toBe(1_700_000_000);
    });
  });

  describe('weapon (currentWeapon + WEAO baselines)', () => {
    it('returns null when unarmed', () => {
      setup();
      expect(handle.view.weapon).toBeNull();
    });

    it('returns null when the WEAO baselines haven\'t arrived yet', () => {
      // Without a WorldModel, weapon is always null.
      setup();
      recv(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNpBaseline({ currentWeapon: 0xfeedn })));
      expect(handle.view.weapon).toBeNull();
    });
  });

  describe('roadmap (PLAY p8 m_workingSkill + m_activeQuests)', () => {
    it('starts null until first PLAY p8 baseline lands', () => {
      setup();
      expect(handle.view.roadmap).toBeNull();
    });

    it('parses currentPhase + currentTask from a standard NGE workingSkill', () => {
      setup();
      recv(
        playFirstParentBaseline(
          PLAYER_ID,
          makePlayFirstParentBaseline({
            workingSkill: 'class_domestics_phase1_novice',
          }),
        ),
      );
      expect(handle.view.roadmap).not.toBeNull();
      expect(handle.view.roadmap?.currentPhase).toBe('phase1');
      expect(handle.view.roadmap?.currentTask).toBe('novice');
      expect(handle.view.roadmap?.tasksRemaining).toBe(0);
    });

    it('falls back to whole-string task when workingSkill is non-standard', () => {
      setup();
      recv(
        playFirstParentBaseline(
          PLAYER_ID,
          makePlayFirstParentBaseline({ workingSkill: 'combat_brawler_novice' }),
        ),
      );
      expect(handle.view.roadmap?.currentPhase).toBe('');
      expect(handle.view.roadmap?.currentTask).toBe('combat_brawler_novice');
    });

    it('counts active-quest bits as tasksRemaining', () => {
      setup();
      // 3 bits set: bit 0, bit 2, bit 5 in the first byte → byte = 0b00100101 = 0x25
      recv(
        playFirstParentBaseline(
          PLAYER_ID,
          makePlayFirstParentBaseline({
            workingSkill: 'class_domestics_phase1_novice',
            activeQuests: {
              numInUseBits: 8,
              bytes: new Uint8Array([0x25]),
            },
          }),
        ),
      );
      expect(handle.view.roadmap?.tasksRemaining).toBe(3);
    });
  });

  describe('factionDetails (CREO p3 m_pvpType + PLAY p3 m_currentGcwPoints)', () => {
    it('defaults to neutral with 0 standing before any baseline', () => {
      setup();
      expect(handle.view.factionDetails).toEqual({
        type: 0,
        name: 'neutral',
        standing: 0,
        pvpStatus: 0,
      });
    });

    it('maps type 1 to "imperial"', () => {
      setup();
      recv(creoSharedBaseline(PLAYER_ID, makeCreoSharedBaseline({ pvpType: 1 })));
      expect(handle.view.factionDetails.name).toBe('imperial');
      expect(handle.view.factionDetails.type).toBe(1);
      expect(handle.view.factionDetails.pvpStatus).toBe(1);
    });

    it('maps type 2 to "rebel"', () => {
      setup();
      recv(creoSharedBaseline(PLAYER_ID, makeCreoSharedBaseline({ pvpType: 2 })));
      expect(handle.view.factionDetails.name).toBe('rebel');
    });

    it('reads standing from PLAY p3 currentGcwPoints', () => {
      setup();
      recv(
        playSharedBaseline(
          PLAYER_ID,
          makePlayObjectSharedBaseline({ currentGcwPoints: 5000 }),
        ),
      );
      expect(handle.view.factionDetails.standing).toBe(5000);
    });

    it('toJSON includes new fields without bigint leaks', () => {
      setup();
      recv(creoSharedBaseline(PLAYER_ID, makeCreoSharedBaseline({ pvpType: 1 })));
      recv(
        creoClientServerNpBaseline(
          PLAYER_ID,
          makeCreoClientServerNpBaseline({
            modMap: [{ name: 'pistol_accuracy', base: 50, bonus: 0 }],
          }),
        ),
      );
      recv(
        playFirstParentBaseline(
          PLAYER_ID,
          makePlayFirstParentBaseline({
            experiencePoints: [{ category: 'combat_general', amount: 100 }],
            workingSkill: 'class_artisan_phase1_novice',
          }),
        ),
      );
      const json = handle.view.toJSON() as Record<string, unknown>;
      expect(() => JSON.stringify(json)).not.toThrow();
      expect(json.skillMods).toEqual({ pistol_accuracy: 50 });
      expect(json.xp).toEqual({ combat_general: 100 });
      expect((json.roadmap as { currentPhase: string }).currentPhase).toBe('phase1');
      expect((json.factionDetails as { name: string }).name).toBe('imperial');
    });
  });

  describe('weapon view (full joined view with mock WorldModel)', () => {
    it('joins WEAO p3 baseline + AttributeListMessage into the weapon shape', () => {
      // Build a minimal WorldModel-like with a single weapon entry whose
      // baselines map contains a synthetic WEAO p3 shape.
      const { dispatcher, recv: recv2 } = makeFakeDispatcher();
      const weaponId = 0xfeedn;
      const worldObj = {
        id: weaponId,
        typeId: 0x5745414f, // WEAO
        typeIdString: 'WEAO',
        templateName: 'object/weapon/melee/sword/sword_curved.iff',
        position: { x: 0, y: 0, z: 0 },
        yaw: 0,
        parentCell: 0n,
        cellPosition: { x: 0, y: 0, z: 0 },
        containerId: 0n,
        slotArrangement: -1,
        hyperspace: false,
        baselines: new Map<number, unknown>([
          [
            BaselinePackageIds.SHARED,
            {
              attackSpeed: 3.5,
              maxRange: 5,
              minRange: 0,
              accuracy: 10,
              damageType: 1,
              elementalType: 0,
              elementalValue: 0,
            },
          ],
        ]),
        firstSeenAt: 0,
        lastUpdatedAt: 0,
      };
      const fakeWorld = {
        get(id: bigint): typeof worldObj | undefined {
          return id === weaponId ? worldObj : undefined;
        },
        objects: () => [].values(),
      };
      const localHandle = createCharacterSheet({
        dispatcher,
        playerNetworkId: PLAYER_ID,
        world: fakeWorld as unknown as Parameters<typeof createCharacterSheet>[0]['world'],
      });
      // Equip the weapon by sending a SHARED_NP baseline with currentWeapon set.
      recv2(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNpBaseline({ currentWeapon: weaponId })));
      // Send the AttributeListMessage with min/max damage and ammo.
      recv2(
        new AttributeListMessage(
          weaponId,
          '',
          [
            { key: 'wpn_damage_min', value: '50' },
            { key: 'wpn_damage_max', value: '100' },
            { key: 'wpn_ammo', value: '42' },
          ],
          0,
        ),
      );
      const w = localHandle.view.weapon;
      expect(w).not.toBeNull();
      expect(w?.networkId).toBe(weaponId);
      expect(w?.templateName).toBe('object/weapon/melee/sword/sword_curved.iff');
      expect(w?.attackSpeed).toBeCloseTo(3.5, 5);
      expect(w?.range).toBe(5);
      expect(w?.minDamage).toBe(50);
      expect(w?.maxDamage).toBe(100);
      expect(w?.ammoRemaining).toBe(42);
      localHandle.detach();
    });

    it('parses the unified NGE cat_wpn_damage.damage range "50-200"', () => {
      const { dispatcher, recv: recv2 } = makeFakeDispatcher();
      const weaponId = 0xb0bn;
      const worldObj = {
        id: weaponId,
        typeId: 0x5745414f,
        typeIdString: 'WEAO',
        templateName: 'object/weapon/melee/2h_sword/2h_sword_battleaxe.iff',
        position: { x: 0, y: 0, z: 0 },
        yaw: 0,
        parentCell: 0n,
        cellPosition: { x: 0, y: 0, z: 0 },
        containerId: 0n,
        slotArrangement: -1,
        hyperspace: false,
        baselines: new Map<number, unknown>([
          [
            BaselinePackageIds.SHARED,
            {
              attackSpeed: 4.0,
              maxRange: 5,
              minRange: 0,
              accuracy: 10,
              damageType: 1,
              elementalType: 0,
              elementalValue: 0,
            },
          ],
        ]),
        firstSeenAt: 0,
        lastUpdatedAt: 0,
      };
      const fakeWorld = {
        get: (id: bigint) => (id === weaponId ? worldObj : undefined),
        objects: () => [].values(),
      };
      const localHandle = createCharacterSheet({
        dispatcher,
        playerNetworkId: PLAYER_ID,
        world: fakeWorld as unknown as Parameters<typeof createCharacterSheet>[0]['world'],
      });
      recv2(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNpBaseline({ currentWeapon: weaponId })));
      recv2(
        new AttributeListMessage(
          weaponId,
          '',
          [
            { key: 'cat_wpn_damage.damage', value: '50-200' },
            { key: 'cat_wpn_damage.wpn_attack_speed', value: '4.0' },
            { key: 'cat_wpn_other.wpn_range', value: '5' },
          ],
          0,
        ),
      );
      const w = localHandle.view.weapon;
      expect(w?.minDamage).toBe(50);
      expect(w?.maxDamage).toBe(200);
      localHandle.detach();
    });

    it('returns null minDamage when no AttributeListMessage has arrived', () => {
      const { dispatcher, recv: recv2 } = makeFakeDispatcher();
      const weaponId = 0xc0den;
      const worldObj = {
        id: weaponId,
        typeId: 0x5745414f,
        typeIdString: 'WEAO',
        templateName: 'object/weapon/ranged/rifle/rifle_e11.iff',
        position: { x: 0, y: 0, z: 0 },
        yaw: 0,
        parentCell: 0n,
        cellPosition: { x: 0, y: 0, z: 0 },
        containerId: 0n,
        slotArrangement: -1,
        hyperspace: false,
        baselines: new Map<number, unknown>([
          [
            BaselinePackageIds.SHARED,
            {
              attackSpeed: 2.5,
              maxRange: 64,
              minRange: 2,
              accuracy: 25,
              damageType: 2,
              elementalType: 0,
              elementalValue: 0,
            },
          ],
        ]),
        firstSeenAt: 0,
        lastUpdatedAt: 0,
      };
      const fakeWorld = {
        get: (id: bigint) => (id === weaponId ? worldObj : undefined),
        objects: () => [].values(),
      };
      const localHandle = createCharacterSheet({
        dispatcher,
        playerNetworkId: PLAYER_ID,
        world: fakeWorld as unknown as Parameters<typeof createCharacterSheet>[0]['world'],
      });
      recv2(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNpBaseline({ currentWeapon: weaponId })));
      const w = localHandle.view.weapon;
      expect(w).not.toBeNull();
      expect(w?.minDamage).toBeNull();
      expect(w?.maxDamage).toBeNull();
      expect(w?.ammoRemaining).toBeNull();
      expect(w?.attackSpeed).toBe(2.5);
      expect(w?.range).toBe(64);
      localHandle.detach();
    });
  });

  describe('detach()', () => {
    it('stops further updates after detach', () => {
      setup();
      recv(creoSharedBaseline(PLAYER_ID, makeCreoSharedBaseline({ objectName: 'Before' })));
      expect(handle.view.name).toBe('Before');
      handle.detach();
      // A new baseline after detach must NOT update the view.
      recv(creoSharedBaseline(PLAYER_ID, makeCreoSharedBaseline({ objectName: 'After' })));
      expect(handle.view.name).toBe('Before');
    });

    it('is idempotent', () => {
      setup();
      handle.detach();
      expect(() => handle.detach()).not.toThrow();
    });
  });
});

describe('postureName', () => {
  it('maps known enumerators to display names', () => {
    expect(postureName(0)).toBe('standing');
    expect(postureName(1)).toBe('crouched');
    expect(postureName(2)).toBe('prone');
    expect(postureName(8)).toBe('sitting');
    expect(postureName(14)).toBe('dead');
  });

  it('returns "unknown" for out-of-range enumerators', () => {
    expect(postureName(-1)).toBe('unknown');
    expect(postureName(99)).toBe('unknown');
  });
});
