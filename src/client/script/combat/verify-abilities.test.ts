import { describe, expect, it, vi } from 'vitest';

import {
  type CreatureObjectClientServerNpBaseline,
  CreatureObjectClientServerNpKind,
} from '../../../messages/game/baselines/creature-object-baseline-4.js';
import { BaselinePackageIds, ObjectTypeTags } from '../../../messages/game/baselines/registry.js';
import type { NetworkId, Vector3 } from '../../../types.js';
import type { WorldModel, WorldObject } from '../../world-model.js';
import type { ProfessionId, Rotation } from './types.js';
import { readKnownCommands, verifyAbilities } from './verify-abilities.js';

function makeWorld(
  playerId: NetworkId,
  baseline?: Partial<CreatureObjectClientServerNpBaseline>,
): WorldModel {
  const objects = new Map<NetworkId, WorldObject>();
  if (baseline !== undefined) {
    const baselines = new Map<number, unknown>();
    baselines.set(BaselinePackageIds.CLIENT_SERVER_NP, baseline);
    const obj: WorldObject = {
      id: playerId,
      typeId: ObjectTypeTags.CREO,
      typeIdString: 'CREO',
      position: { x: 0, y: 0, z: 0 } as Vector3,
      yaw: 0,
      parentCell: 0n,
      cellPosition: { x: 0, y: 0, z: 0 } as Vector3,
      containerId: 0n,
      slotArrangement: -1,
      hyperspace: false,
      baselines,
      firstSeenAt: 0,
      lastUpdatedAt: 0,
    };
    objects.set(playerId, obj);
  }
  return {
    get(id: NetworkId): WorldObject | undefined {
      return objects.get(id);
    },
  } as unknown as WorldModel;
}

const minimalRotation = (
  profession: ProfessionId,
  signatureAbilities: readonly string[],
): Rotation => ({
  profession,
  opener: [],
  combo: [],
  filler: { id: 'filler', ability: 'attack', fallbackCooldownMs: 1500 },
  panic: {},
  signatureAbilities,
});

describe('verifyAbilities', () => {
  const playerId = 0xdeadbeefn;

  it('returns ok when every signature ability is present', () => {
    const world = makeWorld(playerId, {
      commands: [
        { name: 'attack', level: 0 },
        { name: 'BH_DREAD_STRIKE_5', level: 0 },
        { name: 'bh_sh_3', level: 0 },
      ],
    });
    const result = verifyAbilities(
      { world, sceneStart: { playerNetworkId: playerId } },
      'bounty_hunter',
      {
        rotation: minimalRotation('bounty_hunter', ['attack', 'bh_dread_strike_5', 'bh_sh_3']),
        logFn: () => {},
      },
    );
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.knownCount).toBe(3);
  });

  it('reports missing abilities and warns once when any are absent', () => {
    const world = makeWorld(playerId, {
      commands: [{ name: 'attack', level: 0 }],
    });
    const logs: string[] = [];
    const result = verifyAbilities(
      { world, sceneStart: { playerNetworkId: playerId } },
      'commando',
      {
        rotation: minimalRotation('commando', ['attack', 'co_sh_3', 'co_armor_cracker']),
        logFn: (msg) => logs.push(msg),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['co_sh_3', 'co_armor_cracker']);
    expect(result.knownCount).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[combat:commando]');
    expect(logs[0]).toContain('missing 2 signature abilities');
    expect(logs[0]).toContain('co_sh_3');
  });

  it('treats missing CREO baseline as zero known commands', () => {
    const world = makeWorld(playerId);
    const result = verifyAbilities({ world, sceneStart: { playerNetworkId: playerId } }, 'spy', {
      rotation: minimalRotation('spy', ['attack', 'sp_sh_3']),
      logFn: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.knownCount).toBe(0);
    expect(result.missing).toEqual(['attack', 'sp_sh_3']);
  });

  it('lowercases comparison so case-mismatched grants still count', () => {
    const world = makeWorld(playerId, {
      commands: [
        { name: 'ATTACK', level: 0 },
        { name: 'Bh_Sh_3', level: 0 },
      ],
    });
    const result = verifyAbilities(
      { world, sceneStart: { playerNetworkId: playerId } },
      'bounty_hunter',
      {
        rotation: minimalRotation('bounty_hunter', ['attack', 'bh_sh_3']),
        logFn: () => {},
      },
    );
    expect(result.ok).toBe(true);
    expect(result.knownCount).toBe(2);
  });

  it('defaults to console.warn when no logFn supplied', () => {
    const world = makeWorld(playerId, { commands: [] });
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = verifyAbilities({ world, sceneStart: { playerNetworkId: playerId } }, 'jedi', {
        rotation: minimalRotation('jedi', ['fs_flurry_7']),
      });
      expect(result.ok).toBe(false);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('readKnownCommands', () => {
  const playerId = 0xabcdn;

  it('returns lowercase set of every command name', () => {
    const world = makeWorld(playerId, {
      commands: [
        { name: 'Attack', level: 0 },
        { name: 'BH_DM_8', level: 1 },
        { name: 'bh_sh_3', level: 0 },
      ],
    });
    const cmds = readKnownCommands({
      world,
      sceneStart: { playerNetworkId: playerId },
    });
    expect(cmds.has('attack')).toBe(true);
    expect(cmds.has('bh_dm_8')).toBe(true);
    expect(cmds.has('bh_sh_3')).toBe(true);
    expect(cmds.size).toBe(3);
  });

  it('returns empty set when commands field absent', () => {
    const world = makeWorld(playerId, {});
    const cmds = readKnownCommands({
      world,
      sceneStart: { playerNetworkId: playerId },
    });
    expect(cmds.size).toBe(0);
  });

  // Keep CreatureObjectClientServerNpKind referenced to confirm import path is wired.
  it('imports the CreatureObjectClientServerNpKind decoder kind', () => {
    expect(CreatureObjectClientServerNpKind).toBe('CreatureObjectClientServerNp');
  });
});
