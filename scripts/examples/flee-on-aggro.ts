#!/usr/bin/env node --import tsx
/**
 * flee-on-aggro.ts — reactive flee: watch for CREO deltas where
 * `intendedTarget` = us, sprint away.
 *
 * Subscribes to the WorldModel's `'delta'` events and watches every
 * `CreatureObjectSharedNpDelta` payload for an `intendedTarget` field that
 * resolves to OUR NetworkId. When that happens we treat the emitting CREO
 * as an aggressor: record their last-known position, drop them into a
 * cooldown set, and sprint `--flee-distance` metres in the direction
 * opposite the centroid of all live aggressor positions.
 *
 * A per-aggressor TTL (`--cooldown-ms`) prevents the same creature from
 * triggering back-to-back flees; once the TTL expires the entry is purged
 * and a fresh `intendedTarget = self` delta from that same id will fire
 * another sprint.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/flee-on-aggro.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --flee-distance=30 --flee-speed=6 --cooldown-ms=8000 --minutes=10
 */

import type { CreatureObjectSharedNpBaseline, ScenarioFn, Vector3 } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/flee-on-aggro.ts';

interface ScriptArgs {
  fleeDistance: number;
  fleeSpeed: number;
  cooldownMs: number;
  /** How often the main loop wakes to consider whether to flee, in ms. */
  pollMs: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    fleeDistance: Number.parseFloat(extra.get('flee-distance') ?? '30'),
    fleeSpeed: Number.parseFloat(extra.get('flee-speed') ?? '6'),
    cooldownMs: Number.parseInt(extra.get('cooldown-ms') ?? '8000', 10),
    pollMs: Number.parseInt(extra.get('poll-ms') ?? '500', 10),
  };
}

interface FleeStats {
  aggroEvents: number;
  uniqueAggressors: number;
  fleeSprints: number;
  cooldownSkips: number;
}

function buildScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  stats: FleeStats,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('flee-on-aggro', verbose);
    const selfId = ctx.sceneStart.playerNetworkId;
    log(
      `watching for aggro on 0x${selfId.toString(16)} — flee=${args.fleeDistance}m speed=${args.fleeSpeed} cooldown=${args.cooldownMs}ms`,
    );

    /** aggressor NetworkId-as-string → expiry timestamp (wall-clock ms). */
    const aggressors = new Map<string, number>();
    /** aggressor NetworkId-as-string → cached last-known position (used if WorldObject is destroyed mid-flee). */
    const aggressorPositions = new Map<string, Vector3>();
    /** Set of aggressor ids we've ever seen; for the unique-count stat. */
    const everSeen = new Set<string>();
    /** Set when there's a fresh aggro event we haven't responded to yet. */
    let pendingFlee = false;

    const unsub = ctx.world.on((e) => {
      if (e.kind !== 'delta') return;
      if (e.decodedKind !== 'CreatureObjectSharedNpDelta') return;
      if (e.object.id === selfId) return;
      const changes = e.changes as Partial<CreatureObjectSharedNpBaseline>;
      // `intendedTarget` is only in `changes` when this particular delta
      // actually mutated it (sparse semantics) — exactly when someone just
      // changed their target with intent. That is our aggro signal.
      if (changes.intendedTarget === undefined) return;
      if (changes.intendedTarget !== selfId) return;

      const key = e.object.id.toString();
      const now = Date.now();
      const expiry = aggressors.get(key);
      if (expiry !== undefined && now < expiry) {
        // Same creature is still in their cooldown window — don't re-flee
        // from them, but freshen the cached position in case they've moved.
        aggressorPositions.set(key, { ...e.object.position });
        stats.cooldownSkips++;
        return;
      }
      stats.aggroEvents++;
      if (!everSeen.has(key)) {
        everSeen.add(key);
        stats.uniqueAggressors++;
      }
      aggressors.set(key, now + args.cooldownMs);
      aggressorPositions.set(key, { ...e.object.position });
      pendingFlee = true;
      log(
        `aggro from ${key} at (${e.object.position.x.toFixed(1)}, ${e.object.position.z.toFixed(1)}) — typeId=${e.object.typeIdString}`,
      );
    });

    try {
      const deadline = Date.now() + totalMs;
      while (Date.now() < deadline) {
        // Drop any expired aggressor entries so the centroid math only
        // considers creatures still pressing us.
        const now = Date.now();
        for (const [key, expiry] of aggressors) {
          if (now >= expiry) {
            aggressors.delete(key);
            aggressorPositions.delete(key);
          }
        }
        if (pendingFlee && aggressors.size > 0) {
          pendingFlee = false;
          const me = ctx.position();
          // Compute centroid of live aggressors using freshest known
          // positions (prefer the live WorldObject; fall back to cached).
          let cx = 0;
          let cz = 0;
          let n = 0;
          for (const key of aggressors.keys()) {
            const idBig = BigInt(key);
            const live = ctx.world.get(idBig);
            const p = live?.position ?? aggressorPositions.get(key);
            if (p === undefined) continue;
            cx += p.x;
            cz += p.z;
            n++;
          }
          if (n === 0) continue;
          cx /= n;
          cz /= n;
          // Flee direction = unit vector from centroid → player, then walk
          // `fleeDistance` past the player along that vector. That's the
          // "opposite of aggressor's position relative to player" line.
          const dx = me.x - cx;
          const dz = me.z - cz;
          const len = Math.hypot(dx, dz);
          let ux: number;
          let uz: number;
          if (len < 1e-3) {
            // Aggressor is sitting on top of us — pick a random heading
            // rather than divide by zero.
            const a = Math.random() * 2 * Math.PI;
            ux = Math.cos(a);
            uz = Math.sin(a);
          } else {
            ux = dx / len;
            uz = dz / len;
          }
          const target = {
            x: me.x + ux * args.fleeDistance,
            z: me.z + uz * args.fleeDistance,
          };
          stats.fleeSprints++;
          log(
            `sprint ${args.fleeDistance}m from centroid of ${n} aggressor(s) → (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`,
          );
          // Make sure we're upright before sprinting; crouched/prone
          // creatures move at a small fraction of run speed.
          ctx.changePosture('standing');
          try {
            await ctx.walkTo(target, { speed: args.fleeSpeed });
          } catch (err) {
            log(`walkTo failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          await ctx.wait(Math.min(args.pollMs, deadline - Date.now()));
        }
      }
    } finally {
      unsub();
    }
    log(
      `done: ${stats.aggroEvents} aggro events, ${stats.uniqueAggressors} unique, ${stats.fleeSprints} sprints, ${stats.cooldownSkips} cooldown skips`,
    );
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(
      SCRIPT,
      'Reactive flee — watch for CREO deltas where `intendedTarget` = us, sprint away.',
      [
        '  --flee-distance=N        metres to sprint per aggro event (default 30)',
        '  --flee-speed=N           run speed in m/s (default 6)',
        '  --cooldown-ms=N          ignore the same aggressor for this many ms (default 8000)',
        '  --poll-ms=N              main-loop tick when no pending flee (default 500)',
      ],
    );
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const stats: FleeStats = {
    aggroEvents: 0,
    uniqueAggressors: 0,
    fleeSprints: 0,
    cooldownSkips: 0,
  };
  const scenario = buildScenario(script, totalMs, args.verbose, stats);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    fleeDistance: script.fleeDistance,
    fleeSpeed: script.fleeSpeed,
    cooldownMs: script.cooldownMs,
    aggroEvents: stats.aggroEvents,
    uniqueAggressors: stats.uniqueAggressors,
    fleeSprints: stats.fleeSprints,
    cooldownSkips: stats.cooldownSkips,
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
