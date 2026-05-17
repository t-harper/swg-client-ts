import type { CreatureObjectSharedNpBaseline } from '../messages/game/baselines/creature-object-baseline-6.js';
/**
 * Combat / safety helpers exposed on `ScriptContext` as `ctx.combat` and
 * `ctx.safety`. These eliminate boilerplate from every grinding / PvE script:
 *
 *  - `ctx.combat.targets()` — every CREO that currently has US as their
 *    lookAtTarget (i.e. is actively targeting us). Sorted by 2D distance.
 *  - `ctx.combat.engaged` — true if `targets().length > 0` OR we got hit in
 *    the last 10 seconds (heuristic for "we're in a fight right now").
 *  - `ctx.combat.autoLoot` — when set true, the engine watches for creature
 *    deaths (chat system message + scene-destroy on a creature we damaged)
 *    and auto-sends the `loot` command targeting the corpse.
 *  - `ctx.combat.attackingNearest()` — one-liner that resolves a target via
 *    `nearestHostile()` then waits for the target to die (or soft-timeout).
 *  - `ctx.safety.fleeWhenHealthBelow(ratio, opts?)` — register a watcher on
 *    `ctx.character.health`. When the ratio drops, optionally break combat
 *    (peace), then call any datapad vehicle and walk to safe coords.
 *
 * Lifetime: created inside `createScriptContext` and detached during
 * `runScript` teardown. The state lives on the script-context state bag so
 * it cleans up with everything else.
 */
import { BaselinePackageIds, ObjectTypeTags } from '../messages/game/baselines/registry.js';
import { ChatSystemMessage } from '../messages/game/chat/index.js';
import type { NetworkId } from '../types.js';
import type { CharacterSheet } from './character-sheet.js';
import type { MessageDispatcher } from './dispatcher.js';
import type { WorldEvent, WorldModel, WorldObject } from './world-model.js';

/** A single hostile entry on `ctx.combat.targets()`. */
export interface CombatTargetEntry {
  /** Target's NetworkId. */
  id: NetworkId;
  /** 2D distance (x/z) from the player at the time of the call. */
  distance: number;
  /**
   * Current health/max pair, when known. Pulled from the CREO p6
   * `totalAttributes[Health=0]` / `totalMaxAttributes[Health=0]` if the
   * baseline + delta stream has populated them; otherwise `null`.
   */
  ham: { health: number; healthMax: number } | null;
}

/** Options for `ctx.combat.attackingNearest()`. */
export interface AttackingNearestOptions {
  /** Search radius for `nearestHostile()`. Default 40m. */
  maxRadiusM?: number;
  /** Ability to enqueue each tick (default 'attack'). */
  ability?: string;
  /** ms between attack ticks (default 1500). */
  tickMs?: number;
  /** Soft cap on how long to keep attacking; default 60s. */
  timeoutMs?: number;
  /**
   * Optional: a predicate run each tick. Return true to stop attacking
   * (e.g. low health, fleeing, etc.). Default: never.
   */
  stopIf?: () => boolean;
}

/** Options for `ctx.safety.fleeWhenHealthBelow()`. */
export interface FleeOptions {
  /**
   * Coordinates to walk to once the flee trigger fires. Default
   * `{x:0, z:0}` (starport-ish). The watcher honors `opts.goTo` if supplied.
   */
  goTo?: { x: number; z: number };
  /**
   * Try to break combat first by sending `useAbility('peace')`. Default true.
   */
  usePeace?: boolean;
  /**
   * Try to call+mount a vehicle from the datapad before walking. When true
   * (default) and the datapad has at least one vehicle PCD, the watcher
   * will call the PCD, wait briefly, then issue `useAbility('mount', ...)`
   * on the vehicle creature most recently created. If no vehicle PCD or no
   * fresh vehicle creature is observed within `vehicleSettleMs`, the
   * watcher just walks on foot.
   */
  useVehicle?: boolean;
  /** ms to wait between callVehicle and mount attempt. Default 1200ms. */
  vehicleSettleMs?: number;
  /**
   * Walking speed to pass to `ctx.walkTo`. Default 12 m/s (clamped by
   * mounted-speed cap when applicable).
   */
  speed?: number;
  /**
   * Per-trigger hook fired right after the watcher decides to flee. Useful
   * for logging in scripts. The hook receives a small object describing the
   * trigger conditions; the watcher does NOT await the hook (fire-and-forget).
   */
  onTrigger?: (info: {
    healthRatio: number;
    health: number;
    healthMax: number;
    usingVehicle: boolean;
  }) => void;
}

/**
 * The `ctx.combat` surface. Read `targets()` for the live list, set
 * `autoLoot = true` to enable post-death looting, and call
 * `attackingNearest()` for the one-line "engage the nearest hostile" sugar.
 */
export interface CombatView {
  /**
   * Every CREO that currently has us as their `lookAtTarget` (from the
   * SHARED_NP baseline). Sorted by ascending 2D distance to the player.
   */
  targets(): CombatTargetEntry[];
  /**
   * Heuristic: true when `targets().length > 0` OR we were hit (i.e.
   * received a SHARED_NP delta that set `inCombat=true` for us, or our
   * own health dropped) within `timeSinceLastHitMs`.
   */
  readonly engaged: boolean;
  /**
   * When true, the engine watches for creature deaths and auto-issues
   * `useAbility('loot', corpseId)` targeting the dead creature. Detection
   * is the union of two signals:
   *
   *   1. `ChatSystemMessage` whose outOfBand carries a known combat-death
   *      STF token (`prose_target_dead` / `killer_target_dead`).
   *   2. `SceneDestroyObject` on a CREO that's in our "damaged set"
   *      (creatures we attacked at any point during the run).
   *
   * Combining the two ensures the loot fires even when one signal is
   * absent: SceneDestroy alone for view-range departures (filtered by
   * damaged-set), or ChatSystemMessage alone before the destroy event
   * lands.
   *
   * Default: false. Setter is idempotent.
   */
  autoLoot: boolean;
  /** Wall-clock ms since the last observed "we got hit" signal. `null` if never hit this run. */
  readonly timeSinceLastHitMs: number | null;
  /**
   * Sugar over `nearestHostile() + attackTarget() + sleep(tickMs)` loop.
   * Resolves cleanly once the target is no longer in `ctx.world` (assumed
   * dead) OR once `timeoutMs` elapses. Records a soft failure when no
   * hostile is in range.
   */
  attackingNearest(opts?: AttackingNearestOptions): Promise<void>;
  /**
   * The set of CREO NetworkIds the script has issued an `attack` (or other
   * combat-like) ability against this run. Populated automatically by the
   * `attackTarget` / `useAbility('attack', ...)` paths. Exposed for tests
   * and advanced consumers.
   */
  damagedSet(): ReadonlySet<bigint>;
}

/**
 * The `ctx.safety` surface — currently just the flee-watcher.
 */
export interface SafetyView {
  /**
   * Register a watcher on `ctx.character.health.current / .max`. When the
   * ratio drops below `ratio`, the watcher:
   *
   *   1. Optionally sends `useAbility('peace')` to break combat.
   *   2. If a vehicle PCD exists in the datapad, calls it (PET_CALL radial)
   *      and waits briefly, then attempts to mount the freshest spawned
   *      creature observed.
   *   3. Walks to `opts.goTo` (default `{x:0, z:0}`).
   *
   * One watcher at a time; calling again replaces the previous registration.
   * Returns an unsubscribe function so scripts can disable.
   *
   * The watcher disarms after firing once — registering again re-arms.
   */
  fleeWhenHealthBelow(ratio: number, opts?: FleeOptions): () => void;
}

/**
 * Internal handle returned by `attachCombatHelpers`. Tracks the listeners
 * the helpers installed on the dispatcher / world so they can be torn down
 * from `runScript`'s `finally` block.
 */
export interface CombatHelpersHandle {
  combat: CombatView;
  safety: SafetyView;
  /** Detach all listeners + cancel any pending flee watcher. Idempotent. */
  detach(): void;
}

/**
 * Minimum surface the helpers need from the `ScriptContext` they live on.
 * Defined as a subset interface so the helper module doesn't pull a
 * circular type dep on `ScriptContext` itself.
 */
export interface CombatHostContext {
  readonly dispatcher: MessageDispatcher;
  readonly world: WorldModel;
  readonly character: CharacterSheet;
  readonly sceneStart: { playerNetworkId: NetworkId };
  readonly signal: AbortSignal;
  position(): Readonly<{ x: number; y: number; z: number }>;
  nearestHostile(opts?: { maxRadiusM?: number }): WorldObject | undefined;
  useAbility(commandName: string, targetId?: NetworkId, params?: string): number;
  walkTo(target: { x: number; z: number; y?: number }, opts?: { speed?: number }): Promise<void>;
  mount(vehicleId: NetworkId, options?: { speedCap?: number }): number;
  callVehicle(datapadItemId: NetworkId): number;
  fail(reason: string): void;
  wait(ms: number): Promise<void>;
  datapad: { vehicles(): Array<{ networkId: NetworkId }> };
}

/** Default "we just got hit" window for `engaged`. */
const ENGAGED_WINDOW_MS = 10_000;

/**
 * STF-token tokens that the server sends as outOfBand on a creature kill.
 *  - `prose_target_dead`     — "You have killed <victim>."
 *  - `killer_target_dead`    — group-broadcast form.
 *
 * Both originate from `pclib.java` (SID_KILLER_TARGET_DEAD / PROSE_TARGET_DEAD).
 * The wire encoding packs UTF-16 codeunits two-at-a-time per JS char; we
 * just substring-match on the raw outOfBand string with both raw and
 * U+0000-separated forms covered.
 */
const KILL_TOKENS = ['prose_target_dead', 'killer_target_dead', 'victim_dead'] as const;

function killTokenMatches(oob: string): boolean {
  if (oob.length === 0) return false;
  // Strip null bytes (the unicode wire packs ASCII into the low byte of
  // each codeunit, leaving the high byte as 0); this gives us a plain-ASCII
  // string to substring-match against.
  let ascii = '';
  for (let i = 0; i < oob.length; i++) {
    const cu = oob.charCodeAt(i);
    const lo = cu & 0xff;
    const hi = (cu >> 8) & 0xff;
    if (lo >= 0x20 && lo < 0x7f) ascii += String.fromCharCode(lo);
    if (hi >= 0x20 && hi < 0x7f) ascii += String.fromCharCode(hi);
  }
  for (const t of KILL_TOKENS) {
    if (ascii.includes(t)) return true;
  }
  return false;
}

/**
 * Construct the combat / safety helper surface and wire its listeners onto
 * the host's dispatcher + world model. Caller (createScriptContext) is
 * responsible for calling `handle.detach()` at teardown.
 */
export function attachCombatHelpers(host: CombatHostContext): CombatHelpersHandle {
  const playerId = host.sceneStart.playerNetworkId;
  const damaged = new Set<bigint>();
  let autoLootEnabled = false;
  let lastHitAt: number | null = null;
  let lastHealth = 0;
  let activeFleeUnsub: (() => void) | null = null;

  // ── lookAtTarget tracking → "who is targeting us" ──────────────────
  function isHostileTargetingUs(o: WorldObject): boolean {
    if (o.typeId !== ObjectTypeTags.CREO) return false;
    if (o.id === playerId) return false;
    const np = o.baselines.get(BaselinePackageIds.SHARED_NP) as
      | CreatureObjectSharedNpBaseline
      | undefined;
    if (np === undefined) return false;
    // The CREO p6 `lookAtTarget` is a NetworkId; an enemy who has us as
    // their lookAtTarget is actively targeting us. We accept that field;
    // some content also flips `intendedTarget` to us before fully turning
    // — match either to broaden the net (intendedTarget is the precursor).
    return np.lookAtTarget === playerId || np.intendedTarget === playerId;
  }

  function listTargets(): CombatTargetEntry[] {
    const here = host.position();
    const out: CombatTargetEntry[] = [];
    for (const o of host.world.byType(ObjectTypeTags.CREO)) {
      if (!isHostileTargetingUs(o)) continue;
      const dx = o.position.x - here.x;
      const dz = o.position.z - here.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      const np = o.baselines.get(BaselinePackageIds.SHARED_NP) as
        | CreatureObjectSharedNpBaseline
        | undefined;
      let ham: CombatTargetEntry['ham'] = null;
      if (np !== undefined) {
        const ta = np.totalAttributes;
        const tm = np.totalMaxAttributes;
        if (Array.isArray(ta) && Array.isArray(tm) && typeof ta[0] === 'number') {
          ham = { health: ta[0] ?? 0, healthMax: tm[0] ?? 0 };
        }
      }
      out.push({ id: o.id, distance, ham });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  // ── "we got hit" detection ─────────────────────────────────────────
  // Trigger on:
  //   - Our health value dropped (compared to previous reading)
  //   - A CREO p6 delta arrived for us with inCombat=true
  // We poll the character sheet's health current; the field updates
  // synchronously inside the dispatcher loop, so by the time we look it
  // already reflects any recent delta. Polling cost is negligible.
  function recordHitIfNeeded(): void {
    const hp = host.character.health.current;
    if (lastHealth > 0 && hp < lastHealth) {
      lastHitAt = Date.now();
    }
    lastHealth = hp;
  }

  // Subscribe to deltas + baselines for the player creature to refresh
  // the health-drop check on every tick. We defer via queueMicrotask so the
  // CharacterSheet's own dispatcher listener (which subscribed before us,
  // but is invoked AFTER the WorldModel's emit) has time to update
  // `state.totalAttributes` from the same wire packet before we sample
  // `host.character.health.current`.
  const playerWatcherUnsub = host.world.on((e: WorldEvent) => {
    if (e.kind === 'delta' || e.kind === 'baseline') {
      if (e.object.id === playerId) {
        queueMicrotask(recordHitIfNeeded);
      }
    }
  });

  // ── auto-loot ──────────────────────────────────────────────────────
  // Loot candidate detection has two signals: a kill-confirm chat system
  // message AND a scene-destroy of a creature in our damaged-set. Either
  // alone is sufficient; we dedupe by id within a short window so a single
  // kill doesn't fire two `loot` commands.
  const lootedRecently = new Set<bigint>();
  const lootedExpiryMs = 30_000;

  function maybeLoot(targetId: NetworkId): void {
    if (!autoLootEnabled) return;
    if (lootedRecently.has(targetId)) return;
    lootedRecently.add(targetId);
    setTimeout(() => lootedRecently.delete(targetId), lootedExpiryMs).unref?.();
    // 'loot' is a server-side command (CommandTable). Targeted at the corpse.
    host.useAbility('loot', targetId);
  }

  const chatUnsub = host.dispatcher.onMessage(ChatSystemMessage, (m) => {
    if (!autoLootEnabled) return;
    if (!killTokenMatches(m.outOfBand)) return;
    // The outOfBand prose carries the victim's name + a prose-package id but
    // not always the victim's NetworkId in a stable form. Use the damaged
    // set as the candidate pool — loot the most-recently-touched id that is
    // still in the world (or has just been destroyed).
    const candidate = pickKillCandidate(host, damaged);
    if (candidate !== null) maybeLoot(candidate);
  });

  const destroyUnsub = host.world.on((e: WorldEvent) => {
    if (e.kind !== 'destroy') return;
    if (!autoLootEnabled) return;
    if (e.hyperspace) return;
    if (e.lastKnown.typeId !== ObjectTypeTags.CREO) return;
    if (!damaged.has(e.objectId)) return;
    maybeLoot(e.objectId);
  });

  // Track every CREO we damage (via attackTarget / useAbility('attack', ...))
  // by inspecting the dispatcher's send transcript. We need this to populate
  // `damaged` even though the helpers don't intercept `useAbility` directly.
  // The cleanest hook is `onAny` on the dispatcher: on each 'send' event
  // whose messageName is ObjControllerMessage, peek at the most-recent
  // sent message (the dispatcher records bytes only, not the typed message —
  // so we instead patch a setter that the script context calls).
  //
  // For the simplest, robust path: we expose a `damagedAdd(id)` helper and
  // ask the script-context's `useAbility` / `attackTarget` to call it when
  // the command name matches the combat verbs. The hook is set up in
  // createScriptContext by wrapping the existing useAbility.

  // ── attackingNearest sugar ─────────────────────────────────────────
  async function attackingNearest(opts: AttackingNearestOptions = {}): Promise<void> {
    const maxRadiusM = opts.maxRadiusM ?? 40;
    const ability = opts.ability ?? 'attack';
    const tickMs = opts.tickMs ?? 1500;
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const hostile = host.nearestHostile({ maxRadiusM });
    if (hostile === undefined) {
      host.fail('attackingNearest: no hostile in range');
      return;
    }
    const targetId = hostile.id;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (opts.stopIf?.() === true) return;
      if (host.signal.aborted) return;
      // If the target's gone from the world, assume dead/despawned — we're done.
      if (!host.world.has(targetId)) return;
      host.useAbility(ability, targetId);
      await host.wait(Math.min(tickMs, Math.max(0, deadline - Date.now())));
    }
  }

  // ── safety: fleeWhenHealthBelow ────────────────────────────────────
  function fleeWhenHealthBelow(ratio: number, fleeOpts: FleeOptions = {}): () => void {
    // Replace any prior watcher.
    if (activeFleeUnsub !== null) {
      activeFleeUnsub();
      activeFleeUnsub = null;
    }
    let fired = false;
    const goTo = fleeOpts.goTo ?? { x: 0, z: 0 };
    const usePeace = fleeOpts.usePeace ?? true;
    const useVehicle = fleeOpts.useVehicle ?? true;
    const vehicleSettleMs = fleeOpts.vehicleSettleMs ?? 1_200;
    const speed = fleeOpts.speed ?? 12;
    const onTrigger = fleeOpts.onTrigger;

    function check(): void {
      if (fired || host.signal.aborted) return;
      const h = host.character.health;
      if (h.max <= 0) return; // Not yet populated.
      const r = h.current / h.max;
      if (r >= ratio) return;
      fired = true;
      const usingVehicle = useVehicle && host.datapad.vehicles().length > 0;
      try {
        onTrigger?.({ healthRatio: r, health: h.current, healthMax: h.max, usingVehicle });
      } catch {
        // swallow user callback errors
      }
      // Fire-and-forget; the async flee runs independently of the watcher
      // and the watcher disarms itself synchronously.
      void runFlee({ goTo, usePeace, useVehicle, vehicleSettleMs, speed });
    }

    async function runFlee(p: {
      goTo: { x: number; z: number };
      usePeace: boolean;
      useVehicle: boolean;
      vehicleSettleMs: number;
      speed: number;
    }): Promise<void> {
      try {
        if (p.usePeace) host.useAbility('peace');
        if (p.useVehicle) {
          const vehicle = host.datapad.vehicles()[0];
          if (vehicle !== undefined) {
            host.callVehicle(vehicle.networkId);
            // Wait for the vehicle creature to spawn. Then identify the
            // most-recently-created CREO that isn't the player and mount it.
            await host.wait(p.vehicleSettleMs);
            const fresh = pickFreshestVehicle(host);
            if (fresh !== null) {
              host.mount(fresh);
              await host.wait(300);
            }
          }
        }
        await host.walkTo(p.goTo, { speed: p.speed });
      } catch {
        // swallow — flee is best-effort
      }
    }

    // Subscribe to world events that imply our health changed. We only need
    // to react when the player's CREO state mutates (baselines/deltas).
    // Defer via queueMicrotask so CharacterSheet's listener (which is also
    // subscribed to the same wire message but runs after WorldModel.emit
    // synchronously) has time to update `state.totalAttributes` before we
    // sample `host.character.health`.
    const u = host.world.on((e) => {
      if (e.kind !== 'delta' && e.kind !== 'baseline') return;
      if (e.object.id !== playerId) return;
      queueMicrotask(check);
    });
    activeFleeUnsub = () => {
      u();
      if (activeFleeUnsub === unsubReturn) activeFleeUnsub = null;
    };
    const unsubReturn = activeFleeUnsub;
    return unsubReturn;
  }

  // ── public surface ─────────────────────────────────────────────────
  const combat: CombatView = {
    targets: listTargets,
    get engaged(): boolean {
      if (listTargets().length > 0) return true;
      if (lastHitAt === null) return false;
      return Date.now() - lastHitAt < ENGAGED_WINDOW_MS;
    },
    get autoLoot(): boolean {
      return autoLootEnabled;
    },
    set autoLoot(v: boolean) {
      autoLootEnabled = v;
    },
    get timeSinceLastHitMs(): number | null {
      if (lastHitAt === null) return null;
      return Date.now() - lastHitAt;
    },
    attackingNearest,
    damagedSet(): ReadonlySet<bigint> {
      return damaged;
    },
  };

  const safety: SafetyView = {
    fleeWhenHealthBelow,
  };

  function detach(): void {
    chatUnsub();
    destroyUnsub();
    playerWatcherUnsub();
    if (activeFleeUnsub !== null) {
      activeFleeUnsub();
      activeFleeUnsub = null;
    }
  }

  // Expose the damaged-set add helper via a side-channel that
  // createScriptContext picks up.
  (combat as unknown as { __damagedAdd: (id: NetworkId) => void }).__damagedAdd = (
    id: NetworkId,
  ) => {
    if (id !== 0n && id !== playerId) damaged.add(id);
  };

  return { combat, safety, detach };
}

/**
 * Pick a sensible kill candidate: walk the damaged set, return the most
 * recently created/touched id that is either still in-world OR has just
 * been removed (we can't tell from the set alone, so return the last one).
 *
 * The damaged set is unordered; we use `world.get` to filter to ids that
 * either exist OR were recently destroyed (we can't easily tell — the
 * destroyUnsub above will handle the strict-destroy path separately).
 * Here we just pick the most-recently-damaged id by relying on insertion
 * order (Set preserves it).
 */
function pickKillCandidate(host: CombatHostContext, damaged: Set<bigint>): NetworkId | null {
  if (damaged.size === 0) return null;
  // Walk in reverse insertion order — the most-recently-damaged id is
  // statistically the most-likely victim.
  const arr = [...damaged];
  for (let i = arr.length - 1; i >= 0; i--) {
    const id = arr[i];
    if (id === undefined) continue;
    // If still in world, prefer it (we haven't seen the destroy event yet,
    // but the kill chat message came in already — fine, target it).
    if (host.world.has(id)) return id;
  }
  // None alive — fall back to most-recently-damaged.
  const tail = arr[arr.length - 1];
  return tail ?? null;
}

/**
 * Pick the freshest non-player CREO in the world. Used by the flee watcher
 * to identify a just-spawned vehicle for the `mount` call.
 */
function pickFreshestVehicle(host: CombatHostContext): NetworkId | null {
  const playerId = host.sceneStart.playerNetworkId;
  let bestId: NetworkId | null = null;
  let bestSeen = Number.NEGATIVE_INFINITY;
  for (const o of host.world.byType(ObjectTypeTags.CREO)) {
    if (o.id === playerId) continue;
    if (o.firstSeenAt > bestSeen) {
      bestSeen = o.firstSeenAt;
      bestId = o.id;
    }
  }
  return bestId;
}
