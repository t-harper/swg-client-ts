#!/usr/bin/env node --import tsx
/**
 * endless-combat.ts — attack a fixed targetId every K seconds for total
 * duration.
 *
 * Long-running variant of the bundled `combat-attack` scenario. Useful for
 * soak-testing the command-queue path and observing whether the server emits
 * `CommandQueueRemove` for every `CommandQueueEnqueue`.
 *
 * Pass `--target-id` as a hex (`0x...`) or decimal NetworkId.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/endless-combat.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --target-id=0x9999999 --tick-ms=1500 --minutes=10
 */

import type { NetworkId, ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/endless-combat.ts';

interface ScriptArgs {
  targetId: NetworkId;
  tickMs: number;
  ability: string;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('target-id') ?? '0';
  const targetId = (raw.startsWith('0x') ? BigInt(raw) : BigInt(raw)) as NetworkId;
  return {
    targetId,
    tickMs: Number.parseInt(extra.get('tick-ms') ?? '1500', 10),
    ability: extra.get('ability') ?? 'attack',
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('cbt', verbose);
    if (args.targetId === 0n) throw new Error('--target-id is required (decimal or 0x... hex)');
    log(`attacking 0x${args.targetId.toString(16)} every ${args.tickMs}ms ability=${args.ability}`);

    const deadline = Date.now() + totalMs;
    let ticks = 0;
    while (Date.now() < deadline) {
      const seq = ctx.useAbility(args.ability, args.targetId);
      ticks++;
      if (ticks % 10 === 0) log(`tick ${ticks} seq=${seq}`);
      await ctx.wait(args.tickMs);
    }
    log(`combat done: ${ticks} ability queues`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Queue an ability against a target on a fixed cadence.', [
      '  --target-id=N            target NetworkId (decimal or 0x... hex) (required)',
      '  --tick-ms=N              ms between enqueues (default 1500)',
      '  --ability=NAME           ability to queue (default attack)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const scenario = buildScenario(script, totalMs, args.verbose);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    targetId: `0x${script.targetId.toString(16)}`,
    tickMs: script.tickMs,
    ability: script.ability,
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
