#!/usr/bin/env node --import tsx
/**
 * crafting-bench-soak.ts — open a crafting session against a tool, idle for
 * duration, then finish (or just let it implicitly time out at logout).
 * Tests session keep-alive while the player does nothing.
 *
 * You must supply `--tool-id` (the NetworkId of a crafting tool in the
 * character's inventory). Pass it as decimal or `0x...` hex.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/crafting-bench-soak.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --tool-id=0x12345 --minutes=2
 */

import type { NetworkId, ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/crafting-bench-soak.ts';

interface ScriptArgs {
  toolId: NetworkId;
  finish: boolean;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('tool-id') ?? '0';
  return {
    toolId: BigInt(raw) as NetworkId,
    finish: extra.get('finish') !== 'false',
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('craft', verbose);
    if (args.toolId === 0n) throw new Error('--tool-id is required (NetworkId of a crafting tool)');
    log(`opening crafting session against 0x${args.toolId.toString(16)}`);
    const seq = ctx.beginCrafting(args.toolId);
    log(`requestCraftingSession seq=${seq}`);

    // Just idle the whole duration. The server should keep the session open
    // as long as we keep heartbeating (which the orchestrator does).
    log(`idle for ${totalMs}ms`);
    await ctx.wait(totalMs);

    if (args.finish) {
      log('finishing crafting (practice mode)');
      ctx.finishCrafting(args.toolId, { realPrototype: false });
      await ctx.wait(1000);
    }
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Open a crafting session and hold it idle. Tests keep-alive.', [
      '  --tool-id=N              crafting tool NetworkId (decimal or 0x... hex) (required)',
      '  --finish=true|false      finish or abandon at end (default true → finish)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const scenario = buildScenario(script, totalMs, args.verbose);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    toolId: `0x${script.toolId.toString(16)}`,
    finish: script.finish,
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
