/**
 * SurveyMessage — server → client.
 *
 * Carries the radial result of a survey: a list of sample points, each with
 * a 3D location and an `efficiency` (0..1) density reading. The server emits
 * one SurveyMessage in response to a successful `requestSurvey` command
 * (executed via the survey tool's radial menu). Sample density falls off with
 * distance from the tool's reading; the client renders these as a heatmap.
 *
 * Wire layout (addVariable order from SurveyMessage.cpp:23-25):
 *   [AutoArray<Survey_DataItem>] data
 *
 * Where each Survey_DataItem is:
 *   [Vector]  location    (3 f32 LE — x, y, z, world-frame meters)
 *   [f32 LE]  efficiency  (density at this point, typically 0..1)
 *
 * AutoArray<T> on the wire is `[u32 LE count][items...]`.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/game/shared/library/swgSharedNetworkMessages/src/shared/survey/SurveyMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { Vector3Codec } from '../../../archive/transform.js';
import type { Vector3 } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('SurveyMessage');

/** A single radial survey reading: location + density at that point. */
export interface SurveyPoint {
  location: Vector3;
  efficiency: number;
}

export class SurveyMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + data */
  static override readonly varCount = 2;

  constructor(public readonly data: SurveyPoint[]) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeU32(this.data.length);
    for (const point of this.data) {
      Vector3Codec.encode(stream, point.location);
      stream.writeF32(point.efficiency);
    }
  }

  static decodePayload(iter: IReadIterator): SurveyMessage {
    const count = iter.readU32();
    const data: SurveyPoint[] = [];
    for (let i = 0; i < count; i++) {
      const location = Vector3Codec.decode(iter);
      const efficiency = iter.readF32();
      data.push({ location, efficiency });
    }
    return new SurveyMessage(data);
  }
}

export const SurveyMessageDecoder = registerMessage(asDecoder(SurveyMessage));
