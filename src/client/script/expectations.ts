/**
 * Scenario expectation helpers — pure functions that turn a
 * `MessageDispatcher` plus a message class into Promises that resolve
 * (or reject) based on what the server actually sends back.
 *
 * The helpers are intentionally separate from `context.ts` so that file
 * stays small. The `ScriptContext` wires them through with closures so
 * scenario authors don't have to thread the dispatcher manually.
 *
 * Two failure modes:
 *  - "Hard" — `expectWithin` and `expectAfter` reject on timeout by default,
 *    short-circuiting the scenario (`runScript` captures the message).
 *  - "Soft" — pass `{ soft: true }` to receive `undefined` instead of a
 *    rejection. The scenario continues; the surrounding context can record
 *    the failure into `ScriptResult.assertionFailures`.
 *
 * `expectAbsent` is the opposite assertion — it succeeds when nothing
 * matching arrives in the window, and rejects if a match does arrive.
 */

import type { GameNetworkMessage } from '../../messages/interface.js';
import type { MessageDispatcher } from '../dispatcher.js';

/**
 * Constructor side of a `GameNetworkMessage` subclass. Mirrors the shape
 * the dispatcher already uses; duplicated here so the expectations module
 * doesn't have to import from `dispatcher.ts` types beyond
 * `MessageDispatcher` itself.
 */
export type MessageClassRef<T extends GameNetworkMessage> = {
  readonly messageName: string;
  readonly typeCrc: number;
  // Phantom — keeps generic T from being inferred as the base class.
  readonly prototype: T;
};

export interface ExpectOptions<T extends GameNetworkMessage = GameNetworkMessage> {
  /** Filter matches by predicate. Default: accept any instance. */
  predicate?: (msg: T) => boolean;
  /**
   * If true, `expectWithin`/`expectAfter` resolve to `undefined` on timeout
   * instead of rejecting. Callers can then push a human-readable failure
   * onto `ScriptResult.assertionFailures` without short-circuiting.
   */
  soft?: boolean;
}

/**
 * Wait for a matching message to arrive within `timeoutMs`.
 *
 * Hard mode (default): rejects with `Timed out after Nms waiting for X` on
 * timeout. Soft mode (`opts.soft = true`): resolves to `undefined`.
 */
export function expectWithin<T extends GameNetworkMessage>(
  dispatcher: MessageDispatcher,
  ctor: MessageClassRef<T>,
  timeoutMs: number,
  opts?: ExpectOptions<T> & { soft: true },
): Promise<T | undefined>;
export function expectWithin<T extends GameNetworkMessage>(
  dispatcher: MessageDispatcher,
  ctor: MessageClassRef<T>,
  timeoutMs: number,
  opts?: ExpectOptions<T>,
): Promise<T>;
export function expectWithin<T extends GameNetworkMessage>(
  dispatcher: MessageDispatcher,
  ctor: MessageClassRef<T>,
  timeoutMs: number,
  opts?: ExpectOptions<T>,
): Promise<T | undefined> {
  const soft = opts?.soft === true;
  const predicate = opts?.predicate;
  const waitOpts: { timeoutMs: number; predicate?: (m: T) => boolean } = { timeoutMs };
  if (predicate !== undefined) waitOpts.predicate = predicate;
  const p = dispatcher.waitFor(ctor, waitOpts);
  if (!soft) return p;
  return p.then(
    (m) => m as T | undefined,
    (err: unknown) => {
      // Only swallow timeouts; everything else propagates so real bugs
      // (e.g. cancelAllWaiters when the connection drops) still surface.
      if (isTimeoutError(err)) return undefined;
      throw err;
    },
  );
}

/**
 * Assert that NO matching message arrives during the window. Resolves
 * after `windowMs`; rejects synchronously the moment a match shows up.
 */
export function expectAbsent<T extends GameNetworkMessage>(
  dispatcher: MessageDispatcher,
  ctor: MessageClassRef<T>,
  windowMs: number,
  opts?: { predicate?: (m: T) => boolean },
): Promise<void> {
  const predicate = opts?.predicate ?? (() => true);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const unsubscribe = dispatcher.onMessage(ctor, (msg) => {
      if (settled) return;
      let matched = false;
      try {
        matched = predicate(msg);
      } catch (err) {
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!matched) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      reject(new Error(`Expected no ${ctor.messageName} within ${windowMs}ms, but one arrived`));
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve();
    }, windowMs);
    timer.unref?.();
  });
}

/**
 * Fire a `trigger()` action, then wait up to `opts.withinMs` for a
 * matching follow-up. The waiter is registered BEFORE the trigger runs,
 * so messages that race back from the server are caught.
 *
 * Hard mode (default) rejects on timeout; soft mode resolves to `undefined`.
 */
export function expectAfter<T extends GameNetworkMessage>(
  dispatcher: MessageDispatcher,
  trigger: () => void | Promise<void>,
  ctor: MessageClassRef<T>,
  opts: { withinMs: number; predicate?: (m: T) => boolean; soft: true },
): Promise<T | undefined>;
export function expectAfter<T extends GameNetworkMessage>(
  dispatcher: MessageDispatcher,
  trigger: () => void | Promise<void>,
  ctor: MessageClassRef<T>,
  opts: { withinMs: number; predicate?: (m: T) => boolean; soft?: false },
): Promise<T>;
export function expectAfter<T extends GameNetworkMessage>(
  dispatcher: MessageDispatcher,
  trigger: () => void | Promise<void>,
  ctor: MessageClassRef<T>,
  opts: { withinMs: number; predicate?: (m: T) => boolean; soft?: boolean },
): Promise<T | undefined> {
  const soft = opts.soft === true;
  const predicate = opts.predicate;
  const waitOpts: { timeoutMs: number; predicate?: (m: T) => boolean } = {
    timeoutMs: opts.withinMs,
  };
  if (predicate !== undefined) waitOpts.predicate = predicate;
  // Register the waiter BEFORE running the trigger so synchronous server
  // responses can't be missed.
  const waiter = dispatcher.waitFor(ctor, waitOpts);
  // Fire the trigger; if it throws synchronously or asynchronously,
  // propagate so the scenario sees the underlying error.
  const triggered = Promise.resolve().then(() => trigger());
  const combined = triggered.then(() => waiter);
  if (!soft) return combined;
  return combined.then(
    (m) => m as T | undefined,
    (err: unknown) => {
      if (isTimeoutError(err)) return undefined;
      throw err;
    },
  );
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    return /^Timed out after \d+ms waiting for /.test(err.message);
  }
  return false;
}
