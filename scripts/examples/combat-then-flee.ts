#!/usr/bin/env node --import tsx
/**
 * combat-then-flee.ts — attack a target for N seconds, then walk away K
 * metres, repeat.
 *
 * Each cycle:
 *   1. Pick an engagement target (auto: `ctx.nearestHostile` →
 *      `ctx.findNearest(CREO)` fallback, both capped at 40 m). Override with
 *      `--target-id=` for a fixed NetworkId.
 *   2. Queue `attack` against that target every `--tick-ms` for `--combat-ms`
 *   3. Pick a random heading
 *   4. Walk `--flee-distance` metres in that direction
 *   5. Pause `--rest-ms`, then loop
 *
 * Example:
 *   # Auto-pick the nearest in-combat creature (or any CREO if no hostiles
 *   # have flagged inCombat yet) and engage:
 *   pnpm exec tsx scripts/examples/combat-then-flee.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --combat-ms=4000 --flee-distance=15 --minutes=10
 *
 *   # Pin to a known NetworkId (back-compat):
 *   pnpm exec tsx scripts/examples/combat-then-flee.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --target-id=0x9999999 --combat-ms=4000 --flee-distance=15 --minutes=10
 */

import { type NetworkId, ObjectTypeTags, type ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/combat-then-flee.ts';
const AUTO_PICK_RADIUS_M = 40;

interface ScriptArgs {
  /** `0n` = auto-pick each cycle via WorldModel sugar. */
  targetId: NetworkId;
  combatMs: number;
  tickMs: number;
  fleeDistance: number;
  restMs: number;
  speed: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('target-id') ?? '0';
  return {
    targetId: BigInt(raw) as NetworkId,
    combatMs: Number.parseInt(extra.get('combat-ms') ?? '4000', 10),
    tickMs: Number.parseInt(extra.get('tick-ms') ?? '1500', 10),
    fleeDistance: Number.parseFloat(extra.get('flee-distance') ?? '15'),
    restMs: Number.parseInt(extra.get('rest-ms') ?? '2000', 10),
    speed: Number.parseFloat(extra.get('speed') ?? '5'),
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('flee', verbose);
    const pinned = args.targetId !== 0n;
    if (pinned) {
      log(
        `engage pinned 0x${args.targetId.toString(16)} for ${args.combatMs}ms, flee ${args.fleeDistance}m`,
      );
    } else {
      log(
        `auto-pick hostile within ${AUTO_PICK_RADIUS_M}m, engage ${args.combatMs}ms, flee ${args.fleeDistance}m`,
      );
    }

    const deadline = Date.now() + totalMs;
    let cycle = 0;
    let attacks = 0;
    let skippedCycles = 0;
    while (Date.now() < deadline) {
      // 1. Pick a target for this cycle.
      let targetId: NetworkId;
      if (pinned) {
        targetId = args.targetId;
      } else {
        const hostile =
          ctx.nearestHostile({ maxRadiusM: AUTO_PICK_RADIUS_M }) ??
          ctx.findNearest(ObjectTypeTags.CREO, { maxRadiusM: AUTO_PICK_RADIUS_M });
        if (hostile === undefined) {
          skippedCycles++;
          log(`cycle ${cycle}: no CREO within ${AUTO_PICK_RADIUS_M}m, resting ${args.restMs}ms`);
          await ctx.wait(args.restMs);
          cycle++;
          continue;
        }
        targetId = hostile.id;
        const tplLabel = hostile.templateName ?? '(unknown template)';
        log(`cycle ${cycle}: engaging 0x${targetId.toString(16)} — ${tplLabel}`);
      }

      // 2. Attack burst
      const cbtDeadline = Math.min(Date.now() + args.combatMs, deadline);
      while (Date.now() < cbtDeadline) {
        ctx.attackTarget(targetId);
        attacks++;
        await ctx.wait(args.tickMs);
      }
      if (Date.now() >= deadline) break;
      // 3. Flee
      const angle = Math.random() * 2 * Math.PI;
      const cur = ctx.position();
      const target = {
        x: cur.x + Math.cos(angle) * args.fleeDistance,
        z: cur.z + Math.sin(angle) * args.fleeDistance,
      };
      log(`cycle ${cycle}: fleeing to (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`);
      await ctx.walkTo(target, { speed: args.speed });
      // 4. Rest
      await ctx.wait(args.restMs);
      cycle++;
    }
    log(`done: ${cycle} cycles, ${attacks} attacks, ${skippedCycles} skipped (no target)`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Attack a target, then flee a short distance, then repeat.', [
      '  --target-id=N            pin to NetworkId (decimal or 0x... hex);',
      `                           omit to auto-pick via nearestHostile / nearest CREO within ${AUTO_PICK_RADIUS_M}m`,
      '  --combat-ms=N            attack burst duration in ms (default 4000)',
      '  --tick-ms=N              ms between attacks during burst (default 1500)',
      '  --flee-distance=N        flee distance in m (default 15)',
      '  --rest-ms=N              rest after flee in ms (default 2000)',
      '  --speed=N                walk speed (default 5)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const scenario = buildScenario(script, totalMs, args.verbose);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    ...script,
    targetId: script.targetId === 0n ? 'auto' : `0x${script.targetId.toString(16)}`,
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
