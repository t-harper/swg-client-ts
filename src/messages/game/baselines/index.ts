/**
 * Side-effect imports for all baseline decoders.
 *
 * Each module registers itself with `baselineRegistry` on first load.
 * Anything that wants baseline dispatch (e.g. `baselines-message.ts`
 * decoding a payload, the orchestrator pre-warming the registry) should
 * import this module — typically as a side-effect-only import:
 *
 *   import './messages/game/baselines/index.js';
 *
 * Adding a new baseline decoder? Create the file under this directory and
 * append a line here.
 */

export { BaselinesMessage, BaselinesMessageDecoder } from './baselines-message.js';
export { BatchBaselinesMessage, BatchBaselinesMessageDecoder } from './batch-baselines-message.js';
export { DeltasMessage, DeltasMessageDecoder } from './deltas-message.js';
export {
  type DecodedDelta,
  type DeltaFieldCodec,
  type DeltaPackageDecoder,
  deltaRegistry,
  registerDelta,
  tryDecodeDelta,
} from './delta-registry.js';
export {
  TangibleObjectClientServerDeltaDecoder,
  TangibleObjectClientServerDeltaKind,
} from './tangible-object-delta-1.js';
export {
  type BuildingObjectSharedBaseline,
  BuildingObjectSharedDecoder,
  BuildingObjectSharedKind,
} from './building-object-baseline-3.js';
export {
  type BuildingObjectEffect,
  type BuildingObjectSharedNpBaseline,
  BuildingObjectSharedNpDecoder,
  BuildingObjectSharedNpKind,
} from './building-object-baseline-6.js';
export {
  type CellObjectSharedBaseline,
  CellObjectSharedDecoder,
  CellObjectSharedKind,
} from './cell-object-baseline-3.js';
export {
  type CellObjectSharedNpBaseline,
  CellObjectSharedNpDecoder,
  CellObjectSharedNpKind,
} from './cell-object-baseline-6.js';
export {
  type BitArrayValue,
  type MapEntry,
  type MatchMakingIdValue,
  EMPTY_BIT_ARRAY,
  EMPTY_MATCH_MAKING_ID,
  readAutoDeltaMap,
  readAutoDeltaSet,
  readAutoDeltaSetI32,
  readAutoDeltaSetNetworkId,
  readAutoDeltaSetNetworkIdPair,
  readAutoDeltaSetString,
  readAutoDeltaSetStringPair,
  readAutoDeltaVector,
  readAutoDeltaVectorF32,
  readAutoDeltaVectorI32,
  readAutoDeltaVectorString,
  readAutoDeltaVectorU32,
  readBitArray,
  readMatchMakingId,
} from './auto-delta-codecs.js';
export { readAndCheckMemberCount, writeMemberCount } from './auto-byte-stream.js';
export {
  type CreatureObjectClientServerBaseline,
  CreatureObjectClientServerDecoder,
  CreatureObjectClientServerKind,
} from './creature-object-baseline-1.js';
export {
  type CreatureObjectSharedBaseline,
  CreatureObjectSharedDecoder,
  CreatureObjectSharedKind,
} from './creature-object-baseline-3.js';
export {
  type CreatureObjectSharedNpBaseline,
  type CreatureObjectEffect,
  type PlayerAndShipPair,
  CreatureObjectSharedNpDecoder,
  CreatureObjectSharedNpKind,
} from './creature-object-baseline-6.js';
export {
  type CreatureObjectFirstParentClientServerBaseline,
  CreatureObjectFirstParentClientServerDecoder,
  CreatureObjectFirstParentClientServerKind,
} from './creature-object-baseline-8.js';
export {
  type CreatureObjectFirstParentClientServerNpBaseline,
  CreatureObjectFirstParentClientServerNpDecoder,
  CreatureObjectFirstParentClientServerNpKind,
} from './creature-object-baseline-9.js';
export {
  type LocationValue,
  type WaypointValue,
  EMPTY_LOCATION,
  EMPTY_WAYPOINT,
  LocationCodec,
  WaypointCodec,
  WaypointColor,
} from './location.js';
export {
  type MissionObjectSharedBaseline,
  MissionObjectSharedDecoder,
  MissionObjectSharedKind,
} from './mission-object-baseline-3.js';
export {
  type PackedBuffValue,
  PackedBuffCodec,
} from './packed-buff.js';
export {
  type PlayerObjectClientServerBaseline,
  PlayerObjectClientServerDecoder,
  PlayerObjectClientServerKind,
} from './player-object-baseline-1.js';
export {
  type PlayerObjectClientServerNpBaseline,
  PlayerObjectClientServerNpDecoder,
  PlayerObjectClientServerNpKind,
} from './player-object-baseline-4.js';
export {
  type PlayerObjectSharedBaseline,
  PlayerObjectSharedDecoder,
  PlayerObjectSharedKind,
} from './player-object-baseline-3.js';
export {
  type GcwDefenderRegion,
  type PlayerObjectSharedNpBaseline,
  PlayerObjectSharedNpDecoder,
  PlayerObjectSharedNpKind,
} from './player-object-baseline-6.js';
export {
  type BaselineDecoder,
  type BaselinePackageId,
  type DecodedBaseline,
  baselineRegistry,
  BaselinePackageIds,
  ObjectTypeTags,
  registerBaseline,
  stringToTag,
  tagToString,
  tryDecodeBaseline,
} from './registry.js';
export {
  type ResourceContainerObjectSharedBaseline,
  ResourceContainerObjectSharedDecoder,
  ResourceContainerObjectSharedKind,
} from './resource-container-object-baseline-3.js';
export { type StringIdValue, EMPTY_STRING_ID, StringIdCodec } from './string-id.js';
export {
  type TangibleObjectClientServerBaseline,
  TangibleObjectClientServerDecoder,
  TangibleObjectClientServerKind,
} from './tangible-object-baseline-1.js';
export {
  type TangibleObjectSharedBaseline,
  TangibleObjectSharedDecoder,
  TangibleObjectSharedKind,
} from './tangible-object-baseline-3.js';
export {
  type TangibleObjectClientServerNpBaseline,
  TangibleObjectClientServerNpDecoder,
  TangibleObjectClientServerNpKind,
} from './tangible-object-baseline-4.js';
export {
  type TangibleObjectEffect,
  type TangibleObjectSharedNpBaseline,
  TangibleObjectSharedNpDecoder,
  TangibleObjectSharedNpKind,
} from './tangible-object-baseline-6.js';
export {
  type WearableEntryValue,
  readWearableEntry,
} from './wearable-entry.js';
