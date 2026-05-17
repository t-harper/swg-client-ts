#!/usr/bin/env node --import tsx
/**
 * loot-on-death.ts — react to creature destruction events, walk to the
 * corpse, and try to open its container.
 *
 * Demonstrates the reactive WorldModel pattern: subscribe to `'destroy'`
 * events via `ctx.world.on(handler)` and react when CREO-type objects
 * disappear (deaths or view-range departures). A queue smooths the
 * stream of corpses into a single sequential walk-and-loot loop.
 *
 * Trigger conditions:
 *   - `e.kind === 'destroy'`
 *   - `e.lastKnown.typeId === ObjectTypeTags.CREO`
 *   - `e.hyperspace === false` (skip "left view distance" type departures
 *     that the server flags as hyperspace; we still see view-range
 *     leavers but they look like real destroys, which is fine — they're
 *     filtered by the max-distance check below)
 *   - distance from current player pose <= `--max-distance` (default 50m)
 *   - optionally `--combat-only`: only react to CREOs whose SHARED_NP
 *     baseline had `inCombat === true` at last sighting (filters out
 *     wanderers that just left the view-range)
 *
 * The corpse may already be gone from the WorldModel (destroy fires after
 * the entry is removed), so we use `lastKnown.position` for navigation
 * and only call `openContainer(id)` when the id is still tracked in the
 * world; otherwise we just count it as a "skipped (vanished)".
 *
 * Example:
 *   pnpm exec tsx scripts/examples/loot-on-death.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --max-distance=50 --dwell-ms=2000 --combat-only --minutes=15
 */

import {
  BaselinePackageIds,
  ObjectTypeTags,
  type ScenarioFn,
  type TangibleObjectSharedNpBaseline,
  type WorldEvent,
  type WorldObject,
} from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/loot-on-death.ts';

interface ScriptArgs {
  maxDistanceM: number;
  dwellMs: number;
  combatOnly: boolean;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const combatOnlyRaw = extra.get('combat-only');
  return {
    maxDistanceM: Number.parseFloat(extra.get('max-distance') ?? '50'),
    dwellMs: Number.parseInt(extra.get('dwell-ms') ?? '2000', 10),
    combatOnly: combatOnlyRaw === 'true' || combatOnlyRaw === '',
  };
}

interface CorpseEntry {
  /** The corpse's NetworkId (also the container we'll try to open). */
  id: bigint;
  /** World position at last sighting — what we walk to. */
  x: number;
  z: number;
  /** Was the creature in combat at last sighting? Only set when known. */
  wasInCombat: boolean;
  /** Wall-clock ms when we enqueued it. */
  queuedAt: number;
}

interface LootStats {
  destroysObserved: number;
  creosObserved: number;
  enqueued: number;
  skippedOutOfRange: number;
  skippedNotInCombat: number;
  skippedHyperspace: number;
  skippedDuplicate: number;
  walked: number;
  walkFailed: number;
  openedContainer: number;
  vanishedBeforeOpen: number;
}

function buildScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  stats: LootStats,
  history: Array<{ id: string; x: number; z: number; dist: number; opened: boolean }>,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('loot', verbose);
    log(
      `loot-on-death starting: max-distance=${args.maxDistanceM}m dwell=${args.dwellMs}ms combat-only=${args.combatOnly}`,
    );

    // Acknowledge any pending zone-in teleport lockouts up front so the
    // first walkTo doesn't get silently rejected. walkTo() also does this
    // on first invocation, but doing it explicitly here means the world
    // listener's reactivity isn't gated on the first corpse.
    await ctx.ackPendingTeleports();

    // FIFO queue of corpses to visit. Pushed by the world-event handler,
    // popped by the main loop.
    const queue: CorpseEntry[] = [];
    /** NetworkIds we've already enqueued — prevent double-add if a destroy
     * fires twice (shouldn't, but be defensive). */
    const seen = new Set<bigint>();
    const selfId = ctx.sceneStart.playerNetworkId;

    const handler = (e: WorldEvent): void => {
      if (e.kind !== 'destroy') return;
      stats.destroysObserved++;

      const lastKnown = e.lastKnown;
      // Filter: only CREOs (creatures). Skips items, terminals, ships, etc.
      if (lastKnown.typeId !== ObjectTypeTags.CREO) return;
      stats.creosObserved++;

      // Filter: skip the player themselves on the off-chance the server
      // sends us a destroy for our own creature on logout.
      if (e.objectId === selfId) return;

      // Filter: hyperspace = "left view via shuttle/etc"; not a death.
      if (e.hyperspace) {
        stats.skippedHyperspace++;
        return;
      }

      // Filter: deduplicate (server may resend; our queue handles each id once).
      if (seen.has(e.objectId)) {
        stats.skippedDuplicate++;
        return;
      }

      // Filter: distance — skip corpses too far to reach in a sensible time.
      const me = ctx.position();
      const dx = lastKnown.position.x - me.x;
      const dz = lastKnown.position.z - me.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > args.maxDistanceM) {
        stats.skippedOutOfRange++;
        log(`skip 0x${e.objectId.toString(16)} (${d.toFixed(1)}m > ${args.maxDistanceM}m)`);
        return;
      }

      // Filter (optional): only react to CREOs that were in combat at
      // last sighting. The SHARED_NP baseline carries `inCombat`; if no
      // such baseline arrived (very fresh spawn), we treat as not-in-combat.
      const sharedNp = lastKnown.baselines.get(BaselinePackageIds.SHARED_NP) as
        | TangibleObjectSharedNpBaseline
        | undefined;
      const wasInCombat = sharedNp?.inCombat === true;
      if (args.combatOnly && !wasInCombat) {
        stats.skippedNotInCombat++;
        return;
      }

      seen.add(e.objectId);
      queue.push({
        id: e.objectId,
        x: lastKnown.position.x,
        z: lastKnown.position.z,
        wasInCombat,
        queuedAt: Date.now(),
      });
      stats.enqueued++;
      log(
        `queued 0x${e.objectId.toString(16)} at (${lastKnown.position.x.toFixed(1)},${lastKnown.position.z.toFixed(1)}) ~${d.toFixed(1)}m combat=${wasInCombat}`,
      );
    };

    const unsub = ctx.world.on(handler);

    // Main loop: drain the queue. If empty, sleep briefly and re-check.
    // The world handler runs synchronously on inbound messages, so by the
    // time we wake up the queue may have entries.
    const deadline = Date.now() + totalMs;
    const POLL_MS = 250;
    try {
      while (Date.now() < deadline) {
        const next = queue.shift();
        if (next === undefined) {
          // No corpse waiting — short nap, then re-check.
          await ctx.wait(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
          continue;
        }

        // Walk to the corpse's last-known position. walkTo handles
        // teleport-ack and clamps to mounted speed if applicable.
        log(`walking to 0x${next.id.toString(16)} at (${next.x.toFixed(1)},${next.z.toFixed(1)})`);
        let walkOk = false;
        try {
          await ctx.walkTo({ x: next.x, z: next.z });
          walkOk = true;
          stats.walked++;
        } catch (err) {
          stats.walkFailed++;
          log(`walk failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Try to open the container — only if the corpse is still tracked
        // in the world. Deleted corpses can't be opened (the server would
        // just drop the ClientOpenContainerMessage anyway). Note that the
        // WorldModel removes the entry on `destroy` BEFORE emitting the
        // event, so `still` here is checking whether some other path
        // re-created the id (rare); typically it's undefined and we count
        // as "vanished".
        const still: WorldObject | undefined = ctx.world.get(next.id);
        let opened = false;
        if (still !== undefined && walkOk) {
          ctx.openContainer(next.id);
          stats.openedContainer++;
          opened = true;
          log(`opened container 0x${next.id.toString(16)}`);
        } else if (still === undefined) {
          stats.vanishedBeforeOpen++;
          log(`0x${next.id.toString(16)} vanished before we got here`);
        }

        history.push({
          id: `0x${next.id.toString(16)}`,
          x: next.x,
          z: next.z,
          dist: Math.hypot(next.x - ctx.position().x, next.z - ctx.position().z),
          opened,
        });

        // Dwell — simulate "looting" before moving to the next corpse.
        await ctx.wait(Math.min(args.dwellMs, Math.max(0, deadline - Date.now())));
      }
    } finally {
      unsub();
    }

    log(
      `loot loop done: ${stats.walked} walked, ${stats.openedContainer} opened, ${stats.vanishedBeforeOpen} vanished`,
    );
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'React to creature destruction events: walk to the corpse, open its container.', [
      '  --max-distance=M         metres — skip corpses farther than this (default 50)',
      '  --dwell-ms=N             ms to "loot" before moving to the next corpse (default 2000)',
      '  --combat-only            only react to CREOs that were inCombat at last sighting',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const stats: LootStats = {
    destroysObserved: 0,
    creosObserved: 0,
    enqueued: 0,
    skippedOutOfRange: 0,
    skippedNotInCombat: 0,
    skippedHyperspace: 0,
    skippedDuplicate: 0,
    walked: 0,
    walkFailed: 0,
    openedContainer: 0,
    vanishedBeforeOpen: 0,
  };
  const history: Array<{ id: string; x: number; z: number; dist: number; opened: boolean }> = [];
  const scenario = buildScenario(script, totalMs, args.verbose, stats, history);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    maxDistanceM: script.maxDistanceM,
    dwellMs: script.dwellMs,
    combatOnly: script.combatOnly,
    stats,
    historyHead: history.slice(0, 10),
    historyTotal: history.length,
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
