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
export type { WalkToOptions, CircleOptions } from './client/script/movement.js';
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
