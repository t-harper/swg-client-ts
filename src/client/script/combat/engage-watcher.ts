/**
 * Engage-watcher — derives engaged/disengaged transitions from the live
 * combat surfaces (`ctx.hitTimer` + `ctx.combat.targets()`) and emits
 * one-shot events via `onTransition`.
 *
 * The watcher polls at `pollMs` (default 250ms) — that's fast enough to
 * notice an attack within a tick or two of the combat-action wire delivery,
 * but well under the budget for hundreds of clients in a Fleet. It does NOT
 * subscribe to wire events directly; the underlying surfaces already do
 * (`createCombatTimer` listens to CM_combatAction; combat-helpers listens
 * to world deltas). The watcher just samples both into a unified engaged/
 * disengaged signal.
 *
 * Disengage is debounced: `disengageAfterMs` (default 5000ms) of continuous
 * "not engaged" sampling is required before emitting the disengage event.
 * This avoids flapping in the gap between "last hit landed" and "the next
 * NPC turns toward us".
 */

import type { NetworkId } from '../../../types.js';
import type { CombatView } from '../../combat-helpers.js';
import type { CombatTimerView } from '../../timing.js';

export interface EngageWatcherSnapshot {
  engaged: boolean;
  targetIds: readonly NetworkId[];
  nowMs: number;
}

export interface EngageWatcherTransition {
  kind: 'engage' | 'disengage';
  /** Engaged target ids at the moment of transition (empty for disengage). */
  targetIds: readonly NetworkId[];
  nowMs: number;
}

export interface CreateEngageWatcherOptions {
  combat: CombatView;
  hitTimer: CombatTimerView;
  scriptSignal: AbortSignal;
  /** Sampling interval in ms. Default 250. */
  pollMs?: number;
  /**
   * Continuous-quiet window required before emitting disengage. Default 5000.
   * Setting this very low can cause flapping; setting it very high keeps the
   * tick loop running long after the fight is over.
   */
  disengageAfterMs?: number;
  /**
   * Called on every state transition. Subscribers should NOT throw — the
   * watcher swallows callback errors to keep the poll loop alive.
   */
  onTransition: (e: EngageWatcherTransition) => void;
  /** Optional now() override for testing. Default `Date.now`. */
  now?: () => number;
  /**
   * Optional schedule override for testing — replaces `setInterval` /
   * `clearInterval`. Default uses node's setInterval (with unref()).
   */
  schedule?: {
    setInterval(cb: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
}

export interface EngageWatcher {
  /** Current engaged state. */
  readonly engaged: boolean;
  /** Last sampled snapshot. */
  snapshot(): EngageWatcherSnapshot;
  /** Force a sample now (e.g. immediately after install). */
  sample(): void;
  /**
   * Force-engage manually. Useful for `cb.engage({ targetId })` proactive
   * pulls. Emits an engage transition if currently disengaged.
   */
  forceEngage(targetIds: readonly NetworkId[]): void;
  /**
   * Force-disengage manually. Emits a disengage transition if currently
   * engaged.
   */
  forceDisengage(): void;
  /** Stop the poll loop. Idempotent. */
  detach(): void;
  /** Test/observability hook — true after `detach()`. */
  readonly detached: boolean;
}

export function createEngageWatcher(opts: CreateEngageWatcherOptions): EngageWatcher {
  const pollMs = opts.pollMs ?? 250;
  const disengageAfterMs = opts.disengageAfterMs ?? 5_000;
  const now = opts.now ?? ((): number => Date.now());
  const schedule = opts.schedule ?? {
    setInterval(cb: () => void, ms: number): unknown {
      const handle = setInterval(cb, ms);
      (handle as { unref?: () => void }).unref?.();
      return handle;
    },
    clearInterval(handle: unknown): void {
      clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };

  let engaged = false;
  let lastEngagedSamplingAtMs = 0;
  let lastTargetIds: readonly NetworkId[] = [];
  let detached = false;

  function readEngagedRaw(): { engaged: boolean; targetIds: readonly NetworkId[] } {
    const targets = opts.combat.targets();
    const targetIds = targets.map((t) => t.id);
    const hitTimerEngaged = opts.hitTimer.engaged;
    return { engaged: hitTimerEngaged || targets.length > 0, targetIds };
  }

  function emit(transition: EngageWatcherTransition): void {
    try {
      opts.onTransition(transition);
    } catch {
      // swallow — never let a subscriber error kill the loop
    }
  }

  function sample(): void {
    if (detached) return;
    const t = now();
    const raw = readEngagedRaw();
    lastTargetIds = raw.targetIds;
    if (raw.engaged) {
      lastEngagedSamplingAtMs = t;
      if (!engaged) {
        engaged = true;
        emit({ kind: 'engage', targetIds: raw.targetIds, nowMs: t });
      }
      return;
    }
    // Not currently engaged. If we're transitioning out, debounce until the
    // quiet window elapses.
    if (engaged) {
      if (t - lastEngagedSamplingAtMs >= disengageAfterMs) {
        engaged = false;
        emit({ kind: 'disengage', targetIds: [], nowMs: t });
      }
    }
  }

  // Stop on script-signal abort. We don't proactively forceDisengage —
  // dispose elsewhere handles that.
  const onScriptAbort = (): void => detach();
  if (opts.scriptSignal.aborted) {
    detached = true;
  } else {
    opts.scriptSignal.addEventListener('abort', onScriptAbort, { once: true });
  }

  const intervalHandle = detached ? null : schedule.setInterval(sample, pollMs);

  function forceEngage(targetIds: readonly NetworkId[]): void {
    if (detached) return;
    lastEngagedSamplingAtMs = now();
    lastTargetIds = targetIds;
    if (engaged) return;
    engaged = true;
    emit({ kind: 'engage', targetIds, nowMs: lastEngagedSamplingAtMs });
  }

  function forceDisengage(): void {
    if (detached) return;
    if (!engaged) return;
    engaged = false;
    lastTargetIds = [];
    emit({ kind: 'disengage', targetIds: [], nowMs: now() });
  }

  function detach(): void {
    if (detached) return;
    detached = true;
    if (intervalHandle !== null) {
      try {
        schedule.clearInterval(intervalHandle);
      } catch {
        // swallow
      }
    }
    try {
      opts.scriptSignal.removeEventListener('abort', onScriptAbort);
    } catch {
      // swallow
    }
  }

  return {
    get engaged(): boolean {
      return engaged;
    },
    snapshot(): EngageWatcherSnapshot {
      return { engaged, targetIds: lastTargetIds, nowMs: now() };
    },
    sample,
    forceEngage,
    forceDisengage,
    detach,
    get detached(): boolean {
      return detached;
    },
  };
}
