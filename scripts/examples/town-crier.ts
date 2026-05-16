#!/usr/bin/env node --import tsx
/**
 * town-crier.ts — cycle through K different say-messages on a schedule.
 *
 * Stands in place and rotates through a configurable list of spatial-chat
 * announcements. Useful for soak-testing the spatial chat ObjController
 * subtype across many messages.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/town-crier.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --interval-ms=10000 --minutes=10
 *
 *   pnpm exec tsx scripts/examples/town-crier.ts \
 *     --messages='Hear ye, hear ye!,Tarisun, the AT-AT, has arrived!,Storm coming!' \
 *     --interval-ms=15000 --minutes=30
 */

import type { ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/town-crier.ts';

const DEFAULT_MESSAGES = [
  'Hear ye, hear ye!',
  'The Empire is hiring at the recruitment kiosk.',
  'Sandcrawler spotted near the spaceport.',
  'Best deals on weapons at the bazaar today!',
  'Dancers needed at the Mos Eisley cantina.',
  'A new mission is now available.',
  'Reminder: pay your taxes to the local guild.',
  'May the Force be with you, friends.',
];

interface ScriptArgs {
  intervalMs: number;
  messages: string[];
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('messages');
  return {
    intervalMs: Number.parseInt(extra.get('interval-ms') ?? '8000', 10),
    messages: raw
      ? raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : DEFAULT_MESSAGES,
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('crier', verbose);
    log(`crying ${args.messages.length} messages every ${args.intervalMs}ms`);

    const deadline = Date.now() + totalMs;
    let i = 0;
    while (Date.now() < deadline) {
      const msg = args.messages[i % args.messages.length];
      if (msg === undefined) break;
      ctx.say(msg);
      log(`cry #${i}: ${msg}`);
      i++;
      await ctx.wait(args.intervalMs);
    }
    log(`crier finished: ${i} announcements`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Cycle through a list of say-messages on a schedule.', [
      '  --interval-ms=N          ms between announcements (default 8000)',
      '  --messages=A,B,C         comma-separated messages (default 8 stock messages)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const scenario = buildScenario(script, totalMs, args.verbose);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    intervalMs: script.intervalMs,
    messageCount: script.messages.length,
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
