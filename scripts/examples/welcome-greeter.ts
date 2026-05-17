#!/usr/bin/env node --import tsx
/**
 * welcome-greeter.ts — greet players who walk into earshot.
 *
 * Modern default (`--mode=reactive`): subscribe to the WorldModel's
 * `'create'` events and emit a spatial greeting whenever a `PLAY`-type
 * object lands within `--greet-radius=20m` of the player. A per-player
 * cooldown (`--cooldown-ms=60000`) prevents re-greeting the same
 * NetworkId if they wander back in and out of range.
 *
 * Legacy fallback (`--mode=timer`, also triggered by passing
 * `--interval-ms=...`): the original behavior — emit a rotating welcome
 * message on a fixed interval regardless of who's nearby. Useful for
 * exercising the chat moderation rules / spatial chat pipeline over long
 * periods without needing a second client to wander past.
 *
 * Example (reactive — default):
 *   pnpm exec tsx scripts/examples/welcome-greeter.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --greet-radius=20 --cooldown-ms=60000 --minutes=30
 *
 * Example (timer — legacy):
 *   pnpm exec tsx scripts/examples/welcome-greeter.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --mode=timer --interval-ms=15000 --minutes=30
 */

import { ObjectTypeTags, type ScenarioFn, type WorldEvent } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/welcome-greeter.ts';

const GREETINGS = [
  'Welcome to Mos Eisley, traveller!',
  'Greetings! Mind the Stormtroopers near the cantina.',
  'Hi there - first time on Tatooine?',
  'May the Force be with you.',
  'New here? The bazaar terminal is just around the corner.',
];

type Mode = 'reactive' | 'timer';

interface ScriptArgs {
  mode: Mode;
  intervalMs: number;
  greetRadiusM: number;
  cooldownMs: number;
  greetings: string[];
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('greetings');
  const greetings = raw
    ? raw
        .split('|')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : GREETINGS;
  // Back-compat: if the user passed --interval-ms but no --mode, treat that as
  // an explicit opt-in to the legacy timer path.
  const modeFlag = extra.get('mode');
  const hasIntervalFlag = extra.has('interval-ms');
  const mode: Mode =
    modeFlag === 'timer' || modeFlag === 'reactive'
      ? modeFlag
      : hasIntervalFlag
        ? 'timer'
        : 'reactive';
  return {
    mode,
    intervalMs: Number.parseInt(extra.get('interval-ms') ?? '15000', 10),
    greetRadiusM: Number.parseFloat(extra.get('greet-radius') ?? '20'),
    cooldownMs: Number.parseInt(extra.get('cooldown-ms') ?? '60000', 10),
    greetings,
  };
}

interface GreeterStats {
  mode: Mode;
  greetingsSent: number;
  uniquePlayersGreeted: number;
  arrivalsSeen: number;
  skippedByCooldown: number;
  skippedOutOfRange: number;
}

function buildScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  stats: GreeterStats,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('greet', verbose);
    if (args.mode === 'timer') {
      log(
        `greeter starting (timer), interval=${args.intervalMs}ms, ${args.greetings.length} greetings`,
      );
      const deadline = Date.now() + totalMs;
      let n = 0;
      while (Date.now() < deadline) {
        const text = args.greetings[n % args.greetings.length];
        if (text === undefined) break;
        ctx.say(text);
        stats.greetingsSent++;
        log(`greeted #${n}: ${text}`);
        n++;
        await ctx.wait(args.intervalMs);
      }
      log(`greeter done (timer): ${n} greetings`);
      await ctx.logout();
      return;
    }

    // Reactive mode: greet players as they enter earshot.
    log(
      `greeter starting (reactive), radius=${args.greetRadiusM}m, cooldown=${args.cooldownMs}ms, ${args.greetings.length} greetings`,
    );
    const selfId = ctx.sceneStart.playerNetworkId;
    const r2 = args.greetRadiusM * args.greetRadiusM;
    /** NetworkId-as-string → wall-clock ms of last greeting (for cooldown). */
    const lastGreetedAt = new Map<string, number>();
    let rotation = 0;

    const tryGreet = (otherId: bigint): void => {
      if (otherId === selfId) return;
      // Be defensive: WorldEvents may fire before we're fully zoned in
      // (some baselines arrive before SceneEndBaselines). Position() reads
      // the player's pose; if either side hasn't been populated, just bail.
      const other = ctx.world.get(otherId);
      if (!other) return;
      if (other.typeId !== ObjectTypeTags.PLAY) return;
      const me = ctx.position();
      const dx = other.position.x - me.x;
      const dz = other.position.z - me.z;
      const d2 = dx * dx + dz * dz;
      if (!Number.isFinite(d2)) return;
      if (d2 > r2) {
        stats.skippedOutOfRange++;
        return;
      }
      stats.arrivalsSeen++;
      const key = otherId.toString();
      const now = Date.now();
      const last = lastGreetedAt.get(key);
      if (last !== undefined && now - last < args.cooldownMs) {
        stats.skippedByCooldown++;
        log(`skip ${key} (cooldown, ${now - last}ms since last)`);
        return;
      }
      const text = args.greetings[rotation % args.greetings.length];
      if (text === undefined) return;
      rotation++;
      try {
        ctx.say(text);
        stats.greetingsSent++;
        if (last === undefined) stats.uniquePlayersGreeted++;
        lastGreetedAt.set(key, now);
        log(`greeted ${key} (~${Math.sqrt(d2).toFixed(1)}m): ${text}`);
      } catch (err) {
        log(`say() failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const unsub = ctx.world.on((e: WorldEvent) => {
      // 'create' is the cleanest "someone just appeared" hook. We also
      // consult 'baseline' because typeId is only set once the first
      // BaselinesMessage lands — so a player created moments before they
      // become identifiable as PLAY would otherwise slip through.
      if (e.kind === 'create') {
        tryGreet(e.object.id);
      } else if (e.kind === 'baseline' && e.object.typeId === ObjectTypeTags.PLAY) {
        tryGreet(e.object.id);
      }
    });

    // Greet anyone already in range at start (we missed their 'create'
    // because it landed during zone-in baseline flood, before this handler
    // attached).
    for (const p of ctx.playersInRange(args.greetRadiusM)) {
      tryGreet(p.id);
    }

    try {
      await ctx.wait(totalMs);
    } finally {
      unsub();
    }
    log(
      `greeter done (reactive): ${stats.greetingsSent} greetings, ${stats.uniquePlayersGreeted} unique players`,
    );
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Greet players who walk into earshot (or emit on a timer).', [
      '  --mode=reactive|timer    reactive (default): greet new arrivals; timer: legacy rotating timer',
      '  --greet-radius=M         metres for reactive earshot (default 20)',
      '  --cooldown-ms=N          ms before re-greeting the same player (default 60000)',
      '  --interval-ms=N          (timer mode) ms between greetings (default 15000)',
      '  --greetings=A|B|C        pipe-separated greetings (default 5 stock messages)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const stats: GreeterStats = {
    mode: script.mode,
    greetingsSent: 0,
    uniquePlayersGreeted: 0,
    arrivalsSeen: 0,
    skippedByCooldown: 0,
    skippedOutOfRange: 0,
  };
  const scenario = buildScenario(script, totalMs, args.verbose, stats);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    mode: stats.mode,
    intervalMs: script.intervalMs,
    greetRadiusM: script.greetRadiusM,
    cooldownMs: script.cooldownMs,
    greetingCount: script.greetings.length,
    greetingsSent: stats.greetingsSent,
    uniquePlayersGreeted: stats.uniquePlayersGreeted,
    arrivalsSeen: stats.arrivalsSeen,
    skippedByCooldown: stats.skippedByCooldown,
    skippedOutOfRange: stats.skippedOutOfRange,
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
