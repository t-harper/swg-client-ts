/**
 * Test helpers — a minimal fake dispatcher that records sends without
 * touching a real UDP socket, plus a `createFakeContext()` shortcut.
 *
 * The fake dispatcher also supports `simulateRecv(msg)` so tests can
 * inject inbound messages and exercise the assertion helpers
 * (`expectWithin` / `expectAbsent` / `expectAfter`) without a real
 * SOE connection.
 */

import { encodeMessage } from '../../messages/base.js';
import { ObjControllerMessage } from '../../messages/game/obj-controller-message.js';
import {
  type NetUpdateTransformData,
  NetUpdateTransformKind,
  type NetUpdateTransformWithParentData,
  NetUpdateTransformWithParentKind,
  ObjControllerSubtypeIds,
  type TeleportAckData,
  TeleportAckKind,
} from '../../messages/game/obj-controller/index.js';
import type { GameNetworkMessage } from '../../messages/interface.js';
import type { NetworkId, SceneStart, Vector3 } from '../../types.js';
import type { MessageDispatcher, TranscriptEvent } from '../dispatcher.js';
import { WorldModel } from '../world-model.js';
import { type ScriptContext, createScriptContext } from './context.js';

type MessageClassRef<T extends GameNetworkMessage> = {
  readonly messageName: string;
  readonly typeCrc: number;
  readonly prototype: T;
};

export interface FakeContext {
  ctx: ScriptContext;
  /** Every message handed to `dispatcher.send()` (or `ctx.send()`), in order. */
  sent: GameNetworkMessage[];
  /** The raw encoded bytes for each send, parallel to `sent`. */
  sentBytes: Uint8Array[];
  /** Abort the script context's signal (for cancellation tests). */
  abort: () => void;
  /**
   * Inject an inbound message: fulfills any matching `waitFor` waiter and
   * fires any `onMessage` listener. Use this in tests to simulate server
   * responses for assertion helpers.
   */
  simulateRecv: (msg: GameNetworkMessage) => void;
  /**
   * Synthesize a ClockReflect sample being delivered to the SoeConnection.
   * Use this in timing tests to drive `ctx.serverTime` without standing up
   * a real connection — calls every listener registered via
   * `addClockReflectListener`.
   */
  simulateClockReflect: (sample: import('../../soe/clock-sync.js').ClockReflectSample) => void;
}

interface FakeContextOptions {
  startPosition?: Vector3;
  startYaw?: number;
  playerNetworkId?: NetworkId;
  /** Override SceneStart.serverTimeSeconds — server's GameTime, not Unix. Default 0n. */
  serverTimeSeconds?: bigint;
  /** Override SceneStart.serverEpoch — Unix epoch seconds, the seed for ctx.serverTime. Default 0. */
  serverEpoch?: number;
}

type WaiterRecord = {
  typeCrc: number;
  predicate: (msg: GameNetworkMessage) => boolean;
  resolve: (msg: GameNetworkMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ListenerRecord = {
  typeCrc: number;
  handler: (msg: GameNetworkMessage) => void;
};

export function createFakeContext(opts: FakeContextOptions = {}): FakeContext {
  const sent: GameNetworkMessage[] = [];
  const sentBytes: Uint8Array[] = [];
  const waiters: WaiterRecord[] = [];
  const listeners: ListenerRecord[] = [];
  const anyListeners: ((event: TranscriptEvent) => void)[] = [];

  /**
   * Test stub for SoeConnection — only the surface the timing trackers
   * actually exercise (`addClockReflectListener` / `getLatencyStats`). Returns
   * an unsubscribe function that removes the listener from `clockReflectListeners`.
   */
  const clockReflectListeners: Array<
    (s: import('../../soe/clock-sync.js').ClockReflectSample) => void
  > = [];
  const fakeConnection = {
    addClockReflectListener(
      cb: (s: import('../../soe/clock-sync.js').ClockReflectSample) => void,
    ): () => void {
      clockReflectListeners.push(cb);
      return () => {
        const idx = clockReflectListeners.indexOf(cb);
        if (idx >= 0) clockReflectListeners.splice(idx, 1);
      };
    },
    getLatencyStats(): null {
      return null;
    },
  };

  const fakeDispatcher = {
    connection: fakeConnection,
    send(msg: GameNetworkMessage): void {
      sent.push(msg);
      sentBytes.push(encodeMessage(msg));
    },
    waitFor<T extends GameNetworkMessage>(
      ctor: MessageClassRef<T>,
      waitOpts: { timeoutMs?: number; predicate?: (msg: T) => boolean } = {},
    ): Promise<T> {
      const timeoutMs = waitOpts.timeoutMs ?? 15_000;
      const predicate = (waitOpts.predicate ?? (() => true)) as (
        msg: GameNetworkMessage,
      ) => boolean;
      return new Promise<T>((resolve, reject) => {
        const record: WaiterRecord = {
          typeCrc: ctor.typeCrc,
          predicate,
          resolve: resolve as (msg: GameNetworkMessage) => void,
          reject,
          timer: setTimeout(() => {
            const idx = waiters.indexOf(record);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(
              new Error(
                `Timed out after ${timeoutMs}ms waiting for ${ctor.messageName} (stage=test)`,
              ),
            );
          }, timeoutMs),
        };
        record.timer.unref?.();
        waiters.push(record);
      });
    },
    onMessage<T extends GameNetworkMessage>(
      ctor: MessageClassRef<T>,
      handler: (msg: T) => void,
    ): () => void {
      const record: ListenerRecord = {
        typeCrc: ctor.typeCrc,
        handler: handler as (msg: GameNetworkMessage) => void,
      };
      listeners.push(record);
      return () => {
        const idx = listeners.indexOf(record);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    onAny(handler: (event: TranscriptEvent) => void): () => void {
      anyListeners.push(handler);
      return () => {
        const idx = anyListeners.indexOf(handler);
        if (idx >= 0) anyListeners.splice(idx, 1);
      };
    },
    handleAppMessage(): void {
      // no-op
    },
    cancelAllWaiters(reason: string): void {
      const drained = waiters.splice(0);
      for (const w of drained) {
        clearTimeout(w.timer);
        w.reject(new Error(reason));
      }
    },
    transcript: [],
    stageLabel: 'test',
  } as unknown as MessageDispatcher;

  const abortController = new AbortController();
  const sceneStart: SceneStart = {
    playerNetworkId: opts.playerNetworkId ?? 0x1234n,
    sceneName: 'tatooine',
    startPosition: opts.startPosition ?? { x: 0, y: 0, z: 0 },
    startYaw: opts.startYaw ?? 0,
    templateName: 'object/creature/player/human_male.iff',
    serverTimeSeconds: opts.serverTimeSeconds ?? 0n,
    serverEpoch: opts.serverEpoch ?? 0,
    disableWorldSnapshot: false,
  };

  const world = new WorldModel({
    dispatcher: fakeDispatcher,
    playerId: sceneStart.playerNetworkId,
  });

  const ctx = createScriptContext({
    dispatcher: fakeDispatcher,
    sceneStart,
    signal: abortController.signal,
    world,
  });

  const simulateRecv = (msg: GameNetworkMessage): void => {
    const ctor = msg.constructor as unknown as { typeCrc: number };
    // Fire any-listeners (mostly unused in fake tests, but kept for parity).
    if (anyListeners.length > 0) {
      const ev = {
        direction: 'recv' as const,
        messageName: (msg.constructor as unknown as { messageName: string }).messageName,
        typeCrc: ctor.typeCrc,
        bytes: 0,
        at: Date.now(),
        decoded: msg,
      };
      for (const h of anyListeners.slice()) {
        try {
          h(ev);
        } catch {
          // swallow
        }
      }
    }
    // Fire matching listeners.
    for (const listener of listeners.slice()) {
      if (listener.typeCrc !== ctor.typeCrc) continue;
      try {
        listener.handler(msg);
      } catch {
        // swallow
      }
    }
    // Fulfill any matching waiter (walk back-to-front so splice is safe).
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w === undefined) continue;
      if (w.typeCrc !== ctor.typeCrc) continue;
      let matched = false;
      try {
        matched = w.predicate(msg);
      } catch (err) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.reject(err instanceof Error ? err : new Error(String(err)));
        continue;
      }
      if (matched) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  };

  const simulateClockReflect = (
    sample: import('../../soe/clock-sync.js').ClockReflectSample,
  ): void => {
    for (const cb of clockReflectListeners.slice()) {
      try {
        cb(sample);
      } catch {
        // swallow
      }
    }
  };

  return {
    ctx,
    sent,
    sentBytes,
    abort: () => abortController.abort(),
    simulateRecv,
    simulateClockReflect,
  };
}

/**
 * Extract just the world-coord movement sends (CM_netUpdateTransform) from a
 * `sent[]` array. Filters out teleport-ACK bootstrap sends and any other
 * traffic, returning the decoded subtype data for each.
 */
export function movementSends(
  sent: GameNetworkMessage[],
): { msg: ObjControllerMessage; data: NetUpdateTransformData }[] {
  const out: { msg: ObjControllerMessage; data: NetUpdateTransformData }[] = [];
  for (const m of sent) {
    if (!(m instanceof ObjControllerMessage)) continue;
    if (m.message !== ObjControllerSubtypeIds.CM_netUpdateTransform) continue;
    if (m.decodedSubtype?.kind !== NetUpdateTransformKind) continue;
    out.push({ msg: m, data: m.decodedSubtype.data as NetUpdateTransformData });
  }
  return out;
}

/**
 * Extract just the cell-relative movement sends (CM_netUpdateTransformWithParent).
 */
export function cellMovementSends(
  sent: GameNetworkMessage[],
): { msg: ObjControllerMessage; data: NetUpdateTransformWithParentData }[] {
  const out: { msg: ObjControllerMessage; data: NetUpdateTransformWithParentData }[] = [];
  for (const m of sent) {
    if (!(m instanceof ObjControllerMessage)) continue;
    if (m.message !== ObjControllerSubtypeIds.CM_netUpdateTransformWithParent) continue;
    if (m.decodedSubtype?.kind !== NetUpdateTransformWithParentKind) continue;
    out.push({ msg: m, data: m.decodedSubtype.data as NetUpdateTransformWithParentData });
  }
  return out;
}

/**
 * Extract teleport-ACK sends (CM_teleportAck) from a `sent[]` array.
 */
export function teleportAckSends(
  sent: GameNetworkMessage[],
): { msg: ObjControllerMessage; data: TeleportAckData }[] {
  const out: { msg: ObjControllerMessage; data: TeleportAckData }[] = [];
  for (const m of sent) {
    if (!(m instanceof ObjControllerMessage)) continue;
    if (m.message !== ObjControllerSubtypeIds.CM_teleportAck) continue;
    if (m.decodedSubtype?.kind !== TeleportAckKind) continue;
    out.push({ msg: m, data: m.decodedSubtype.data as TeleportAckData });
  }
  return out;
}
