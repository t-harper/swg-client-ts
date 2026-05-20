/**
 * Host-cancel gate — chained AbortController for plug-and-play combat.
 *
 * The host script wraps any cancellable work in `runHostOperation(fn)`. The
 * gate gives `fn` a child `AbortSignal` that aborts whenever combat takes
 * over OR the script context's signal aborts (whichever fires first). When
 * the gate's signal aborts, `fn`'s promise rejects with `AbortError` —
 * the host catches and decides what to do (resume after disengage, abandon,
 * etc.).
 *
 * After combat disengages, the install layer calls `recycleAfterEngagement`
 * to swap in a fresh internal controller — the next `runHostOperation`
 * starts with a clean signal.
 *
 * Disposal aborts both controllers and unsubscribes from `ctx.signal`.
 */

/** Abort-error name used by host-side checks (matches AbortController.abort()). */
export const ABORT_ERROR_NAME = 'AbortError';

export interface HostCancelGate {
  /** Run `fn` with a child signal that aborts on combat engage. */
  runHostOperation<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** Abort the current host operation (called when combat engages). */
  abortCurrent(): void;
  /** Reset the combat-side controller after disengage so the next op starts clean. */
  recycleAfterEngagement(): void;
  /** Permanently abort + unsubscribe from script signal. Idempotent. */
  dispose(): void;
  /** Test/observability hook — true after `dispose()`. */
  readonly disposed: boolean;
}

export interface CreateHostCancelGateOptions {
  /** The script-context-level AbortSignal — aborts propagate to all gate ops. */
  scriptSignal: AbortSignal;
}

export function createHostCancelGate(opts: CreateHostCancelGateOptions): HostCancelGate {
  // The combat controller is recycled after every engagement so a fresh
  // signal is available for the next runHostOperation. The script signal is
  // permanent — when it aborts, the gate is dead.
  let combatController = new AbortController();
  let disposed = false;
  const scriptSignal = opts.scriptSignal;

  // When the script signal aborts, dispose immediately. If the script
  // already aborted, this listener is a no-op (we still wire it for symmetry).
  const onScriptAbort = (): void => {
    dispose();
  };
  if (scriptSignal.aborted) {
    disposed = true;
    combatController.abort();
  } else {
    scriptSignal.addEventListener('abort', onScriptAbort, { once: true });
  }

  function makeChildSignal(): AbortSignal {
    // Merge the script signal and the combat controller into one child
    // controller. Either firing → child aborts.
    const child = new AbortController();
    if (scriptSignal.aborted || combatController.signal.aborted) {
      child.abort(scriptSignal.aborted ? scriptSignal.reason : combatController.signal.reason);
      return child.signal;
    }
    const onCombatAbort = (): void => {
      child.abort(combatController.signal.reason);
      cleanup();
    };
    const onScriptParentAbort = (): void => {
      child.abort(scriptSignal.reason);
      cleanup();
    };
    function cleanup(): void {
      combatController.signal.removeEventListener('abort', onCombatAbort);
      scriptSignal.removeEventListener('abort', onScriptParentAbort);
    }
    combatController.signal.addEventListener('abort', onCombatAbort, { once: true });
    scriptSignal.addEventListener('abort', onScriptParentAbort, { once: true });
    // Once the caller's `fn` resolves or rejects, cleanup detaches us from
    // the parent signals. We can't intercept that here directly — but the
    // child signal's lifetime is tied to its own AbortController, and the
    // child becomes garbage once `fn` settles. The cleanup above runs only
    // on abort; in the resolve-then-no-abort case the listeners detach when
    // combatController is recycled (next engagement) or scriptSignal aborts.
    return child.signal;
  }

  async function runHostOperation<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (disposed) {
      const e = new Error('host-cancel gate disposed');
      e.name = ABORT_ERROR_NAME;
      throw e;
    }
    const signal = makeChildSignal();
    return fn(signal);
  }

  function abortCurrent(): void {
    if (disposed) return;
    if (combatController.signal.aborted) return;
    const reason = new Error('combat engaged');
    reason.name = ABORT_ERROR_NAME;
    combatController.abort(reason);
  }

  function recycleAfterEngagement(): void {
    if (disposed) return;
    // Always replace — abortCurrent flipped this controller's signal to
    // aborted, and any in-flight host op should now resolve in its catch.
    combatController = new AbortController();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (!combatController.signal.aborted) {
      const reason = new Error('host-cancel gate disposed');
      reason.name = ABORT_ERROR_NAME;
      combatController.abort(reason);
    }
    try {
      scriptSignal.removeEventListener('abort', onScriptAbort);
    } catch {
      // swallow
    }
  }

  return {
    runHostOperation,
    abortCurrent,
    recycleAfterEngagement,
    dispose,
    get disposed(): boolean {
      return disposed;
    },
  };
}
