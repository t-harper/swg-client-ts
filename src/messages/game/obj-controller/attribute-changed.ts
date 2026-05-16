/**
 * AttributeChanged (CM_alterHitPoints = 384) — server-to-client.
 *
 * The damage-tick / heal-tick message. Delivers an integer delta to apply
 * to the recipient's hit points along with the source that caused the
 * change (attacker NetworkId, or `cms_invalid` (0) for self-induced like
 * burn/dot/regen).
 *
 * The C++ name is `alterHitPoints`, but the spec'd subtype covers the
 * HAM (Health, Action, Mind) channel updates as well — the server uses
 * the same controller-message id for any direct hit-point delta to keep
 * the client-side observer logic simple. (`CM_alterAttribute` is a
 * server-internal alias and not sent to clients.)
 *
 * Wire layout (trailer only — `int` and `NetworkId` per the C++
 * `packIntNetworkId` helper):
 *   [i32]                 delta
 *   [NetworkId (i64 LE)]  source       (attacker NetworkId, or 0 if N/A)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverNetworkMessages/src/shared/core/SetupServerNetworkMessages.cpp:404-418  (packIntNetworkId / unpackIntNetworkId)
 *   /home/tharper/code/swg-main/src/engine/server/library/serverNetworkMessages/src/shared/core/SetupServerNetworkMessages.cpp:1360
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface AttributeChangedData {
  delta: number;
  source: NetworkId;
}

export const AttributeChangedKind = 'AttributeChanged' as const;

export const AttributeChangedDecoder = registerObjControllerSubtype<AttributeChangedData>({
  kind: AttributeChangedKind,
  subtypeId: ObjControllerSubtypeIds.CM_alterHitPoints,
  encode(stream: IByteStream, data: AttributeChangedData): void {
    stream.writeI32(data.delta);
    NetworkIdCodec.encode(stream, data.source);
  },
  decode(iter: IReadIterator): AttributeChangedData {
    const delta = iter.readI32();
    const source = NetworkIdCodec.decode(iter);
    return { delta, source };
  },
});
