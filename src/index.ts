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
export { WorldModel } from './client/world-model.js';
export type {
  WorldEvent,
  WorldEventKind,
  WorldModelOptions,
  WorldObject,
} from './client/world-model.js';
export type {
  FullLifecycleOptions,
  FullLifecycleRawCaptureOptions,
  LifecycleLatency,
  LifecycleResult,
  SwgClientOptions,
} from './client/swg-client.js';
// SOE clock-sync / latency stats — surfaced so consumers can hook ClockSync
// events directly on a custom SoeConnection or interpret LifecycleResult.latency.
export type { ClockReflectPacket, ClockSyncPacket, LatencyStats } from './soe/clock-sync.js';
export {
  buildClockReflect,
  buildClockSync,
  clockReflectRttMs,
  localSyncStampLong,
  localSyncStampShort,
  parseClockReflect,
  parseClockSync,
  summarizeLatency,
} from './soe/clock-sync.js';
// Raw SOE-byte capture (pre-decrypt). For drift debugging when the
// GameNetworkMessage transcript hides the issue.
export type { RawCaptureOptions } from './soe/interface.js';
export type {
  RawCaptureFrame,
  RawCaptureMeta,
  RawCaptureSession,
} from './soe/raw-capture-io.js';
export {
  parseRawCapture,
  readRawCapture,
  serializeRawCapture,
  writeRawCapture,
} from './soe/raw-capture-io.js';
export { OfflineSoeDriver, decodeRawFrames } from './soe/raw-capture-decode.js';
export type {
  DecodedAppMessage,
  DecodedFrame,
  DecodedPacketDescription,
} from './soe/raw-capture-decode.js';
export type { TranscriptEvent } from './client/dispatcher.js';
export type { LoginStageResult, LoginStageOptions } from './client/login-stage.js';
export type {
  ConnectionStageResult,
  ConnectionStageOptions,
  CreateCharacterOptions,
} from './client/connection-stage.js';
export type { GameStageResult, GameStageOptions, BaselineSummary } from './client/game-stage.js';

// Scripting engine
export type {
  ScenarioFn,
  ScriptContext,
  ScriptResult,
  SampleEventKind,
} from './client/script/context.js';
export { decodeSampleOob } from './client/script/context.js';
export type { WalkToOptions, CircleOptions, WalkToCellOptions } from './client/script/movement.js';
export type { ExpectOptions } from './client/script/expectations.js';
export { groupTradeScenario, scenarios } from './scenarios/index.js';
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

// Character pool — persistent check-out database for live-test accounts.
// Pre-create N characters once; tests check them out for the duration of
// a run and check them back in on completion. See docs/character-pool
// section in CLAUDE.md.
export { CharacterPool } from './client/character-pool.js';
export type {
  CheckoutManyResult,
  CheckoutOptions,
  CheckoutResult,
  PooledCharacter,
  PoolOptions,
} from './client/character-pool.js';

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

// Radial-menu selection message — the trigger that the client uses to
// activate a menu item (e.g. ITEM_USE) on an object's radial.
export {
  ObjectMenuSelectMessage,
  RadialMenuTypes,
} from './messages/game/object-menu-select-message.js';

// Mission message classes — the top-level browser-populate message plus the
// ObjController subtype decoders that drive the request/response flow.
export {
  MissionAbortDecoder,
  MissionAbortKind,
  MissionAcceptRequestDecoder,
  MissionAcceptRequestKind,
  MissionAcceptResponseDecoder,
  MissionAcceptResponseKind,
  MissionCreateResponseDecoder,
  MissionCreateResponseKind,
  MissionListRequestDecoder,
  MissionListRequestFlags,
  MissionListRequestKind,
  MissionRemoveRequestDecoder,
  MissionRemoveRequestKind,
  MissionRemoveResponseDecoder,
  MissionRemoveResponseKind,
  PopulateMissionBrowserMessage,
} from './messages/game/missions/index.js';
export type {
  MissionAbortData,
  MissionGenericRequestData,
  MissionGenericResponseData,
  MissionListRequestData,
} from './messages/game/missions/index.js';

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
  CreoSharedNpIndices,
  DeltasMessage,
  decodeGroupDelta,
  decodeGroupInviterDelta,
  readFirstDirtyIndex,
  BaselinePackageIds,
  ObjectTypeTags,
  baselineRegistry,
  deltaRegistry,
  registerDelta,
  TangibleObjectClientServerDeltaDecoder,
  TangibleObjectClientServerDeltaKind,
  TangibleObjectSharedDeltaDecoder,
  TangibleObjectSharedDeltaKind,
  TangibleObjectClientServerNpDeltaDecoder,
  TangibleObjectClientServerNpDeltaKind,
  TangibleObjectSharedNpDeltaDecoder,
  TangibleObjectSharedNpDeltaKind,
  CreatureObjectClientServerDeltaDecoder,
  CreatureObjectClientServerDeltaKind,
  CreatureObjectSharedDeltaDecoder,
  CreatureObjectSharedDeltaKind,
  CreatureObjectSharedNpDeltaDecoder,
  CreatureObjectSharedNpDeltaKind,
  CreatureObjectFirstParentClientServerDeltaDecoder,
  CreatureObjectFirstParentClientServerDeltaKind,
  CreatureObjectFirstParentClientServerNpDeltaDecoder,
  CreatureObjectFirstParentClientServerNpDeltaKind,
  PlayerObjectClientServerDeltaDecoder,
  PlayerObjectClientServerDeltaKind,
  PlayerObjectSharedDeltaDecoder,
  PlayerObjectSharedDeltaKind,
  PlayerObjectClientServerNpDeltaDecoder,
  PlayerObjectClientServerNpDeltaKind,
  PlayerObjectSharedNpDeltaDecoder,
  PlayerObjectSharedNpDeltaKind,
  BuildingObjectSharedDeltaDecoder,
  BuildingObjectSharedDeltaKind,
  BuildingObjectSharedNpDeltaDecoder,
  BuildingObjectSharedNpDeltaKind,
  CellObjectSharedDeltaDecoder,
  CellObjectSharedDeltaKind,
  CellObjectSharedNpDeltaDecoder,
  CellObjectSharedNpDeltaKind,
  MissionObjectSharedDeltaDecoder,
  MissionObjectSharedDeltaKind,
  ResourceContainerObjectSharedDeltaDecoder,
  ResourceContainerObjectSharedDeltaKind,
  EMPTY_BIT_ARRAY,
  EMPTY_MATCH_MAKING_ID,
  EMPTY_STRING_ID,
  PlayerObjectSharedDecoder,
  PlayerObjectSharedKind,
  PlayerObjectSharedNpDecoder,
  PlayerObjectSharedNpKind,
  LocationCodec,
  MissionObjectSharedDecoder,
  MissionObjectSharedKind,
  ResourceContainerObjectSharedDecoder,
  ResourceContainerObjectSharedKind,
  WaypointCodec,
  WaypointColor,
  TangibleObjectSharedDecoder,
  TangibleObjectSharedKind,
  TangibleObjectSharedNpDecoder,
  TangibleObjectSharedNpKind,
  BuildingObjectSharedDecoder,
  BuildingObjectSharedKind,
  BuildingObjectSharedNpDecoder,
  BuildingObjectSharedNpKind,
  CellObjectSharedDecoder,
  CellObjectSharedKind,
  CellObjectSharedNpDecoder,
  CellObjectSharedNpKind,
  stringToTag,
  tagToString,
  tryDecodeBaseline,
  tryDecodeDelta,
} from './messages/game/baselines/index.js';
export type {
  BaselineDecoder,
  BaselinePackageId,
  BitArrayValue,
  DecodedBaseline,
  DecodedDelta,
  DeltaFieldCodec,
  DeltaPackageDecoder,
  GcwDefenderRegion,
  LocationValue,
  MatchMakingIdValue,
  MissionObjectSharedBaseline,
  WaypointValue,
  PlayerObjectSharedBaseline,
  PlayerObjectSharedNpBaseline,
  ResourceContainerObjectSharedBaseline,
  StringIdValue,
  TangibleObjectEffect,
  TangibleObjectSharedBaseline,
  TangibleObjectSharedNpBaseline,
  BuildingObjectEffect,
  BuildingObjectSharedBaseline,
  BuildingObjectSharedNpBaseline,
  CellObjectSharedBaseline,
  CellObjectSharedNpBaseline,
} from './messages/game/baselines/index.js';

// Baseline analysis helpers — scan a LifecycleResult's transcript for common
// findings (e.g. the player's inventory container's NetworkId).
export {
  buildBuildingCellIndex,
  extractBaselinesForObject,
  extractInventoryContainerId,
  extractPlayerObjectBaseline,
  findBaselinesByKind,
} from './client/baseline-helpers.js';
export type {
  BuildingCellIndex,
  BuildingIndexEntry,
  CellIndexEntry,
} from './client/baseline-helpers.js';

// Container inspection — walk the transcript and answer "what's inside the
// inventory / backpack / bank / etc.?" Pair with extractInventoryContainerId
// to ask the most common form of the question.
export { ContainerView, containerView, buildContainerIndex } from './client/container-view.js';
export type { ContainerItem } from './client/container-view.js';

// Character snapshot + diff — hashable, deterministic projection of the
// persisted character state from a LifecycleResult. Used by the reconnect
// regression test to validate the DB save/load pipeline end-to-end.
export { snapshot, diffSnapshots } from './client/snapshot.js';
export type {
  CharacterSnapshot,
  SnapshotDiff,
  SnapshotInventoryItem,
} from './client/snapshot.js';

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

// =============================================================================
// Reconnect-verification harness (Feature 6)
// =============================================================================
export { reconnectVerify } from './client/reconnect-harness.js';
export type {
  ReconnectHarnessOptions,
  ReconnectHarnessResult,
} from './client/reconnect-harness.js';

// =============================================================================
// Vehicle / Mount / Pet (Feature 5)
// =============================================================================
export {
  DetachAllRidersDecoder,
  DetachAllRidersKind,
  DetachRiderDecoder,
  DetachRiderKind,
  EmergencyDismountDecoder,
  EmergencyDismountKind,
} from './messages/game/obj-controller/index.js';
export type {
  DetachAllRidersData,
  DetachRiderData,
  EmergencyDismountData,
} from './messages/game/obj-controller/index.js';
export { rideVehicle } from './scenarios/index.js';

// =============================================================================
// SUI + NPC conversation (Feature 1)
// =============================================================================
export {
  type SuiCommand,
  type SuiCommandTypeValue,
  type SuiPageData,
  type SuiWidgetPropertySubscription,
  SuiCommandType,
  SuiCreatePageMessage,
  SuiCreatePageMessageDecoder,
  SuiEventNotification,
  SuiEventNotificationDecoder,
  SuiForceClosePage,
  SuiForceClosePageDecoder,
  SuiUpdatePageMessage,
  SuiUpdatePageMessageDecoder,
  decodeSuiPageData,
  encodeSuiPageData,
  peekSuiPageId,
  readSuiCommand,
  readSuiPageData,
  writeSuiCommand,
  writeSuiPageData,
} from './messages/game/sui/index.js';
export {
  EMPTY_NPC_STRING_ID,
  NpcConversationMessageDecoder,
  NpcConversationMessageKind,
  NpcConversationResponsesDecoder,
  NpcConversationResponsesKind,
  NpcConversationSelectDecoder,
  NpcConversationSelectKind,
  NpcConversationStarter,
  StartNpcConversationDecoder,
  StartNpcConversationKind,
  StopNpcConversationDecoder,
  StopNpcConversationKind,
} from './messages/game/npc/index.js';
export type {
  NpcConversationMessageData,
  NpcConversationResponsesData,
  NpcConversationSelectData,
  NpcConversationStarterValue,
  NpcStringId,
  StartNpcConversationData,
  StopNpcConversationData,
} from './messages/game/npc/index.js';
export type { NpcDialogPrompt } from './client/script/context.js';

// =============================================================================
// SecureTrade handshake (Feature 2)
// =============================================================================
export {
  AbortTradeMessage,
  AbortTradeMessageDecoder,
  AcceptTransactionMessage,
  AcceptTransactionMessageDecoder,
  AddItemMessage,
  AddItemMessageDecoder,
  BeginTradeMessage,
  BeginTradeMessageDecoder,
  GiveMoneyMessage,
  GiveMoneyMessageDecoder,
  RemoveItemMessage,
  RemoveItemMessageDecoder,
  TradeCompleteMessage,
  TradeCompleteMessageDecoder,
  UnAcceptTransactionMessage,
  UnAcceptTransactionMessageDecoder,
  VerifyTradeMessage,
  VerifyTradeMessageDecoder,
} from './messages/game/trade/index.js';
export type { TradeWithOptions, TradeWithResult } from './client/script/context.js';
export {
  TradeMessageId,
  TradeStartDecoder,
  TradeStartKind,
} from './messages/game/obj-controller/index.js';
export type { TradeStartData } from './messages/game/obj-controller/index.js';

// =============================================================================
// Commodities / Bazaar / Auction House (Feature 3)
// =============================================================================
export {
  AcceptAuctionMessage,
  AcceptAuctionResponseMessage,
  AdvancedSearchMatchAllAny,
  AuctionFlags,
  AuctionLocationSearch,
  AuctionQueryHeadersMessage,
  AuctionQueryHeadersResponseMessage,
  AuctionResult,
  AuctionSearchType,
  BidAuctionMessage,
  BidAuctionResponseMessage,
  CancelLiveAuctionMessage,
  CancelLiveAuctionResponseMessage,
  CreateAuctionMessage,
  CreateAuctionResponseMessage,
  CreateImmediateAuctionMessage,
  GetAuctionDetails,
  GetAuctionDetailsResponse,
  IsVendorOwnerMessage,
  IsVendorOwnerResponseMessage,
  RetrieveAuctionItemMessage,
  RetrieveAuctionItemResponseMessage,
  SearchConditionComparison,
  VendorOwnerResult,
} from './messages/game/commodities/index.js';
export type {
  AuctionItemDetails,
  AuctionListing,
  AuctionQueryHeadersFields,
  AuctionResultValue,
  SearchCondition,
  VendorOwnerResultValue,
} from './messages/game/commodities/index.js';
export type {
  AuctionDetails,
  BrowseBazaarOptions,
  ListForSaleOptions,
  ListForSaleResult,
} from './client/script/context.js';
export { bazaarSnipe } from './scenarios/index.js';

// =============================================================================
// TRE (SOE TreeFile) archive reader + writer — game-asset bundle format.
// See src/tre/tre-reader.ts for the on-disk layout and the C++ reference.
// =============================================================================
export {
  TreReader,
  TreWriter,
  normalizeFilename,
  treFilenameCrc,
  treFilenameCrcBytes,
} from './tre/index.js';
export type { TreAddOptions, TreBuildOptions, TreEntry } from './tre/index.js';

// =============================================================================
// Terrain helpers — TRN metadata reader, planet-general asset loader,
// empirical buildability probe, and a concentric-ring grid search for flat
// patches. See src/terrain/index.ts.
// =============================================================================
export * from './terrain/index.js';

// =============================================================================
// IFF (Interchange File Format) parser + writer for SWG data files.
// See src/iff/index.ts for the full surface.
//
// NOTE: the iff module also exports `tagToString` / `tagFromString` — re-exported
// here under the names `iffTagToString` / `iffTagFromString` to avoid colliding
// with the same-named baseline helpers (different byte-order convention).
// =============================================================================
export { Iff, IffWriter, TAG_FORM, tag as iffTag } from './iff/index.js';
export {
  tagFromString as iffTagFromString,
  tagToString as iffTagToString,
} from './iff/index.js';

// =============================================================================
// Building permissions (Feature 0.1)
// =============================================================================
// ObjController subtype decoders for the four permission-mutation cross-auth
// CM ids. The client never receives these directly, but they're useful for
// transcript inspection of server-to-server traffic in test rigs and for
// asserting "we did issue an add-allowed for player X to building Y" in
// integration tests that have a server-side log scraper attached.
export {
  AddAllowedDecoder,
  AddAllowedKind,
  AddBannedDecoder,
  AddBannedKind,
  RemoveAllowedDecoder,
  RemoveAllowedKind,
  RemoveBannedDecoder,
  RemoveBannedKind,
} from './messages/game/obj-controller/index.js';
export type { BuildingPermissionData } from './messages/game/obj-controller/index.js';
