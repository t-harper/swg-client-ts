/**
 * CombatAction (CM_combatAction = 204) — server-to-client.
 *
 * The damage-tick / attack-resolution message for every observed combatant.
 * One CombatAction can carry multiple defenders (an AoE attack hits many
 * targets in a single packet). Each defender carries its own `defense`
 * outcome (miss / dodge / parry / block / hit / crit) and damage amount.
 *
 * The attacker block ALSO carries an optional world-space target location +
 * cell for location-based attacks (e.g. AoE-on-ground). That sub-block only
 * appears if `useLocation = true`.
 *
 * Wire layout (trailer only — the 20-byte ObjControllerMessage header is
 * peeled off upstream):
 *   [u32]                  actionId                  (CrcLowerString of action name)
 *   [NetworkId (i64 LE)]   attacker.id
 *   [NetworkId (i64 LE)]   attacker.weapon
 *   [i8]                   attacker.endPosture       (Postures::Enumerator)
 *   [u8]                   attacker.trailBits        (sfx trail bitfield)
 *   [u8]                   attacker.clientEffectId
 *   [i32]                  attacker.actionNameCrc
 *   [bool (1 byte)]        attacker.useLocation
 *   if useLocation:
 *     [3 x f32 LE]         attacker.targetLocation   (x, y, z world-space)
 *     [NetworkId (i64 LE)] attacker.targetCell
 *   [u16]                  defenderCount
 *   for each defender:
 *     [NetworkId (i64 LE)] defender.id
 *     [i8]                 defender.endPosture
 *     [u8]                 defender.defense          (CombatEngineData::CombatDefense)
 *     [u8]                 defender.clientEffectId
 *     [u8]                 defender.hitLocation
 *     [u16]                defender.damageAmount
 *
 * Source:
 *   /home/tharper/code/swg-main/src/game/shared/library/swgSharedNetworkMessages/src/shared/combat/MessageQueueCombatAction.cpp:414-519
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { Vector3Codec } from '../../../archive/transform.js';
import type { NetworkId, Vector3 } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface CombatActionAttacker {
  id: NetworkId;
  weapon: NetworkId;
  endPosture: number;
  trailBits: number;
  clientEffectId: number;
  actionNameCrc: number;
  useLocation: boolean;
  /** Only meaningful when `useLocation` is true; world-space coordinates. */
  targetLocation: Vector3;
  /** Only meaningful when `useLocation` is true; `0` for top-level/no cell. */
  targetCell: NetworkId;
}

export interface CombatActionDefender {
  id: NetworkId;
  endPosture: number;
  /** CombatDefense enum (CD_miss=0, CD_hit, CD_block, CD_evade, CD_redirect, ...). */
  defense: number;
  clientEffectId: number;
  hitLocation: number;
  damageAmount: number;
}

export interface CombatActionData {
  actionId: number;
  attacker: CombatActionAttacker;
  defenders: CombatActionDefender[];
}

export const CombatActionKind = 'CombatAction' as const;

export const CombatActionDecoder = registerObjControllerSubtype<CombatActionData>({
  kind: CombatActionKind,
  subtypeId: ObjControllerSubtypeIds.CM_combatAction,
  encode(stream: IByteStream, data: CombatActionData): void {
    stream.writeU32(data.actionId);

    const a = data.attacker;
    NetworkIdCodec.encode(stream, a.id);
    NetworkIdCodec.encode(stream, a.weapon);
    stream.writeI8(a.endPosture);
    stream.writeU8(a.trailBits);
    stream.writeU8(a.clientEffectId);
    stream.writeI32(a.actionNameCrc);
    stream.writeBool(a.useLocation);
    if (a.useLocation) {
      Vector3Codec.encode(stream, a.targetLocation);
      NetworkIdCodec.encode(stream, a.targetCell);
    }

    stream.writeU16(data.defenders.length);
    for (const d of data.defenders) {
      NetworkIdCodec.encode(stream, d.id);
      stream.writeI8(d.endPosture);
      stream.writeU8(d.defense);
      stream.writeU8(d.clientEffectId);
      stream.writeU8(d.hitLocation);
      stream.writeU16(d.damageAmount);
    }
  },
  decode(iter: IReadIterator): CombatActionData {
    const actionId = iter.readU32();

    const id = NetworkIdCodec.decode(iter);
    const weapon = NetworkIdCodec.decode(iter);
    const endPosture = iter.readI8();
    const trailBits = iter.readU8();
    const clientEffectId = iter.readU8();
    const actionNameCrc = iter.readI32();
    const useLocation = iter.readBool();
    let targetLocation: Vector3 = { x: 0, y: 0, z: 0 };
    let targetCell: NetworkId = 0n;
    if (useLocation) {
      targetLocation = Vector3Codec.decode(iter);
      targetCell = NetworkIdCodec.decode(iter);
    }
    const attacker: CombatActionAttacker = {
      id,
      weapon,
      endPosture,
      trailBits,
      clientEffectId,
      actionNameCrc,
      useLocation,
      targetLocation,
      targetCell,
    };

    const defenderCount = iter.readU16();
    const defenders: CombatActionDefender[] = [];
    for (let i = 0; i < defenderCount; i++) {
      defenders.push({
        id: NetworkIdCodec.decode(iter),
        endPosture: iter.readI8(),
        defense: iter.readU8(),
        clientEffectId: iter.readU8(),
        hitLocation: iter.readU8(),
        damageAmount: iter.readU16(),
      });
    }

    return { actionId, attacker, defenders };
  },
});
