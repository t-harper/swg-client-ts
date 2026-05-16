/**
 * CombatSpam (CM_combatSpam = 308) — server-to-client.
 *
 * The combat-log line for an observed combat resolution. Three discriminated
 * variants exist on the wire, distinguished by the leading `dataType` byte:
 *
 *   - `dataType = 0` (`attackDataWeaponObject`)  — full attack vs.
 *     defender using a known weapon object (NetworkId).
 *   - `dataType = 1` (`attackDataWeaponName`)    — same, but the weapon
 *     identity is a `StringId` (used when the weapon object isn't yet
 *     known to this observer, e.g. NPC weapons).
 *   - `dataType = 2` (`messageData`)             — pre-formatted Unicode
 *     spam line (`/me` chat, environment messages, etc.) with no per-hit
 *     accounting.
 *
 * For the headless client, all three carry the attacker / defender
 * positions and the per-attack flags (critical, glancing, proc, spamType).
 * The first two also nest a `success: bool`; if true, hit accounting
 * (rawDamage, blocked, evade, etc.) follows. If false, just `dodge` and
 * `parry` flags.
 *
 * Wire layout (trailer only — discriminated by `dataType`):
 *
 *   [u8]                  dataType
 *   [NetworkId (i64 LE)]  attacker
 *   [3 x f32 LE]          attackerPosition_w
 *   [NetworkId (i64 LE)]  defender
 *   [3 x f32 LE]          defenderPosition_w
 *
 *   if dataType == 0 (attackDataWeaponObject) || dataType == 1 (attackDataWeaponName):
 *     if dataType == 0:
 *       [NetworkId (i64 LE)] weapon
 *     else:
 *       [StringId]           weaponName     (std::string + i32 index + std::string)
 *     [StringId]             attackName
 *     [bool (1 byte)]        success
 *     if success:
 *       [NetworkId (i64 LE)] armor
 *       [i32]                rawDamage
 *       [i32]                damageType
 *       [i32]                elementalDamage
 *       [i32]                elementalDamageType
 *       [i32]                bleedDamage
 *       [i32]                critDamage
 *       [i32]                blockedDamage
 *       [i32]                finalDamage
 *       [i32]                hitLocation
 *       [bool (1)]           crushing
 *       [bool (1)]           strikethrough
 *       [f32]                strikethroughAmount
 *       [bool (1)]           evadeResult
 *       [f32]                evadeAmount
 *       [bool (1)]           blockResult
 *       [i32]                block
 *     else:
 *       [bool (1)]           dodge
 *       [bool (1)]           parry
 *   else (dataType == 2, messageData):
 *     [UnicodeString]       spamMessage     (u32 char-count + UTF-16 LE)
 *
 *   [bool (1)]              critical
 *   [bool (1)]              glancing
 *   [bool (1)]              proc
 *   [i32]                   spamType
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueCombatSpamArchive.cpp:30-121
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import { Vector3Codec } from '../../../archive/transform.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import type { NetworkId, Vector3 } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

/** CombatSpam variant discriminator. */
export const CombatSpamDataType = {
  AttackDataWeaponObject: 0,
  AttackDataWeaponName: 1,
  MessageData: 2,
} as const;
export type CombatSpamDataType = (typeof CombatSpamDataType)[keyof typeof CombatSpamDataType];

/**
 * StringId on the wire: `std::string table`, `unsigned long textIndex`,
 * `std::string name`. The C++ codec parses then drops the index back to 0,
 * but we round-trip it verbatim for fidelity.
 *
 * Source: /home/tharper/code/swg-main/src/external/ours/library/localizationArchive/src/shared/StringIdArchive.cpp
 */
export interface StringIdValue {
  table: string;
  textIndex: number;
  name: string;
}

function readStringId(iter: IReadIterator): StringIdValue {
  const table = readStdString(iter);
  const textIndex = iter.readU32();
  const name = readStdString(iter);
  return { table, textIndex, name };
}

function writeStringId(stream: IByteStream, v: StringIdValue): void {
  writeStdString(stream, v.table);
  stream.writeU32(v.textIndex);
  writeStdString(stream, v.name);
}

/** Hit-accounting fields only present when `success = true`. */
export interface CombatSpamHitDetails {
  armor: NetworkId;
  rawDamage: number;
  damageType: number;
  elementalDamage: number;
  elementalDamageType: number;
  bleedDamage: number;
  critDamage: number;
  blockedDamage: number;
  finalDamage: number;
  hitLocation: number;
  crushing: boolean;
  strikethrough: boolean;
  strikethroughAmount: number;
  evadeResult: boolean;
  evadeAmount: number;
  blockResult: boolean;
  block: number;
}

/** Miss fields only present when `success = false`. */
export interface CombatSpamMissDetails {
  dodge: boolean;
  parry: boolean;
}

export interface CombatSpamData {
  dataType: CombatSpamDataType;
  attacker: NetworkId;
  attackerPosition: Vector3;
  defender: NetworkId;
  defenderPosition: Vector3;
  /** Present iff dataType == AttackDataWeaponObject. */
  weapon?: NetworkId;
  /** Present iff dataType == AttackDataWeaponName. */
  weaponName?: StringIdValue;
  /** Present iff dataType in {AttackDataWeaponObject, AttackDataWeaponName}. */
  attackName?: StringIdValue;
  /** Present iff dataType in {AttackDataWeaponObject, AttackDataWeaponName}. */
  success?: boolean;
  /** Present iff success == true. */
  hitDetails?: CombatSpamHitDetails;
  /** Present iff success == false. */
  missDetails?: CombatSpamMissDetails;
  /** Present iff dataType == MessageData. */
  spamMessage?: string;
  critical: boolean;
  glancing: boolean;
  proc: boolean;
  spamType: number;
}

export const CombatSpamKind = 'CombatSpam' as const;

export const CombatSpamDecoder = registerObjControllerSubtype<CombatSpamData>({
  kind: CombatSpamKind,
  subtypeId: ObjControllerSubtypeIds.CM_combatSpam,
  encode(stream: IByteStream, data: CombatSpamData): void {
    stream.writeU8(data.dataType);
    NetworkIdCodec.encode(stream, data.attacker);
    Vector3Codec.encode(stream, data.attackerPosition);
    NetworkIdCodec.encode(stream, data.defender);
    Vector3Codec.encode(stream, data.defenderPosition);

    if (
      data.dataType === CombatSpamDataType.AttackDataWeaponObject ||
      data.dataType === CombatSpamDataType.AttackDataWeaponName
    ) {
      if (data.dataType === CombatSpamDataType.AttackDataWeaponObject) {
        if (data.weapon === undefined) {
          throw new Error(
            'CombatSpam encode: weapon required when dataType=AttackDataWeaponObject',
          );
        }
        NetworkIdCodec.encode(stream, data.weapon);
      } else {
        if (data.weaponName === undefined) {
          throw new Error(
            'CombatSpam encode: weaponName required when dataType=AttackDataWeaponName',
          );
        }
        writeStringId(stream, data.weaponName);
      }
      if (data.attackName === undefined) {
        throw new Error('CombatSpam encode: attackName required for attack-data variants');
      }
      writeStringId(stream, data.attackName);
      const success = data.success === true;
      stream.writeBool(success);
      if (success) {
        if (data.hitDetails === undefined) {
          throw new Error('CombatSpam encode: hitDetails required when success=true');
        }
        const h = data.hitDetails;
        NetworkIdCodec.encode(stream, h.armor);
        stream.writeI32(h.rawDamage);
        stream.writeI32(h.damageType);
        stream.writeI32(h.elementalDamage);
        stream.writeI32(h.elementalDamageType);
        stream.writeI32(h.bleedDamage);
        stream.writeI32(h.critDamage);
        stream.writeI32(h.blockedDamage);
        stream.writeI32(h.finalDamage);
        stream.writeI32(h.hitLocation);
        stream.writeBool(h.crushing);
        stream.writeBool(h.strikethrough);
        stream.writeF32(h.strikethroughAmount);
        stream.writeBool(h.evadeResult);
        stream.writeF32(h.evadeAmount);
        stream.writeBool(h.blockResult);
        stream.writeI32(h.block);
      } else {
        if (data.missDetails === undefined) {
          throw new Error('CombatSpam encode: missDetails required when success=false');
        }
        stream.writeBool(data.missDetails.dodge);
        stream.writeBool(data.missDetails.parry);
      }
    } else {
      if (data.spamMessage === undefined) {
        throw new Error('CombatSpam encode: spamMessage required when dataType=MessageData');
      }
      writeUnicodeString(stream, data.spamMessage);
    }

    stream.writeBool(data.critical);
    stream.writeBool(data.glancing);
    stream.writeBool(data.proc);
    stream.writeI32(data.spamType);
  },
  decode(iter: IReadIterator): CombatSpamData {
    const dataType = iter.readU8() as CombatSpamDataType;
    const attacker = NetworkIdCodec.decode(iter);
    const attackerPosition = Vector3Codec.decode(iter);
    const defender = NetworkIdCodec.decode(iter);
    const defenderPosition = Vector3Codec.decode(iter);

    const out: CombatSpamData = {
      dataType,
      attacker,
      attackerPosition,
      defender,
      defenderPosition,
      critical: false,
      glancing: false,
      proc: false,
      spamType: 0,
    };

    if (
      dataType === CombatSpamDataType.AttackDataWeaponObject ||
      dataType === CombatSpamDataType.AttackDataWeaponName
    ) {
      if (dataType === CombatSpamDataType.AttackDataWeaponObject) {
        out.weapon = NetworkIdCodec.decode(iter);
      } else {
        out.weaponName = readStringId(iter);
      }
      out.attackName = readStringId(iter);
      const success = iter.readBool();
      out.success = success;
      if (success) {
        out.hitDetails = {
          armor: NetworkIdCodec.decode(iter),
          rawDamage: iter.readI32(),
          damageType: iter.readI32(),
          elementalDamage: iter.readI32(),
          elementalDamageType: iter.readI32(),
          bleedDamage: iter.readI32(),
          critDamage: iter.readI32(),
          blockedDamage: iter.readI32(),
          finalDamage: iter.readI32(),
          hitLocation: iter.readI32(),
          crushing: iter.readBool(),
          strikethrough: iter.readBool(),
          strikethroughAmount: iter.readF32(),
          evadeResult: iter.readBool(),
          evadeAmount: iter.readF32(),
          blockResult: iter.readBool(),
          block: iter.readI32(),
        };
      } else {
        out.missDetails = {
          dodge: iter.readBool(),
          parry: iter.readBool(),
        };
      }
    } else {
      out.spamMessage = readUnicodeString(iter);
    }

    out.critical = iter.readBool();
    out.glancing = iter.readBool();
    out.proc = iter.readBool();
    out.spamType = iter.readI32();
    return out;
  },
});
