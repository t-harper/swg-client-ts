/**
 * ScriptContext — runtime handed to a scenario function during the
 * zoned-in dwell. Exposes movement, container, and message primitives,
 * plus an escape-hatch `send()` and a `signal` for cooperative cancel.
 *
 * Scenarios are plain async functions:
 *
 *   const myScenario: ScenarioFn = async (ctx) => {
 *     await ctx.walkTo({ x: -100, z: 50 }, { speed: 5 });
 *     await ctx.walkCircle({ centerX: -100, centerZ: 50, radius: 10, durationMs: 5_000 });
 *     ctx.openPlayerInventory();
 *     await ctx.wait(1_000);
 *     await ctx.logout();
 *   };
 */

import { ByteStream } from '../../archive/byte-stream.js';
import {
  type AttributePair,
  AttributeListMessage,
} from '../../messages/game/attribute-list-message.js';
import {
  type ChatAvatarId,
  ChatInstantMessageToCharacter,
  ChatPersistentMessageToServer,
  ChatRequestRoomList,
  ChatSendToRoom,
  chatAvatarId,
} from '../../messages/game/chat/index.js';
import { ClientOpenContainerMessage } from '../../messages/game/client-open-container.js';
import {
  CLIENT_TO_AUTH_SERVER_FLAGS,
  CommandQueueEnqueue,
  NO_TARGET,
  hashCommand,
  wrapAsObjControllerMessage,
} from '../../messages/game/command-queue/index.js';
import { LogoutMessage } from '../../messages/game/logout-message.js';
import {
  ObjectMenuSelectMessage,
  RadialMenuTypes,
} from '../../messages/game/object-menu-select-message.js';
import {
  type MissionAbortData,
  MissionAbortDecoder,
  MissionAcceptRequestDecoder,
  type MissionGenericRequestData,
  type MissionListRequestData,
  MissionListRequestDecoder,
  MissionRemoveRequestDecoder,
} from '../../messages/game/missions/index.js';
import {
  AbortTradeMessage,
  AcceptTransactionMessage,
  AddItemMessage,
  BeginTradeMessage,
  GiveMoneyMessage,
  TradeCompleteMessage,
  VerifyTradeMessage,
} from '../../messages/game/trade/index.js';
import { ObjControllerMessage } from '../../messages/game/obj-controller-message.js';
import { _encodeObjectMenu } from '../../messages/game/obj-controller/object-menu-request.js';
import {
  type CraftingExperimentData,
  CraftingExperimentDecoder,
  type CraftingSlotAssignData,
  CraftingSlotAssignDecoder,
  type CraftingSlotEmptyData,
  CraftingSlotEmptyDecoder,
  type NetUpdateTransformData,
  NetUpdateTransformKind,
  ObjControllerSubtypeIds,
  SpatialChatType,
  type TeleportAckData,
  TeleportAckDecoder,
  TradeMessageId,
  TradeStartDecoder,
} from '../../messages/game/obj-controller/index.js';
import {
  type DraftSchematicsData,
  DraftSchematicsKind,
  type ManufactureSchematicData,
  ManufactureSchematicKind,
} from '../../messages/game/crafting/index.js';
import { ChatSystemMessage } from '../../messages/game/chat/index.js';
import {
  ResourceListForSurveyMessage,
  type ResourceListItem,
  SurveyMessage,
  type SurveyPoint,
} from '../../messages/game/survey/index.js';
import type { GameNetworkMessage } from '../../messages/interface.js';
import type { NetworkId, SceneStart, Vector3 } from '../../types.js';
import type { MessageDispatcher } from '../dispatcher.js';
import {
  type ExpectOptions,
  expectAbsent as expectAbsentImpl,
  expectAfter as expectAfterImpl,
  expectWithin as expectWithinImpl,
} from './expectations.js';
import {
  type CircleOptions,
  type WalkToCellOptions,
  type WalkToOptions,
  walkCircle as walkCircleImpl,
  walkToCell as walkToCellImpl,
  walkTo as walkToImpl,
} from './movement.js';

/**
 * Posture command names recognised by `changePosture()`. These map to
 * top-level ability names in the server's CommandTable; the command-hash
 * lookup is case-insensitive but we standardize on lowercase.
 */
export type Posture = 'standing' | 'crouched' | 'prone' | 'sitting';

const POSTURE_COMMAND: Record<Posture, string> = {
  standing: 'stand',
  crouched: 'crouch',
  prone: 'prone',
  sitting: 'sit',
};

export type ScenarioFn = (ctx: ScriptContext) => Promise<void>;

/**
 * Categorized outcome of one server-side sample-loop tick. Derived from the
 * STF token embedded in `ChatSystemMessage.outOfBand`. See
 * `ctx.waitForSampleEvent`.
 */
export type SampleEventKind =
  | 'located'
  | 'failed'
  | 'cancel'
  | 'in_progress'
  | 'start'
  | 'mind'
  | 'density'
  | 'trace'
  | 'other';

/**
 * Internal helper — decode `ChatSystemMessage.outOfBand` to a printable
 * ASCII string (the wire packs each pair of bytes into one UTF-16
 * codepoint via Unicode::String encoding).
 */
export function decodeSampleOob(oob: string): string {
  let s = '';
  for (let i = 0; i < oob.length; i++) {
    const cu = oob.charCodeAt(i);
    const lo = cu & 0xff;
    const hi = (cu >> 8) & 0xff;
    for (const b of [lo, hi]) {
      if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    }
  }
  return s;
}

function classifySampleEvent(oob: string): SampleEventKind {
  const t = decodeSampleOob(oob);
  if (/sample_located/.test(t)) return 'located';
  if (/sample_failed/.test(t)) return 'failed';
  if (/sample_cancel/.test(t)) return 'cancel';
  if (/already_sampling/.test(t)) return 'in_progress';
  if (/start_sampling/.test(t)) return 'start';
  if (/sample_mind/.test(t)) return 'mind';
  if (/density_below/.test(t)) return 'density';
  if (/trace_amt/.test(t)) return 'trace';
  return 'other';
}

/**
 * Options for `ctx.tradeWith()`. All fields optional.
 *
 * `items`            — NetworkIds to offer from the player's inventory.
 *                      Each is sent as an `AddItemMessage` after the trade
 *                      window opens. Server may reject any (silently or via
 *                      `AddItemFailedMessage`); rejected items are still
 *                      counted as attempted.
 * `credits`          — Amount to offer via `GiveMoneyMessage`. Skipped when
 *                      0 or undefined.
 * `acceptTimeoutMs`  — Max time to wait for the OTHER party to accept (and
 *                      hence for `VerifyTradeMessage` to arrive). Default 15s.
 * `verifyTimeoutMs`  — Max time to wait for `TradeCompleteMessage` after
 *                      both parties echoed `VerifyTradeMessage`. Default 15s.
 * `beginTimeoutMs`   — Max time to wait for `BeginTradeMessage` (server's
 *                      confirmation that the other party accepted the
 *                      initial `CM_secureTrade(RequestTrade)`). Default 15s.
 */
export interface TradeWithOptions {
  items?: readonly NetworkId[];
  credits?: number;
  beginTimeoutMs?: number;
  acceptTimeoutMs?: number;
  verifyTimeoutMs?: number;
}

/** Outcome of a `ctx.tradeWith()` call. */
export interface TradeWithResult {
  /** True iff `TradeCompleteMessage` was received (server moved items/credits). */
  completed: boolean;
  /** Populated on any failure — `no-begin`, `aborted`, `no-verify`, `no-complete`. */
  abortReason?: string;
}

/** Optional overrides for `ctx.say()` — directed chat, shout, mood, etc. */
export interface SayOptions {
  /** Directed chat (e.g. `/whisper`); `0n` ⇒ broadcast. Default: 0n. */
  targetId?: NetworkId;
  /** Chat type — Say (0), Shout (1), Whisper (2), or other. Default: Say. */
  chatType?: number;
  /** Mood index (from moodAnimation.iff). Default: 0 (no mood). */
  moodType?: number;
  /** Language enum (0..255). Default: 0 (basic). */
  language?: number;
  /** Bit-flags. Default: 0. */
  flags?: number;
  /** Volume hint. Default: 0. */
  volume?: number;
}

export interface ScriptResult {
  /** Wall-clock elapsed time the scenario function took, in ms. */
  elapsedMs: number;
  /** Total `dispatcher.send()` calls made via the context (any path). */
  sendsCount: number;
  /** Set if the scenario threw. */
  error?: string;
  /** True if the scenario called `ctx.logout()`. */
  didLogout: boolean;
  /**
   * Soft-assertion failure messages collected during the run. Populated by
   * `ctx.fail(reason)` and by soft `ctx.expectWithin(..., { soft: true })`
   * timeouts. Always present; empty array when nothing failed.
   */
  assertionFailures: string[];
}

type MessageClassRef<T extends GameNetworkMessage> = {
  readonly messageName: string;
  readonly typeCrc: number;
  readonly prototype: T;
};

export interface ScriptContext {
  readonly dispatcher: MessageDispatcher;
  readonly sceneStart: SceneStart;
  readonly signal: AbortSignal;
  /** Live cursor — current best estimate of the player's position. */
  position(): Readonly<Vector3>;
  /** Live cursor — current best estimate of the player's heading (radians). */
  yaw(): number;
  /** Next movement sequence number (auto-incremented by movement primitives). */
  nextSequenceNumber(): number;
  /**
   * Monotonic milliseconds-since-script-start, wrapped to u32. Used as the
   * `syncStamp` field in MessageQueueDataTransform — the server divides
   * `distance / (syncStamp delta in seconds)` to derive the effective speed
   * for anti-cheat validation, so it just needs to be monotonic and have
   * meaningful deltas. Rolled on every call so consecutive sends don't
   * collide at `delta = 0`.
   */
  nextSyncStamp(): number;
  /**
   * ACK every pending server-initiated teleport / zone-in lockout. Scans
   * the dispatcher's transcript for inbound
   * `ObjControllerMessage(CM_netUpdateTransform=113)` events for the
   * player's networkId with a negative `sequenceNumber` (the wire-level
   * signal from `PlayerCreatureController::resyncMovementUpdates`) and
   * sends back a `CM_teleportAck` for each matching seq, plus seq=-1 as a
   * defensive fallback. Idempotent: only ACKs each seq once per context.
   *
   * Movement primitives (`walkTo`, `walkCircle`, `walkToCell`) call this
   * automatically on first invocation per context. Manual code that uses
   * `ctx.send()` to push raw transforms must call this once after zone-in
   * before its first transform — otherwise every transform is dropped
   * server-side by `handleMove`'s `isTeleporting()` check.
   */
  ackPendingTeleports(): Promise<void>;
  /** Update the position cursor (used by movement primitives; rarely called directly). */
  setPose(position: Vector3, yaw: number): void;
  /** Escape hatch — send any GameNetworkMessage and count it in scriptResult. */
  send<T extends GameNetworkMessage>(msg: T): void;
  /** Sleep for `ms` milliseconds; rejects with AbortError if signal aborts. */
  wait(ms: number): Promise<void>;
  /** Wait for the next inbound message of the given class. */
  waitForMessage<T extends GameNetworkMessage>(
    ctor: MessageClassRef<T>,
    opts?: { timeoutMs?: number; predicate?: (m: T) => boolean },
  ): Promise<T>;
  /** Walk in a straight line to (x, z); y is held constant unless overridden. */
  walkTo(target: { x: number; z: number; y?: number }, opts?: WalkToOptions): Promise<void>;
  /** Walk around a circle of given centre/radius/duration. */
  walkCircle(opts: CircleOptions): Promise<void>;
  /**
   * Walk in a straight line to (x, z) inside `parentId`'s cell-local
   * coordinate frame. Uses `UpdateTransformWithParentMessage` (cell-relative,
   * 0.125m wire resolution) instead of `UpdateTransformMessage`. The
   * orchestrator's world cursor (`position()` / `setPose()`) is left alone;
   * the cell cursor is tracked separately and queryable via
   * `cellPosition()` + `parentCell()`.
   */
  walkToCell(
    parentId: NetworkId,
    target: { x: number; z: number; y?: number },
    opts?: WalkToCellOptions,
  ): Promise<void>;
  /**
   * Current best estimate of the player's cell-relative position. Only valid
   * when `parentCell()` is non-zero; otherwise returns the last-known
   * cell-relative pose or `{x:0, y:0, z:0}` if the player has never been
   * cell-parented this session.
   */
  cellPosition(): Readonly<Vector3>;
  /**
   * NetworkId of the cell the player is currently parented to, or `0n` if
   * the player is in the open world.
   */
  parentCell(): NetworkId;
  /**
   * Update the cell-relative pose cursor. Called automatically by
   * `walkToCell`; rarely useful directly except to "enter" a known cell at a
   * specific local position before the first walk.
   */
  setCellPose(parentId: NetworkId, position: Vector3, yaw: number): void;
  /** Open a container by its NetworkId (slot is "" by default; for inventory use openPlayerInventory). */
  openContainer(containerId: NetworkId, slot?: string): void;
  /** Open the player's own inventory (containerId = playerNetworkId, slot = "inventory"). */
  openPlayerInventory(): void;
  /**
   * "Close" a container. There is no wire-level close message in SWG; the
   * server treats opening another container or moving away as a close.
   * This method is a documentation hook — it logs the intent and records
   * a `send` for counting but emits no UDP bytes.
   */
  closeContainer(containerId: NetworkId): void;
  /** Send LogoutMessage and wait briefly so the server can persist. */
  logout(): Promise<void>;

  // --- Combat / command-queue primitives ---

  /**
   * Next command-queue sequence number (auto-incremented; separate from the
   * movement sequence counter). Each `useAbility` / `attackTarget` /
   * `changePosture` call consumes one.
   */
  nextCommandSequence(): number;

  /**
   * Queue an ability by command name. Wraps a
   * `MessageQueueCommandQueueEnqueue` inside an `ObjControllerMessage` with
   * subtype `CM_commandQueueEnqueue` (278) and sends it. Returns the
   * sequenceId used so callers can correlate with an inbound CommandQueueRemove.
   *
   * - `targetId` defaults to `NO_TARGET` (0n) for self / area abilities
   * - `params` defaults to '' (most abilities take no params)
   */
  useAbility(commandName: string, targetId?: NetworkId, params?: string): number;

  /** Convenience wrapper: useAbility('attack', targetId). */
  attackTarget(targetId: NetworkId): number;

  /**
   * Queue a posture change. Maps the friendly name to the appropriate
   * server-side command:
   *   - 'standing'  → 'stand'
   *   - 'crouched'  → 'crouch'
   *   - 'prone'     → 'prone'
   *   - 'sitting'   → 'sit'
   */
  changePosture(posture: Posture): number;

  // --- Chat primitives ---

  /** Next chat sequence id (auto-incremented; separate from movement/command). */
  nextChatSequence(): number;
  /**
   * Send `text` as a private tell to `targetName`. Pass a bare first-name
   * (lowercased server-side) or a full `ChatAvatarId` for cross-cluster.
   */
  tell(targetName: string | ChatAvatarId, text: string): number;
  /** Post `text` into chat-room `channelId`. */
  sendToChannel(channelId: number, text: string): number;
  /** Send in-game mail (persistent message) to `target`. */
  sendMail(target: string | ChatAvatarId, subject: string, body: string): number;
  /**
   * Speak spatial chat (the wire path behind `/say`). Wraps a
   * `MessageQueueCommandQueueEnqueue` for the server's `spatialChatInternal`
   * command inside an `ObjControllerMessage(CM_commandQueueEnqueue=278)` —
   * the same path the real Windows client uses, and the only one that
   * passes the server's `ControllerMessageFactory::allowFromClient` gate
   * (which has `CM_spatialChatSend=false` for non-admin clients).
   *
   * The server-side `commandFuncSpatialChatInternal` then builds the
   * `MessageQueueSpatialChat`, looks up the volume from
   * `chat/spatial_chat_types.iff`, runs the chat-spam limiter, and
   * broadcasts `CM_spatialChatReceive(244)` to every observer in radius.
   *
   * For directed `/whisper`-style chat pass a non-zero `targetId` via the
   * `opts` argument; for `/shout` set `chatType`. Most callers want the
   * defaults — `say(text)`.
   *
   * Returns the chat-sequence id used so callers can correlate this with
   * subsequent chat events. Note: the command-queue sequence is internally
   * also incremented — `ctx.nextCommandSequence()` will reflect this.
   */
  say(text: string, opts?: SayOptions): number;
  /** Request the server's chat-room list (server responds with ChatRoomList). */
  requestChannelList(): void;

  // --- Crafting primitives ---

  /**
   * Open a crafting session against the given tool / station. Sends
   * `useAbility('requestCraftingSession', toolId, params)` via the command
   * queue — the server's `commandFuncRequestCraftingSession` then opens
   * the session and replies via `CM_craftingResult` followed by
   * `CM_draftSchematicsMessage` with the player's known schematics. The
   * optional `schematicCrc` is forwarded as the `params` payload as a hint
   * (the server currently ignores it for this command but consumers may
   * still want it logged in the transcript).
   *
   * Returns the command-queue sequenceId so callers can correlate with the
   * inbound CommandQueueRemove.
   */
  beginCrafting(toolId: NetworkId, schematicCrc?: number): number;

  /**
   * Select a draft schematic from the list returned in `DraftSchematics`.
   * Sends `useAbility('selectDraftSchematic', 0n, String(schematicIndex))`
   * via the command queue — the server's
   * `commandFuncSelectDraftSchematic` then instantiates a fresh
   * ManufactureSchematic and pushes `CM_draftSlotsMessage`.
   *
   * Returns the command-queue sequenceId.
   */
  selectCraftingSchematic(schematicIndex: number): number;

  /**
   * Wait for the next `DraftSchematics` server response (the list of
   * schematics offered by the current crafting tool/station combo).
   * Default timeout 8_000ms.
   */
  waitForDraftSchematics(opts?: { timeoutMs?: number }): Promise<DraftSchematicsData>;

  /**
   * Wait for the next `ManufactureSchematic` / `DraftSlots` server response
   * (the resource/component slot requirements for the previously-selected
   * schematic, plus the in-flight `manfSchemId` and `prototypeId`). Default
   * timeout 8_000ms.
   */
  waitForDraftSlots(opts?: { timeoutMs?: number }): Promise<ManufactureSchematicData>;

  /**
   * Assign an ingredient (item or resource container) to a schematic slot.
   * Sends a bare `ObjControllerMessage(CM_fillSchematicSlotMessage)` with
   * the `MessageQueueCraftFillSlot` payload — bypasses the command queue.
   * The server responds via `CM_craftingResult` with `requestId =
   * CM_fillSchematicSlotMessage`.
   *
   * `optionIndex` (default 0) tells the server which of the slot's
   * accepted-ingredient options this satisfies (resource class / item /
   * template — see `ManufactureSchematicSlotOption`). The optional
   * `quantity` argument is accepted for forward-compatibility but is not
   * carried on this wire subtype — the server infers the quantity from
   * the ingredient container (it's checked against `amountNeeded` on the
   * slot's option).
   *
   * Returns the per-crafting-session sequenceId.
   */
  assignCraftingSlot(
    slotIndex: number,
    ingredientId: NetworkId,
    options?: { optionIndex?: number; quantity?: number },
  ): number;

  /**
   * Clear an ingredient out of a schematic slot. Sends a bare
   * `ObjControllerMessage(CM_emptySchematicSlotMessage)` with the
   * `MessageQueueCraftEmptySlot` payload. The returned ingredient is
   * moved to `targetContainer` (defaults to the player's NetworkId —
   * which the server interprets as the player's inventory).
   *
   * Returns the per-crafting-session sequenceId.
   */
  clearCraftingSlot(slotIndex: number, targetContainer?: NetworkId): number;

  /**
   * Run an experimentation attempt on the active schematic. Sends a bare
   * `ObjControllerMessage(CM_experimentMessage)` with the
   * `MessageQueueCraftExperiment` payload. Each `experiments` entry says
   * "spend N points on attribute index X". The server's response carries a
   * `MessageQueueGenericIntResponse` under `CM_experimentResult` (= 275)
   * — note that's a *different* subtype id than `CM_craftingResult`.
   *
   * `coreLevel` defaults to 0 (no experimentation tool / device bonus).
   *
   * Returns the per-crafting-session sequenceId.
   */
  craftExperiment(
    experiments: Array<{ attribute: number; points: number }>,
    options?: { coreLevel?: number },
  ): number;

  /**
   * Finalize the active schematic into a prototype. Sends
   * `useAbility('createPrototype', toolId, '<seq> <realPrototype>')` via
   * the command queue — the server's `commandFuncCreatePrototype` then
   * calls `player->createPrototype(realPrototype)` and replies via
   * `CM_craftingResult`. Pair `realPrototype=true` (default) with
   * `createPrototype` to actually spawn the item, or `false` for the
   * legacy "practice" mode.
   *
   * Returns the command-queue sequenceId.
   */
  finishCrafting(toolId: NetworkId, options?: { realPrototype?: boolean }): number;

  // --- Expectation / assertion primitives ---

  /**
   * Wait for a message of `ctor` to arrive within `timeoutMs`. Hard mode
   * (default) throws on timeout; soft mode (`{ soft: true }`) resolves to
   * `undefined` and records a failure into `assertionFailures`.
   */
  expectWithin<T extends GameNetworkMessage>(
    ctor: MessageClassRef<T>,
    timeoutMs: number,
    opts: ExpectOptions<T> & { soft: true },
  ): Promise<T | undefined>;
  expectWithin<T extends GameNetworkMessage>(
    ctor: MessageClassRef<T>,
    timeoutMs: number,
    opts?: ExpectOptions<T>,
  ): Promise<T>;

  /** Assert NO matching message arrives in `windowMs`. Throws if one does. */
  expectAbsent<T extends GameNetworkMessage>(
    ctor: MessageClassRef<T>,
    windowMs: number,
    opts?: { predicate?: (m: T) => boolean },
  ): Promise<void>;

  /** Run `trigger`, then expect a matching message within `withinMs`. */
  expectAfter<T extends GameNetworkMessage>(
    trigger: () => void | Promise<void>,
    ctor: MessageClassRef<T>,
    opts: { withinMs: number; predicate?: (m: T) => boolean; soft: true },
  ): Promise<T | undefined>;
  expectAfter<T extends GameNetworkMessage>(
    trigger: () => void | Promise<void>,
    ctor: MessageClassRef<T>,
    opts: { withinMs: number; predicate?: (m: T) => boolean },
  ): Promise<T>;

  /** Record a soft failure; does NOT throw. */
  fail(reason: string): void;

  /** Read the current list of soft-assertion failures. */
  assertionFailures(): readonly string[];

  // --- Survey primitives ---

  /**
   * Trigger a survey for a SPECIFIC `resourceTypeName` (e.g. `"Resotine"`,
   * `"Yponaco"` — an actual spawned resource type name, NOT a class name like
   * `"mineral"`). Wraps `useAbility('requestsurvey', toolId, resourceTypeName)`.
   *
   * Server-side this runs `commandFuncRequestSurvey` (CommandCppFuncs.cpp:2761)
   * → `survey_tool_script.OnRequestSurvey` → `requestSurvey` JNI →
   * `SurveySystem::TaskSurvey` which looks the type up by exact name. Passing
   * a class name like `"mineral"` causes the type lookup to fail silently and
   * no `SurveyMessage` is ever broadcast.
   *
   * To discover the legal `resourceTypeName` values for a tool's class, call
   * `fetchSurveyResources(toolId)` first — it returns the
   * `ResourceListForSurveyMessage.data` array of currently-spawned types.
   *
   * Returns the command-queue sequence id used.
   */
  survey(toolId: NetworkId, resourceTypeName: string): number;

  /**
   * Fetch the list of currently-spawned resource types this `toolId` can
   * survey. Drives the radial-menu "Use" flow end-to-end:
   *
   *   1. `ObjControllerMessage(CM_objectMenuRequest=326, target=toolId)`
   *   2. wait for `ObjControllerMessage(CM_objectMenuResponse=327)`
   *   3. `ObjectMenuSelectMessage(targetId=toolId, itemId=ITEM_USE=21)`
   *   4. wait for `ResourceListForSurveyMessage`
   *
   * Server-side step 3 triggers `survey_tool_script.OnObjectMenuSelect`,
   * which calls `requestResourceListForSurvey(player, tool, resource_class)`
   * — but only if the tool's `VAR_SURVEY_CLASS` objvar is set (crafted tools
   * have it; raw-spawned templates may not). If the objvar is missing the
   * server silently returns and this promise rejects with a timeout.
   *
   * Returns the `data` array of {resourceName, resourceId, parentClassName}.
   * Default timeout 8_000ms.
   */
  fetchSurveyResources(
    toolId: NetworkId,
    opts?: { timeoutMs?: number },
  ): Promise<ResourceListItem[]>;

  /**
   * Wait for the next `SurveyMessage` radial response within `timeoutMs`.
   * Returns the parsed sample points. The wire `SurveyMessage` does NOT
   * carry the resource type name (the server assumes the client is tracking
   * the in-flight survey state from the prior `requestsurvey` issue).
   * Default timeout 60_000ms — real surveys take ~5-10s but the server may
   * delay during heavy load.
   */
  waitForSurvey(opts?: { timeoutMs?: number }): Promise<{
    points: SurveyPoint[];
  }>;

  /**
   * Start a core-sample loop for a SPECIFIC `resourceTypeName` (e.g.
   * `"Carboseuweroris"`). Wraps `useAbility('requestcoresample', toolId,
   * resourceTypeName)`. Server-side this runs `survey_tool_script.OnRequestCoreSample`
   * which validates state (not in structure, not in combat, density ≥ 30%,
   * etc.) and starts a ~30-second-tick sample loop. Each tick has a random
   * chance (≈50% at no surveying skill, up to ~70% with skill) of producing
   * units of the resource — the units **stack into an existing resource
   * container of the same type** if one exists in inventory, otherwise a
   * new container is created.
   *
   * The loop continues until any of:
   *   - The player moves more than 1 meter from the start spot
   *   - Action attribute drains to 0
   *   - Density at current position drops below threshold
   *
   * To stop the loop: walk 2+ meters. The next tick sees the movement and
   * cleans up. `cancelSampling()` is a convenience for this.
   *
   * **Stale state warning**: if a prior session disconnected mid-loop, the
   * server keeps `surveying.takingSamples` set on the player; new calls
   * return `already_sampling` (kind `'in_progress'`) until the stale loop
   * times out (drain action / move check) or the server is restarted.
   * Robust callers should `await ctx.cancelSampling()` first when they
   * suspect stale state, or look for `'in_progress'` kind from
   * `waitForSampleEvent` and act accordingly.
   *
   * Returns the command-queue sequence id used.
   */
  sample(toolId: NetworkId, resourceTypeName: string): number;

  /**
   * Walk 2 meters in-place to bust the server's sample loop (its move-check
   * triggers cleanup on the next tick). Returns once the move is sent — the
   * server's `sample_cancel` chat message arrives a few seconds later.
   */
  cancelSampling(): Promise<void>;

  /**
   * Wait for the next sample-loop event from the server, returned as a
   * `{ kind, raw }` discriminated union. The `kind` is derived from the
   * STF token in the `ChatSystemMessage`'s `outOfBand` payload:
   *
   *   - `'located'`     — `survey/sample_located` (a sample succeeded; units
   *                       added to inventory's matching resource container,
   *                       or a new container created)
   *   - `'failed'`      — `survey/sample_failed` (this tick's random roll
   *                       didn't pass; loop continues)
   *   - `'cancel'`      — `survey/sample_cancel` (loop terminated, e.g.
   *                       player moved)
   *   - `'in_progress'` — `survey/already_sampling` (a stale loop from a
   *                       prior session is still active; restart server or
   *                       wait it out)
   *   - `'start'`       — `survey/start_sampling`
   *   - `'mind'`        — `survey/sample_mind` (out of action attribute)
   *   - `'density'`     — `survey/density_below_threshold`
   *   - `'trace'`       — `survey/trace_amt`
   *   - `'other'`       — anything else (raw token in `raw`)
   *
   * Default timeout 60_000ms (long enough for one sample-loop tick).
   */
  waitForSampleEvent(opts?: {
    timeoutMs?: number;
    predicate?: (kind: SampleEventKind, raw: string) => boolean;
  }): Promise<{ kind: SampleEventKind; raw: string }>;

  /**
   * Fetch the server-side attribute list for one or more objects via the
   * batched `useAbility('getAttributesBatch', 0n, '<id1> -1 <id2> -1 ...')`
   * (CommandCppFuncs.cpp:5451). The server queues one `TaskGetAttributes`
   * per id which responds with `AttributeListMessage`.
   *
   * Works for any object id the server can look up: ServerObjects (items,
   * creatures, structures), **ResourceTypeObjects** (returns resource stats
   * like OQ/CR/DR/...), and waypoints — see TaskGetAttributes.cpp:47-114.
   *
   * Large batches are **split into chunks of `maxBatchSize` ids (default 25)
   * and sent as multiple `useAbility` calls** to stay under the
   * single-packet wire-size ceiling (our `SoeConnection.sendApp` doesn't
   * fragment outbound; the Windows client fragments at this layer instead).
   * A single subscriber collects responses for all chunks under one
   * `timeoutMs` budget.
   *
   * The optional `clientRevision` is the cache-busting hint the real client
   * uses; -1 forces a fresh response (server sends if `serverRevision !=
   * clientRevision`). Default -1.
   *
   * Returns `Map<NetworkId, AttributePair[]>` keyed by the requested ids.
   * Ids that didn't receive a response by `timeoutMs` are omitted from the
   * map (the caller can diff against the input to find them).
   *
   * Default timeout 8_000ms; default `maxBatchSize` 25 (≈350 chars of
   * params per chunk, well under the ~480-byte safe ceiling).
   */
  fetchResourceAttributes(
    objectIds: NetworkId[],
    opts?: { timeoutMs?: number; clientRevision?: number; maxBatchSize?: number },
  ): Promise<Map<NetworkId, readonly AttributePair[]>>;

  // --- Mission primitives ---

  /**
   * Next per-player mission-flow sequence id (auto-incremented; separate
   * from movement/command/chat/craft). Returned values are wrapped to u8
   * by the request primitives (the wire field is `uint8`).
   */
  nextMissionSequence(): number;

  /**
   * Request the mission list from `terminalId`. Sends a bare
   * `ObjControllerMessage(CM_missionListRequest)` whose trailer is a
   * `MessageQueueMissionListRequest` payload. The server responds by
   * pushing one or more `MissionObject` SHARED baselines into the player's
   * mission bag, followed by a `PopulateMissionBrowserMessage` carrying
   * the NetworkIds of the MissionObjects the terminal generated.
   *
   * Returns the sequenceId used so callers can correlate inbound traffic.
   *
   * `flags` defaults to 0; pass `MissionListRequestFlags.MineOnly` (0x01)
   * to filter for missions previously claimed by this player.
   */
  requestMissionList(terminalId: NetworkId, opts?: { flags?: number }): number;

  /**
   * Accept the named mission from the named terminal. Sends a bare
   * `ObjControllerMessage(CM_missionAcceptRequest)` whose trailer is a
   * `MessageQueueMissionGenericRequest` payload. The server responds with
   * a `MessageQueueMissionGenericResponse` under `CM_missionAcceptResponse`
   * carrying the success bit.
   *
   * Returns the sequenceId used so callers can correlate the response.
   */
  acceptMission(missionId: NetworkId, terminalId: NetworkId): number;

  /**
   * Remove (abandon) a mission. Sends a bare
   * `ObjControllerMessage(CM_missionRemoveRequest)` with the same
   * `MessageQueueMissionGenericRequest` trailer shape as
   * `acceptMission`. The server responds with
   * `MessageQueueMissionGenericResponse` under `CM_missionRemoveResponse`.
   *
   * Returns the sequenceId used so callers can correlate the response.
   */
  removeMission(missionId: NetworkId, terminalId: NetworkId): number;

  /**
   * Abort the named mission (player-initiated, no terminal required).
   * Sends a bare `ObjControllerMessage(CM_missionAbort)` with a
   * `MessageQueueNetworkId` trailer carrying just the mission's NetworkId.
   * The server echoes the same NetworkId back under `CM_missionAbort` as
   * confirmation.
   */
  abortMission(missionId: NetworkId): void;

  // --- SecureTrade handshake ---

  /**
   * Open and drive a full SecureTrade window with `otherId` end-to-end.
   *
   * State machine:
   *   1. Send `CM_secureTrade(RequestTrade)` ObjController to `otherId`.
   *   2. Wait for `BeginTradeMessage` (server confirms the other party
   *      accepted). On timeout → `{ completed: false, abortReason: 'no-begin' }`.
   *   3. For each item in `opts.items`: send `AddItemMessage(item)`.
   *   4. If `opts.credits` > 0: send `GiveMoneyMessage(credits)`.
   *   5. Send `AcceptTransactionMessage`.
   *   6. Wait for `VerifyTradeMessage` (or `AbortTradeMessage`). On timeout
   *      → `{ completed: false, abortReason: 'no-verify' }`. On abort →
   *      `{ completed: false, abortReason: 'aborted' }`.
   *   7. Echo `VerifyTradeMessage` back, then wait for
   *      `TradeCompleteMessage`. On timeout → `{ completed: false,
   *      abortReason: 'no-complete' }`. On success → `{ completed: true }`.
   *
   * If the OTHER party drives the trade (i.e. they sent `RequestTrade` to
   * us) the same primitive can still be used by the recipient — step 1 is
   * idempotent server-side. In practice the recipient typically waits for
   * `BeginTradeMessage` to arrive first, then calls `tradeWith` — the
   * RequestTrade we send is consumed as a redundant accept.
   */
  tradeWith(otherId: NetworkId, opts?: TradeWithOptions): Promise<TradeWithResult>;
}

interface InternalContext extends ScriptContext {
  /** Tracking for the orchestrator. */
  readonly _state: {
    sendsCount: number;
    didLogout: boolean;
    pose: { x: number; y: number; z: number; yaw: number };
    /** Cell-relative pose cursor — separate from the world pose. */
    cellPose: { parentId: NetworkId; x: number; y: number; z: number; yaw: number };
    sequenceNumber: number;
    /** Wall-clock ms when the context was created — base for syncStamp derivation. */
    scriptStartTime: number;
    /** Last syncStamp returned by nextSyncStamp(); ensures monotonic-with-delta progression even on rapid calls. */
    lastSyncStamp: number;
    /** Negative seqs we've already ACKed via CM_teleportAck. */
    ackedTeleportSeqs: Set<number>;
    /** Unsubscribe handle for the live CM=113 listener installed in ackPendingTeleports. */
    teleportListenerUnsubscribe: (() => void) | null;
    commandSequence: number;
    chatSequence: number;
    /**
     * Per-crafting-session sequence id. Counts up across every
     * `assignCraftingSlot` / `clearCraftingSlot` / `craftExperiment` call.
     * The server echoes it back in `CM_craftingResult` so the client can
     * correlate request → reply. Reset would happen at end-of-session in a
     * stateful orchestrator; we just let it monotonically grow.
     */
    craftSequence: number;
    /**
     * Per-player mission-flow sequence id. Counts up across every
     * `requestMissionList` / `acceptMission` / `removeMission` call.
     * The server echoes it back in `MessageQueueMissionGenericResponse`
     * so the client can correlate request → reply. Wraps to u8 on the wire.
     */
    missionSequence: number;
    assertionFailures: string[];
  };
}

export interface CreateScriptContextOptions {
  dispatcher: MessageDispatcher;
  sceneStart: SceneStart;
  signal: AbortSignal;
  /** Initial sequence number for UpdateTransformMessage. Default 1. */
  initialSequenceNumber?: number;
  /** Initial sequence number for command-queue messages. Default 1. */
  initialCommandSequence?: number;
  /** Initial sequence number for chat messages. Default 1. */
  initialChatSequence?: number;
  /** Initial sequence number for crafting-session messages. Default 1. */
  initialCraftSequence?: number;
  /** Initial sequence number for mission-flow messages. Default 1. */
  initialMissionSequence?: number;
}

export function createScriptContext(opts: CreateScriptContextOptions): ScriptContext {
  const state = {
    sendsCount: 0,
    didLogout: false,
    pose: {
      x: opts.sceneStart.startPosition.x,
      y: opts.sceneStart.startPosition.y,
      z: opts.sceneStart.startPosition.z,
      yaw: opts.sceneStart.startYaw,
    },
    cellPose: {
      parentId: 0n as NetworkId,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
    },
    sequenceNumber: opts.initialSequenceNumber ?? 1,
    scriptStartTime: Date.now(),
    lastSyncStamp: 0,
    ackedTeleportSeqs: new Set<number>(),
    teleportListenerUnsubscribe: null as (() => void) | null,
    commandSequence: opts.initialCommandSequence ?? 1,
    chatSequence: opts.initialChatSequence ?? 1,
    craftSequence: opts.initialCraftSequence ?? 1,
    missionSequence: opts.initialMissionSequence ?? 1,
    assertionFailures: [] as string[],
  };

  const ctx: InternalContext = {
    dispatcher: opts.dispatcher,
    sceneStart: opts.sceneStart,
    signal: opts.signal,
    _state: state,

    position(): Readonly<Vector3> {
      return { x: state.pose.x, y: state.pose.y, z: state.pose.z };
    },
    yaw(): number {
      return state.pose.yaw;
    },
    nextSequenceNumber(): number {
      return state.sequenceNumber++;
    },
    nextSyncStamp(): number {
      const elapsed = (Date.now() - state.scriptStartTime) >>> 0;
      const next = elapsed <= state.lastSyncStamp ? (state.lastSyncStamp + 1) >>> 0 : elapsed;
      state.lastSyncStamp = next;
      return next;
    },
    async ackPendingTeleports(): Promise<void> {
      const playerId = opts.sceneStart.playerNetworkId;
      const ackSeq = (seq: number): void => {
        if (state.ackedTeleportSeqs.has(seq)) return;
        state.ackedTeleportSeqs.add(seq);
        const data: TeleportAckData = { sequenceId: seq };
        const stream = new ByteStream();
        TeleportAckDecoder.encode(stream, data);
        ctx.send(
          new ObjControllerMessage(
            CLIENT_TO_AUTH_SERVER_FLAGS,
            ObjControllerSubtypeIds.CM_teleportAck,
            playerId,
            0,
            stream.toBytes(),
            { kind: TeleportAckDecoder.kind, data },
          ),
        );
      };

      // 1) Scan the transcript for already-received teleport signals
      //    (the zone-in flood arrives BEFORE the script runs).
      for (const e of opts.dispatcher.transcript) {
        if (e.direction !== 'recv') continue;
        const decoded = (e as { decoded?: unknown }).decoded;
        if (!(decoded instanceof ObjControllerMessage)) continue;
        if (decoded.message !== ObjControllerSubtypeIds.CM_netUpdateTransform) continue;
        if (decoded.networkId !== playerId) continue;
        if (decoded.decodedSubtype?.kind !== NetUpdateTransformKind) continue;
        const td = decoded.decodedSubtype.data as NetUpdateTransformData;
        if (td.sequenceNumber < 0) ackSeq(td.sequenceNumber);
      }

      // 2) Defensive fallback — also send -1, which is what
      //    resyncMovementUpdates uses by default when no specific id is in
      //    the m_teleportIds set yet but isTeleporting() is still true.
      ackSeq(-1);

      // 3) Subscribe to future signals so subsequent server teleports
      //    (during the script's run) get ACKed automatically.
      if (state.teleportListenerUnsubscribe === null) {
        state.teleportListenerUnsubscribe = opts.dispatcher.onMessage(
          ObjControllerMessage,
          (m) => {
            if (m.message !== ObjControllerSubtypeIds.CM_netUpdateTransform) return;
            if (m.networkId !== playerId) return;
            if (m.decodedSubtype?.kind !== NetUpdateTransformKind) return;
            const td = m.decodedSubtype.data as NetUpdateTransformData;
            if (td.sequenceNumber < 0) ackSeq(td.sequenceNumber);
          },
        );
      }

      // 4) Brief settle so the server processes the ACK before the next
      //    movement send hits handleMove.
      await sleep(50, opts.signal);
    },
    setPose(position: Vector3, yaw: number): void {
      state.pose.x = position.x;
      state.pose.y = position.y;
      state.pose.z = position.z;
      state.pose.yaw = yaw;
    },

    send<T extends GameNetworkMessage>(msg: T): void {
      opts.dispatcher.send(msg);
      state.sendsCount++;
    },

    wait(ms: number): Promise<void> {
      return sleep(ms, opts.signal);
    },

    waitForMessage(ctor, waitOpts) {
      return opts.dispatcher.waitFor(ctor, waitOpts ?? {});
    },

    walkTo(target, walkOpts) {
      return walkToImpl(ctx, target, walkOpts ?? {});
    },

    walkCircle(circleOpts) {
      return walkCircleImpl(ctx, circleOpts);
    },

    walkToCell(parentId, target, walkOpts) {
      return walkToCellImpl(ctx, parentId, target, walkOpts ?? {});
    },

    cellPosition(): Readonly<Vector3> {
      return { x: state.cellPose.x, y: state.cellPose.y, z: state.cellPose.z };
    },

    parentCell(): NetworkId {
      return state.cellPose.parentId;
    },

    setCellPose(parentId: NetworkId, position: Vector3, yaw: number): void {
      state.cellPose.parentId = parentId;
      state.cellPose.x = position.x;
      state.cellPose.y = position.y;
      state.cellPose.z = position.z;
      state.cellPose.yaw = yaw;
    },

    openContainer(containerId, slot) {
      ctx.send(new ClientOpenContainerMessage(containerId, slot ?? ''));
    },

    openPlayerInventory(): void {
      ctx.openContainer(opts.sceneStart.playerNetworkId, 'inventory');
    },

    closeContainer(_containerId): void {
      // No wire message exists. Count the intent so transcripts include it.
      state.sendsCount++;
    },

    async logout(): Promise<void> {
      ctx.send(new LogoutMessage());
      state.didLogout = true;
      // Match what the Windows client does: brief settle before SOE Terminate.
      await sleep(1_000, opts.signal);
    },

    // --- Combat / command-queue primitives ---

    nextCommandSequence(): number {
      return state.commandSequence++;
    },

    useAbility(commandName, targetId, params): number {
      const seq = ctx.nextCommandSequence();
      const enqueue = new CommandQueueEnqueue(
        seq,
        hashCommand(commandName),
        targetId ?? NO_TARGET,
        params ?? '',
      );
      const wrapped = wrapAsObjControllerMessage(enqueue, opts.sceneStart.playerNetworkId);
      ctx.send(wrapped);
      return seq;
    },

    attackTarget(targetId): number {
      return ctx.useAbility('attack', targetId);
    },

    changePosture(posture): number {
      return ctx.useAbility(POSTURE_COMMAND[posture]);
    },

    // --- Chat primitives ---

    nextChatSequence(): number {
      return state.chatSequence++;
    },

    tell(targetName, text): number {
      const seq = ctx.nextChatSequence();
      const avatar = typeof targetName === 'string' ? chatAvatarId(targetName) : targetName;
      ctx.send(new ChatInstantMessageToCharacter(avatar, text, '', seq));
      return seq;
    },

    sendToChannel(channelId, text): number {
      const seq = ctx.nextChatSequence();
      ctx.send(new ChatSendToRoom(seq, channelId, text, ''));
      return seq;
    },

    sendMail(target, subject, body): number {
      const seq = ctx.nextChatSequence();
      const avatar = typeof target === 'string' ? chatAvatarId(target) : target;
      ctx.send(new ChatPersistentMessageToServer(seq, avatar, subject, body, ''));
      return seq;
    },

    say(text, sayOpts): number {
      // Spatial chat travels through the server-side CommandQueue command
      // `spatialChatInternal` rather than the direct `CM_spatialChatSend`
      // ObjController subtype. Reason: the server's
      // `ControllerMessageFactory::allowFromClient` registry has
      // `CM_spatialChatSend=false` (see MessageQueueSpatialChat.cpp:26 — the
      // 4th arg is left at its default of `false`). A direct
      // `CM_spatialChatSend` from a non-admin client is logged as a
      // HackAttempts entry and dropped (Client.cpp:972). The real Windows
      // client uses the CommandQueue path, which goes through the standard
      // command-allow-list (CommandTable says spatialChatInternal is fine)
      // and then the server builds the `MessageQueueSpatialChat` itself,
      // filling in volume from `chat/spatial_chat_types.iff` and running
      // the chat-spam limiter (CommandCppFuncs.cpp:1693). The server then
      // broadcasts a `CM_spatialChatReceive` (244) to every observer in
      // radius — which our subtype registry decodes via
      // `SpatialChatReceiveDecoder`.
      //
      // params format (whitespace-separated, then a Unicode::String tail):
      //   "<targetId> <chatType> <mood> <flags> <language> <text>"
      //
      // We consume from the chat-sequence counter (the wire goes through
      // useAbility, but the user-facing "chat sequence id" is what callers
      // see). The internal command-queue sequence still increments —
      // there's no harm in both ticking.
      const seq = ctx.nextChatSequence();
      const chatType = sayOpts?.chatType ?? SpatialChatType.Say;
      const targetId = sayOpts?.targetId ?? 0n;
      const moodType = sayOpts?.moodType ?? 0;
      const flags = sayOpts?.flags ?? 0;
      const language = sayOpts?.language ?? 0;
      const params = `${targetId.toString()} ${chatType} ${moodType} ${flags} ${language} ${text}`;
      ctx.useAbility('spatialChatInternal', 0n, params);
      return seq;
    },

    requestChannelList(): void {
      ctx.send(new ChatRequestRoomList());
    },

    // --- Crafting primitives ---

    beginCrafting(toolId: NetworkId, schematicCrc?: number): number {
      // Wrap as a command-queue request — the server's
      // `commandFuncRequestCraftingSession` then opens the session and
      // replies via CM_craftingResult + DraftSchematicsMessage.
      const params = schematicCrc !== undefined ? String(schematicCrc) : '';
      return ctx.useAbility('requestCraftingSession', toolId, params);
    },

    selectCraftingSchematic(schematicIndex: number): number {
      // commandFuncSelectDraftSchematic parses params as the integer index.
      return ctx.useAbility('selectDraftSchematic', 0n, String(schematicIndex));
    },

    async waitForDraftSchematics(
      waitOpts?: { timeoutMs?: number },
    ): Promise<DraftSchematicsData> {
      const timeoutMs = waitOpts?.timeoutMs ?? 8_000;
      const msg = await opts.dispatcher.waitFor(ObjControllerMessage, {
        timeoutMs,
        predicate: (m) =>
          m.message === ObjControllerSubtypeIds.CM_draftSchematicsMessage &&
          m.decodedSubtype?.kind === DraftSchematicsKind,
      });
      return msg.decodedSubtype!.data as DraftSchematicsData;
    },

    async waitForDraftSlots(
      waitOpts?: { timeoutMs?: number },
    ): Promise<ManufactureSchematicData> {
      const timeoutMs = waitOpts?.timeoutMs ?? 8_000;
      const msg = await opts.dispatcher.waitFor(ObjControllerMessage, {
        timeoutMs,
        predicate: (m) =>
          m.message === ObjControllerSubtypeIds.CM_draftSlotsMessage &&
          m.decodedSubtype?.kind === ManufactureSchematicKind,
      });
      return msg.decodedSubtype!.data as ManufactureSchematicData;
    },

    assignCraftingSlot(
      slotIndex: number,
      ingredientId: NetworkId,
      assignOpts?: { optionIndex?: number; quantity?: number },
    ): number {
      const seq = state.craftSequence++ & 0xff; // u8 on the wire
      const data: CraftingSlotAssignData = {
        ingredientId,
        slotIndex,
        optionIndex: assignOpts?.optionIndex ?? 0,
        sequenceId: seq,
      };
      const stream = new ByteStream();
      CraftingSlotAssignDecoder.encode(stream, data);
      const wrapped = new ObjControllerMessage(
        CLIENT_TO_AUTH_SERVER_FLAGS,
        ObjControllerSubtypeIds.CM_fillSchematicSlotMessage,
        opts.sceneStart.playerNetworkId,
        0,
        stream.toBytes(),
        { kind: CraftingSlotAssignDecoder.kind, data },
      );
      ctx.send(wrapped);
      return seq;
    },

    clearCraftingSlot(slotIndex: number, targetContainer?: NetworkId): number {
      const seq = state.craftSequence++ & 0xff;
      const data: CraftingSlotEmptyData = {
        slotIndex,
        targetContainer: targetContainer ?? opts.sceneStart.playerNetworkId,
        sequenceId: seq,
      };
      const stream = new ByteStream();
      CraftingSlotEmptyDecoder.encode(stream, data);
      const wrapped = new ObjControllerMessage(
        CLIENT_TO_AUTH_SERVER_FLAGS,
        ObjControllerSubtypeIds.CM_emptySchematicSlotMessage,
        opts.sceneStart.playerNetworkId,
        0,
        stream.toBytes(),
        { kind: CraftingSlotEmptyDecoder.kind, data },
      );
      ctx.send(wrapped);
      return seq;
    },

    craftExperiment(
      experiments: Array<{ attribute: number; points: number }>,
      experimentOpts?: { coreLevel?: number },
    ): number {
      const seq = state.craftSequence++ & 0xff;
      const data: CraftingExperimentData = {
        sequenceId: seq,
        experiments: experiments.map((e) => ({
          attributeIndex: e.attribute,
          experimentPoints: e.points,
        })),
        coreLevel: experimentOpts?.coreLevel ?? 0,
      };
      const stream = new ByteStream();
      CraftingExperimentDecoder.encode(stream, data);
      const wrapped = new ObjControllerMessage(
        CLIENT_TO_AUTH_SERVER_FLAGS,
        ObjControllerSubtypeIds.CM_experimentMessage,
        opts.sceneStart.playerNetworkId,
        0,
        stream.toBytes(),
        { kind: CraftingExperimentDecoder.kind, data },
      );
      ctx.send(wrapped);
      return seq;
    },

    finishCrafting(toolId: NetworkId, finishOpts?: { realPrototype?: boolean }): number {
      // Command-queue path — the server's commandFuncCreatePrototype parses
      // params as "<sequenceId> <realPrototype>" and uses
      // player->createPrototype to spawn the item.
      const seqForServer = state.craftSequence++ & 0xff;
      const realProto = (finishOpts?.realPrototype ?? true) ? '1' : '0';
      const params = `${seqForServer} ${realProto}`;
      return ctx.useAbility('createPrototype', toolId, params);
    },

    // --- Expectation primitives ---

    expectWithin(ctor, timeoutMs, expectOpts) {
      if (expectOpts?.soft === true) {
        return expectWithinImpl(opts.dispatcher, ctor, timeoutMs, {
          ...expectOpts,
          soft: true,
        }).then((m) => {
          if (m === undefined) {
            state.assertionFailures.push(
              `Timed out after ${timeoutMs}ms waiting for ${ctor.messageName}`,
            );
          }
          return m;
        });
      }
      return expectWithinImpl(opts.dispatcher, ctor, timeoutMs, expectOpts);
    },

    expectAbsent(ctor, windowMs, expectOpts) {
      return expectAbsentImpl(opts.dispatcher, ctor, windowMs, expectOpts);
    },

    expectAfter(trigger, ctor, expectOpts) {
      const soft = (expectOpts as { soft?: boolean }).soft === true;
      if (soft) {
        return expectAfterImpl(opts.dispatcher, trigger, ctor, {
          ...expectOpts,
          soft: true,
        }).then((m) => {
          if (m === undefined) {
            state.assertionFailures.push(
              `Timed out after ${expectOpts.withinMs}ms waiting for ${ctor.messageName} after trigger`,
            );
          }
          return m;
        });
      }
      return expectAfterImpl(opts.dispatcher, trigger, ctor, {
        ...expectOpts,
        soft: false,
      });
    },

    fail(reason: string): void {
      state.assertionFailures.push(reason);
    },

    assertionFailures(): readonly string[] {
      return state.assertionFailures;
    },

    // --- Survey primitives ---

    survey(toolId: NetworkId, resourceTypeName: string): number {
      // Server-side commandFuncRequestSurvey (CommandCppFuncs.cpp:2761) takes
      // the survey tool's NetworkId as `target` and the resource TYPE NAME
      // (not class) as `params`. The script trigger
      // `survey_tool_script.OnRequestSurvey` then calls `requestSurvey` JNI
      // → SurveySystem::TaskSurvey which looks the type up by exact name.
      return ctx.useAbility('requestsurvey', toolId, resourceTypeName);
    },

    async fetchSurveyResources(
      toolId: NetworkId,
      fetchOpts?: { timeoutMs?: number },
    ): Promise<ResourceListItem[]> {
      const timeoutMs = fetchOpts?.timeoutMs ?? 8_000;
      const playerId = opts.sceneStart.playerNetworkId;

      // Set up the response waiter BEFORE sending, so a fast server reply
      // can't slip past us.
      const listPromise = opts.dispatcher.waitFor(ResourceListForSurveyMessage, {
        timeoutMs,
        predicate: (m) => m.surveyToolId === toolId,
      });

      // Step 1: ObjControllerMessage(CM_objectMenuRequest=326) with an empty
      // items list — the server populates the radial.
      const reqStream = new ByteStream();
      _encodeObjectMenu(reqStream, {
        targetId: toolId,
        requestorId: playerId,
        items: [],
        sequence: 1,
      });
      const reqData = reqStream.toBytes();
      ctx.send(
        new ObjControllerMessage(
          CLIENT_TO_AUTH_SERVER_FLAGS,
          ObjControllerSubtypeIds.CM_objectMenuRequest,
          playerId,
          0,
          reqData,
        ),
      );

      // We don't strictly need the menu response — the server triggers
      // OnObjectMenuRequest in survey_tool_script which calls
      // requestResourceListForSurvey directly. But sending the request is
      // what kicks the script. Some clients also send ObjectMenuSelectMessage
      // explicitly after picking; we do that as a defensive belt-and-suspenders.

      // Step 2: ObjectMenuSelectMessage(target=tool, itemId=ITEM_USE) — the
      // selection trigger that directly fires OnObjectMenuSelect. This is
      // what kicks the resource-list send server-side per pcap analysis.
      ctx.send(new ObjectMenuSelectMessage(toolId, RadialMenuTypes.ITEM_USE));

      // Step 3: wait for the resource list to arrive.
      const msg = await listPromise;
      return msg.data;
    },

    async waitForSurvey(surveyOpts): Promise<{ points: SurveyPoint[] }> {
      const timeoutMs = surveyOpts?.timeoutMs ?? 60_000;
      const msg = await opts.dispatcher.waitFor(SurveyMessage, { timeoutMs });
      return { points: msg.data };
    },

    sample(toolId: NetworkId, resourceTypeName: string): number {
      return ctx.useAbility('requestcoresample', toolId, resourceTypeName);
    },

    async cancelSampling(): Promise<void> {
      // The server's sample loop cancels when the player has moved > 1m
      // from `surveying.sampleLocation`. Walk a small distance and let the
      // next tick (~30s later) clean up. We don't wait for the cancel chat
      // here — that's the caller's choice.
      const cur = ctx.position();
      // Use walkTo with a 2m offset; default tickMs/speed give us a quick send.
      const { walkTo: walkToImplLocal } = await import('./movement.js');
      await walkToImplLocal(
        ctx,
        { x: cur.x + 2.5, z: cur.z + 2.5 },
        { speed: 4, tickMs: 500 },
      );
    },

    async waitForSampleEvent(
      sampleOpts?: {
        timeoutMs?: number;
        predicate?: (kind: SampleEventKind, raw: string) => boolean;
      },
    ): Promise<{ kind: SampleEventKind; raw: string }> {
      const timeoutMs = sampleOpts?.timeoutMs ?? 60_000;
      const pred = sampleOpts?.predicate;
      const msg = await opts.dispatcher.waitFor(ChatSystemMessage, {
        timeoutMs,
        predicate: (m) => {
          const kind = classifySampleEvent(m.outOfBand);
          if (kind === 'other') return false;
          if (pred !== undefined) {
            const raw = decodeSampleOob(m.outOfBand);
            return pred(kind, raw);
          }
          return true;
        },
      });
      return { kind: classifySampleEvent(msg.outOfBand), raw: decodeSampleOob(msg.outOfBand) };
    },

    async fetchResourceAttributes(
      objectIds: NetworkId[],
      attrOpts?: { timeoutMs?: number; clientRevision?: number; maxBatchSize?: number },
    ): Promise<Map<NetworkId, readonly AttributePair[]>> {
      const timeoutMs = attrOpts?.timeoutMs ?? 8_000;
      const clientRevision = attrOpts?.clientRevision ?? -1;
      const maxBatchSize = attrOpts?.maxBatchSize ?? 25;
      const result = new Map<NetworkId, readonly AttributePair[]>();
      if (objectIds.length === 0) return result;

      const pending = new Set<bigint>(objectIds);
      // Subscribe to AttributeListMessage BEFORE sending. We collect every
      // response whose networkId is in our pending set; resolve when the
      // set is empty or the timeout fires.
      const collected = new Promise<void>((resolve) => {
        const unsub = opts.dispatcher.onMessage(AttributeListMessage, (m) => {
          if (!pending.has(m.networkId)) return;
          pending.delete(m.networkId);
          result.set(m.networkId, m.data);
          if (pending.size === 0) {
            unsub();
            resolve();
          }
        });
        const timer = setTimeout(() => {
          unsub();
          resolve();
        }, timeoutMs);
        timer.unref?.();
      });

      // Send in chunks of maxBatchSize. Each useAbility carries a
      // CommandQueueEnqueue whose `params` string is "<id1> <rev> <id2> <rev> ..."
      // — at ~12 chars per id, a chunk of 25 stays comfortably under the
      // single-packet ceiling.
      for (let i = 0; i < objectIds.length; i += maxBatchSize) {
        const chunk = objectIds.slice(i, i + maxBatchSize);
        const params = chunk.map((id) => `${id.toString()} ${clientRevision}`).join(' ');
        ctx.useAbility('getAttributesBatch', 0n, params);
      }

      await collected;
      return result;
    },

    // --- Mission primitives ---

    nextMissionSequence(): number {
      return state.missionSequence++;
    },

    requestMissionList(terminalId: NetworkId, requestOpts?: { flags?: number }): number {
      const seq = ctx.nextMissionSequence() & 0xff; // u8 on the wire
      const data: MissionListRequestData = {
        flags: requestOpts?.flags ?? 0,
        sequenceId: seq,
        terminalId,
      };
      const stream = new ByteStream();
      MissionListRequestDecoder.encode(stream, data);
      const wrapped = new ObjControllerMessage(
        CLIENT_TO_AUTH_SERVER_FLAGS,
        ObjControllerSubtypeIds.CM_missionListRequest,
        opts.sceneStart.playerNetworkId,
        0,
        stream.toBytes(),
        { kind: MissionListRequestDecoder.kind, data },
      );
      ctx.send(wrapped);
      return seq;
    },

    acceptMission(missionId: NetworkId, terminalId: NetworkId): number {
      const seq = ctx.nextMissionSequence() & 0xff;
      const data: MissionGenericRequestData = {
        missionObjectId: missionId,
        terminalId,
        sequenceId: seq,
      };
      const stream = new ByteStream();
      MissionAcceptRequestDecoder.encode(stream, data);
      const wrapped = new ObjControllerMessage(
        CLIENT_TO_AUTH_SERVER_FLAGS,
        ObjControllerSubtypeIds.CM_missionAcceptRequest,
        opts.sceneStart.playerNetworkId,
        0,
        stream.toBytes(),
        { kind: MissionAcceptRequestDecoder.kind, data },
      );
      ctx.send(wrapped);
      return seq;
    },

    removeMission(missionId: NetworkId, terminalId: NetworkId): number {
      const seq = ctx.nextMissionSequence() & 0xff;
      const data: MissionGenericRequestData = {
        missionObjectId: missionId,
        terminalId,
        sequenceId: seq,
      };
      const stream = new ByteStream();
      MissionRemoveRequestDecoder.encode(stream, data);
      const wrapped = new ObjControllerMessage(
        CLIENT_TO_AUTH_SERVER_FLAGS,
        ObjControllerSubtypeIds.CM_missionRemoveRequest,
        opts.sceneStart.playerNetworkId,
        0,
        stream.toBytes(),
        { kind: MissionRemoveRequestDecoder.kind, data },
      );
      ctx.send(wrapped);
      return seq;
    },

    abortMission(missionId: NetworkId): void {
      const data: MissionAbortData = { missionObjectId: missionId };
      const stream = new ByteStream();
      MissionAbortDecoder.encode(stream, data);
      const wrapped = new ObjControllerMessage(
        CLIENT_TO_AUTH_SERVER_FLAGS,
        ObjControllerSubtypeIds.CM_missionAbort,
        opts.sceneStart.playerNetworkId,
        0,
        stream.toBytes(),
        { kind: MissionAbortDecoder.kind, data },
      );
      ctx.send(wrapped);
    },

    // --- SecureTrade handshake ---

    async tradeWith(
      otherId: NetworkId,
      tradeOpts?: TradeWithOptions,
    ): Promise<TradeWithResult> {
      const playerId = opts.sceneStart.playerNetworkId;
      const beginTimeoutMs = tradeOpts?.beginTimeoutMs ?? 15_000;
      const acceptTimeoutMs = tradeOpts?.acceptTimeoutMs ?? 15_000;
      const verifyTimeoutMs = tradeOpts?.verifyTimeoutMs ?? 15_000;
      const items = tradeOpts?.items ?? [];
      const credits = tradeOpts?.credits ?? 0;

      const abortPromise = opts.dispatcher.waitFor(AbortTradeMessage, {
        timeoutMs: beginTimeoutMs + acceptTimeoutMs + verifyTimeoutMs + 5_000,
      });
      abortPromise.catch(() => {
        // intentionally swallowed — abort never arrived in the budget window.
      });

      const reqStream = new ByteStream();
      const reqData = {
        tradeMessageId: TradeMessageId.RequestTrade,
        initiatorId: playerId,
        recipientId: otherId,
      };
      TradeStartDecoder.encode(reqStream, reqData);
      ctx.send(
        new ObjControllerMessage(
          CLIENT_TO_AUTH_SERVER_FLAGS,
          ObjControllerSubtypeIds.CM_secureTrade,
          playerId,
          0,
          reqStream.toBytes(),
          { kind: TradeStartDecoder.kind, data: reqData },
        ),
      );

      const beginPromise = opts.dispatcher.waitFor(BeginTradeMessage, {
        timeoutMs: beginTimeoutMs,
      });
      try {
        const winner = await Promise.race([
          beginPromise.then((m) => ({ kind: 'begin' as const, msg: m })),
          abortPromise.then(() => ({ kind: 'abort' as const })),
        ]);
        if (winner.kind === 'abort') {
          return { completed: false, abortReason: 'aborted' };
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (/Timed out/.test(reason)) {
          return { completed: false, abortReason: 'no-begin' };
        }
        throw err;
      }

      for (const itemId of items) {
        ctx.send(new AddItemMessage(itemId));
      }

      if (credits > 0) {
        ctx.send(new GiveMoneyMessage(credits));
      }

      ctx.send(new AcceptTransactionMessage());

      const verifyPromise = opts.dispatcher.waitFor(VerifyTradeMessage, {
        timeoutMs: acceptTimeoutMs,
      });
      try {
        const winner = await Promise.race([
          verifyPromise.then((m) => ({ kind: 'verify' as const, msg: m })),
          abortPromise.then(() => ({ kind: 'abort' as const })),
        ]);
        if (winner.kind === 'abort') {
          return { completed: false, abortReason: 'aborted' };
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (/Timed out/.test(reason)) {
          return { completed: false, abortReason: 'no-verify' };
        }
        throw err;
      }

      const completePromise = opts.dispatcher.waitFor(TradeCompleteMessage, {
        timeoutMs: verifyTimeoutMs,
      });
      ctx.send(new VerifyTradeMessage());

      try {
        const winner = await Promise.race([
          completePromise.then((m) => ({ kind: 'complete' as const, msg: m })),
          abortPromise.then(() => ({ kind: 'abort' as const })),
        ]);
        if (winner.kind === 'abort') {
          return { completed: false, abortReason: 'aborted' };
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (/Timed out/.test(reason)) {
          return { completed: false, abortReason: 'no-complete' };
        }
        throw err;
      }

      return { completed: true };
    },
  };

  return ctx;
}

/** Run a scenario function and return a ScriptResult. Never throws. */
export async function runScript(fn: ScenarioFn, ctx: ScriptContext): Promise<ScriptResult> {
  const t0 = Date.now();
  const internal = ctx as InternalContext;
  let error: string | undefined;
  try {
    await fn(ctx);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    if (internal._state.teleportListenerUnsubscribe !== null) {
      internal._state.teleportListenerUnsubscribe();
      internal._state.teleportListenerUnsubscribe = null;
    }
  }
  return {
    elapsedMs: Date.now() - t0,
    sendsCount: internal._state.sendsCount,
    didLogout: internal._state.didLogout,
    assertionFailures: [...internal._state.assertionFailures],
    ...(error !== undefined ? { error } : {}),
  };
}

/** Read whether the script called logout. Used by the game-stage to skip a double-send. */
export function didScriptLogout(ctx: ScriptContext): boolean {
  return (ctx as InternalContext)._state.didLogout;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    t.unref?.();
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
