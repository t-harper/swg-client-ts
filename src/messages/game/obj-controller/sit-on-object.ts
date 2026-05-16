/**
 * SitOnObject (CM_sitOnObject = 315) — server-to-client.
 *
 * Instructs a creature to sit on a target object (a chair, bench, etc.).
 * Delivers the chair's cell (NetworkId — `0` for top-level / no cell)
 * and the local-space position within the cell where the seat is.
 *
 * The accompanying ObjControllerMessage header has `networkId` = the
 * creature being seated, so the trailer is just the chair anchor.
 *
 * Wire layout (trailer only):
 *   [NetworkId (i64 LE)]  chairCellId
 *   [3 x f32 LE]          chairPosition_p     (x, y, z in cell-local space)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueSitOnObjectArchive.cpp:19-45
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { Vector3Codec } from '../../../archive/transform.js';
import type { NetworkId, Vector3 } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface SitOnObjectData {
  chairCellId: NetworkId;
  chairPosition: Vector3;
}

export const SitOnObjectKind = 'SitOnObject' as const;

export const SitOnObjectDecoder = registerObjControllerSubtype<SitOnObjectData>({
  kind: SitOnObjectKind,
  subtypeId: ObjControllerSubtypeIds.CM_sitOnObject,
  encode(stream: IByteStream, data: SitOnObjectData): void {
    NetworkIdCodec.encode(stream, data.chairCellId);
    Vector3Codec.encode(stream, data.chairPosition);
  },
  decode(iter: IReadIterator): SitOnObjectData {
    const chairCellId = NetworkIdCodec.decode(iter);
    const chairPosition = Vector3Codec.decode(iter);
    return { chairCellId, chairPosition };
  },
});
