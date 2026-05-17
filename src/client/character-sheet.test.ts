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

import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import type { CreatureObjectClientServerBaseline } from '../messages/game/baselines/creature-object-baseline-1.js';
import { CreatureObjectClientServerKind } from '../messages/game/baselines/creature-object-baseline-1.js';
import type { CreatureObjectSharedBaseline } from '../messages/game/baselines/creature-object-baseline-3.js';
import { CreatureObjectSharedKind } from '../messages/game/baselines/creature-object-baseline-3.js';
import type { CreatureObjectSharedNpBaseline } from '../messages/game/baselines/creature-object-baseline-6.js';
import { CreatureObjectSharedNpKind } from '../messages/game/baselines/creature-object-baseline-6.js';
import { DeltasMessage } from '../messages/game/baselines/deltas-message.js';
import { EMPTY_STRING_ID, PlayerObjectSharedKind } from '../messages/game/baselines/index.js';
import type { PlayerObjectClientServerBaseline } from '../messages/game/baselines/player-object-baseline-1.js';
import { PlayerObjectClientServerKind } from '../messages/game/baselines/player-object-baseline-1.js';
import type { PlayerObjectSharedBaseline } from '../messages/game/baselines/player-object-baseline-3.js';
import { BaselinePackageIds, ObjectTypeTags } from '../messages/game/baselines/registry.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import {
  ObjControllerSubtypeIds,
  PostureChangeKind,
} from '../messages/game/obj-controller/index.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import { type CharacterSheetHandle, createCharacterSheet, postureName } from './character-sheet.js';
import type { MessageDispatcher } from './dispatcher.js';

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
