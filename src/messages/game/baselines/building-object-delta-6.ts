/**
 * BuildingObject DELTAS_SHARED_NP (packageId 6) — server-to-client.
 *
 * Delta counterpart to `BuildingObjectSharedNpDecoder` (the baseline decoder
 * for the same `(typeId, packageId)` pair). Carries incremental updates to
 * the transient (non-persisted) shared state on a `BuildingObject` —
 * combat-state toggles, access-list adds/removes, guild-access-list
 * adds/removes, passive-reveal player toggles, map-color changes, and the
 * effects-map mutations (e.g. a chimney smoke effect getting added when a
 * fireplace is lit, or a structure-damage effect getting set/cleared).
 *
 * Since `BuildingObject extends TangibleObject extends ServerObject` and
 * `BuildingObject::addMembersToPackages` contributes ZERO `addServerVariable_np`
 * shared fields of its own, this package's fields are identical in shape and
 * order to `TangibleObject` SHARED_NP — but the wire `typeId` is `BUIO`, so
 * a separate decoder registration is required.
 *
 * Field order (matches `BuildingObjectSharedNpBaseline.decode()` 1:1):
 *
 *   ServerObject section (2 fields):
 *     index 0 — authServerProcessId             (u32)
 *     index 1 — descriptionStringId             (StringId)
 *
 *   TangibleObject section (6 fields):
 *     index 2 — inCombat                        (u8 bool)
 *     index 3 — passiveRevealPlayerCharacter    (AutoDeltaSet<NetworkId>)
 *     index 4 — mapColorOverride                (u32)
 *     index 5 — accessList                      (AutoDeltaSet<NetworkId>)
 *     index 6 — guildAccessList                 (AutoDeltaSet<i32>)
 *     index 7 — effects                         (AutoDeltaMap<string, pair<string, pair<string, pair<Vector, float>>>>)
 *
 *   BuildingObject section: (none)
 *
 * Total: 8 fields, matching `BuildingObjectSharedNpDecoder.expectedMemberCount`.
 *
 * Source for the field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 589-590 (ServerObject SHARED_NP — 2 lines),
 *   lines 718-723 (TangibleObject SHARED_NP — 6 lines),
 *   lines 64-73   (BuildingObject — no `addSharedVariable_np` calls).
 *
 * # AutoDelta* container fields
 *
 *   index 3 (passiveRevealPlayerCharacter) — AutoDeltaSet<NetworkId>
 *   index 5 (accessList)                   — AutoDeltaSet<NetworkId>
 *   index 6 (guildAccessList)              — AutoDeltaSet<i32>
 *   index 7 (effects)                      — AutoDeltaMap<string, value>
 *
 *   Each container delta encodes a sequence of commands rather than the full
 *   container state. See `auto-delta-delta-codecs.ts` for the wire layouts.
 *
 * # `effects` map value shape
 *
 *   The C++ type is `pair<string, pair<string, pair<Vector, float>>>`, which
 *   packs as: [std::string effectScript][std::string hardpoint][f32 x][f32 y][f32 z][f32 scale].
 *   No length prefix, no command byte at the value level (only at the outer
 *   map-level command byte). Mirrors `building-object-baseline-6.ts`.
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString } from '../../../archive/string.js';
import type { Vector3 } from '../../../types.js';
import { readAutoDeltaMapDelta, readAutoDeltaSetDelta } from './auto-delta-delta-codecs.js';
import type { BuildingObjectSharedNpBaseline } from './building-object-baseline-6.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';

export const BuildingObjectSharedNpDeltaKind = 'BuildingObjectSharedNpDelta' as const;

/**
 * Reader for one `m_effectsMap` value:
 *   pair<string, pair<string, pair<Vector, float>>>
 *
 * Mirrors `building-object-baseline-6.ts`'s effect-value reader. The C++
 * `pair` packs concatenate without any framing — read in declaration order.
 */
function readEffectMapValue(iter: IReadIterator): {
  effectScript: string;
  hardpoint: string;
  offset: Vector3;
  scale: number;
} {
  const effectScript = readStdString(iter);
  const hardpoint = readStdString(iter);
  const x = iter.readF32();
  const y = iter.readF32();
  const z = iter.readF32();
  const scale = iter.readF32();
  return { effectScript, hardpoint, offset: { x, y, z }, scale };
}

export const BuildingObjectSharedNpDeltaDecoder: DeltaPackageDecoder<BuildingObjectSharedNpBaseline> =
  registerDelta<BuildingObjectSharedNpBaseline>({
    kind: BuildingObjectSharedNpDeltaKind,
    typeId: ObjectTypeTags.BUIO,
    packageId: BaselinePackageIds.SHARED_NP,
    fields: [
      // ---- ServerObject SHARED_NP (2 fields) ----
      { name: 'authServerProcessId', decode: (i) => i.readU32() },
      { name: 'descriptionStringId', decode: (i) => StringIdCodec.decode(i) },
      // ---- TangibleObject SHARED_NP (6 fields) ----
      { name: 'inCombat', decode: (i) => i.readBool() },
      {
        name: 'passiveRevealPlayerCharacter',
        decode: (i) => readAutoDeltaSetDelta(i, NetworkIdCodec.decode),
      },
      { name: 'mapColorOverride', decode: (i) => i.readU32() },
      {
        name: 'accessList',
        decode: (i) => readAutoDeltaSetDelta(i, NetworkIdCodec.decode),
      },
      {
        name: 'guildAccessList',
        decode: (i) => readAutoDeltaSetDelta(i, (j) => j.readI32()),
      },
      {
        name: 'effects',
        decode: (i) => readAutoDeltaMapDelta(i, readStdString, readEffectMapValue),
      },
      // ---- BuildingObject SHARED_NP: no fields ----
    ],
  });
