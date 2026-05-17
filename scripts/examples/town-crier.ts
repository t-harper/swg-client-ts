#!/usr/bin/env node --import tsx
/**
 * town-crier.ts — cycle through K different say-messages on a schedule,
 * but only when someone is nearby to hear them.
 *
 * Stands in place and rotates through a configurable list of spatial-chat
 * announcements. Before each shout, queries `ctx.playersInRange(radius)`
 * (WorldModel-backed) and skips the cycle if no audience is present. Useful
 * for soak-testing the spatial-chat ObjController subtype across many
 * messages without screaming into the void.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/town-crier.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --interval-ms=10000 --minutes=10 --audience-radius=25
 *
 *   # Only shout when 2+ players are within 30m (population-test mode):
 *   pnpm exec tsx scripts/examples/town-crier.ts \
 *     --interval-ms=15000 --minutes=30 \
 *     --audience-radius=30 --minimum-audience=2
 *
 *   # Custom messages, audience-gated:
 *   pnpm exec tsx scripts/examples/town-crier.ts \
 *     --messages='Hear ye, hear ye!,Tarisun, the AT-AT, has arrived!,Storm coming!' \
 *     --interval-ms=15000 --minutes=30
 *
 *   # Legacy back-compat: shout unconditionally (skip the audience check):
 *   pnpm exec tsx scripts/examples/town-crier.ts \
 *     --interval-ms=10000 --minutes=10 --always-shout=true
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
  audienceRadius: number;
  minimumAudience: number;
  alwaysShout: boolean;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('messages');
  let messages: string[] = DEFAULT_MESSAGES;
  if (raw !== undefined) {
    // Allow a JSON-array form (--messages='["a","b"]') OR comma-separated
    // fallback for back-compat with the previous CLI shape.
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
          messages = (parsed as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
        }
      } catch {
        // fall through to comma-split
      }
    }
    if (messages === DEFAULT_MESSAGES) {
      messages = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  }
  const alwaysShoutRaw = extra.get('always-shout');
  return {
    intervalMs: Number.parseInt(extra.get('interval-ms') ?? '8000', 10),
    messages,
    audienceRadius: Number.parseFloat(extra.get('audience-radius') ?? '25'),
    minimumAudience: Number.parseInt(extra.get('minimum-audience') ?? '1', 10),
    alwaysShout: alwaysShoutRaw === 'true' || alwaysShoutRaw === '',
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('crier', verbose);
    const mode = args.alwaysShout
      ? 'always-shout'
      : `audience-gated (r=${args.audienceRadius}m, min=${args.minimumAudience})`;
    log(`crying ${args.messages.length} messages every ${args.intervalMs}ms — mode: ${mode}`);

    const deadline = Date.now() + totalMs;
    let i = 0;
    let shouts = 0;
    let skipped = 0;
    while (Date.now() < deadline) {
      const msg = args.messages[i % args.messages.length];
      if (msg === undefined) break;

      if (!args.alwaysShout) {
        const audience = ctx.playersInRange(args.audienceRadius);
        if (audience.length < args.minimumAudience) {
          log(
            `cycle #${i}: no audience (${audience.length}/${args.minimumAudience} within ${args.audienceRadius}m) — skip`,
          );
          skipped++;
          i++;
          await ctx.wait(args.intervalMs);
          continue;
        }
        log(`cry #${i}: ${audience.length} listener(s) in range — ${msg}`);
      } else {
        log(`cry #${i}: ${msg}`);
      }

      ctx.say(msg);
      shouts++;
      i++;
      await ctx.wait(args.intervalMs);
    }
    log(`crier finished: ${shouts} shouted, ${skipped} skipped, ${i} cycles`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Cycle through a list of say-messages on a schedule, gated by audience.', [
      '  --interval-ms=N          ms between announcements (default 8000)',
      '  --messages=A,B,C         comma-separated messages (or JSON array; default 8 stock messages)',
      '  --audience-radius=M      meters to scan for listeners (default 25)',
      '  --minimum-audience=N     skip cycle unless >=N players in range (default 1)',
      '  --always-shout=true      bypass the audience check (legacy back-compat)',
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
    audienceRadius: script.audienceRadius,
    minimumAudience: script.minimumAudience,
    alwaysShout: script.alwaysShout,
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
