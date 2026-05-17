/**
 * GuildView unit tests.
 *
 * The guild view is intentionally minimal — most guild data lives in
 * the SERVER-only GuildObject package the client never sees. We test
 * the wire-visible surface: numeric `guildId` from CREO, and best-effort
 * `abbrev` from any GuildObject SHARED baseline that lands.
 */

import { describe, expect, it } from 'vitest';

import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import type { CreatureObjectSharedNpBaseline } from '../messages/game/baselines/creature-object-baseline-6.js';
import { CreatureObjectSharedNpKind } from '../messages/game/baselines/creature-object-baseline-6.js';
import { EMPTY_STRING_ID } from '../messages/game/baselines/index.js';
import { BaselinePackageIds, ObjectTypeTags } from '../messages/game/baselines/registry.js';
import { createFakeContext } from './script/test-helpers.js';

import '../messages/game/baselines/index.js';

const PLAYER_ID = 0x1234n;
const GUILD_OBJ_ID = 0xeeeen;

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

/**
 * Synthesize a GuildObject SHARED baseline with the abbrev set. We don't
 * have a decoder for GUIO SHARED yet — pass the typed data through the
 * `decodedBaseline` shortcut so the WorldModel sees it.
 */
function guildSharedBaseline(target: bigint, abbrevs: string[]): BaselinesMessage {
  return new BaselinesMessage(
    target,
    ObjectTypeTags.GILD,
    BaselinePackageIds.SHARED,
    new Uint8Array(0),
    { kind: 'GuildObjectShared', data: { abbrevs } },
  );
}

describe('GuildView (ctx.guild)', () => {
  it('starts with id=0 and all-null fields', () => {
    const { ctx } = createFakeContext({ playerNetworkId: PLAYER_ID });
    expect(ctx.guild.id).toBe(0);
    expect(ctx.guild.name).toBe(null);
    expect(ctx.guild.abbrev).toBe(null);
    expect(ctx.guild.rank).toBe(null);
    expect(ctx.guild.members).toEqual([]);
  });

  it('reads guildId from the player CREO SHARED_NP baseline', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    simulateRecv(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNp({ guildId: 99 })));
    expect(ctx.guild.id).toBe(99);
  });

  it('surfaces abbrev from GuildObject SHARED baseline when there is exactly one abbrev', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    simulateRecv(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNp({ guildId: 42 })));
    simulateRecv(guildSharedBaseline(GUILD_OBJ_ID, ['JEDI']));
    expect(ctx.guild.abbrev).toBe('JEDI');
  });

  it('returns null abbrev when GuildObject baseline carries multiple abbrevs (cannot disambiguate)', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    simulateRecv(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNp({ guildId: 42 })));
    simulateRecv(guildSharedBaseline(GUILD_OBJ_ID, ['JEDI', 'SITH']));
    // Multiple abbrevs without a guildId→abbrev mapping ⇒ can't pick ours.
    expect(ctx.guild.abbrev).toBe(null);
  });

  it('returns empty abbrev when GuildObject SHARED baseline is absent', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    simulateRecv(creoSharedNpBaseline(PLAYER_ID, makeCreoSharedNp({ guildId: 7 })));
    expect(ctx.guild.id).toBe(7);
    expect(ctx.guild.abbrev).toBe(null);
  });
});
