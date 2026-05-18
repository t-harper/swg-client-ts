/**
 * PlanetTravelPointListResponse — server → client. Reply to
 * `PlanetTravelPointListRequest`. Carries parallel arrays describing every
 * travel point on the requested planet.
 *
 * The four parallel arrays are aligned by index: travel point `i` has name
 * `travelPointNameList[i]`, world position `travelPointPointList[i]`, base
 * cost `travelPointCostList[i]`, and is interplanetary-capable iff
 * `travelPointInterplanetaryList[i]` is true.
 *
 * Wire layout (addVariable order, 5 vars — the source has a commented-out
 * `m_sequenceId` that is NOT serialized):
 *   [std::string]         m_planetName
 *   [vector<std::string>] m_travelPointNameList         — i32 LE count + items
 *   [vector<Vector>]      m_travelPointPointList        — Vector = 3×f32 LE
 *   [vector<int>]         m_travelPointCostList         — i32 LE count + i32 items
 *   [vector<bool>]        m_travelPointInterplanetaryList — i32 LE count + u8 items
 *
 * `vector<bool>` in C++ Archive serializes each bool as a 1-byte uchar
 * (see Archive::get/put(bool) — Archive.h around the bool overload). The
 * size prefix is the standard `int32 LE` count.
 *
 * Source:
 *   ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/
 *     shared/clientGameServer/PlanetTravelPointListResponse.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import { Vector3Codec } from '../../../archive/transform.js';
import type { Vector3 } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('PlanetTravelPointListResponse');

export class PlanetTravelPointListResponse extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + planetName + 4 parallel arrays */
  static override readonly varCount = 6;

  constructor(
    public readonly planetName: string,
    public readonly travelPointNameList: readonly string[],
    public readonly travelPointPointList: readonly Vector3[],
    public readonly travelPointCostList: readonly number[],
    public readonly travelPointInterplanetaryList: readonly boolean[],
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeStdString(stream, this.planetName);
    stream.writeI32(this.travelPointNameList.length);
    for (const name of this.travelPointNameList) writeStdString(stream, name);
    stream.writeI32(this.travelPointPointList.length);
    for (const v of this.travelPointPointList) Vector3Codec.encode(stream, v);
    stream.writeI32(this.travelPointCostList.length);
    for (const c of this.travelPointCostList) stream.writeI32(c);
    stream.writeI32(this.travelPointInterplanetaryList.length);
    for (const b of this.travelPointInterplanetaryList) stream.writeU8(b ? 1 : 0);
  }

  static decodePayload(iter: IReadIterator): PlanetTravelPointListResponse {
    const planetName = readStdString(iter);
    const nameCount = iter.readI32();
    if (nameCount < 0) throw new RangeError(`travelPointNameList count negative: ${nameCount}`);
    const names: string[] = [];
    for (let i = 0; i < nameCount; i++) names.push(readStdString(iter));
    const pointCount = iter.readI32();
    if (pointCount < 0) throw new RangeError(`travelPointPointList count negative: ${pointCount}`);
    const points: Vector3[] = [];
    for (let i = 0; i < pointCount; i++) points.push(Vector3Codec.decode(iter));
    const costCount = iter.readI32();
    if (costCount < 0) throw new RangeError(`travelPointCostList count negative: ${costCount}`);
    const costs: number[] = [];
    for (let i = 0; i < costCount; i++) costs.push(iter.readI32());
    const interCount = iter.readI32();
    if (interCount < 0) {
      throw new RangeError(`travelPointInterplanetaryList count negative: ${interCount}`);
    }
    const interplanetary: boolean[] = [];
    for (let i = 0; i < interCount; i++) interplanetary.push(iter.readU8() !== 0);
    return new PlanetTravelPointListResponse(planetName, names, points, costs, interplanetary);
  }
}

export const PlanetTravelPointListResponseDecoder = registerMessage(
  asDecoder(PlanetTravelPointListResponse),
);
