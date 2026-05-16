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
  readAutoDeltaSetString,
  readAutoDeltaVector,
  readAutoDeltaVectorString,
  readBitArray,
  readMatchMakingId,
} from './auto-delta-codecs.js';
export { readAndCheckMemberCount, writeMemberCount } from './auto-byte-stream.js';
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
export { type StringIdValue, EMPTY_STRING_ID, StringIdCodec } from './string-id.js';
export {
  type TangibleObjectSharedBaseline,
  TangibleObjectSharedDecoder,
  TangibleObjectSharedKind,
} from './tangible-object-baseline-3.js';
export {
  type TangibleObjectEffect,
  type TangibleObjectSharedNpBaseline,
  TangibleObjectSharedNpDecoder,
  TangibleObjectSharedNpKind,
} from './tangible-object-baseline-6.js';
