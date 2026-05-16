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

import { ClientOpenContainerMessage } from '../../messages/game/client-open-container.js';
import {
  CommandQueueEnqueue,
  hashCommand,
  NO_TARGET,
  wrapAsObjControllerMessage,
} from '../../messages/game/command-queue/index.js';
import { LogoutMessage } from '../../messages/game/logout-message.js';
import type { GameNetworkMessage } from '../../messages/interface.js';
import type { NetworkId, SceneStart, Vector3 } from '../../types.js';
import type { MessageDispatcher } from '../dispatcher.js';
import {
  type CircleOptions,
  type WalkToOptions,
  walkCircle as walkCircleImpl,
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

export interface ScriptResult {
  /** Wall-clock elapsed time the scenario function took, in ms. */
  elapsedMs: number;
  /** Total `dispatcher.send()` calls made via the context (any path). */
  sendsCount: number;
  /** Set if the scenario threw. */
  error?: string;
  /** True if the scenario called `ctx.logout()`. */
  didLogout: boolean;
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
}

interface InternalContext extends ScriptContext {
  /** Tracking for the orchestrator. */
  readonly _state: {
    sendsCount: number;
    didLogout: boolean;
    pose: { x: number; y: number; z: number; yaw: number };
    sequenceNumber: number;
    commandSequence: number;
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
    sequenceNumber: opts.initialSequenceNumber ?? 1,
    commandSequence: opts.initialCommandSequence ?? 1,
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
