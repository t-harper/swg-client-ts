/**
 * SessionControl — the directive state machine that steers one running
 * scripted session. It replaces the bots' ad-hoc `{ stop, reason }`
 * kill-switch object with a richer set of states the control socket can
 * drive and the script loops can observe.
 *
 * Lifetime: one `SessionControl` per `fullLifecycle()` iteration. A
 * supervisor (`runSupervised`) creates one, hands it to `fullLifecycle`,
 * and re-reads its `directive` after the lifecycle returns to decide
 * whether to reconnect (`restart`) or exit (`stop` / `logout`).
 *
 * Directive semantics:
 *  - `run` / `paused` are the two steady states. `shouldKeepRunning()` is
 *    true for both; a cooperative script loop ticks in both but skips its
 *    periodic work while `isPaused()`.
 *  - `reload` / `restart` / `stop` / `logout` are one-shot transitions a
 *    script loop should break out of. `stop` / `logout` are terminal —
 *    once requested they cannot be overridden.
 *  - `reload` is consumed by the game-stage inner loop (re-run a freshly
 *    imported scenario against the SAME connection). `restart` is consumed
 *    by the outer supervisor loop (reconnect). `stop` / `logout` end
 *    everything.
 */

/** The six directive states. */
export type SessionDirective = 'run' | 'paused' | 'reload' | 'restart' | 'stop' | 'logout';

/** A named action a scenario registers for the `trigger` control command. */
export type SessionActionFn = (args?: Record<string, unknown>) => unknown | Promise<unknown>;

export interface SessionControl {
  /** The current directive. */
  readonly directive: SessionDirective;
  /** Free-form reason string attached to the most recent `request`. */
  readonly reason: string;
  /** True while the script should keep ticking (`run` or `paused`). */
  shouldKeepRunning(): boolean;
  /** True while behavior should be suspended but the session kept alive. */
  isPaused(): boolean;
  /** True once `stop` or `logout` has been requested (no going back). */
  isTerminal(): boolean;
  /**
   * Request a directive transition. Guarded: `stop`/`logout` are sticky;
   * `paused` only takes from `run`; `run` (resume) only takes from
   * `paused`/`run` so it can't cancel a pending `reload`/`restart`.
   */
  request(directive: SessionDirective, reason?: string): void;
  /**
   * Force the directive back to `run` — used by the inner/outer loops
   * after they have consumed a `reload`/`restart`. No-op when terminal.
   */
  resetToRun(): void;
  /** Subscribe to directive changes. Returns an unsubscribe function. */
  onChange(fn: (directive: SessionDirective, reason: string) => void): () => void;
  /** Resolve on the next directive change. */
  waitForChange(): Promise<SessionDirective>;
  /** Register a named action invokable via the `trigger` control command. */
  registerAction(name: string, fn: SessionActionFn): () => void;
  /** Invoke a registered action. Rejects if `name` is not registered. */
  invokeAction(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** List the names of currently-registered actions. */
  listActions(): string[];
  /**
   * Drop every registered action. Called between script runs so a reload
   * starts with a clean registry — a re-imported scenario re-registers its
   * own actions, and stale actions (holding a dead context) don't linger.
   */
  clearActions(): void;
}

/** Construct a fresh {@link SessionControl} in the `run` state. */
export function createSessionControl(): SessionControl {
  let directive: SessionDirective = 'run';
  let reason = '';
  const listeners = new Set<(d: SessionDirective, r: string) => void>();
  const actions = new Map<string, SessionActionFn>();

  function notify(): void {
    for (const fn of [...listeners]) {
      try {
        fn(directive, reason);
      } catch {
        // a listener throwing must not break the state machine
      }
    }
  }

  function set(next: SessionDirective, r: string): void {
    directive = next;
    reason = r;
    notify();
  }

  return {
    get directive(): SessionDirective {
      return directive;
    },
    get reason(): string {
      return reason;
    },
    shouldKeepRunning(): boolean {
      return directive === 'run' || directive === 'paused';
    },
    isPaused(): boolean {
      return directive === 'paused';
    },
    isTerminal(): boolean {
      return directive === 'stop' || directive === 'logout';
    },
    request(next: SessionDirective, r = ''): void {
      if (directive === 'stop' || directive === 'logout') return; // terminal
      switch (next) {
        case 'run':
          // Resume: only un-pause; never cancel a pending reload/restart.
          if (directive === 'paused' || directive === 'run') set('run', r);
          break;
        case 'paused':
          if (directive === 'run') set('paused', r);
          break;
        case 'reload':
        case 'restart':
          // Latest of reload/restart wins; can preempt run/paused.
          set(next, r);
          break;
        case 'stop':
        case 'logout':
          set(next, r);
          break;
      }
    },
    resetToRun(): void {
      if (directive === 'stop' || directive === 'logout') return;
      directive = 'run';
      reason = '';
    },
    onChange(fn: (d: SessionDirective, r: string) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    waitForChange(): Promise<SessionDirective> {
      return new Promise<SessionDirective>((resolve) => {
        const off = this.onChange((d) => {
          off();
          resolve(d);
        });
      });
    },
    registerAction(name: string, fn: SessionActionFn): () => void {
      actions.set(name, fn);
      return () => {
        if (actions.get(name) === fn) actions.delete(name);
      };
    },
    async invokeAction(name: string, args?: Record<string, unknown>): Promise<unknown> {
      const fn = actions.get(name);
      if (fn === undefined) {
        throw new Error(`no action registered named "${name}"`);
      }
      return await fn(args);
    },
    listActions(): string[] {
      return [...actions.keys()];
    },
    clearActions(): void {
      actions.clear();
    },
  };
}
