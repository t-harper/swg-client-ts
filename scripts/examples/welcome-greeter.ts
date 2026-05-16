#!/usr/bin/env node --import tsx
/**
 * welcome-greeter.ts — periodically say a welcome message at the spawn.
 *
 * Stays put and emits a short rotating welcome message every N seconds.
 * Designed to exercise chat moderation rules and the spatial chat pipeline
 * over long periods.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/welcome-greeter.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --interval-ms=15000 --minutes=30
 */

import type { ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/welcome-greeter.ts';

const GREETINGS = [
  'Welcome to Mos Eisley, traveller!',
  'Greetings! Mind the Stormtroopers near the cantina.',
  'Hi there - first time on Tatooine?',
  'May the Force be with you.',
  'New here? The bazaar terminal is just around the corner.',
];

interface ScriptArgs {
  intervalMs: number;
  greetings: string[];
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('greetings');
  return {
    intervalMs: Number.parseInt(extra.get('interval-ms') ?? '15000', 10),
    greetings: raw
      ? raw
          .split('|')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : GREETINGS,
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('greet', verbose);
    log(`greeter starting, interval=${args.intervalMs}ms, ${args.greetings.length} greetings`);

    const deadline = Date.now() + totalMs;
    let n = 0;
    while (Date.now() < deadline) {
      const text = args.greetings[n % args.greetings.length];
      if (text === undefined) break;
      ctx.say(text);
      log(`greeted #${n}: ${text}`);
      n++;
      await ctx.wait(args.intervalMs);
    }
    log(`greeter done: ${n} greetings`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Stand at spawn and emit periodic welcome messages.', [
      '  --interval-ms=N          ms between greetings (default 15000)',
      '  --greetings=A|B|C        pipe-separated greetings (default 5 stock messages)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const scenario = buildScenario(script, totalMs, args.verbose);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    intervalMs: script.intervalMs,
    greetingCount: script.greetings.length,
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
