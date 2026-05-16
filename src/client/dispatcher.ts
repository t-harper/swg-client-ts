/**
 * Promise-based message dispatcher that sits on top of `SoeConnection`.
 *
 * Owns one `SoeConnection`. Routes every inbound app payload through the
 * `messageRegistry` to a typed `GameNetworkMessage`. Callers may register
 * listeners for specific message classes (`onMessage`) or wait for the next
 * one of a given type to arrive (`waitFor`).
 *
 * Used by Stage 1/2/3 — each opens a connection, instantiates a Dispatcher
 * around it, and calls `await dispatcher.waitFor(LoginEnumCluster)` etc.
 *
 * Also records a `TranscriptEvent` for every send + receive so the
 * orchestrator can return a debug-friendly trace at the end of the lifecycle.
 */
import type { ReadException } from '../archive/interface.js';
import { encodeMessage, parseHeader } from '../messages/base.js';
import type { GameNetworkMessage, MessageDecoder } from '../messages/interface.js';
import { messageRegistry } from '../messages/registry.js';
import type { SoeConnection } from '../soe/connection.js';

/**
 * Constructor side of a `GameNetworkMessage` subclass. The instance type `T`
 * is carried so `waitFor(SomeMessage)` resolves to `SomeMessage`. We don't
 * constrain the constructor's `new (...)` shape because subclasses vary
 * (some take positional args, some take an options object), and the
 * dispatcher never calls `new` — it only reads `messageName` + `typeCrc`.
 */
type MessageClassRef<T extends GameNetworkMessage> = {
  readonly messageName: string;
  readonly typeCrc: number;
  // Phantom property — keeps the generic T from being trivially inferred as
  // GameNetworkMessage. We never read it.
  readonly prototype: T;
};

/**
 * One event in the full-lifecycle transcript. Either a message we sent
 * (the wire-encoded form) or a message we received (typed-instance).
 *
 * `unknownCrc` is set for inbound messages whose CRC isn't registered (we
 * keep going — the server emits many messages that aren't relevant to the
 * MVP, like ObjControllerMessage / chat / combat).
 */
export type TranscriptEvent =
  | {
      direction: 'send';
      messageName: string;
      typeCrc: number;
      bytes: number;
      at: number;
    }
  | {
      direction: 'recv';
      messageName: string;
      typeCrc: number;
      bytes: number;
      at: number;
      decoded: GameNetworkMessage | null;
      unknownCrc?: boolean;
      decodeError?: string;
    };

type MessageListener<T extends GameNetworkMessage> = (msg: T) => void;

type PendingWait<T extends GameNetworkMessage> = {
  typeCrc: number;
  predicate: (msg: T) => boolean;
  resolve: (msg: T) => void;
  reject: (err: Error) => void;
};

export interface DispatcherOptions {
  /**
   * Connection to wrap. Caller is responsible for calling `connect()` before
   * sending; this dispatcher only handles message-level send/receive.
   */
  connection: SoeConnection;

  /**
   * Optional label for transcript events (e.g. 'login' / 'connection' / 'game')
   * to make it easy to grep stage transitions.
   */
  stageLabel?: string;
}

/**
 * High-level message I/O over an SoeConnection.
 */
export class MessageDispatcher {
  readonly connection: SoeConnection;
  readonly stageLabel: string;
  readonly transcript: TranscriptEvent[] = [];

  private readonly listeners = new Map<number, MessageListener<GameNetworkMessage>[]>();
  private readonly waiters: PendingWait<GameNetworkMessage>[] = [];
  /** Catch-all for every transcript event (both inbound and outbound). */
  private readonly anyListeners: ((event: TranscriptEvent) => void)[] = [];

  constructor(opts: DispatcherOptions) {
    this.connection = opts.connection;
    this.stageLabel = opts.stageLabel ?? '';
  }

  /**
   * Encode and ship a `GameNetworkMessage` on the connection. The connection
   * must already be in the connected state.
   */
  send<T extends GameNetworkMessage>(message: T): void {
    const ctor = message.constructor as unknown as MessageClassRef<T>;
    const bytes = encodeMessage(message);
    const event: TranscriptEvent = {
      direction: 'send',
      messageName: ctor.messageName,
      typeCrc: ctor.typeCrc,
      bytes: bytes.length,
      at: Date.now(),
    };
    this.transcript.push(event);
    for (const h of this.anyListeners) {
      try {
        h(event);
      } catch {
        // swallow
      }
    }
    this.connection.sendApp(bytes);
  }

  /**
   * Subscribe to all instances of a specific message class. Returns an
   * unsubscribe function.
   */
  onMessage<T extends GameNetworkMessage>(
    ctor: MessageClassRef<T>,
    handler: MessageListener<T>,
  ): () => void {
    let arr = this.listeners.get(ctor.typeCrc);
    if (arr === undefined) {
      arr = [];
      this.listeners.set(ctor.typeCrc, arr);
    }
    arr.push(handler as MessageListener<GameNetworkMessage>);
    return () => {
      const list = this.listeners.get(ctor.typeCrc);
      if (list === undefined) return;
      const idx = list.indexOf(handler as MessageListener<GameNetworkMessage>);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  /**
   * Subscribe to every inbound transcript event (typed or unknown CRC). The
   * orchestrator uses this for live logging in the CLI's verbose mode.
   */
  onAny(handler: (event: TranscriptEvent) => void): () => void {
    this.anyListeners.push(handler);
    return () => {
      const idx = this.anyListeners.indexOf(handler);
      if (idx >= 0) this.anyListeners.splice(idx, 1);
    };
  }

  /**
   * Resolve once a message of the given class arrives. Optionally filtered
   * by a predicate. Rejects on the given timeout (default 15s).
   *
   * NOTE: `waitFor` does NOT replay messages that have already been
   * delivered; the caller must register the wait BEFORE the message can be
   * received (the SOE event loop is async, so call `waitFor` before `send`).
   */
  waitFor<T extends GameNetworkMessage>(
    ctor: MessageClassRef<T>,
    opts: { timeoutMs?: number; predicate?: (msg: T) => boolean } = {},
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const predicate = (opts.predicate ?? (() => true)) as (msg: GameNetworkMessage) => boolean;

    return new Promise<T>((resolve, reject) => {
      const wait: PendingWait<GameNetworkMessage> = {
        typeCrc: ctor.typeCrc,
        predicate,
        resolve: resolve as (msg: GameNetworkMessage) => void,
        reject,
      };
      this.waiters.push(wait);

      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(wait);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for ${ctor.messageName} (stage=${this.stageLabel})`,
          ),
        );
      }, timeoutMs);
      // Don't keep the process alive purely for this timeout
      timer.unref?.();

      // Hook the original resolve to clear the timer
      const origResolve = wait.resolve;
      wait.resolve = (msg) => {
        clearTimeout(timer);
        origResolve(msg);
      };
      const origReject = wait.reject;
      wait.reject = (err) => {
        clearTimeout(timer);
        origReject(err);
      };
    });
  }

  /**
   * Called from the SoeConnection's onAppMessage. Decodes and dispatches to
   * any registered listeners and waiters.
   */
  handleAppMessage(payload: Uint8Array): void {
    let typeCrc = 0;
    let messageName = '<header-decode-failed>';
    let decoded: GameNetworkMessage | null = null;
    let decodeError: string | undefined;
    let unknownCrc = false;
    try {
      const { typeCrc: crc, payload: iter } = parseHeader(payload);
      typeCrc = crc;
      const decoder = messageRegistry.getByCrc(typeCrc) as MessageDecoder | undefined;
      if (decoder === undefined) {
        unknownCrc = true;
        messageName = `<crc:0x${typeCrc.toString(16).padStart(8, '0')}>`;
      } else {
        messageName = decoder.messageName;
        try {
          decoded = decoder.decodePayload(iter);
        } catch (err) {
          decodeError = err instanceof Error ? err.message : String(err);
        }
      }
    } catch (err) {
      decodeError = err instanceof Error ? err.message : String(err);
    }

    const event: TranscriptEvent = {
      direction: 'recv',
      messageName,
      typeCrc,
      bytes: payload.length,
      at: Date.now(),
      decoded,
      ...(unknownCrc ? { unknownCrc: true } : {}),
      ...(decodeError !== undefined ? { decodeError } : {}),
    };
    this.transcript.push(event);

    for (const h of this.anyListeners) {
      try {
        h(event);
      } catch {
        // swallow
      }
    }

    if (decoded === null) return;

    // Fire any listeners registered for this CRC
    const subs = this.listeners.get(typeCrc);
    if (subs !== undefined) {
      // Iterate a copy in case a handler unsubscribes
      for (const h of subs.slice()) {
        try {
          h(decoded);
        } catch {
          // swallow
        }
      }
    }

    // Fulfill any matching waiters
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (w === undefined) continue;
      if (w.typeCrc !== typeCrc) continue;
      let matched = false;
      try {
        matched = w.predicate(decoded);
      } catch (err) {
        this.waiters.splice(i, 1);
        w.reject(err instanceof Error ? err : new Error(String(err)));
        continue;
      }
      if (matched) {
        this.waiters.splice(i, 1);
        w.resolve(decoded);
      }
    }
  }

  /**
   * Reject every pending waiter with the given reason. Used when the
   * connection drops mid-handshake so callers don't hang.
   */
  cancelAllWaiters(reason: string): void {
    const drained = this.waiters.splice(0);
    for (const w of drained) {
      w.reject(new Error(reason));
    }
  }
}

/** Convenience: format a ReadException compactly for transcript display. */
export function formatReadException(err: ReadException | Error): string {
  if (err.name === 'ReadException') {
    return err.message;
  }
  return `${err.name}: ${err.message}`;
}
