/**
 * Timing trackers — live views surfaced on `ScriptContext` that decay
 * against the wall clock without being touched by user code.
 *
 *   - {@link CooldownTracker}  — `ctx.cooldowns`: per-command-name cooldown
 *     remaining + ready-state, derived from `CM_commandTimer` (762) and
 *     `CM_commandQueueRemove` (279) ObjController subtypes.
 *   - {@link ServerTimeTracker} — `ctx.serverTime`: a best-estimate of the
 *     current server wall-clock in ms / seconds. Seeded from
 *     `CmdStartScene.serverEpoch` (the i32 Unix-epoch field — NOT
 *     `serverTimeSeconds`, which is the server's GameTime / uptime in
 *     seconds since process-start, not a wall clock) and continuously
 *     refined by ClockReflect samples (the `serverSyncStampLong` field
 *     in each reply).
 *   - {@link CombatTimer}      — `ctx.combat`: how long ago the player was
 *     last hit (per `CM_combatAction` 204 deliveries where our networkId is
 *     in the defender list), plus a boolean `engaged` (true within 10s of
 *     the last hit).
 *
 * All three are pure read-only views — no methods that send wire messages.
 * They subscribe to the dispatcher at construction and release subscriptions
 * via `detach()` (called from `runScript` teardown). Tests can construct
 * them directly with a fake dispatcher.
 */

import { ReadIterator } from '../archive/read-iterator.js';
import {
  CM_COMMAND_QUEUE_ENQUEUE,
  CM_COMMAND_TIMER,
  CommandQueueEnqueue,
  CommandTimerData,
  CommandTimerFlag,
  hashCommand,
} from '../messages/game/command-queue/index.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import {
  type CombatActionData,
  CombatActionKind,
  ObjControllerSubtypeIds,
} from '../messages/game/obj-controller/index.js';
import type { ClockReflectSample } from '../soe/clock-sync.js';
import type { NetworkId } from '../types.js';
import type { MessageDispatcher } from './dispatcher.js';

// ──────────────────────────────────────────────────────────────────────────
// Cooldown tracker — per-command-name remaining cooldown + ready state.
// ──────────────────────────────────────────────────────────────────────────

/**
 * One command's current cooldown state. Returned by
 * `CooldownView.all().get(name)` so consumers can read both the remaining ms
 * and the boolean `isReady()` from a stable shape. Both halves recompute
 * against `Date.now()` on every read — there's no internal timer.
 */
export interface CooldownEntry {
  /**
   * Milliseconds until the cooldown expires (relative to right now). `0`
   * means ready; a positive value means still cooling.
   */
  msUntilReady: number;
  /** Convenience — `msUntilReady === 0`. */
  isReady(): boolean;
}

/**
 * The live cooldown view exposed as `ctx.cooldowns`.
 *
 * Look up by command name (e.g. `'mount'`, `'attack'`, `'spatialChatInternal'`).
 * Lookups by name are O(1); they walk a `Map<commandHash, expiresAtMs>`
 * after hashing the input.
 */
export interface CooldownView {
  /** Get the remaining cooldown for `commandName` in ms. `0` if ready or unknown. */
  msUntil(commandName: string): number;
  /** True if `commandName` is currently ready (no cooldown OR unknown command). */
  isReady(commandName: string): boolean;
  /**
   * Snapshot every tracked command's current cooldown. Returns a fresh map
   * with stable `{msUntilReady, isReady()}` entries — the entries reflect
   * the cooldown state at the moment `all()` was called, not live thereafter.
   */
  all(): Map<string, CooldownEntry>;
  /**
   * Read the raw `Map<commandHash, expiresAtMs>` — for tests / introspection.
   * Keys are the constcrc(commandName.toLowerCase()) hashes. Values are
   * absolute `Date.now()`-frame millisecond timestamps at which the
   * cooldown expires.
   */
  rawExpiries(): ReadonlyMap<number, number>;
}

/** Internal handle — used by orchestrator to detach + by tests to feed updates. */
export interface CooldownTrackerHandle {
  view: CooldownView;
  /**
   * Register a command name so its hash can be looked up later. Called
   * automatically when the script context's `useAbility` is invoked — but
   * tests / scripts that want to query by-name for an externally-issued
   * command can call this explicitly.
   */
  registerCommandName(commandName: string): void;
  /** Tear down dispatcher subscriptions. Idempotent. */
  detach(): void;
}

interface CooldownState {
  /** commandHash -> name. Populated lazily as we see useAbility calls. */
  hashToName: Map<number, string>;
  /** commandHash -> absolute Date.now()-frame ms when the cooldown expires. */
  expiresAt: Map<number, number>;
  /**
   * Per-cooldown-group (i32) expiry. CommandTimerData may carry a
   * `cooldownGroup` int that applies to a whole family of abilities — we
   * record the group expiry separately so that future per-name lookups
   * (which would need the server's CommandTable to resolve) can include
   * it. Not currently used by the by-name lookups, but kept for completeness.
   */
  groupExpiresAt: Map<number, number>;
}

/**
 * Construct a CooldownTracker hooked up to `dispatcher`.
 *
 * The tracker subscribes to two ObjController subtypes:
 *   - `CM_commandTimer (762)` — full per-command timer with warmup /
 *     execute / cooldown phases. The `cooldown` phase (flag bit 2) carries
 *     the remaining-and-max time pair; we project remaining → an absolute
 *     expiry timestamp.
 *   - `CM_commandQueueRemove (279)` — the cheaper "command finished"
 *     ack. Its `waitTime` field is the remaining cooldown (sometimes 0,
 *     sometimes the same value as the cooldown half of CommandTimer);
 *     not used here for the per-name map because the remove ack lacks
 *     the command hash, but the subscribe is documented for completeness.
 *
 * It also intercepts outbound `ObjControllerMessage(CM_commandQueueEnqueue=
 * 278)` sends to maintain a hash→name map — because the server's
 * `CommandTimerData.commandNameCrc` is just a hash, we need the original
 * name to support `ctx.cooldowns.msUntil('mount')` lookups.
 */
export function createCooldownTracker(opts: {
  dispatcher: MessageDispatcher;
}): CooldownTrackerHandle {
  const state: CooldownState = {
    hashToName: new Map<number, string>(),
    expiresAt: new Map<number, number>(),
    groupExpiresAt: new Map<number, number>(),
  };

  function registerCommandName(commandName: string): void {
    const lower = commandName.toLowerCase();
    state.hashToName.set(hashCommand(lower), lower);
  }

  function applyCooldownSeconds(commandHash: number, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      // Server is signalling "command finished, no cooldown" — clear any
      // stale expiry so the next msUntil() call returns 0.
      state.expiresAt.delete(commandHash);
      return;
    }
    const expiresAt = Date.now() + seconds * 1000;
    const existing = state.expiresAt.get(commandHash);
    // Track the LATER of the two — multiple sources (CommandTimer +
    // CommandQueueRemove) may report overlapping windows; the server
    // permits the next use only when ALL cooldown sources have elapsed.
    if (existing === undefined || expiresAt > existing) {
      state.expiresAt.set(commandHash, expiresAt);
    }
  }

  function applyGroupCooldownSeconds(group: number, seconds: number): void {
    if (group < 0) return; // -1 = NULL_COOLDOWN_GROUP
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const expiresAt = Date.now() + seconds * 1000;
    const existing = state.groupExpiresAt.get(group);
    if (existing === undefined || expiresAt > existing) {
      state.groupExpiresAt.set(group, expiresAt);
    }
  }

  const unsubscribers: Array<() => void> = [];

  // 1) CM_commandTimer (762) — the rich timer message.
  unsubscribers.push(
    opts.dispatcher.onMessage(ObjControllerMessage, (m) => {
      if (m.message !== CM_COMMAND_TIMER) return;
      let timerData: CommandTimerData;
      try {
        const iter = new ReadIterator(m.data);
        timerData = CommandTimerData.unpack(iter);
      } catch {
        return;
      }
      // The `cooldown` phase (flag bit 2) carries the (current, max) pair
      // for the per-command cooldown in seconds. The C++
      // `MessageQueueCommandTimer` pack/unpack uses (current, max); the
      // server fills current with the "time remaining" amount.
      const cooldownEntry = timerData.times[CommandTimerFlag.Cooldown];
      if (cooldownEntry !== undefined) {
        applyCooldownSeconds(timerData.commandNameCrc, cooldownEntry.current);
      }
      // CM_commandTimer can also carry a cooldownGroup; record it so callers
      // can introspect via rawExpiries() (no name lookup today, but the
      // bookkeeping is here for completeness).
      if (timerData.cooldownGroup !== -1 && cooldownEntry !== undefined) {
        applyGroupCooldownSeconds(timerData.cooldownGroup, cooldownEntry.current);
      }
      if (timerData.cooldownGroup2 !== -1) {
        const cd2 = timerData.times[CommandTimerFlag.Cooldown2];
        if (cd2 !== undefined) {
          applyGroupCooldownSeconds(timerData.cooldownGroup2, cd2.current);
        }
      }
    }),
  );

  // 2) Outbound CM_commandQueueEnqueue (278) — register the command name.
  //    Pre-populate the hash→name map so by-name lookups work even before
  //    the server's CommandTimer arrives. We don't have the original name
  //    from just the wire bytes (we only get the hash), but the `useAbility`
  //    call site that produced this send will register the friendly name
  //    via `registerCommandName` — so this onAny hook is mostly for
  //    capturing externally-built CommandQueueEnqueue messages where the
  //    caller didn't register the name. In that case the hash itself becomes
  //    a placeholder key.
  unsubscribers.push(
    opts.dispatcher.onAny((event) => {
      if (event.direction !== 'send') return;
      if (event.messageName !== 'ObjControllerMessage') return;
      const decoded = (event as { decoded?: unknown }).decoded;
      if (!(decoded instanceof ObjControllerMessage)) return;
      if (decoded.message !== CM_COMMAND_QUEUE_ENQUEUE) return;
      try {
        const iter = new ReadIterator(decoded.data);
        const enqueue = CommandQueueEnqueue.unpack(iter);
        if (!state.hashToName.has(enqueue.commandHash)) {
          state.hashToName.set(
            enqueue.commandHash,
            `<hash:0x${enqueue.commandHash.toString(16)}>`,
          );
        }
      } catch {
        // ignore
      }
    }),
  );

  // ── View ──────────────────────────────────────────────────────────
  function msUntil(commandName: string): number {
    const hash = hashCommand(commandName);
    const expiresAt = state.expiresAt.get(hash);
    if (expiresAt === undefined) return 0;
    const remaining = expiresAt - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  function isReady(commandName: string): boolean {
    return msUntil(commandName) === 0;
  }

  function entryFor(hash: number): CooldownEntry {
    const expiresAt = state.expiresAt.get(hash);
    const ms = expiresAt === undefined ? 0 : Math.max(0, expiresAt - Date.now());
    return {
      msUntilReady: ms,
      isReady(): boolean {
        return ms === 0;
      },
    };
  }

  function all(): Map<string, CooldownEntry> {
    const out = new Map<string, CooldownEntry>();
    for (const [hash] of state.expiresAt) {
      const name = state.hashToName.get(hash) ?? `<hash:0x${hash.toString(16)}>`;
      out.set(name, entryFor(hash));
    }
    return out;
  }

  function rawExpiries(): ReadonlyMap<number, number> {
    return state.expiresAt;
  }

  const view: CooldownView = { msUntil, isReady, all, rawExpiries };

  return {
    view,
    registerCommandName,
    detach(): void {
      for (const u of unsubscribers) {
        try {
          u();
        } catch {
          // swallow
        }
      }
      unsubscribers.length = 0;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Server-time tracker — `ctx.serverTime`.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Live read of the server's current wall-clock estimate.
 *
 * Sources:
 *   1. The seed — `CmdStartScene.serverEpoch` (Unix epoch seconds; the i32
 *      tail of the message — NOT `serverTimeSeconds`, which is the server's
 *      GameTime / uptime). Captured at zone-in construction. Gives us the
 *      absolute floor of `serverWallSeconds at CmdStartScene arrival`.
 *      Combined with our local `Date.now()` snapshot at that moment, we
 *      have a coarse `wallClockOffsetMs` good to within RTT plus
 *      seed-arrival latency.
 *   2. Refinement — every ClockReflect sample carries the server's
 *      `serverSyncStampLong` (low 32 bits of its local `Clock()` in ms).
 *      Per-sample we compute `serverWallEstimate(at recv) ≈ seedServerWall
 *      + (clientRecvWall - rttMs/2 - seedClientWall)` and EMA that into a
 *      smoothed offset against `Date.now()`. As more samples accumulate
 *      the offset stabilizes; with no samples we fall back to pure seed
 *      projection.
 *
 * Returns server-clock estimates without ever blocking or sending wire
 * traffic — purely derived from data the connection has already received.
 */
export interface ServerTimeView {
  /** Best estimate of the current server wall-clock in ms (Unix epoch). */
  ms(): number;
  /** Best estimate of the current server wall-clock in whole seconds (Unix epoch). */
  seconds(): bigint;
  /** Number of ClockReflect samples folded into the offset estimate. */
  readonly samples: number;
  /** True once at least the seed has been set. */
  readonly hasSeed: boolean;
}

/** Internal handle — used by orchestrator to detach. */
export interface ServerTimeTrackerHandle {
  view: ServerTimeView;
  /**
   * Set the seed — the absolute server wall-clock in seconds at the moment
   * `CmdStartScene` arrived. The orchestrator passes
   * `CmdStartScene.serverEpoch` (Unix epoch, i32 field) — NOT
   * `serverTimeSeconds` (which is server uptime). Called once at script
   * context construction. After this `ms()` returns sensible values even
   * if no ClockReflect has arrived yet.
   */
  setSeed(seedServerSeconds: bigint, clientWallMsAtSeed?: number): void;
  /** Tear down dispatcher subscriptions. Idempotent. */
  detach(): void;
}

interface ServerTimeState {
  /** Server wall-clock in ms at the seed moment (CmdStartScene). */
  seedServerWallMs: number | null;
  /** Our local Date.now() at the seed moment. */
  seedClientWallMs: number | null;
  /**
   * Smoothed offset = (serverWallMs - clientWallMs) at the sample moment.
   * Updated on every ClockReflect sample using an EMA so spikes from a
   * single bad RTT don't whiplash the offset.
   *
   * `null` when no samples have arrived; `ms()` falls back to seed math.
   */
  smoothedOffsetMs: number | null;
  samples: number;
  /** Detach handle for the SoeConnection clock-reflect listener. */
  reflectListenerUnsubscribe: (() => void) | null;
}

export interface CreateServerTimeTrackerOptions {
  dispatcher: MessageDispatcher;
  /** EMA alpha for offset smoothing. Default 0.2 (responsive but not jittery). */
  smoothingAlpha?: number;
}

export function createServerTimeTracker(
  opts: CreateServerTimeTrackerOptions,
): ServerTimeTrackerHandle {
  const alpha = opts.smoothingAlpha ?? 0.2;
  const state: ServerTimeState = {
    seedServerWallMs: null,
    seedClientWallMs: null,
    smoothedOffsetMs: null,
    samples: 0,
    reflectListenerUnsubscribe: null,
  };

  function applySample(sample: ClockReflectSample): void {
    if (state.seedServerWallMs === null || state.seedClientWallMs === null) {
      // No seed yet — record samples count but don't compute offset.
      state.samples++;
      return;
    }
    const oneWayMs = sample.rttMs / 2;
    // Estimate the server's wall-clock at the moment of reflect arrival:
    //   sampleServerWallMs ≈ seedServerWallMs
    //                      + (clientRecvWallMs - oneWayMs - seedClientWallMs)
    // From which a per-sample offset against our local clock:
    //   offset = sampleServerWallMs - sample.clientRecvWallMs
    const sampleServerWallMs =
      state.seedServerWallMs + (sample.clientRecvWallMs - oneWayMs - state.seedClientWallMs);
    const sampleOffset = sampleServerWallMs - sample.clientRecvWallMs;
    if (state.smoothedOffsetMs === null) {
      state.smoothedOffsetMs = sampleOffset;
    } else {
      state.smoothedOffsetMs = state.smoothedOffsetMs * (1 - alpha) + sampleOffset * alpha;
    }
    state.samples++;
  }

  state.reflectListenerUnsubscribe =
    opts.dispatcher.connection.addClockReflectListener(applySample);

  function currentServerMs(): number {
    // Preferred: smoothed offset (folds in ClockReflect samples).
    if (state.smoothedOffsetMs !== null) {
      return Date.now() + state.smoothedOffsetMs;
    }
    // Fallback: pure seed projection.
    if (state.seedServerWallMs !== null && state.seedClientWallMs !== null) {
      return state.seedServerWallMs + (Date.now() - state.seedClientWallMs);
    }
    // No seed — surface as 0 to signal "no data". Consumers can check
    // `hasSeed` first.
    return 0;
  }

  const view: ServerTimeView = {
    ms(): number {
      return currentServerMs();
    },
    seconds(): bigint {
      const ms = currentServerMs();
      return BigInt(Math.floor(ms / 1000));
    },
    get samples(): number {
      return state.samples;
    },
    get hasSeed(): boolean {
      return state.seedServerWallMs !== null;
    },
  };

  return {
    view,
    setSeed(seedServerSeconds: bigint, clientWallMsAtSeed?: number): void {
      const sec = Number(seedServerSeconds);
      // Guard against absurd seeds — `CmdStartScene.serverTimeSeconds`
      // should be a Unix epoch in seconds. Reject negative / zero / NaN
      // to keep ms() from returning garbage.
      if (!Number.isFinite(sec) || sec <= 0) return;
      state.seedServerWallMs = sec * 1000;
      state.seedClientWallMs = clientWallMsAtSeed ?? Date.now();
    },
    detach(): void {
      if (state.reflectListenerUnsubscribe !== null) {
        try {
          state.reflectListenerUnsubscribe();
        } catch {
          // swallow
        }
        state.reflectListenerUnsubscribe = null;
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Combat timer — `ctx.combat`.
// ──────────────────────────────────────────────────────────────────────────

/**
 * The combat-engagement view exposed as `ctx.combat`.
 *
 * `timeSinceLastHitMs` is the number of ms between right-now and the most
 * recent `CM_combatAction` (204) ObjControllerMessage in which the player
 * was listed as a defender. Returns `Number.POSITIVE_INFINITY` when the
 * player has never been hit during this script's lifetime.
 *
 * `engaged` is a stateless derived view — true if `timeSinceLastHitMs <
 * engagementWindowMs` (default 10_000ms), false otherwise.
 *
 * Note: a "hit" here means "the server told us we were targeted in a
 * combat-action delivery" — including pure misses (defense != 0) and
 * zero-damage outcomes. The lastHit().damageAmount reports the actual
 * damage so callers can filter by `info.damageAmount > 0` if they only
 * care about actual damage events.
 */
export interface CombatTimerView {
  /** ms since the last hit, or `Number.POSITIVE_INFINITY` if never. */
  readonly timeSinceLastHitMs: number;
  /** True when within `engagementWindowMs` of the last hit. */
  readonly engaged: boolean;
  /** Snapshot last hit info — `null` if never hit. */
  lastHit(): CombatHitInfo | null;
}

/** Snapshot of the most recent hit on the player. */
export interface CombatHitInfo {
  /** Date.now()-frame ms when the hit was observed. */
  receivedAtMs: number;
  /** Network id of the attacker. */
  attackerId: NetworkId;
  /** Total damage on this hit (sum across all defender entries pointing at us). */
  damageAmount: number;
  /** Defense outcome from the matching defender entry (CombatDefense enum). */
  defense: number;
}

/** Internal handle for orchestrator detach. */
export interface CombatTimerHandle {
  view: CombatTimerView;
  detach(): void;
  /** Test hook — directly set the last-hit info without simulating wire bytes. */
  testSetLastHit(info: CombatHitInfo | null): void;
}

export interface CreateCombatTimerOptions {
  dispatcher: MessageDispatcher;
  playerNetworkId: NetworkId;
  /** Window in ms after the last hit during which `engaged === true`. Default 10_000. */
  engagementWindowMs?: number;
}

export function createCombatTimer(opts: CreateCombatTimerOptions): CombatTimerHandle {
  const engagementWindowMs = opts.engagementWindowMs ?? 10_000;
  let lastHit: CombatHitInfo | null = null;

  const unsubscribers: Array<() => void> = [];

  unsubscribers.push(
    opts.dispatcher.onMessage(ObjControllerMessage, (m) => {
      if (m.message !== ObjControllerSubtypeIds.CM_combatAction) return;
      if (m.decodedSubtype?.kind !== CombatActionKind) return;
      const data = m.decodedSubtype.data as CombatActionData;
      // Find every defender entry that points at us.
      let damageTotal = 0;
      let defense = 0;
      let matched = false;
      for (const d of data.defenders) {
        if (d.id !== opts.playerNetworkId) continue;
        matched = true;
        damageTotal += d.damageAmount;
        // Keep the highest non-zero defense value — a CombatAction with
        // mixed outcomes against us is uncommon (the wire only allows
        // a single defense byte per defender entry, but ranged attacks
        // can fire two separate entries for two hit-locations on the
        // same target).
        if (d.defense !== 0 && d.defense > defense) defense = d.defense;
      }
      if (!matched) return;
      lastHit = {
        receivedAtMs: Date.now(),
        attackerId: data.attacker.id,
        damageAmount: damageTotal,
        defense,
      };
    }),
  );

  const view: CombatTimerView = {
    get timeSinceLastHitMs(): number {
      if (lastHit === null) return Number.POSITIVE_INFINITY;
      return Date.now() - lastHit.receivedAtMs;
    },
    get engaged(): boolean {
      if (lastHit === null) return false;
      return Date.now() - lastHit.receivedAtMs < engagementWindowMs;
    },
    lastHit(): CombatHitInfo | null {
      return lastHit === null ? null : { ...lastHit };
    },
  };

  return {
    view,
    detach(): void {
      for (const u of unsubscribers) {
        try {
          u();
        } catch {
          // swallow
        }
      }
      unsubscribers.length = 0;
    },
    testSetLastHit(info: CombatHitInfo | null): void {
      lastHit = info === null ? null : { ...info };
    },
  };
}
