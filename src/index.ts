/**
 * @swg/ts-client — Headless TypeScript SWG wire-compatible client.
 *
 * Public surface for consumers (CI tests, load testers, fuzzers).
 * Implementation modules under src/ are not exported.
 *
 * See README.md and the swg-main CLAUDE.md for full context.
 */

// Public types
export type {
  ServerEndpoint,
  EncryptionParams,
  ClusterInfo,
  CharacterInfo,
  NetworkId,
  LoginToken,
  ClientPermissions,
  SceneStart,
  Vector3,
} from './types.js';

export {
  EncryptMethod,
  UdpPacketType,
  ClusterStatus,
  PopulationStatus,
  CharacterType,
  ZoneState,
} from './types.js';

// High-level client API
export { SwgClient, lifecycleResultToJSON } from './client/swg-client.js';
export type {
  FullLifecycleOptions,
  LifecycleResult,
  SwgClientOptions,
} from './client/swg-client.js';
export type { TranscriptEvent } from './client/dispatcher.js';
export type { LoginStageResult, LoginStageOptions } from './client/login-stage.js';
export type {
  ConnectionStageResult,
  ConnectionStageOptions,
  CreateCharacterOptions,
} from './client/connection-stage.js';
export type { GameStageResult, GameStageOptions, BaselineSummary } from './client/game-stage.js';

// Scripting engine
export type { ScenarioFn, ScriptContext, ScriptResult } from './client/script/context.js';
export type { WalkToOptions, CircleOptions, WalkToCellOptions } from './client/script/movement.js';
export type { ExpectOptions } from './client/script/expectations.js';
export { scenarios } from './scenarios/index.js';
export type { ScenarioFactory } from './scenarios/index.js';

// Fleet multi-client orchestrator
export { Fleet } from './client/fleet.js';
export type {
  FleetClientConfig,
  FleetMessageCount,
  FleetOptions,
  FleetOutcome,
  FleetResult,
  FleetRunOptions,
  FleetSummary,
} from './client/fleet.js';

// Survey message classes — for receiving the survey-tool radial result and
// the available-resources list.
export {
  ResourceListForSurveyMessage,
  SurveyMessage,
} from './messages/game/survey/index.js';
export type {
  ResourceListItem,
  SurveyPoint,
} from './messages/game/survey/index.js';

// Chat message primitives — useful for consumers that want to send tells,
// post in chat rooms, or send in-game mail without going through the
// scripting engine.
export {
  ChatInstantMessageToCharacter,
  ChatInstantMessageToClient,
  ChatRequestRoomList,
  ChatRoomList,
  ChatSendToRoom,
  ChatPersistentMessageToServer,
  PERSISTENT_MESSAGE_MAX_SIZE,
  chatAvatarId,
  ChatRoomType,
} from './messages/game/chat/index.js';
export type {
  ChatAvatarId,
  ChatRoomData,
} from './messages/game/chat/index.js';

// Crafting wire types — both the server→client schematic messages and the
// client→server step subtypes. Useful for consumers wiring crafting flows
// programmatically (the ScriptContext primitives wrap most of these for
// convenience).
export {
  DraftSchematicsDecoder,
  DraftSchematicsKind,
  CraftingIngredientType,
  ManufactureSchematicDecoder,
  ManufactureSchematicKind,
} from './messages/game/crafting/index.js';
export type {
  CraftingIngredientTypeValue,
  DraftSchematicEntry,
  DraftSchematicsData,
  ManufactureSchematicData,
  ManufactureSchematicSlot,
  ManufactureSchematicSlotOption,
  ManufactureSchematicStringId,
} from './messages/game/crafting/index.js';
export {
  CraftingExperimentDecoder,
  CraftingExperimentKind,
  CraftingFinishDecoder,
  CraftingFinishKind,
  CraftingResultDecoder,
  CraftingResultKind,
  CraftSelectSchematicDecoder,
  CraftSelectSchematicKind,
  CraftingSlotAssignDecoder,
  CraftingSlotAssignKind,
  CraftingSlotEmptyDecoder,
  CraftingSlotEmptyKind,
  CraftingStartDecoder,
  CraftingStartKind,
} from './messages/game/obj-controller/index.js';
export type {
  CraftingExperimentData,
  CraftingExperimentEntry,
  CraftingFinishData,
  CraftingResultData,
  CraftSelectSchematicData,
  CraftingSlotAssignData,
  CraftingSlotEmptyData,
  CraftingStartData,
} from './messages/game/obj-controller/index.js';

// Baseline decoders — for inspecting per-object state pushed during zone-in.
// The `BaselinesMessage` envelope wraps the variable-length package payload;
// once decoded, `decodedBaseline.data` is one of the per-type interfaces below.
export {
  BaselinesMessage,
  BaselinePackageIds,
  ObjectTypeTags,
  baselineRegistry,
  EMPTY_BIT_ARRAY,
  EMPTY_MATCH_MAKING_ID,
  EMPTY_STRING_ID,
  PlayerObjectSharedDecoder,
  PlayerObjectSharedKind,
  PlayerObjectSharedNpDecoder,
  PlayerObjectSharedNpKind,
  ResourceContainerObjectSharedDecoder,
  ResourceContainerObjectSharedKind,
  TangibleObjectSharedDecoder,
  TangibleObjectSharedKind,
  TangibleObjectSharedNpDecoder,
  TangibleObjectSharedNpKind,
  BuildingObjectSharedDecoder,
  BuildingObjectSharedKind,
  CellObjectSharedDecoder,
  CellObjectSharedKind,
  stringToTag,
  tagToString,
  tryDecodeBaseline,
} from './messages/game/baselines/index.js';
export type {
  BaselineDecoder,
  BaselinePackageId,
  BitArrayValue,
  DecodedBaseline,
  GcwDefenderRegion,
  MatchMakingIdValue,
  PlayerObjectSharedBaseline,
  PlayerObjectSharedNpBaseline,
  ResourceContainerObjectSharedBaseline,
  StringIdValue,
  TangibleObjectEffect,
  TangibleObjectSharedBaseline,
  TangibleObjectSharedNpBaseline,
  BuildingObjectSharedBaseline,
  CellObjectSharedBaseline,
} from './messages/game/baselines/index.js';

// Baseline analysis helpers — scan a LifecycleResult's transcript for common
// findings (e.g. the player's inventory container's NetworkId).
export {
  extractBaselinesForObject,
  extractInventoryContainerId,
  extractPlayerObjectBaseline,
  findBaselinesByKind,
} from './client/baseline-helpers.js';

// Container inspection — walk the transcript and answer "what's inside the
// inventory / backpack / bank / etc.?" Pair with extractInventoryContainerId
// to ask the most common form of the question.
export { ContainerView, containerView, buildContainerIndex } from './client/container-view.js';
export type { ContainerItem } from './client/container-view.js';

// Wire capture + replay harness
export {
  attachCapture,
  eventsFromTranscript,
  readTranscript,
  transcriptFromNdjson,
  transcriptToNdjson,
  writeTranscript,
} from './client/transcript-io.js';
export type { CapturedEvent } from './client/transcript-io.js';
export { captureLifecycle, replay, replayScenario } from './client/replay.js';
export type {
  CaptureLifecycleOptions,
  CaptureLifecycleResult,
  ReplayOptions,
  ReplayResult,
  ReplayScenarioOptions,
  ReplayScriptContext,
} from './client/replay.js';
