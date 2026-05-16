/**
 * ResourceListForSurveyMessage — server → client.
 *
 * Sent when the player activates a survey tool: enumerates the resource
 * classes the tool is capable of scanning for, plus the survey type
 * (matches the tool's `surveyType` template field, e.g. "mineral",
 * "flora", "inorganic_chemical") and the tool's NetworkId so the client
 * UI can pin the radial menu to a specific tool when multiple are open.
 *
 * Wire layout (addVariable order from ResourceListForSurveyMessage.cpp:26-28):
 *   [AutoArray<ResourceList_DataItem>] data
 *   [std::string]                       surveyType
 *   [NetworkId]                         surveyToolId
 *
 * Where each ResourceList_DataItem is (Archive::put order, ResourceListForSurveyMessage.cpp:72-77):
 *   [std::string]  resourceName     (the spawned resource's unique name, e.g. "Heshurium")
 *   [NetworkId]    resourceId       (the ResourceTypeObject's NetworkId)
 *   [std::string]  parentClassName  (the resource class, e.g. "iron_class_3")
 *
 * AutoArray<T> on the wire is `[u32 LE count][items...]`.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/game/shared/library/swgSharedNetworkMessages/src/shared/survey/ResourceListForSurveyMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('ResourceListForSurveyMessage');

/** One entry in the available-resources list for a survey tool. */
export interface ResourceListItem {
  /** Spawned resource's unique name (e.g. "Heshurium" — the in-world name). */
  resourceName: string;
  /** The ResourceTypeObject's NetworkId. */
  resourceId: NetworkId;
  /** The resource's class name (e.g. "iron_class_3" — the tree node). */
  parentClassName: string;
}

export class ResourceListForSurveyMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + data + surveyType + surveyToolId */
  static override readonly varCount = 4;

  constructor(
    public readonly data: ResourceListItem[],
    public readonly surveyType: string,
    public readonly surveyToolId: NetworkId,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeU32(this.data.length);
    for (const item of this.data) {
      writeStdString(stream, item.resourceName);
      NetworkIdCodec.encode(stream, item.resourceId);
      writeStdString(stream, item.parentClassName);
    }
    writeStdString(stream, this.surveyType);
    NetworkIdCodec.encode(stream, this.surveyToolId);
  }

  static decodePayload(iter: IReadIterator): ResourceListForSurveyMessage {
    const count = iter.readU32();
    const data: ResourceListItem[] = [];
    for (let i = 0; i < count; i++) {
      const resourceName = readStdString(iter);
      const resourceId = NetworkIdCodec.decode(iter);
      const parentClassName = readStdString(iter);
      data.push({ resourceName, resourceId, parentClassName });
    }
    const surveyType = readStdString(iter);
    const surveyToolId = NetworkIdCodec.decode(iter);
    return new ResourceListForSurveyMessage(data, surveyType, surveyToolId);
  }
}

export const ResourceListForSurveyMessageDecoder = registerMessage(
  asDecoder(ResourceListForSurveyMessage),
);
