/**
 * TangibleObject DELTAS_SHARED_NP (packageId 6) — server-to-client.
 *
 * Delta counterpart to `TangibleObjectSharedNpDecoder` (the baseline decoder
 * for the same `(typeId, packageId)` pair). The "SHARED_NP" package is the
 * publicly-broadcast, NOT-persisted transient state — combat-state toggles,
 * map-color tint changes, access-list edits (cells/buildings/etc.), guild
 * access edits, and visual-effect attachments arriving/leaving on the object.
 *
 * Field order (matches `TangibleObjectSharedNpBaseline.decode()` read order
 * exactly — see `tangible-object-baseline-6.ts`):
 *
 *   ServerObject section (2 fields):
 *     index 0 — authServerProcessId         (u32)
 *     index 1 — descriptionStringId         (StringId)
 *
 *   TangibleObject section (6 fields):
 *     index 2 — inCombat                    (u8 bool)
 *     index 3 — passiveRevealPlayerCharacter (AutoDeltaSet<NetworkId>)
 *     index 4 — mapColorOverride            (u32)
 *     index 5 — accessList                  (AutoDeltaSet<NetworkId>)
 *     index 6 — guildAccessList             (AutoDeltaSet<i32>)
 *     index 7 — effects                     (AutoDeltaMap<string, pair<string, pair<string, pair<Vector, float>>>>)
 *
 * Total: 8 fields, matching `TangibleObjectSharedNpDecoder.expectedMemberCount`.
 *
 * Source for the field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 589-590 (ServerObject SHARED_NP — 2 lines)
 *   lines 718-723 (TangibleObject SHARED_NP — 6 lines)
 *
 * # AutoDelta* container fields
 *
 *   index 3 (passiveRevealPlayerCharacter), index 5 (accessList) —
 *     AutoDeltaSet<NetworkId>; delta wire format is a sequence of
 *     ERASE/INSERT/CLEAR commands (see `readAutoDeltaSetDelta`).
 *
 *   index 6 (guildAccessList) — AutoDeltaSet<i32>; same command grammar
 *     as above but with i32 values.
 *
 *   index 7 (effects) — AutoDeltaMap whose value is
 *     `pair<string, pair<string, pair<Vector, float>>>`. The wire layout
 *     for one value: [std::string effectScript][std::string hardpoint]
 *     [f32 x][f32 y][f32 z][f32 scale] — no length prefix, no command
 *     byte at the value level (only at the outer map level). Mirrors
 *     the baseline helper inline in `tangible-object-baseline-6.ts`.
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString } from '../../../archive/string.js';
import type { Vector3 } from '../../../types.js';
import { readAutoDeltaMapDelta, readAutoDeltaSetDelta } from './auto-delta-delta-codecs.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';
import type { TangibleObjectSharedNpBaseline } from './tangible-object-baseline-6.js';

export const TangibleObjectSharedNpDeltaKind = 'TangibleObjectSharedNpDelta' as const;

/**
 * Reader for one `m_effectsMap` value:
 *   pair<string, pair<string, pair<Vector, float>>>
 *
 * Mirrors `tangible-object-baseline-6.ts`'s inline value reader. The C++
 * pair packs concatenate without any framing — read in declaration order.
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

export const TangibleObjectSharedNpDeltaDecoder: DeltaPackageDecoder<TangibleObjectSharedNpBaseline> =
  registerDelta<TangibleObjectSharedNpBaseline>({
    kind: TangibleObjectSharedNpDeltaKind,
    typeId: ObjectTypeTags.TANO,
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
    ],
  });
