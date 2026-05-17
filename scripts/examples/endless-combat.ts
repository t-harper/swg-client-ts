#!/usr/bin/env node --import tsx
/**
 * endless-combat.ts — attack a target every K seconds for total duration.
 *
 * Long-running variant of the bundled `combat-attack` scenario. Useful for
 * soak-testing the command-queue path and observing whether the server emits
 * `CommandQueueRemove` for every `CommandQueueEnqueue`.
 *
 * Auto-targeting (default): each tick picks the nearest hostile CREO within
 * `--max-radius-m` via `ctx.nearestHostile()`, falling back to the nearest
 * creature of any kind via `ctx.findNearest(ObjectTypeTags.CREO)`. If nothing
 * is in range the tick logs and continues — the soak is robust against empty
 * neighborhoods. The current target is re-queried every tick so creatures
 * that wander out of range or are destroyed get replaced automatically.
 *
 * Back-compat: pass `--target-id=` as a hex (`0x...`) or decimal NetworkId to
 * pin the attack to a specific creature. The script will still re-check
 * `ctx.world.has(targetId)` each tick and switch to auto-targeting once the
 * pinned target leaves the world.
 *
 * Example:
 *   # auto-target nearest hostile within 40m
 *   pnpm exec tsx scripts/examples/endless-combat.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --tick-ms=1500 --minutes=10
 *
 *   # back-compat: pin to a specific target
 *   pnpm exec tsx scripts/examples/endless-combat.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --target-id=0x9999999 --tick-ms=1500 --minutes=10
 */

import { type NetworkId, ObjectTypeTags, type ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/endless-combat.ts';

interface ScriptArgs {
  pinnedTargetId: NetworkId | null;
  tickMs: number;
  ability: string;
  maxRadiusM: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('target-id');
  const pinnedTargetId =
    raw === undefined || raw === '' || raw === '0'
      ? null
      : ((raw.startsWith('0x') ? BigInt(raw) : BigInt(raw)) as NetworkId);
  return {
    pinnedTargetId,
    tickMs: Number.parseInt(extra.get('tick-ms') ?? '1500', 10),
    ability: extra.get('ability') ?? 'attack',
    maxRadiusM: Number.parseFloat(extra.get('max-radius-m') ?? '40'),
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('cbt', verbose);
    if (args.pinnedTargetId !== null) {
      log(
        `pinned target 0x${args.pinnedTargetId.toString(16)} (auto-target fallback on destroy/range)`,
      );
    } else {
      log(`auto-targeting nearest hostile within ${args.maxRadiusM}m`);
    }
    log(`tick=${args.tickMs}ms ability=${args.ability}`);

    const deadline = Date.now() + totalMs;
    let ticks = 0;
    let attacks = 0;
    let misses = 0;
    let currentTargetId: NetworkId | null = null;

    while (Date.now() < deadline) {
      ticks++;

      // Resolve target for this tick.
      let targetId: NetworkId | null = null;
      if (args.pinnedTargetId !== null && ctx.world.has(args.pinnedTargetId)) {
        targetId = args.pinnedTargetId;
      } else {
        const hostile = ctx.nearestHostile({ maxRadiusM: args.maxRadiusM });
        const pick =
          hostile ?? ctx.findNearest(ObjectTypeTags.CREO, { maxRadiusM: args.maxRadiusM });
        targetId = pick?.networkId ?? null;
      }

      if (targetId === null) {
        misses++;
        if (verbose && (misses === 1 || misses % 10 === 0)) {
          log(`tick ${ticks}: no target in range (misses=${misses})`);
        }
      } else {
        if (targetId !== currentTargetId) {
          log(`tick ${ticks}: target -> 0x${targetId.toString(16)}`);
          currentTargetId = targetId;
        }
        const seq = ctx.useAbility(args.ability, targetId);
        attacks++;
        if (attacks % 10 === 0) {
          // Every 10th attack, log our HAM so the operator can see whether
          // we're winning or losing the exchange. `ctx.character` updates
          // from CREO p6 (SHARED_NP) totalAttributes deltas; readings are
          // live with no extra wire traffic.
          const h = ctx.character.health;
          const a = ctx.character.action;
          const m = ctx.character.mind;
          log(
            `tick ${ticks} attacks=${attacks} seq=${seq} ham=${h.current}/${h.max} | ${a.current}/${a.max} | ${m.current}/${m.max}`,
          );
        }
      }

      await ctx.wait(args.tickMs);
    }
    log(
      `combat done: ticks=${ticks} attacks=${attacks} idleTicks=${misses} (final ham: H=${ctx.character.health.current}/${ctx.character.health.max} A=${ctx.character.action.current}/${ctx.character.action.max} M=${ctx.character.mind.current}/${ctx.character.mind.max})`,
    );
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Queue an ability against a target on a fixed cadence.', [
      '  --target-id=N            optional pinned NetworkId (decimal or 0x... hex)',
      '  --tick-ms=N              ms between enqueues (default 1500)',
      '  --ability=NAME           ability to queue (default attack)',
      '  --max-radius-m=N         auto-target search radius in m (default 40)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const scenario = buildScenario(script, totalMs, args.verbose);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    pinnedTargetId:
      script.pinnedTargetId === null ? null : `0x${script.pinnedTargetId.toString(16)}`,
    tickMs: script.tickMs,
    ability: script.ability,
    maxRadiusM: script.maxRadiusM,
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
