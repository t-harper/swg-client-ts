#!/usr/bin/env node --import tsx
/**
 * mirror-bot.ts — shadow another player's position in real time.
 *
 * Subscribes to the WorldModel's `'transform'` event stream and, whenever the
 * target moves, walks to a point `--follow-offset` metres short of their
 * current position (so we trail behind rather than overlapping). A
 * `--min-delta` threshold suppresses micro-jitter from the wire's 0.25m
 * quantization, and a single in-flight `walkTo` is enforced via an
 * `isWalking` flag — if a new transform lands while we're still walking, the
 * latest position is stashed and consumed on the next loop iteration.
 *
 * Target selection:
 *   - `--target-id=` (decimal or 0x-prefixed hex) picks an explicit player.
 *   - Otherwise we auto-pick the nearest PLAY via `ctx.playersInRange(50)[0]`
 *     once baselines settle (we briefly wait + retry if nobody is in range yet).
 *
 * Re-acquisition:
 *   - On `'destroy'` for the current target, we clear `targetId` and the
 *     driver loop falls back to `--auto-pick=true` (the default) for the next
 *     nearest player. Set `--auto-pick=false` to instead exit on target loss.
 *
 * Example:
 *   # follow the nearest player, 3m behind, until they log out
 *   pnpm exec tsx scripts/examples/mirror-bot.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --follow-offset=3 --min-delta=0.5 --speed=6 --minutes=10
 *
 *   # follow a specific player by NetworkId
 *   pnpm exec tsx scripts/examples/mirror-bot.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --target-id=0xdeadbeef --minutes=30
 */

import type { NetworkId, ScenarioFn, WorldEvent, WorldObject } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/mirror-bot.ts';

interface ScriptArgs {
  targetId: NetworkId | null;
  followOffsetM: number;
  minDeltaM: number;
  speed: number;
  /** When the current target vanishes, auto-pick a new nearest player. */
  autoPick: boolean;
  /** Initial auto-pick search radius if --target-id is omitted. */
  pickRadiusM: number;
  /** How often to log the target's current position (ms). */
  positionLogIntervalMs: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const rawTarget = extra.get('target-id');
  let targetId: NetworkId | null = null;
  if (rawTarget !== undefined && rawTarget.length > 0) {
    targetId = BigInt(rawTarget) as NetworkId;
  }
  const autoPickRaw = extra.get('auto-pick');
  const autoPick = autoPickRaw === undefined ? true : autoPickRaw !== 'false';
  return {
    targetId,
    followOffsetM: Number.parseFloat(extra.get('follow-offset') ?? '3'),
    minDeltaM: Number.parseFloat(extra.get('min-delta') ?? '0.5'),
    speed: Number.parseFloat(extra.get('speed') ?? '6'),
    autoPick,
    pickRadiusM: Number.parseFloat(extra.get('pick-radius') ?? '50'),
    positionLogIntervalMs: Number.parseInt(extra.get('position-log-ms') ?? '5000', 10),
  };
}

interface MirrorStats {
  targetIds: string[];
  transformsObserved: number;
  walksIssued: number;
  walksSkippedMinDelta: number;
  walksCoalesced: number;
  reAcquisitions: number;
  finalTargetId: string | null;
}

/**
 * Compute a "follow point" `offsetM` metres along the line from `target` back
 * toward `self`. If self and target are co-located the offset direction is
 * undefined; we just stay put (return null and let the caller no-op).
 */
function computeFollowPoint(
  self: { x: number; z: number },
  target: { x: number; z: number },
  offsetM: number,
): { x: number; z: number } | null {
  const dx = self.x - target.x;
  const dz = self.z - target.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) return null;
  const k = Math.min(offsetM, d) / d;
  return { x: target.x + dx * k, z: target.z + dz * k };
}

function buildScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  stats: MirrorStats,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('mirror', verbose);
    const selfId = ctx.sceneStart.playerNetworkId;
    const deadline = Date.now() + totalMs;

    /** Currently-followed player. `null` between targets (paused). */
    let targetId: NetworkId | null = args.targetId;
    /** Most recent target position observed but not yet walked-to. */
    let pendingTarget: { x: number; z: number } | null = null;
    /** Last position we actually issued a walk for (basis of min-delta gate). */
    let lastWalkAimedAt: { x: number; z: number } | null = null;
    /** True while a `walkTo` promise is in flight; new transforms only stash. */
    let isWalking = false;
    /** Resolves whenever a new pendingTarget arrives — the driver awaits it
     *  when there's nothing to do, so it doesn't busy-spin. */
    let wake: () => void = () => {};
    let wakeP: Promise<void> = new Promise<void>((r) => {
      wake = r;
    });
    const wakeNow = (): void => {
      const oldWake = wake;
      wakeP = new Promise<void>((r) => {
        wake = r;
      });
      oldWake();
    };

    const acquireTarget = (): NetworkId | null => {
      const nearby = ctx.playersInRange(args.pickRadiusM);
      const pick = nearby.find((p) => p.id !== selfId);
      return pick === undefined ? null : pick.id;
    };

    // If no explicit --target-id, try to auto-pick now. If still nothing,
    // the driver loop below will keep retrying every second.
    if (targetId === null) {
      const auto = acquireTarget();
      if (auto !== null) {
        targetId = auto;
        log(`auto-picked target ${auto.toString()} (nearest PLAY in ${args.pickRadiusM}m)`);
      } else {
        log(`no PLAY in ${args.pickRadiusM}m yet; will keep trying`);
      }
    } else {
      log(`following explicit target ${targetId.toString()}`);
    }
    if (targetId !== null) stats.targetIds.push(targetId.toString());

    // Seed pendingTarget from whatever position is currently known for the
    // target — so we walk immediately on startup even before they move.
    const seedFrom = (id: NetworkId): void => {
      const obj = ctx.world.get(id);
      if (obj === undefined) return;
      pendingTarget = { x: obj.position.x, z: obj.position.z };
      wakeNow();
    };
    if (targetId !== null) seedFrom(targetId);

    const unsubWorld = ctx.world.on((e: WorldEvent) => {
      if (targetId === null) return;
      if (e.kind === 'transform' && e.object.id === targetId) {
        stats.transformsObserved++;
        pendingTarget = { x: e.object.position.x, z: e.object.position.z };
        // If we're already walking, this stash will be picked up when the
        // current walk resolves and the driver checks pendingTarget again.
        if (isWalking) stats.walksCoalesced++;
        wakeNow();
      } else if (e.kind === 'destroy' && e.objectId === targetId) {
        const lost = targetId;
        targetId = null;
        pendingTarget = null;
        log(`target ${lost.toString()} destroyed (left world or logged out)`);
        // Wake the driver so it can either re-acquire or exit.
        wakeNow();
      }
    });

    // Periodic position log — every 5s by default. Runs as a background
    // promise; cancelled via the global ctx.signal at script end.
    const positionLogger = (async (): Promise<void> => {
      while (Date.now() < deadline && !ctx.signal.aborted) {
        await ctx.wait(args.positionLogIntervalMs);
        if (Date.now() >= deadline) break;
        if (targetId === null) {
          log('target: <none> (searching)');
          continue;
        }
        const obj: WorldObject | undefined = ctx.world.get(targetId);
        if (obj === undefined) {
          log(`target ${targetId.toString()}: <not in world>`);
          continue;
        }
        const me = ctx.position();
        const dx = obj.position.x - me.x;
        const dz = obj.position.z - me.z;
        log(
          `target ${targetId.toString()} at (${obj.position.x.toFixed(1)}, ${obj.position.z.toFixed(1)}) — ${Math.hypot(dx, dz).toFixed(1)}m away`,
        );
      }
    })().catch((err) => {
      // ctx.wait throws AbortError on signal; swallow that, surface others.
      if (err instanceof Error && err.message === 'aborted') return;
      log(`position logger crashed: ${err instanceof Error ? err.message : String(err)}`);
    });

    try {
      // ─── Driver loop ──────────────────────────────────────────────────
      while (Date.now() < deadline && !ctx.signal.aborted) {
        // (a) No target? Try to re-acquire (if enabled), or wait briefly.
        if (targetId === null) {
          if (!args.autoPick) {
            log('target lost and --auto-pick=false; exiting follow loop');
            break;
          }
          const next = acquireTarget();
          if (next !== null) {
            targetId = next;
            stats.targetIds.push(next.toString());
            stats.reAcquisitions++;
            log(`re-acquired target ${next.toString()}`);
            seedFrom(next);
            continue;
          }
          // Nothing in range; nap 1s then retry. Bail early if aborted.
          await ctx.wait(Math.min(1000, Math.max(0, deadline - Date.now())));
          continue;
        }

        // (b) Have a target but no fresh position yet? Sleep on the wake
        //     condvar (or until the deadline) so we don't spin.
        if (pendingTarget === null) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await Promise.race([wakeP, ctx.wait(Math.min(remaining, 5000))]);
          continue;
        }

        // (c) Snapshot + clear pendingTarget BEFORE walking — any transform
        //     that arrives during the walk will set it again and be handled
        //     on the next iteration.
        const aim = pendingTarget;
        pendingTarget = null;

        const me = ctx.position();
        const followPoint = computeFollowPoint(me, aim, args.followOffsetM);
        if (followPoint === null) {
          // We're stacked on the target; nothing meaningful to do this tick.
          continue;
        }

        // (d) Min-delta gate: skip the walk if our intended destination
        //     hasn't moved meaningfully since the last issued walk.
        if (lastWalkAimedAt !== null) {
          const ddx = followPoint.x - lastWalkAimedAt.x;
          const ddz = followPoint.z - lastWalkAimedAt.z;
          if (Math.hypot(ddx, ddz) < args.minDeltaM) {
            stats.walksSkippedMinDelta++;
            continue;
          }
        }

        lastWalkAimedAt = followPoint;
        stats.walksIssued++;
        isWalking = true;
        try {
          await ctx.walkTo(followPoint, { speed: args.speed });
        } catch (err) {
          // walkTo throws 'aborted' on signal — break out cleanly.
          if (err instanceof Error && err.message === 'aborted') break;
          log(`walkTo failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          isWalking = false;
        }
      }
    } finally {
      unsubWorld();
      await positionLogger.catch(() => {});
    }

    stats.finalTargetId = targetId === null ? null : targetId.toString();
    log(
      `mirror done: ${stats.walksIssued} walks, ${stats.transformsObserved} transforms observed, ${stats.walksCoalesced} coalesced, ${stats.walksSkippedMinDelta} skipped (min-delta), ${stats.reAcquisitions} re-acquisitions`,
    );
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Mirror another player: follow their position in real time.', [
      '  --target-id=ID           NetworkId of player to follow (decimal or 0x-hex)',
      '  --follow-offset=N        metres behind the target (default 3)',
      '  --min-delta=N            metres of target movement to trigger a re-walk (default 0.5)',
      '  --speed=N                walk speed in m/s (default 6)',
      '  --auto-pick=true|false   on target loss, pick a new nearest player (default true)',
      '  --pick-radius=N          metres for auto-pick search (default 50)',
      '  --position-log-ms=N      ms between target-position log lines (default 5000)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const stats: MirrorStats = {
    targetIds: [],
    transformsObserved: 0,
    walksIssued: 0,
    walksSkippedMinDelta: 0,
    walksCoalesced: 0,
    reAcquisitions: 0,
    finalTargetId: null,
  };
  const scenario = buildScenario(script, totalMs, args.verbose, stats);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    targetIdArg: script.targetId === null ? null : script.targetId.toString(),
    followOffsetM: script.followOffsetM,
    minDeltaM: script.minDeltaM,
    speed: script.speed,
    autoPick: script.autoPick,
    pickRadiusM: script.pickRadiusM,
    transformsObserved: stats.transformsObserved,
    walksIssued: stats.walksIssued,
    walksSkippedMinDelta: stats.walksSkippedMinDelta,
    walksCoalesced: stats.walksCoalesced,
    reAcquisitions: stats.reAcquisitions,
    targetIds: stats.targetIds,
    finalTargetId: stats.finalTargetId,
  };
  process.stdout.write(formatJson(summary, args.pretty));
  return summary.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
