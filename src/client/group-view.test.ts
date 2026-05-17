/**
 * GroupView unit tests.
 *
 * Synthesizes BaselinesMessages with pre-decoded data and drives them
 * through the WorldModel inside a `createFakeContext` so we exercise the
 * real `ctx.group` integration. Wire-format encoders aren't run — the
 * production code path takes the already-decoded `data` from the
 * registry, and so do we.
 */

import { describe, expect, it } from 'vitest';

import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import type { CreatureObjectSharedNpBaseline } from '../messages/game/baselines/creature-object-baseline-6.js';
import { CreatureObjectSharedNpKind } from '../messages/game/baselines/creature-object-baseline-6.js';
import type { CreatureObjectSharedBaseline } from '../messages/game/baselines/creature-object-baseline-3.js';
import { CreatureObjectSharedKind } from '../messages/game/baselines/creature-object-baseline-3.js';
import type { GroupObjectSharedNpBaseline } from '../messages/game/baselines/group-object-baseline-6.js';
import { GroupObjectSharedNpKind } from '../messages/game/baselines/group-object-baseline-6.js';
import { EMPTY_STRING_ID } from '../messages/game/baselines/index.js';
import { BaselinePackageIds, ObjectTypeTags } from '../messages/game/baselines/registry.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import {
  type NetUpdateTransformData,
  NetUpdateTransformKind,
  ObjControllerSubtypeIds,
} from '../messages/game/obj-controller/index.js';
import { UpdateTransformMessage } from '../messages/game/update-transform-message.js';
import { createFakeContext } from './script/test-helpers.js';

// Side-effect: register all baseline + delta decoders so typeCrc lookups work.
import '../messages/game/baselines/index.js';

const PLAYER_ID = 0x1234n;
const GROUP_ID = 0xddddn;
const LEADER_ID = PLAYER_ID;
const BOB_ID = 0xb0bn;
const CAROL_ID = 0xca501n;

function makeCreoSharedNp(
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
    level: 1,
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

function makeCreoShared(
  partial: Partial<CreatureObjectSharedBaseline> = {},
): CreatureObjectSharedBaseline {
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
    count: 0,
    damageTaken: 0,
    maxHitPoints: 1000,
    visible: true,
    posture: 0,
    rank: 0,
    masterId: 0n,
    scaleFactor: 1,
    shockWounds: 0,
    states: 0n,
    ...partial,
  };
}

function creoSharedBaseline(target: bigint, data: CreatureObjectSharedBaseline): BaselinesMessage {
  return new BaselinesMessage(target, ObjectTypeTags.CREO, BaselinePackageIds.SHARED, new Uint8Array(0), {
    kind: CreatureObjectSharedKind,
    data,
  });
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

function groupSharedNpBaseline(
  target: bigint,
  data: GroupObjectSharedNpBaseline,
): BaselinesMessage {
  return new BaselinesMessage(
    target,
    ObjectTypeTags.GRUP,
    BaselinePackageIds.SHARED_NP,
    new Uint8Array(0),
    { kind: GroupObjectSharedNpKind, data },
  );
}

function makeGroupSharedNp(partial: Partial<GroupObjectSharedNpBaseline> = {}): GroupObjectSharedNpBaseline {
  return {
    authServerProcessId: 0,
    descriptionStringId: EMPTY_STRING_ID,
    members: [],
    shipFormationMembers: [],
    groupName: '',
    groupLevel: 0,
    formationNameCrc: 0,
    lootMaster: 0n,
    lootRule: 0,
    pickupTimer: { startTime: 0, endTime: 0 },
    pickupLocation: { planetName: '', position: { x: 0, y: 0, z: 0 } },
    ...partial,
  };
}

describe('GroupView (ctx.group)', () => {
  it('returns id=null and empty members when not in a group', () => {
    const { ctx } = createFakeContext({ playerNetworkId: PLAYER_ID });
    expect(ctx.group.id).toBe(null);
    expect(ctx.group.size).toBe(0);
    expect(ctx.group.leader).toBe(null);
    expect(ctx.group.members).toEqual([]);
  });

  it('populates id+members+leader from CREO + GroupObject baselines', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });

    // Player joins group.
    simulateRecv(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNp({ group: GROUP_ID })));

    // GroupObject roster arrives.
    simulateRecv(
      groupSharedNpBaseline(
        GROUP_ID,
        makeGroupSharedNp({
          members: [
            { id: LEADER_ID, name: 'Leader' },
            { id: BOB_ID, name: 'Bob' },
            { id: CAROL_ID, name: 'Carol' },
          ],
          lootMaster: LEADER_ID,
          groupLevel: 10,
        }),
      ),
    );

    expect(ctx.group.id).toBe(GROUP_ID);
    expect(ctx.group.size).toBe(3);
    expect(ctx.group.leader?.name).toBe('Leader');
    expect(ctx.group.members.map((m) => m.name)).toEqual(['Leader', 'Bob', 'Carol']);
  });

  it('joins member CREO baselines for live position/health/posture', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });

    simulateRecv(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNp({ group: GROUP_ID })));
    simulateRecv(
      groupSharedNpBaseline(
        GROUP_ID,
        makeGroupSharedNp({
          members: [
            { id: LEADER_ID, name: 'Leader' },
            { id: BOB_ID, name: 'Bob' },
          ],
        }),
      ),
    );

    // Bob's CREO baselines: posture sitting, health 500/1000.
    simulateRecv(creoSharedBaseline(BOB_ID, makeCreoShared({ posture: 8 /* sitting */ })));
    simulateRecv(
      creoSharedNpBaseline(
        BOB_ID,
        makeCreoSharedNp({
          totalAttributes: [500, 0, 700, 0, 600, 0],
          totalMaxAttributes: [1000, 0, 900, 0, 800, 0],
        }),
      ),
    );

    const bob = ctx.group.members.find((m) => m.id === BOB_ID);
    expect(bob).toBeDefined();
    expect(bob?.posture).toBe('sitting');
    expect(bob?.health?.current).toBe(500);
    expect(bob?.health?.max).toBe(1000);
  });

  it('returns null health/posture when a member CREO has not been observed', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });

    simulateRecv(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNp({ group: GROUP_ID })));
    simulateRecv(
      groupSharedNpBaseline(
        GROUP_ID,
        makeGroupSharedNp({
          members: [
            { id: LEADER_ID, name: 'Leader' },
            { id: CAROL_ID, name: 'Carol-Offline' },
          ],
        }),
      ),
    );

    const carol = ctx.group.members.find((m) => m.id === CAROL_ID);
    expect(carol).toBeDefined();
    expect(carol?.health).toBe(null);
    expect(carol?.posture).toBe(null);
    expect(carol?.position).toBe(null);
  });

  it('returns empty members when GroupObject baseline has not arrived yet', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    // Player knows they're in a group but the GroupObject hasn't been pushed.
    simulateRecv(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNp({ group: GROUP_ID })));
    expect(ctx.group.id).toBe(GROUP_ID);
    expect(ctx.group.size).toBe(0);
    expect(ctx.group.members).toEqual([]);
  });

  it('follow(leaderId) mirrors leader UpdateTransformMessage as our own CM_netUpdateTransform', () => {
    const { ctx, simulateRecv, sent } = createFakeContext({ playerNetworkId: PLAYER_ID });

    // Subscribe to leader's transforms.
    const unsub = ctx.group.follow(BOB_ID);

    // Server broadcasts Bob's transform: position (40, 0, -20), seq 5.
    // UpdateTransformMessage wire is i16 * 4 (1/4-metre resolution).
    simulateRecv(new UpdateTransformMessage(BOB_ID, 160, 0, -80, 5, 0, 0, 0, 0));

    // Our send list should now contain one CM_netUpdateTransform whose
    // networkId is OUR player id, sourced at Bob's (decoded) position.
    const mirror = sent.find(
      (m): m is ObjControllerMessage =>
        m instanceof ObjControllerMessage &&
        m.message === ObjControllerSubtypeIds.CM_netUpdateTransform,
    );
    expect(mirror).toBeDefined();
    expect(mirror?.networkId).toBe(PLAYER_ID);
    expect(mirror?.decodedSubtype?.kind).toBe(NetUpdateTransformKind);
    const data = mirror?.decodedSubtype?.data as NetUpdateTransformData;
    expect(data.position.x).toBeCloseTo(40, 4);
    expect(data.position.z).toBeCloseTo(-20, 4);
    // speed is always 0 (server derives it from positional delta).
    expect(data.speed).toBe(0);

    unsub();

    // After unsub, no further mirrors.
    const before = sent.length;
    simulateRecv(new UpdateTransformMessage(BOB_ID, 200, 0, 0, 6, 0, 0, 0, 0));
    expect(sent.length).toBe(before);
  });

  it('follow() ignores transforms for other ids', () => {
    const { ctx, simulateRecv, sent } = createFakeContext({ playerNetworkId: PLAYER_ID });
    ctx.group.follow(BOB_ID);
    // A transform for someone else — should be ignored.
    simulateRecv(new UpdateTransformMessage(CAROL_ID, 100, 0, 0, 1, 0, 0, 0, 0));
    const mirror = sent.find(
      (m): m is ObjControllerMessage =>
        m instanceof ObjControllerMessage &&
        m.message === ObjControllerSubtypeIds.CM_netUpdateTransform,
    );
    expect(mirror).toBeUndefined();
  });
});
