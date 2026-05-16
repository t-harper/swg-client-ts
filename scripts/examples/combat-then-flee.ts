#!/usr/bin/env node --import tsx
/**
 * combat-then-flee.ts — attack a target for N seconds, then walk away K
 * metres, repeat.
 *
 * Each cycle:
 *   1. Queue `attack` against `--target-id` every `--tick-ms` for `--combat-ms`
 *   2. Pick a random heading
 *   3. Walk `--flee-distance` metres in that direction
 *   4. Pause `--rest-ms`, then loop
 *
 * Example:
 *   pnpm exec tsx scripts/examples/combat-then-flee.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --target-id=0x9999999 --combat-ms=4000 --flee-distance=15 --minutes=10
 */

import type { NetworkId, ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/combat-then-flee.ts';

interface ScriptArgs {
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
    if (args.targetId === 0n) throw new Error('--target-id is required');
    log(
      `engage 0x${args.targetId.toString(16)} for ${args.combatMs}ms, flee ${args.fleeDistance}m`,
    );

    const deadline = Date.now() + totalMs;
    let cycle = 0;
    let attacks = 0;
    while (Date.now() < deadline) {
      // 1. Attack burst
      const cbtDeadline = Math.min(Date.now() + args.combatMs, deadline);
      while (Date.now() < cbtDeadline) {
        ctx.attackTarget(args.targetId);
        attacks++;
        await ctx.wait(args.tickMs);
      }
      if (Date.now() >= deadline) break;
      // 2. Flee
      const angle = Math.random() * 2 * Math.PI;
      const cur = ctx.position();
      const target = {
        x: cur.x + Math.cos(angle) * args.fleeDistance,
        z: cur.z + Math.sin(angle) * args.fleeDistance,
      };
      log(`cycle ${cycle}: fleeing to (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`);
      await ctx.walkTo(target, { speed: args.speed });
      // 3. Rest
      await ctx.wait(args.restMs);
      cycle++;
    }
    log(`done: ${cycle} cycles, ${attacks} attacks`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Attack a target, then flee a short distance, then repeat.', [
      '  --target-id=N            target NetworkId (decimal or 0x... hex) (required)',
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
  summary.extra = { ...script, targetId: `0x${script.targetId.toString(16)}` };
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
