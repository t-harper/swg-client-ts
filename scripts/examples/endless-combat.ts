#!/usr/bin/env node --import tsx
/**
 * endless-combat.ts — attack the nearest hostile every K seconds for total
 * duration; auto-loot the corpse on death.
 *
 * Built on top of `ctx.combat.attackingNearest()` (the one-line sugar that
 * resolves a target via `nearestHostile` and waits for the kill) and
 * `ctx.combat.autoLoot` (auto-fires `loot` on creature-death detection).
 * The script-level boilerplate is gone — this is essentially a `while`-loop
 * around a single async call.
 *
 * Back-compat: pass `--target-id=` as a hex (`0x...`) or decimal NetworkId
 * to bypass auto-targeting and keep attacking a fixed creature until it
 * leaves the world (then fall back to auto-targeting).
 *
 * Example:
 *   pnpm exec tsx scripts/examples/endless-combat.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --tick-ms=1500 --minutes=10
 */

import type { NetworkId, ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/endless-combat.ts';

interface ScriptArgs {
  pinnedTargetId: NetworkId | null;
  tickMs: number;
  ability: string;
  maxRadiusM: number;
  autoLoot: boolean;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('target-id');
  const pinnedTargetId =
    raw === undefined || raw === '' || raw === '0'
      ? null
      : ((raw.startsWith('0x') ? BigInt(raw) : BigInt(raw)) as NetworkId);
  const autoLootRaw = extra.get('auto-loot');
  return {
    pinnedTargetId,
    tickMs: Number.parseInt(extra.get('tick-ms') ?? '1500', 10),
    ability: extra.get('ability') ?? 'attack',
    maxRadiusM: Number.parseFloat(extra.get('max-radius-m') ?? '40'),
    autoLoot: autoLootRaw === undefined ? true : autoLootRaw !== 'false',
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('cbt', verbose);
    ctx.combat.autoLoot = args.autoLoot;
    if (args.pinnedTargetId !== null) {
      log(
        `pinned target 0x${args.pinnedTargetId.toString(16)} (auto-target fallback on destroy/range)`,
      );
    } else {
      log(`auto-targeting nearest hostile within ${args.maxRadiusM}m`);
    }
    log(`tick=${args.tickMs}ms ability=${args.ability} autoLoot=${ctx.combat.autoLoot}`);

    const deadline = Date.now() + totalMs;
    let cycles = 0;
    while (Date.now() < deadline) {
      cycles++;
      if (args.pinnedTargetId !== null && ctx.world.has(args.pinnedTargetId)) {
        ctx.useAbility(args.ability, args.pinnedTargetId);
        await ctx.wait(Math.min(args.tickMs, Math.max(0, deadline - Date.now())));
      } else {
        // attackingNearest resolves the target, attacks every tickMs until
        // the target dies (leaves the world) or its 60s budget expires.
        await ctx.combat.attackingNearest({
          maxRadiusM: args.maxRadiusM,
          ability: args.ability,
          tickMs: args.tickMs,
          timeoutMs: Math.min(60_000, Math.max(0, deadline - Date.now())),
        });
      }
      if (cycles % 5 === 0) {
        const h = ctx.character.health;
        log(
          `cycle=${cycles} engaged=${ctx.combat.engaged} targets=${ctx.combat.targets().length} ham=${h.current}/${h.max}`,
        );
      }
    }
    log(
      `combat done: cycles=${cycles} engaged=${ctx.combat.engaged} (final ham: H=${ctx.character.health.current}/${ctx.character.health.max})`,
    );
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(
      SCRIPT,
      'Queue an ability against the nearest hostile on a fixed cadence; auto-loot on death.',
      [
        '  --target-id=N            optional pinned NetworkId (decimal or 0x... hex)',
        '  --tick-ms=N              ms between enqueues (default 1500)',
        '  --ability=NAME           ability to queue (default attack)',
        '  --max-radius-m=N         auto-target search radius in m (default 40)',
        '  --auto-loot=BOOL         auto-fire loot on creature death (default true)',
      ],
    );
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
    autoLoot: script.autoLoot,
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
