/**
 * installCombatBehavior — the public entry point.
 *
 * Wires the engage-watcher, host-cancel gate, and tick loop together into
 * a single `CombatBehavior` handle. The host script calls this once,
 * receives a handle, wraps cancellable work in `cb.runHostOperation(...)`,
 * and trusts the framework to take over when attacked.
 *
 *   const cb = installCombatBehavior(ctx, { profession: 'spy' });
 *   try {
 *     await cb.runHostOperation((signal) => surveyLoop(ctx, signal));
 *   } catch {
 *     // AbortError when combat engaged; combat is now handling the fight.
 *   }
 *   cb.dispose();
 *
 * Lifecycle:
 *   1. Install → engage-watcher poll begins (250ms cadence).
 *   2. On engage transition → abort host op, start tick loop in background.
 *   3. Tick loop runs until disengage transition (or signal abort).
 *   4. On disengage transition → recycle host-cancel gate, reset tick state.
 *   5. dispose() / scriptSignal abort → detach watcher, abort tick loop,
 *      dispose host-cancel gate.
 */

import type { ScriptContext } from '../context.js';
import { type EngageWatcher, createEngageWatcher } from './engage-watcher.js';
import { type HostCancelGate, createHostCancelGate } from './host-cancel.js';
import { resolveProfessionRotation } from './profession/index.js';
import { createTickLoopState, resetTickLoopState, runTickLoop } from './tick-loop.js';
import {
  type CombatBehavior,
  type CombatBehaviorOptions,
  DEFAULT_HEAL_POLICY,
  DEFAULT_KITE_PROFILES,
  DEFAULT_TARGETING_POLICY,
  type DisengageEvent,
  type DisengageReason,
  type EngageEvent,
  type EngageReason,
  type ProfessionId,
  type ResolvedOptions,
  type Rotation,
} from './types.js';
import { verifyAbilities } from './verify-abilities.js';

export function installCombatBehavior(
  ctx: ScriptContext,
  opts: CombatBehaviorOptions,
): CombatBehavior {
  const resolved = resolveOptions(opts);
  const logFn = resolved.logFn;
  const engageListeners = new Set<(e: EngageEvent) => void>();
  const disengageListeners = new Set<(e: DisengageEvent) => void>();
  let engaged = false;
  let engagementStartedAtMs = 0;
  let disposed = false;
  let tickAbortController: AbortController | null = null;
  let tickLoopPromise: Promise<unknown> | null = null;

  // Optional install-time check. Logs warnings only.
  if (resolved.verify) {
    verifyAbilities({ world: ctx.world, sceneStart: ctx.sceneStart }, resolved.profession, {
      rotation: resolved.rotation,
    });
  }

  const tickState = createTickLoopState();
  const hostCancel: HostCancelGate = createHostCancelGate({ scriptSignal: ctx.signal });

  const watcher: EngageWatcher = createEngageWatcher({
    combat: ctx.combat,
    hitTimer: ctx.hitTimer,
    scriptSignal: ctx.signal,
    pollMs: 250,
    disengageAfterMs: resolved.disengageAfterMs,
    onTransition: (t) => {
      if (t.kind === 'engage') {
        beginEngagement('targets-present', t.targetIds, t.nowMs);
      } else {
        endEngagement('no-targets-and-quiet', t.nowMs);
      }
    },
  });

  function beginEngagement(
    reason: EngageReason,
    targetIds: readonly bigint[],
    nowMs: number,
  ): void {
    if (disposed) return;
    if (engaged) return;
    engaged = true;
    engagementStartedAtMs = nowMs;
    logFn('combat:engage', { reason, targetIds: targetIds.map((id) => id.toString()) });
    // Abort any in-flight host op so combat can take over.
    hostCancel.abortCurrent();
    // Start tick loop in background.
    tickAbortController = new AbortController();
    tickLoopPromise = runTickLoop(
      // The ScriptContext satisfies TickLoopHost — share fields directly.
      {
        combat: ctx.combat,
        hitTimer: ctx.hitTimer,
        cooldowns: ctx.cooldowns,
        character: ctx.character,
        world: ctx.world,
        sceneStart: ctx.sceneStart,
        position: () => ctx.position(),
        yaw: () => ctx.yaw(),
        useAbility: (n, t, p) => ctx.useAbility(n, t, p),
        send: (m) => ctx.send(m),
        nextSyncStamp: () => ctx.nextSyncStamp(),
        nextSequenceNumber: () => ctx.nextSequenceNumber(),
        setPose: (pos, y) => ctx.setPose(pos, y),
      },
      tickState,
      {
        rotation: resolved.rotation,
        heal: resolved.heal,
        kite: resolved.kite,
        targeting: resolved.targeting,
        tickMs: resolved.tickMs,
        signal: tickAbortController.signal,
        logFn,
      },
    ).catch((err) => {
      logFn('combat:tick-loop:error', { err: (err as Error).message });
    });
    emit('engage', { reason, targetIds, atMs: nowMs });
  }

  function endEngagement(reason: DisengageReason, nowMs: number): void {
    if (disposed && reason !== 'host-disposed') return;
    if (!engaged) return;
    engaged = false;
    const durationMs = nowMs - engagementStartedAtMs;
    logFn('combat:disengage', { reason, durationMs });
    if (tickAbortController !== null) {
      tickAbortController.abort();
      tickAbortController = null;
    }
    tickLoopPromise = null;
    resetTickLoopState(tickState);
    hostCancel.recycleAfterEngagement();
    emit('disengage', { reason, durationMs, atMs: nowMs });
  }

  function emit(kind: 'engage' | 'disengage', payload: EngageEvent | DisengageEvent): void {
    const listeners = kind === 'engage' ? engageListeners : disengageListeners;
    for (const fn of listeners) {
      try {
        if (kind === 'engage') (fn as (e: EngageEvent) => void)(payload as EngageEvent);
        else (fn as (e: DisengageEvent) => void)(payload as DisengageEvent);
      } catch {
        // swallow
      }
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (engaged) {
      endEngagement('host-disposed', Date.now());
    }
    watcher.detach();
    hostCancel.dispose();
    engageListeners.clear();
    disengageListeners.clear();
  }

  // Tear down on script-signal abort.
  if (!ctx.signal.aborted) {
    ctx.signal.addEventListener('abort', () => dispose(), { once: true });
  } else {
    dispose();
  }

  return {
    get engaged(): boolean {
      return engaged;
    },
    profession: resolved.profession,
    runHostOperation: (fn) => hostCancel.runHostOperation(fn),
    async engage(o): Promise<void> {
      if (disposed) return;
      if (engaged) return;
      const targetIds: bigint[] = [];
      if (o?.targetId !== undefined) {
        targetIds.push(o.targetId);
        // Plumb the forced target into the tick loop so the picker has
        // something to fire at even before the enemy counter-attacks and
        // populates `ctx.combat.targets()`.
        tickState.forcedTargetId = o.targetId;
      }
      watcher.forceEngage(targetIds);
      // forceEngage emits via onTransition, which beginEngagement processes
      // — but for the synchronous "engage right now" semantic we also call
      // beginEngagement directly if the watcher's debounced sample-loop
      // hasn't picked it up yet.
      if (!engaged) {
        beginEngagement('manual', targetIds, Date.now());
      }
    },
    disengage(_reason?: 'manual'): void {
      if (disposed) return;
      if (!engaged) return;
      watcher.forceDisengage();
      endEngagement('manual', Date.now());
    },
    onEngage(fn: (e: EngageEvent) => void): () => void {
      engageListeners.add(fn);
      return () => engageListeners.delete(fn);
    },
    onDisengage(fn: (e: DisengageEvent) => void): () => void {
      disengageListeners.add(fn);
      return () => disengageListeners.delete(fn);
    },
    dispose,
  };
}

/** Merge user options with defaults. */
function resolveOptions(opts: CombatBehaviorOptions): ResolvedOptions {
  const profession = opts.profession;
  const rotation: Rotation = opts.rotation ?? resolveProfessionRotation(profession);
  const heal = { ...DEFAULT_HEAL_POLICY, ...(opts.heal ?? {}) };
  const kite = { ...DEFAULT_KITE_PROFILES[profession], ...(opts.kite ?? {}) };
  const targeting = { ...DEFAULT_TARGETING_POLICY, ...(opts.targeting ?? {}) };
  return {
    profession,
    rotation,
    heal,
    kite,
    targeting,
    tickMs: opts.tickMs ?? 100,
    verify: opts.verify ?? true,
    disengageAfterMs: opts.disengageAfterMs ?? 5_000,
    logFn: opts.logFn ?? ((_tag: string, _payload: unknown): void => {}),
  };
}
// Suppress no-unused-vars warning for the ProfessionId import (kept for
// downstream re-export discoverability).
const _professionRef: ProfessionId = 'bounty_hunter';
void _professionRef;
