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
import { ObjControllerMessage } from '../../messages/game/obj-controller-message.js';
import {
  ObjControllerSubtypeIds,
  SpatialChatSendDecoder,
  SpatialChatType,
  makeSpatialChatData,
} from '../../messages/game/obj-controller/index.js';
import { SurveyMessage, type SurveyPoint } from '../../messages/game/survey/index.js';
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
  /** Next UpdateTransformMessage sequence number (auto-incremented by movement primitives). */
  nextSequenceNumber(): number;
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
   * Speak spatial chat (the wire path behind `/say`). Sends a single
   * `ObjControllerMessage` whose `message = CM_spatialChatSend` and whose
   * trailer is a `MessageQueueSpatialChat` (sourceId = player, targetId = 0,
   * chatType = Say, all other fields default). Returns the chat-sequence id
   * used so callers can correlate with any future sequence-based ack.
   *
   * For directed `/whisper`-style chat pass a non-zero `targetId` via the
   * `opts` argument; for `/shout` set `chatType`. Most callers want the
   * defaults — say(text).
   */
  say(text: string, opts?: SayOptions): number;
  /** Request the server's chat-room list (server responds with ChatRoomList). */
  requestChannelList(): void;

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
   * Trigger a survey for `resourceClass` (e.g. `'mineral'`, `'flora'`,
   * `'inorganic_chemical'`). Wraps the standard command-queue path
   * (`useAbility('requestSurvey', 0n, resourceClass)`) — server-side this
   * runs `commandFuncRequestSurvey` (CommandCppFuncs.cpp:2761) which
   * dispatches to the `TRIG_REQUEST_SURVEY` script trigger on the active
   * survey tool. Requires the player to have a matching survey tool of the
   * correct type in inventory and to have called `radial-menu-activate`
   * on it first — otherwise the server emits a chat-system error.
   *
   * Returns the command-queue sequence id used (same counter as `useAbility`).
   */
  survey(resourceClass: string): number;

  /**
   * Wait for the next `SurveyMessage` radial response within `timeoutMs`.
   * Returns the parsed sample points; `resourceClass` is included for
   * convenience but is only populated if you set it (the wire SurveyMessage
   * itself does not carry the resource class — that round-trips via the
   * `ResourceListForSurveyMessage` issued before the survey window opens).
   * Default timeout is 5_000ms.
   */
  waitForSurvey(opts?: { timeoutMs?: number }): Promise<{
    points: SurveyPoint[];
    resourceClass?: string;
  }>;
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
    commandSequence: number;
    chatSequence: number;
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
    commandSequence: opts.initialCommandSequence ?? 1,
    chatSequence: opts.initialChatSequence ?? 1,
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
      const seq = ctx.nextChatSequence();
      const playerId = opts.sceneStart.playerNetworkId;
      const data = makeSpatialChatData(playerId, text, {
        targetId: sayOpts?.targetId ?? 0n,
        chatType: sayOpts?.chatType ?? SpatialChatType.Say,
        moodType: sayOpts?.moodType ?? 0,
        language: sayOpts?.language ?? 0,
        flags: sayOpts?.flags ?? 0,
        volume: sayOpts?.volume ?? 0,
      });
      // Pack the spatial-chat trailer
      const stream = new ByteStream();
      SpatialChatSendDecoder.encode(stream, data);
      // Wrap in an ObjControllerMessage with message = CM_spatialChatSend.
      // Pre-populate `decodedSubtype` so transcripts & test introspection
      // see the structured data without round-tripping through the wire.
      const wrapped = new ObjControllerMessage(
        CLIENT_TO_AUTH_SERVER_FLAGS,
        ObjControllerSubtypeIds.CM_spatialChatSend,
        playerId,
        0,
        stream.toBytes(),
        { kind: SpatialChatSendDecoder.kind, data },
      );
      ctx.send(wrapped);
      return seq;
    },

    requestChannelList(): void {
      ctx.send(new ChatRequestRoomList());
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

    survey(resourceClass: string): number {
      // The actual server command name is `requestSurvey` (camelCase) —
      // verified in command_table.tab:927 and CommandCppFuncs.cpp:2761.
      // `useAbility` lowercases for the constcrc lookup (CommandTable is
      // case-insensitive), so 'requestsurvey' would also hash identically,
      // but we keep the canonical camelCase here for grep-readability.
      return ctx.useAbility('requestSurvey', 0n, resourceClass);
    },

    async waitForSurvey(surveyOpts): Promise<{
      points: SurveyPoint[];
      resourceClass?: string;
    }> {
      const timeoutMs = surveyOpts?.timeoutMs ?? 5_000;
      const msg = await opts.dispatcher.waitFor(SurveyMessage, { timeoutMs });
      return { points: msg.data };
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
