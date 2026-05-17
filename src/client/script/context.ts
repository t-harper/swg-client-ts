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
  AttributeListMessage,
  type AttributePair,
} from '../../messages/game/attribute-list-message.js';
import { BaselinePackageIds, ObjectTypeTags } from '../../messages/game/baselines/registry.js';
import type { TangibleObjectSharedNpBaseline } from '../../messages/game/baselines/tangible-object-baseline-6.js';
import {
  type ChatAvatarId,
  ChatInstantMessageToCharacter,
  ChatPersistentMessageToServer,
  ChatRequestRoomList,
  ChatSendToRoom,
  chatAvatarId,
} from '../../messages/game/chat/index.js';
import { ChatSystemMessage } from '../../messages/game/chat/index.js';
import { ClientOpenContainerMessage } from '../../messages/game/client-open-container.js';
import {
  CLIENT_TO_AUTH_SERVER_FLAGS,
  CommandQueueEnqueue,
  NO_TARGET,
  hashCommand,
  wrapAsObjControllerMessage,
} from '../../messages/game/command-queue/index.js';
import {
  AdvancedSearchMatchAllAny,
  type AuctionListing,
  AuctionLocationSearch,
  AuctionQueryHeadersMessage,
  AuctionQueryHeadersResponseMessage,
  AuctionResult,
  AuctionSearchType,
  BidAuctionMessage,
  CancelLiveAuctionMessage,
  CreateAuctionMessage,
  CreateAuctionResponseMessage,
  CreateImmediateAuctionMessage,
  GetAuctionDetails,
  GetAuctionDetailsResponse,
  RetrieveAuctionItemMessage,
  type SearchCondition,
} from '../../messages/game/commodities/index.js';
import {
  type DraftSchematicsData,
  DraftSchematicsKind,
  type ManufactureSchematicData,
  ManufactureSchematicKind,
} from '../../messages/game/crafting/index.js';
import { LogoutMessage } from '../../messages/game/logout-message.js';
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
  type NpcConversationMessageData,
  NpcConversationMessageKind,
  type NpcConversationResponsesData,
  NpcConversationResponsesKind,
} from '../../messages/game/npc/index.js';
import { ObjControllerMessage } from '../../messages/game/obj-controller-message.js';
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
  type TradeStartData,
  TradeStartDecoder,
  TradeStartKind,
} from '../../messages/game/obj-controller/index.js';
import { _encodeObjectMenu } from '../../messages/game/obj-controller/object-menu-request.js';
import {
  ObjectMenuSelectMessage,
  RadialMenuTypes,
} from '../../messages/game/object-menu-select-message.js';
import { SuiCreatePageMessage, SuiEventNotification } from '../../messages/game/sui/index.js';
import {
  ResourceListForSurveyMessage,
  type ResourceListItem,
  SurveyMessage,
  type SurveyPoint,
} from '../../messages/game/survey/index.js';
import {
  AbortTradeMessage,
  AcceptTransactionMessage,
  AddItemMessage,
  BeginTradeMessage,
  BeginVerificationMessage,
  GiveMoneyMessage,
  TradeCompleteMessage,
  VerifyTradeMessage,
} from '../../messages/game/trade/index.js';
import type { GameNetworkMessage } from '../../messages/interface.js';
import type { NetworkId, SceneStart, Vector3 } from '../../types.js';
import type { CharacterSheet } from '../character-sheet.js';
import { createCharacterSheet } from '../character-sheet.js';
import type { MessageDispatcher } from '../dispatcher.js';
import {
  type CombatTimerHandle,
  type CombatTimerView,
  type CooldownTrackerHandle,
  type CooldownView,
  type ServerTimeTrackerHandle,
  type ServerTimeView,
  createCombatTimer,
  createCooldownTracker,
  createServerTimeTracker,
} from '../timing.js';
import { SceneCreateObjectByCrc } from '../../messages/game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from '../../messages/game/scene-create-object-by-name.js';
import {
  InventoryViewImpl,
  type InventoryView,
} from '../inventory-view.js';
import type { WorldModel, WorldObject } from '../world-model.js';
import {
  PLAYER_DATAPAD_TEMPLATE_CRC,
  extractDatapadContainerId,
} from '../baseline-helpers.js';
import { type DatapadView, DatapadViewImpl } from './datapad-view.js';
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
 * Paired NPC dialog state returned from `ctx.waitForNpcDialog()`. The server
 * sends the prompt text and the option menu as TWO ObjController subtypes
 * (CM_npcConversationMessage = 223 + CM_npcConversationResponses = 224); the
 * scripting helper waits for both within a short window and bundles them here.
 */
export interface NpcDialogPrompt {
  /** The player's NetworkId — i.e. the addressee of these conversation messages. */
  playerId: NetworkId;
  /** NPC's prompt text (Unicode). */
  prompt: string;
  /** Menu option strings (Unicode). Empty when the prompt is auto-advance. */
  options: readonly string[];
}

/** Options for `ctx.tradeWith()`. */
export interface TradeWithOptions {
  items?: readonly NetworkId[];
  credits?: number;
  beginTimeoutMs?: number;
  acceptTimeoutMs?: number;
  verifyTimeoutMs?: number;
}

/** Outcome of a `ctx.tradeWith()` / `ctx.acceptIncomingTrade()` call. */
export interface TradeWithResult {
  completed: boolean;
  /**
   * Populated on any failure — `no-request` (recipient side, no incoming
   * RequestTrade), `no-begin`, `aborted`, `declined`, `no-verify`,
   * `no-complete`.
   */
  abortReason?: string;
}

/** Options for `ctx.acceptIncomingTrade()`. */
export interface TradeAcceptOptions {
  /** Items to put on OUR side of the trade window. */
  items?: readonly NetworkId[];
  /** Credits to offer (we are the receiver of the initiator's offer; this is OUR offer to them). */
  credits?: number;
  /** Skip the accept — sends nothing and resolves with `abortReason: 'declined'`. */
  decline?: boolean;
  /** How long to wait for the inbound TradeRequested. Default 15s. */
  requestTimeoutMs?: number;
  beginTimeoutMs?: number;
  acceptTimeoutMs?: number;
  verifyTimeoutMs?: number;
}

/** Re-export the depalettized commodities listing struct for consumers. */
export type { AuctionListing } from '../../messages/game/commodities/index.js';

/**
 * Result of a `ctx.getAuctionDetails(auctionId)` call. Pulls the
 * `GetAuctionDetailsResponse` server reply into a flat shape — full item
 * description, the property/attribute pair list, server template name, and
 * appearance string.
 */
export interface AuctionDetails {
  itemId: NetworkId;
  userDescription: string;
  propertyList: ReadonlyArray<readonly [string, string]>;
  templateName: string;
  appearanceString: string;
}

/** Optional overrides for `ctx.browseBazaar()`. */
export interface BrowseBazaarOptions {
  /** AuctionSearchType (default ByAll=2). */
  searchType?: number;
  /** AuctionLocationSearch (default Galaxy=0). */
  locationSearchType?: number;
  /** Category itemType filter (default 0 = all categories). */
  category?: number;
  /** When `category` is set, require exact match (default false). */
  itemTypeExactMatch?: boolean;
  /** Specific template id filter (default 0 = any). */
  itemTemplateId?: number;
  /** All-words text filter (default ''). */
  textFilterAll?: string;
  /** Any-of-words text filter (default ''). */
  textFilterAny?: string;
  /** Min price (default 0 = no minimum). */
  minPrice?: number;
  /** Max price (default 0 = no maximum). */
  maxPrice?: number;
  /** Whether the price filter includes the bazaar fee (default false). */
  priceFilterIncludesFee?: boolean;
  /** Advanced-search conditions (default []). */
  advancedSearch?: readonly SearchCondition[];
  /** Match-mode for advanced-search (default match_all=0). */
  advancedSearchMatchAllAny?: number;
  /** Limit to my-vendor listings only (default false). */
  myVendorsOnly?: boolean;
  /** Page offset (default 0). */
  queryOffset?: number;
  /** Client-side request id (auto-generated if omitted). */
  requestId?: number;
  /** Server response timeout (default 8_000ms). */
  timeoutMs?: number;
}

/** Optional overrides for `ctx.listForSale()`. */
export interface ListForSaleOptions {
  /** Price in credits — for instant-sale this is the buy-now price; for auction-style this is the minimum bid. */
  price: number;
  /** Auction window in HOURS (converted to seconds on the wire). Default 24. */
  durationHours?: number;
  /** Optional description shown to bidders. Default ''. */
  description?: string;
  /** Localized display name. Default ''. */
  localizedName?: string;
  /** True ⇒ instant-buy at `price`; false ⇒ bidding-style auction. Default false. */
  instantSale?: boolean;
  /** True ⇒ pay the premium-listing fee for higher visibility. Default false. */
  premium?: boolean;
  /** Vendor-transfer flag (instant-sale only). Default false. */
  vendorTransfer?: boolean;
  /** Server response timeout (default 8_000ms). */
  timeoutMs?: number;
}

/** Result of a `ctx.listForSale()` call. */
export interface ListForSaleResult {
  /** True when `result === AuctionResult.OK`. */
  success: boolean;
  /** Echoed back by the server — usually the item id on success. */
  auctionId?: NetworkId;
  /** Raw `AuctionResult` code. */
  resultCode: number;
  /** Server-supplied human-readable rejection text (ITEM_RESTRICTED only). */
  errorReason?: string;
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
  /**
   * Live in-memory view of every object the server has told us about —
   * other players, NPCs, items, containers, buildings. Updated in place
   * from the server's baseline flood, delta updates, transform broadcasts,
   * containment changes, and scene-destroy messages.
   *
   * Common queries:
   *   `ctx.world.get(npcId)`              — fetch one object by NetworkId
   *   `ctx.world.nearby(20)`              — every object within 20m of the player
   *   `ctx.world.byType(ObjectTypeTags.CREO)` — every creature
   *   `ctx.world.filter(o => o.containerId === inventoryId)` — inventory contents
   *
   * Subscribe to live events:
   *   `ctx.world.on(e => { if (e.kind === 'delta') ... })`
   *
   * The model never sends anything — it's purely reactive. Holding a
   * reference to a `WorldObject` is safe: it's mutated in place.
   */
  readonly world: WorldModel;
  /**
   * Live, always-current view of the player's character state — name,
   * level, HAM, posture, faction, bank/cash, skills, played time, etc.
   *
   * Reads are O(1): the underlying state is updated as CREO + PLAY
   * baselines and deltas arrive on the dispatcher. Use `ctx.character.ready`
   * to gate on "first CREO baseline received" before reading fields that
   * default to 0/null.
   */
  readonly character: CharacterSheet;

  /**
   * Live cooldown tracker — `ctx.cooldowns.msUntil('mount')` returns the
   * remaining cooldown in ms (0 if ready or unknown); `ctx.cooldowns.isReady('mount')`
   * is the boolean equivalent; `ctx.cooldowns.all()` snapshots every tracked
   * command. Driven by `CM_commandTimer` (762) ObjController subtypes — when
   * the server sends a cooldown timer for a command, the expiry timestamp
   * is stored and decays against `Date.now()` on every read.
   *
   * Pair with `useAbility` to issue a command and then poll readiness; the
   * dispatcher-side subscribe means the cooldown surfaces within one tick
   * of the server's reply.
   */
  readonly cooldowns: CooldownView;

  /**
   * Live server-time view — `ctx.serverTime.ms()` returns the best estimate
   * of the current server wall-clock in ms (Unix epoch), seeded from
   * `CmdStartScene.serverEpoch` (the i32 Unix-epoch field — NOT
   * `serverTimeSeconds`, which is the server's GameTime / uptime) and
   * continuously refined by ClockReflect samples. Useful for comparing
   * mission expiry timestamps, bazaar listing windows, and anything tied
   * to a wall-clock reading on the server.
   *
   * `samples` is the count of ClockReflect samples folded in; when 0 the
   * view falls back to pure seed projection (still accurate to within a
   * couple of ms on a healthy connection, but drift accumulates over long
   * runs without samples).
   */
  readonly serverTime: ServerTimeView;

  /**
   * Live combat-engagement view — `ctx.combat.timeSinceLastHitMs` returns
   * the ms since the player was last targeted by a `CM_combatAction` (204)
   * server delivery (or `Number.POSITIVE_INFINITY` if never hit during the
   * script run); `ctx.combat.engaged` is a derived boolean true when within
   * 10s of the last hit.
   *
   * Useful for: deciding whether to flee, gating "out-of-combat" abilities,
   * or measuring how long a soak script sat unmolested.
   */
  readonly combat: CombatTimerView;

  /**
   * Always-fresh view of the player's datapad — vehicle/pet PCDs,
   * waypoints, missions, ship items, manufacturing schematics.
   *
   *   ctx.datapad.vehicles()[0]?.networkId    // first vehicle PCD
   *   ctx.datapad.waypoints()                 // every waypoint
   *   ctx.datapad.findByTemplate(/swoop/)     // text-match by template
   */
  readonly datapad: DatapadView;

  /**
   * Always-accessible, auto-synced view of the player's inventory.
   * Updated live from baselines/deltas/scene-destroy.
   *
   *   ctx.inventory.items                          // every item now
   *   ctx.inventory.findByTemplate(/survey_tool/i) // pattern-match
   *   ctx.inventory.findById(0xabcdn)              // by NetworkId
   *   ctx.inventory.ready                          // true once populated
   */
  readonly inventory: InventoryView;
  /**
   * Find the nearest `WorldObject` matching `typeId` (one of `ObjectTypeTags`),
   * sorted by 2D distance from the player. Excludes the player itself by
   * default. `maxRadiusM` caps the search; omit to consider the whole world.
   *
   * Sugar over `world.byType(typeId)` + distance sort. Returns `undefined`
   * if nothing matches in range.
   */
  findNearest(
    typeId: number,
    opts?: { maxRadiusM?: number; excludeSelf?: boolean },
  ): WorldObject | undefined;
  /**
   * Find the nearest CREO with `inCombat === true` (from its SHARED_NP
   * baseline) that isn't us. Use this for auto-targeting in combat scripts
   * instead of asking the user to paste a hardcoded `--targetId`.
   *
   * Returns `undefined` if no hostile is in range (or no SHARED_NP baselines
   * have arrived yet, which can happen very early in zone-in).
   */
  nearestHostile(opts?: { maxRadiusM?: number }): WorldObject | undefined;
  /**
   * Every `WorldObject` whose `containerId === containerId`. Mid-script
   * accuracy — reflects the current containment graph (as last reported by
   * `UpdateContainmentMessage`), not a stale transcript scan.
   *
   * Combine with `extractInventoryContainerId(transcript, playerId)` from
   * `baseline-helpers.js` to enumerate inventory contents:
   *   `const items = ctx.findInContainer(inventoryId);`
   */
  findInContainer(containerId: NetworkId): WorldObject[];
  /**
   * Every `PLAY`-type object within `radiusM` of the player, sorted by
   * ascending distance. Convenience over `world.byType(ObjectTypeTags.PLAY)
   * + distance filter`. Excludes us.
   */
  playersInRange(radiusM: number): WorldObject[];
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

  // --- Vehicle / Mount / Pet primitives ---

  /**
   * Current mounted-creature speed cap (m/s), or `null` when the actor is
   * on foot. Set by `mount()` to a sensible per-class default (12 m/s for
   * speeder-bike-class vehicles); cleared by `dismount()`. Read by the
   * movement primitives (`walkTo` / `walkCircle` / `walkToCell`) to clamp
   * the requested `speed` so the server's anti-cheat doesn't reject the
   * transform for moving faster than the mount's `MovementSpeed::getRunSpeed()`.
   */
  mountedSpeedCap(): number | null;

  /**
   * Manually override the mounted speed cap. Pass `null` to clear (treat as
   * on foot). Useful when calling `useAbility('mount', ...)` directly
   * outside of `mount()` and you want movement primitives to honor a cap.
   */
  setMountedSpeedCap(cap: number | null): void;

  /**
   * "Call vehicle" — radial select on the datapad PCD (the persistent
   * control device representing the vehicle inside the player's datapad).
   * Sends `ObjectMenuSelectMessage(datapadItemId, RadialMenuTypes.PET_CALL)`
   * which fires `pet_control_device.OnObjectMenuSelect(PET_CALL=45)` on the
   * server — the standard "spawn the vehicle next to me" trigger used by
   * the real Windows client.
   *
   * Returns the command-queue sequenceId reserved for this call (consumes
   * one slot from the chat/command counter for consistency with other
   * fire-and-forget primitives).
   */
  callVehicle(datapadItemId: NetworkId): number;

  /**
   * "Store vehicle" — radial select on the live vehicle creature (or its
   * PCD). Sends `ObjectMenuSelectMessage(vehicleId, RadialMenuTypes.PET_STORE)`.
   * Server-side `pet_control_device.OnObjectMenuSelect` calls
   * `callable.storeCallable(player, vehicle)`. The reverse of `callVehicle`.
   *
   * Returns the command-queue sequenceId reserved for this call.
   */
  storeVehicle(vehicleId: NetworkId): number;

  /**
   * Mount a vehicle / mountable creature. Wraps `useAbility('mount', mountId)`
   * — server fires the `mount` script-hook in
   * `script.player.skill.taming.mount`, validates the actor isn't already
   * mounted / in shapechange / in a restricted scene, and calls
   * `mountCreature(player, mount)`. On success the player's
   * `States::RidingMount` bit is set and `setMountedMovementRate` switches
   * the anti-cheat speed window to the mount's run-speed.
   *
   * Side-effect: sets `mountedSpeedCap()` to 12 m/s (a sensible speeder-bike
   * default — adjust later if the mount class differs). Movement primitives
   * automatically clamp requested speed to this cap.
   *
   * Returns the command-queue sequenceId.
   */
  mount(vehicleId: NetworkId, options?: { speedCap?: number }): number;

  /**
   * Dismount whatever the player is currently riding. Wraps
   * `useAbility('dismount')` — server fires the `dismount` script-hook in
   * `script.player.skill.taming.dismount` which calls `dismountCreature(player)`.
   *
   * Side-effect: clears `mountedSpeedCap()` back to `null`.
   *
   * Returns the command-queue sequenceId.
   */
  dismount(): number;

  /**
   * "Call pet" — radial select on the pet's datapad PCD. Same wire path
   * as `callVehicle()` (a PCD doesn't differentiate pet vs. vehicle at the
   * radial-menu layer; the distinction is in `ai.pet.type` server-side).
   * Sends `ObjectMenuSelectMessage(controlDeviceId, RadialMenuTypes.PET_CALL=45)`.
   *
   * Returns the command-queue sequenceId.
   */
  callPet(controlDeviceId: NetworkId): number;

  /**
   * "Store pet" — radial select on the live pet creature (or its PCD).
   * Sends `ObjectMenuSelectMessage(petId, RadialMenuTypes.PET_STORE=60)`.
   *
   * Returns the command-queue sequenceId.
   */
  storePet(petId: NetworkId): number;

  /**
   * Issue a structured pet command (follow / stay / attack / guard / patrol).
   * Maps the command string to its `RadialMenuTypes.PET_*` int and sends
   * `ObjectMenuSelectMessage(petId, PET_FOLLOW=225 | PET_STAY=226 | ...)` —
   * the same wire path the real client's radial sub-menu uses.
   *
   * If `targetId` is supplied AND `command` is `'attack'` or `'guard'`,
   * `useAbility('setCombatTarget', targetId)` is sent first so the pet
   * inherits the master's combat target (see `pet.java` — the pet pulls
   * `master.getCombatTarget()` on attack).
   *
   * Returns the command-queue sequenceId reserved for this call.
   */
  petCommand(
    petId: NetworkId,
    command: 'follow' | 'stay' | 'attack' | 'guard' | 'patrol',
    targetId?: NetworkId,
  ): number;

  // --- SUI primitives ---

  /**
   * Wait for the next `SuiCreatePageMessage` from the server. SUI pages are
   * dialogs the server opens on the client (banker / vendor / quest /
   * list-picker). The page's widget tree is decoded into a typed
   * `SuiPageData` struct (`pageData.pageId`, `pageData.pageName`,
   * `pageData.commands`, etc.) which the client echoes back via the
   * `pageId` field in `respondToSui`.
   *
   * Default timeout 8_000ms.
   */
  waitForSui(opts?: {
    timeoutMs?: number;
    predicate?: (m: SuiCreatePageMessage) => boolean;
  }): Promise<SuiCreatePageMessage>;

  /**
   * Reply to an open SUI page. `pageId` is the integer carried in the
   * server's `SuiCreatePageMessage.pageId`; `eventType` identifies which
   * subscribed widget event fired (0 = the default OK / confirm); the
   * optional `returnList` carries any widget-property values the server
   * asked us to send back. Sends a `SuiEventNotification`.
   */
  respondToSui(pageId: number, eventType: number, returnList?: readonly string[]): void;

  // --- NPC conversation primitives ---

  /**
   * Open an NPC conversation with `npcId`. Driven through the command queue
   * (`useAbility('npcConversationStart', npcId, '<starter> <name>')`) because
   * the underlying `CM_npcConversationStart` ObjController subtype is
   * `allowFromClient=false` server-side — direct sends are logged as
   * `HackAttempts` and the player is kicked.
   *
   * The server replies with a `CM_npcConversationMessage(223)` prompt + a
   * `CM_npcConversationResponses(224)` option menu addressed to the player.
   */
  talkTo(npcId: NetworkId): void;

  /**
   * Pick option `index` from the current NPC conversation menu. Driven
   * through the command queue (`useAbility('npcConversationSelect', 0n,
   * String(index))`) for the same reason as `talkTo`: the underlying
   * `CM_npcConversationSelect` subtype is gated `allowFromClient=false`.
   */
  selectDialog(index: number): void;

  /**
   * End the current NPC conversation. Driven through the command queue
   * (`useAbility('npcConversationStop', 0n, '')`) for the same reason as
   * `talkTo`. The server will push a `CM_npcConversationStop(222)` back
   * with the NPC's farewell prose.
   */
  endConversation(): void;

  /**
   * Wait for the next NPC dialog prompt — pairs the server's
   * `CM_npcConversationMessage(223)` prompt with its companion
   * `CM_npcConversationResponses(224)` option menu and returns both in one
   * `NpcDialogPrompt`. If the responses message arrives within `pairWindowMs`
   * (default 250ms) it's included; otherwise `options` is `[]` (auto-advance
   * prompt). Default timeout 8_000ms.
   */
  waitForNpcDialog(opts?: {
    timeoutMs?: number;
    pairWindowMs?: number;
  }): Promise<NpcDialogPrompt>;

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
   * If you're the RECIPIENT (the other party called `RequestTrade` on you),
   * use `acceptIncomingTrade()` instead — `tradeWith()` is the initiator path.
   */
  tradeWith(otherId: NetworkId, opts?: TradeWithOptions): Promise<TradeWithResult>;

  /**
   * Respond to an incoming trade request from another player.
   *
   * State machine:
   *   1. Wait for `CM_secureTrade(TMI_TradeRequested)` from the server — the
   *      handshake server-side sends this after a remote `RequestTrade`.
   *   2. Send `CM_secureTrade(TMI_AcceptTrade)` back (or set `decline: true`
   *      to skip this and end the flow with `abortReason: 'declined'`).
   *   3. Wait for `BeginTradeMessage` from server (both parties now in the
   *      trade window).
   *   4. Send any `items` + `credits` from this side via AddItem / GiveMoney.
   *   5. Send `AcceptTransactionMessage`.
   *   6. Wait for `VerifyTradeMessage`, echo it back.
   *   7. Wait for `TradeCompleteMessage` → `{ completed: true }`.
   *
   * Failure paths return `{ completed: false, abortReason: ... }`.
   */
  acceptIncomingTrade(opts?: TradeAcceptOptions): Promise<TradeWithResult>;

  // --- Commodities / bazaar / auction-house primitives ---

  /**
   * Browse the bazaar from `terminalId`. Sends
   * `AuctionQueryHeadersMessage` and resolves with the depalettized listings
   * from the next `AuctionQueryHeadersResponseMessage` matching the request
   * id. Defaults to a galaxy-wide ByAll search (no filters).
   *
   * The terminal id is the `container` arg the server uses to scope the
   * search — pass the NetworkId of a bazaar terminal (or a player vendor's
   * container id for vendor browses).
   */
  browseBazaar(terminalId: NetworkId, opts?: BrowseBazaarOptions): Promise<AuctionListing[]>;

  /**
   * Request full description / attributes / template name for a single
   * auction. Sends `GetAuctionDetails` and resolves with the depalettized
   * `AuctionDetails` from the next matching `GetAuctionDetailsResponse`.
   * Default timeout 8_000ms.
   */
  getAuctionDetails(auctionId: NetworkId, opts?: { timeoutMs?: number }): Promise<AuctionDetails>;

  /**
   * Place a bid on a live auction. Fire-and-forget — sends
   * `BidAuctionMessage(itemId=auctionId, bid=credits, maxProxyBid=maxProxy)`.
   * The server replies asynchronously with `BidAuctionResponseMessage`;
   * `ctx.waitForMessage(BidAuctionResponseMessage, ...)` if you want to
   * confirm. `maxProxy` defaults to `credits` (no auto-rebid).
   */
  bidOn(auctionId: NetworkId, credits: number, maxProxy?: number): void;

  /**
   * List an item for sale at `terminalId` (bazaar / vendor container).
   * Sends either `CreateImmediateAuctionMessage` (when
   * `opts.instantSale` is true) or `CreateAuctionMessage` (default,
   * bidding-style auction). Awaits the next matching
   * `CreateAuctionResponseMessage` and returns its parsed shape.
   *
   * `opts.durationHours` is converted to seconds for the wire. Default 24h.
   */
  listForSale(
    terminalId: NetworkId,
    itemId: NetworkId,
    opts: ListForSaleOptions,
  ): Promise<ListForSaleResult>;

  /**
   * Retrieve a won / expired / cancelled auction item back into your
   * inventory. Fire-and-forget — sends `RetrieveAuctionItemMessage`. The
   * server replies asynchronously with `RetrieveAuctionItemResponseMessage`.
   */
  retrieveBazaarItem(terminalId: NetworkId, itemId: NetworkId): void;

  /**
   * Cancel one of your own live listings. Fire-and-forget — sends
   * `CancelLiveAuctionMessage`. The server replies asynchronously with
   * `CancelLiveAuctionResponseMessage`.
   */
  cancelMyListing(auctionId: NetworkId): void;
}

interface InternalContext extends ScriptContext {
  /** Detach handle for the character sheet's dispatcher subscriptions. */
  readonly _characterSheetDetach: () => void;
  /** Detach handle for the cooldown tracker's dispatcher subscriptions. */
  readonly _cooldownTrackerDetach: () => void;
  /** Detach handle for the server-time tracker's clock-reflect subscription. */
  readonly _serverTimeTrackerDetach: () => void;
  /** Detach handle for the combat timer's dispatcher subscriptions. */
  readonly _combatTimerDetach: () => void;
  /** Internal handle for cooldown tracker — allows useAbility to register names. */
  readonly _cooldownTrackerHandle: CooldownTrackerHandle;
  /** Internal handle for the server-time tracker — exposed for the orchestrator's seed call. */
  readonly _serverTimeTrackerHandle: ServerTimeTrackerHandle;
  /** Internal handle for the combat timer — exposed mainly for tests. */
  readonly _combatTimerHandle: CombatTimerHandle;
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
    /** Currently-mounted creature speed cap (m/s). `null` ⇒ on foot. */
    mountedSpeedCap: number | null;
    /** Per-player bazaar-browse request id. */
    bazaarRequestId: number;
    assertionFailures: string[];
    /** Unsubscribe handle for the live datapad SceneCreateObjectByName listener. */
    datapadCreateUnsubscribe: (() => void) | null;
    /**
     * `InventoryViewImpl` constructed by `createScriptContext` (vs. passed
     * in via opts). Detached during `runScript` teardown. Null when the
     * caller supplied their own InventoryView (assumed to be managed
     * externally).
     */
    ownedInventoryView: InventoryViewImpl | null;
  };
}

export interface CreateScriptContextOptions {
  dispatcher: MessageDispatcher;
  sceneStart: SceneStart;
  signal: AbortSignal;
  /**
   * Live world view (objects + baselines + deltas + transforms). The
   * orchestrator constructs one in `runGameStage` and passes it in so
   * scripts can query `ctx.world.nearby(20)` etc.
   */
  world: WorldModel;
  /**
   * Optional pre-built {@link InventoryView}. If omitted, a fresh one is
   * constructed over `world` here and attached for the lifetime of the
   * context. Pass an externally-managed instance (e.g. one that was
   * primed before the script started) if you need precise control.
   */
  inventory?: InventoryView;
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
  /** Initial bazaar browse request id. Default 1. */
  initialBazaarRequestId?: number;
}

export function createScriptContext(opts: CreateScriptContextOptions): ScriptContext {
  // Construct (and attach) an InventoryView if the caller didn't provide
  // one. Either way, the script context just exposes it via `ctx.inventory`.
  let ownedInventoryView: InventoryViewImpl | null = null;
  let inventoryView: InventoryView;
  if (opts.inventory !== undefined) {
    inventoryView = opts.inventory;
  } else {
    const impl = new InventoryViewImpl(opts.world, opts.sceneStart.playerNetworkId);
    impl.attach();
    ownedInventoryView = impl;
    inventoryView = impl;
  }

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
    mountedSpeedCap: null as number | null,
    bazaarRequestId: opts.initialBazaarRequestId ?? 1,
    assertionFailures: [] as string[],
    datapadCreateUnsubscribe: null as (() => void) | null,
    ownedInventoryView,
  };

  // DatapadView — seeded from any datapad create event already in the
  // transcript (typical case after zone-in), and kept fresh by live
  // listeners for the case where the datapad's create event arrives after
  // the script context is constructed (e.g. respawn / mid-script re-create).
  // The live server sends the datapad via ByCrc (compact form); we
  // subscribe to both ByName and ByCrc to cover any wire shape.
  const datapadView = new DatapadViewImpl(opts.world);
  const seedDatapadId = extractDatapadContainerId(opts.dispatcher.transcript);
  if (seedDatapadId !== null) datapadView.setContainerId(seedDatapadId);
  const datapadByNameUnsubscribe = opts.dispatcher.onMessage(SceneCreateObjectByName, (m) => {
    if (datapadView.containerId !== null) return;
    if (/(^|\/)(shared_)?character_datapad\.iff$/.test(m.templateName)) {
      datapadView.setContainerId(m.networkId);
    }
  });
  const datapadByCrcUnsubscribe = opts.dispatcher.onMessage(SceneCreateObjectByCrc, (m) => {
    if (datapadView.containerId !== null) return;
    if (m.templateCrc === PLAYER_DATAPAD_TEMPLATE_CRC) {
      datapadView.setContainerId(m.networkId);
    }
  });
  state.datapadCreateUnsubscribe = (): void => {
    datapadByNameUnsubscribe();
    datapadByCrcUnsubscribe();
  };

  const characterSheetHandle = createCharacterSheet({
    dispatcher: opts.dispatcher,
    playerNetworkId: opts.sceneStart.playerNetworkId,
    world: opts.world,
    templateName: opts.sceneStart.templateName,
  });

  // Timing trackers — cooldowns, server-time, combat. All three are wire-
  // driven; the orchestrator's only obligation is to seed serverTime with
  // the absolute server wall-clock from CmdStartScene (which the dispatcher
  // never sees again, so we can't subscribe to it after the fact).
  const cooldownTrackerHandle = createCooldownTracker({ dispatcher: opts.dispatcher });
  const serverTimeTrackerHandle = createServerTimeTracker({ dispatcher: opts.dispatcher });
  // CmdStartScene carries two time fields: `serverTimeSeconds` (the
  // server's GameTime — seconds-since-server-process-start — NOT a Unix
  // epoch) and `serverEpoch` (i32 = `time(0)` server wall-clock as Unix
  // seconds). Seed the server-time tracker from `serverEpoch` so `ms()`
  // returns a real Unix-epoch ms reading.
  if (opts.sceneStart.serverEpoch > 0) {
    serverTimeTrackerHandle.setSeed(BigInt(opts.sceneStart.serverEpoch));
  }
  const combatTimerHandle = createCombatTimer({
    dispatcher: opts.dispatcher,
    playerNetworkId: opts.sceneStart.playerNetworkId,
  });

  const ctx: InternalContext = {
    dispatcher: opts.dispatcher,
    sceneStart: opts.sceneStart,
    signal: opts.signal,
    world: opts.world,
    character: characterSheetHandle.view,
    cooldowns: cooldownTrackerHandle.view,
    serverTime: serverTimeTrackerHandle.view,
    combat: combatTimerHandle.view,
    datapad: datapadView,
    inventory: inventoryView,
    _state: state,
    _characterSheetDetach: characterSheetHandle.detach,
    _cooldownTrackerDetach: cooldownTrackerHandle.detach,
    _serverTimeTrackerDetach: serverTimeTrackerHandle.detach,
    _combatTimerDetach: combatTimerHandle.detach,
    _cooldownTrackerHandle: cooldownTrackerHandle,
    _serverTimeTrackerHandle: serverTimeTrackerHandle,
    _combatTimerHandle: combatTimerHandle,

    findNearest(
      typeId: number,
      findOpts?: { maxRadiusM?: number; excludeSelf?: boolean },
    ): WorldObject | undefined {
      const selfId = opts.sceneStart.playerNetworkId;
      const excludeSelf = findOpts?.excludeSelf ?? true;
      const maxR = findOpts?.maxRadiusM;
      const here = { x: state.pose.x, y: state.pose.y, z: state.pose.z };
      let best: WorldObject | undefined;
      let bestD2 = Number.POSITIVE_INFINITY;
      const maxR2 = maxR !== undefined ? maxR * maxR : Number.POSITIVE_INFINITY;
      for (const o of opts.world.byType(typeId)) {
        if (excludeSelf && o.id === selfId) continue;
        const dx = o.position.x - here.x;
        const dz = o.position.z - here.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > maxR2) continue;
        if (d2 < bestD2) {
          best = o;
          bestD2 = d2;
        }
      }
      return best;
    },

    nearestHostile(findOpts?: { maxRadiusM?: number }): WorldObject | undefined {
      const selfId = opts.sceneStart.playerNetworkId;
      const maxR = findOpts?.maxRadiusM;
      const here = { x: state.pose.x, y: state.pose.y, z: state.pose.z };
      let best: WorldObject | undefined;
      let bestD2 = Number.POSITIVE_INFINITY;
      const maxR2 = maxR !== undefined ? maxR * maxR : Number.POSITIVE_INFINITY;
      for (const o of opts.world.byType(ObjectTypeTags.CREO)) {
        if (o.id === selfId) continue;
        const tanoNp = o.baselines.get(BaselinePackageIds.SHARED_NP) as
          | TangibleObjectSharedNpBaseline
          | undefined;
        if (tanoNp?.inCombat !== true) continue;
        const dx = o.position.x - here.x;
        const dz = o.position.z - here.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > maxR2) continue;
        if (d2 < bestD2) {
          best = o;
          bestD2 = d2;
        }
      }
      return best;
    },

    findInContainer(containerId: NetworkId): WorldObject[] {
      return opts.world.filter((o) => o.containerId === containerId);
    },

    playersInRange(radiusM: number): WorldObject[] {
      const selfId = opts.sceneStart.playerNetworkId;
      const here = { x: state.pose.x, y: state.pose.y, z: state.pose.z };
      const r2 = radiusM * radiusM;
      const out: Array<[WorldObject, number]> = [];
      for (const o of opts.world.byType(ObjectTypeTags.PLAY)) {
        if (o.id === selfId) continue;
        const dx = o.position.x - here.x;
        const dz = o.position.z - here.z;
        const d2 = dx * dx + dz * dz;
        if (d2 <= r2) out.push([o, d2]);
      }
      out.sort((a, b) => a[1] - b[1]);
      return out.map(([o]) => o);
    },

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
        state.teleportListenerUnsubscribe = opts.dispatcher.onMessage(ObjControllerMessage, (m) => {
          if (m.message !== ObjControllerSubtypeIds.CM_netUpdateTransform) return;
          if (m.networkId !== playerId) return;
          if (m.decodedSubtype?.kind !== NetUpdateTransformKind) return;
          const td = m.decodedSubtype.data as NetUpdateTransformData;
          if (td.sequenceNumber < 0) ackSeq(td.sequenceNumber);
        });
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
      // Tell the cooldown tracker the human-readable name BEFORE we send so
      // any CM_commandTimer that arrives can be looked up by-name via
      // ctx.cooldowns.msUntil(commandName).
      cooldownTrackerHandle.registerCommandName(commandName);
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

    async waitForDraftSchematics(waitOpts?: { timeoutMs?: number }): Promise<DraftSchematicsData> {
      const timeoutMs = waitOpts?.timeoutMs ?? 8_000;
      const msg = await opts.dispatcher.waitFor(ObjControllerMessage, {
        timeoutMs,
        predicate: (m) =>
          m.message === ObjControllerSubtypeIds.CM_draftSchematicsMessage &&
          m.decodedSubtype?.kind === DraftSchematicsKind,
      });
      return msg.decodedSubtype!.data as DraftSchematicsData;
    },

    async waitForDraftSlots(waitOpts?: { timeoutMs?: number }): Promise<ManufactureSchematicData> {
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
      await walkToImplLocal(ctx, { x: cur.x + 2.5, z: cur.z + 2.5 }, { speed: 4, tickMs: 500 });
    },

    async waitForSampleEvent(sampleOpts?: {
      timeoutMs?: number;
      predicate?: (kind: SampleEventKind, raw: string) => boolean;
    }): Promise<{ kind: SampleEventKind; raw: string }> {
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

    // --- Vehicle / Mount / Pet primitives ---

    mountedSpeedCap(): number | null {
      return state.mountedSpeedCap;
    },

    setMountedSpeedCap(cap: number | null): void {
      state.mountedSpeedCap = cap;
    },

    callVehicle(datapadItemId: NetworkId): number {
      const seq = ctx.nextCommandSequence();
      ctx.send(new ObjectMenuSelectMessage(datapadItemId, RadialMenuTypes.PET_CALL));
      return seq;
    },

    storeVehicle(vehicleId: NetworkId): number {
      const seq = ctx.nextCommandSequence();
      ctx.send(new ObjectMenuSelectMessage(vehicleId, RadialMenuTypes.PET_STORE));
      return seq;
    },

    mount(vehicleId: NetworkId, mountOpts?: { speedCap?: number }): number {
      // SPEEDER_DEFAULT_CAP — chosen as a permissive baseline for the
      // generic speeder-bike class; callers with a faster mount should
      // pass an explicit `speedCap` (e.g. swoop bike: 17.5 m/s).
      const SPEEDER_DEFAULT_CAP = 12;
      state.mountedSpeedCap = mountOpts?.speedCap ?? SPEEDER_DEFAULT_CAP;
      return ctx.useAbility('mount', vehicleId);
    },

    dismount(): number {
      state.mountedSpeedCap = null;
      return ctx.useAbility('dismount');
    },

    callPet(controlDeviceId: NetworkId): number {
      const seq = ctx.nextCommandSequence();
      ctx.send(new ObjectMenuSelectMessage(controlDeviceId, RadialMenuTypes.PET_CALL));
      return seq;
    },

    storePet(petId: NetworkId): number {
      const seq = ctx.nextCommandSequence();
      ctx.send(new ObjectMenuSelectMessage(petId, RadialMenuTypes.PET_STORE));
      return seq;
    },

    petCommand(
      petId: NetworkId,
      command: 'follow' | 'stay' | 'attack' | 'guard' | 'patrol',
      targetId?: NetworkId,
    ): number {
      const itemId = PET_COMMAND_RADIAL[command];
      // For target-bearing commands, pre-set the master's combat target so
      // the pet's `getCurrentAttackTarget(master)` resolves to it on the
      // first AI tick. See ai/pet.java `tellPetAttack` flow.
      if (targetId !== undefined && (command === 'attack' || command === 'guard')) {
        ctx.useAbility('setCombatTarget', targetId);
      }
      const seq = ctx.nextCommandSequence();
      ctx.send(new ObjectMenuSelectMessage(petId, itemId));
      return seq;
    },

    // --- SUI primitives ---

    waitForSui(suiOpts?: {
      timeoutMs?: number;
      predicate?: (m: SuiCreatePageMessage) => boolean;
    }): Promise<SuiCreatePageMessage> {
      const timeoutMs = suiOpts?.timeoutMs ?? 8_000;
      return opts.dispatcher.waitFor(SuiCreatePageMessage, {
        timeoutMs,
        ...(suiOpts?.predicate !== undefined ? { predicate: suiOpts.predicate } : {}),
      });
    },

    respondToSui(pageId: number, eventType: number, returnList?: readonly string[]): void {
      ctx.send(new SuiEventNotification(pageId, eventType, returnList ?? []));
    },

    // --- NPC conversation primitives ---

    talkTo(npcId: NetworkId): void {
      // Command-queue path — direct CM_npcConversationStart is allowFromClient=false
      // server-side (would log a HackAttempts entry and kick the player).
      // params format from CommandCppFuncs.cpp:6689-6697 is "<starter> <conversationName>".
      ctx.useAbility('npcConversationStart', npcId, '0 ');
    },

    selectDialog(index: number): void {
      ctx.useAbility('npcConversationSelect', 0n, String(index));
    },

    endConversation(): void {
      ctx.useAbility('npcConversationStop', 0n, '');
    },

    async waitForNpcDialog(npcOpts?: {
      timeoutMs?: number;
      pairWindowMs?: number;
    }): Promise<NpcDialogPrompt> {
      const timeoutMs = npcOpts?.timeoutMs ?? 8_000;
      const pairWindowMs = npcOpts?.pairWindowMs ?? 250;
      const playerId = opts.sceneStart.playerNetworkId;

      const promptMsg = await opts.dispatcher.waitFor(ObjControllerMessage, {
        timeoutMs,
        predicate: (m) =>
          m.message === ObjControllerSubtypeIds.CM_npcConversationMessage &&
          m.networkId === playerId &&
          m.decodedSubtype?.kind === NpcConversationMessageKind,
      });
      // The predicate above guarantees decodedSubtype is set with the right kind.
      const promptSubtype = promptMsg.decodedSubtype;
      if (promptSubtype === null) {
        throw new Error('waitForNpcDialog: prompt has no decodedSubtype');
      }
      const promptData = promptSubtype.data as NpcConversationMessageData;

      let options: readonly string[] = [];
      try {
        const responsesMsg = await opts.dispatcher.waitFor(ObjControllerMessage, {
          timeoutMs: pairWindowMs,
          predicate: (m) =>
            m.message === ObjControllerSubtypeIds.CM_npcConversationResponses &&
            m.networkId === playerId &&
            m.decodedSubtype?.kind === NpcConversationResponsesKind,
        });
        const responsesSubtype = responsesMsg.decodedSubtype;
        if (responsesSubtype !== null) {
          const respData = responsesSubtype.data as NpcConversationResponsesData;
          options = respData.responses;
        }
      } catch {
        // No companion responses arrived in the pair window — leave options empty.
      }

      return { playerId, prompt: promptData.npcMessage, options };
    },

    // --- SecureTrade handshake ---

    async tradeWith(otherId: NetworkId, tradeOpts?: TradeWithOptions): Promise<TradeWithResult> {
      const playerId = opts.sceneStart.playerNetworkId;
      const beginTimeoutMs = tradeOpts?.beginTimeoutMs ?? 15_000;
      const acceptTimeoutMs = tradeOpts?.acceptTimeoutMs ?? 15_000;
      const verifyTimeoutMs = tradeOpts?.verifyTimeoutMs ?? 15_000;
      const totalBudget = beginTimeoutMs + acceptTimeoutMs + verifyTimeoutMs + 5_000;

      const abortPromise = opts.dispatcher.waitFor(AbortTradeMessage, { timeoutMs: totalBudget });
      abortPromise.catch(() => {});

      sendTradeSubtype(ctx, playerId, {
        tradeMessageId: TradeMessageId.RequestTrade,
        initiatorId: playerId,
        recipientId: otherId,
      });

      const beginOutcome = await raceWithAbort(
        opts.dispatcher.waitFor(BeginTradeMessage, { timeoutMs: beginTimeoutMs }),
        abortPromise,
        'no-begin',
      );
      if (beginOutcome.failed) return beginOutcome.result;

      return completeTradeAfterBegin(
        ctx,
        opts.dispatcher,
        abortPromise,
        tradeOpts?.items ?? [],
        tradeOpts?.credits ?? 0,
        acceptTimeoutMs,
        verifyTimeoutMs,
      );
    },

    async acceptIncomingTrade(acceptOpts?: TradeAcceptOptions): Promise<TradeWithResult> {
      const playerId = opts.sceneStart.playerNetworkId;
      const requestTimeoutMs = acceptOpts?.requestTimeoutMs ?? 15_000;
      const beginTimeoutMs = acceptOpts?.beginTimeoutMs ?? 15_000;
      const acceptTimeoutMs = acceptOpts?.acceptTimeoutMs ?? 15_000;
      const verifyTimeoutMs = acceptOpts?.verifyTimeoutMs ?? 15_000;
      const totalBudget =
        requestTimeoutMs + beginTimeoutMs + acceptTimeoutMs + verifyTimeoutMs + 5_000;

      const abortPromise = opts.dispatcher.waitFor(AbortTradeMessage, { timeoutMs: totalBudget });
      abortPromise.catch(() => {});

      let requested: ObjControllerMessage;
      try {
        requested = await opts.dispatcher.waitFor(ObjControllerMessage, {
          timeoutMs: requestTimeoutMs,
          predicate: (m) =>
            m.message === ObjControllerSubtypeIds.CM_secureTrade &&
            m.decodedSubtype?.kind === TradeStartKind &&
            (m.decodedSubtype.data as TradeStartData).tradeMessageId ===
              TradeMessageId.TradeRequested,
        });
      } catch (err) {
        if (/Timed out/.test(err instanceof Error ? err.message : String(err))) {
          return { completed: false, abortReason: 'no-request' };
        }
        throw err;
      }
      const initiatorId = (requested.decodedSubtype!.data as TradeStartData).initiatorId;

      if (acceptOpts?.decline === true) {
        sendTradeSubtype(ctx, playerId, {
          tradeMessageId: TradeMessageId.DeniedTrade,
          initiatorId,
          recipientId: playerId,
        });
        return { completed: false, abortReason: 'declined' };
      }

      sendTradeSubtype(ctx, playerId, {
        tradeMessageId: TradeMessageId.AcceptTrade,
        initiatorId,
        recipientId: playerId,
      });

      const beginOutcome = await raceWithAbort(
        opts.dispatcher.waitFor(BeginTradeMessage, { timeoutMs: beginTimeoutMs }),
        abortPromise,
        'no-begin',
      );
      if (beginOutcome.failed) return beginOutcome.result;

      return completeTradeAfterBegin(
        ctx,
        opts.dispatcher,
        abortPromise,
        acceptOpts?.items ?? [],
        acceptOpts?.credits ?? 0,
        acceptTimeoutMs,
        verifyTimeoutMs,
      );
    },

    // --- Commodities / bazaar / auction-house primitives ---

    async browseBazaar(
      terminalId: NetworkId,
      browseOpts?: BrowseBazaarOptions,
    ): Promise<AuctionListing[]> {
      const requestId = browseOpts?.requestId ?? state.bazaarRequestId++;
      const timeoutMs = browseOpts?.timeoutMs ?? 8_000;

      const responsePromise = opts.dispatcher.waitFor(AuctionQueryHeadersResponseMessage, {
        timeoutMs,
        predicate: (m) => m.requestId === requestId,
      });

      const msg = new AuctionQueryHeadersMessage({
        locationSearchType: browseOpts?.locationSearchType ?? AuctionLocationSearch.Galaxy,
        requestId,
        searchType: browseOpts?.searchType ?? AuctionSearchType.ByAll,
        itemType: browseOpts?.category ?? 0,
        itemTypeExactMatch: browseOpts?.itemTypeExactMatch ?? false,
        itemTemplateId: browseOpts?.itemTemplateId ?? 0,
        textFilterAll: browseOpts?.textFilterAll ?? '',
        textFilterAny: browseOpts?.textFilterAny ?? '',
        priceFilterMin: browseOpts?.minPrice ?? 0,
        priceFilterMax: browseOpts?.maxPrice ?? 0,
        priceFilterIncludesFee: browseOpts?.priceFilterIncludesFee ?? false,
        advancedSearch: browseOpts?.advancedSearch ?? [],
        advancedSearchMatchAllAny:
          browseOpts?.advancedSearchMatchAllAny ?? AdvancedSearchMatchAllAny.match_all,
        container: terminalId,
        myVendorsOnly: browseOpts?.myVendorsOnly ?? false,
        queryOffset: browseOpts?.queryOffset ?? 0,
      });
      ctx.send(msg);

      const response = await responsePromise;
      return [...response.listings];
    },

    async getAuctionDetails(
      auctionId: NetworkId,
      detailsOpts?: { timeoutMs?: number },
    ): Promise<AuctionDetails> {
      const timeoutMs = detailsOpts?.timeoutMs ?? 8_000;
      const responsePromise = opts.dispatcher.waitFor(GetAuctionDetailsResponse, {
        timeoutMs,
        predicate: (m) => m.details.itemId === auctionId,
      });
      ctx.send(new GetAuctionDetails(auctionId));
      const response = await responsePromise;
      return {
        itemId: response.details.itemId,
        userDescription: response.details.userDescription,
        propertyList: response.details.propertyList,
        templateName: response.details.templateName,
        appearanceString: response.details.appearanceString,
      };
    },

    bidOn(auctionId: NetworkId, credits: number, maxProxy?: number): void {
      ctx.send(new BidAuctionMessage(auctionId, credits, maxProxy ?? credits));
    },

    async listForSale(
      terminalId: NetworkId,
      itemId: NetworkId,
      listOpts: ListForSaleOptions,
    ): Promise<ListForSaleResult> {
      const timeoutMs = listOpts.timeoutMs ?? 8_000;
      const durationSeconds = (listOpts.durationHours ?? 24) * 3600;
      const description = listOpts.description ?? '';
      const localizedName = listOpts.localizedName ?? '';
      const premium = listOpts.premium ?? false;

      const responsePromise = opts.dispatcher.waitFor(CreateAuctionResponseMessage, {
        timeoutMs,
        predicate: (m) => m.itemId === itemId,
      });

      if (listOpts.instantSale === true) {
        ctx.send(
          new CreateImmediateAuctionMessage(
            itemId,
            localizedName,
            terminalId,
            listOpts.price,
            durationSeconds,
            description,
            premium,
            listOpts.vendorTransfer ?? false,
          ),
        );
      } else {
        ctx.send(
          new CreateAuctionMessage(
            itemId,
            localizedName,
            terminalId,
            listOpts.price,
            durationSeconds,
            description,
            premium,
          ),
        );
      }

      const response = await responsePromise;
      const success = response.result === AuctionResult.OK;
      const result: ListForSaleResult = {
        success,
        resultCode: response.result,
      };
      if (success) result.auctionId = response.itemId;
      if (response.itemRestrictedRejectionMessage !== '') {
        result.errorReason = response.itemRestrictedRejectionMessage;
      }
      return result;
    },

    retrieveBazaarItem(terminalId: NetworkId, itemId: NetworkId): void {
      ctx.send(new RetrieveAuctionItemMessage(itemId, terminalId));
    },

    cancelMyListing(auctionId: NetworkId): void {
      ctx.send(new CancelLiveAuctionMessage(auctionId));
    },
  };

  return ctx;
}

const PET_COMMAND_RADIAL: Record<'follow' | 'stay' | 'attack' | 'guard' | 'patrol', number> = {
  follow: RadialMenuTypes.PET_FOLLOW,
  stay: RadialMenuTypes.PET_STAY,
  attack: RadialMenuTypes.PET_ATTACK,
  guard: RadialMenuTypes.PET_GUARD,
  patrol: RadialMenuTypes.PET_PATROL,
};

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
    // Detach the character sheet's dispatcher subscriptions. Safe to call
    // multiple times — `detach()` empties the unsubscriber list on the
    // first call.
    internal._characterSheetDetach();
    // Detach the timing trackers (cooldowns / serverTime / combat). All
    // three are idempotent.
    internal._cooldownTrackerDetach();
    internal._serverTimeTrackerDetach();
    internal._combatTimerDetach();
    if (internal._state.datapadCreateUnsubscribe !== null) {
      internal._state.datapadCreateUnsubscribe();
      internal._state.datapadCreateUnsubscribe = null;
    }
    if (internal._state.ownedInventoryView !== null) {
      internal._state.ownedInventoryView.detach();
      internal._state.ownedInventoryView = null;
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

function sendTradeSubtype(ctx: ScriptContext, playerId: NetworkId, data: TradeStartData): void {
  const stream = new ByteStream();
  TradeStartDecoder.encode(stream, data);
  ctx.send(
    new ObjControllerMessage(
      CLIENT_TO_AUTH_SERVER_FLAGS,
      ObjControllerSubtypeIds.CM_secureTrade,
      playerId,
      0,
      stream.toBytes(),
      { kind: TradeStartDecoder.kind, data },
    ),
  );
}

async function raceWithAbort<T>(
  winner: Promise<T>,
  abort: Promise<unknown>,
  timeoutReason: string,
): Promise<{ failed: false } | { failed: true; result: TradeWithResult }> {
  try {
    const outcome = await Promise.race([
      winner.then((m) => ({ kind: 'ok' as const, msg: m })),
      abort.then(() => ({ kind: 'abort' as const })),
    ]);
    if (outcome.kind === 'abort') {
      return { failed: true, result: { completed: false, abortReason: 'aborted' } };
    }
    return { failed: false };
  } catch (err) {
    if (/Timed out/.test(err instanceof Error ? err.message : String(err))) {
      return { failed: true, result: { completed: false, abortReason: timeoutReason } };
    }
    throw err;
  }
}

async function completeTradeAfterBegin(
  ctx: ScriptContext,
  dispatcher: MessageDispatcher,
  abortPromise: Promise<unknown>,
  items: readonly NetworkId[],
  credits: number,
  acceptTimeoutMs: number,
  verifyTimeoutMs: number,
): Promise<TradeWithResult> {
  for (const itemId of items) {
    ctx.send(new AddItemMessage(itemId));
  }
  if (credits > 0) {
    ctx.send(new GiveMoneyMessage(credits));
  }
  ctx.send(new AcceptTransactionMessage());

  // Server sends BeginVerificationMessage to both parties once both have
  // accepted. This is the "ok, send VerifyTradeMessage" trigger — the
  // post-accept VerifyTradeMessage we receive afterwards is the forwarded
  // copy of the OTHER party's verify (informational; not what gates us).
  const beginVerifyOutcome = await raceWithAbort(
    dispatcher.waitFor(BeginVerificationMessage, { timeoutMs: acceptTimeoutMs }),
    abortPromise,
    'no-verify',
  );
  if (beginVerifyOutcome.failed) return beginVerifyOutcome.result;

  const completePromise = dispatcher.waitFor(TradeCompleteMessage, { timeoutMs: verifyTimeoutMs });
  ctx.send(new VerifyTradeMessage());

  const completeOutcome = await raceWithAbort(completePromise, abortPromise, 'no-complete');
  if (completeOutcome.failed) return completeOutcome.result;

  return { completed: true };
}
