#!/usr/bin/env node --import tsx
/**
 * channel-bot.ts — request the channel list, then post a rotating message in
 * each known channel id every cycle.
 *
 * The script:
 *   1. Calls `ctx.requestChannelList()` and waits a few seconds for
 *      `ChatRoomList` to arrive (we don't decode the list — we just trust
 *      the `--channels` flag for ids).
 *   2. Loops: for each channel id, post a message; sleep `cycle-ms`.
 *
 * Pass `--channels=1,2,3` with channel ids learned out-of-band (e.g. from a
 * previous capture).
 *
 * Example:
 *   pnpm exec tsx scripts/examples/channel-bot.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --channels=1,7 --cycle-ms=10000 --minutes=10
 */

import { ChatRoomList } from '../../src/index.js';
import type { ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/channel-bot.ts';

interface ScriptArgs {
  channels: number[];
  cycleMs: number;
  message: string;
  waitListMs: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('channels') ?? '';
  const channels = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return {
    channels,
    cycleMs: Number.parseInt(extra.get('cycle-ms') ?? '10000', 10),
    message: extra.get('message') ?? 'channel-bot here, just saying hi',
    waitListMs: Number.parseInt(extra.get('wait-list-ms') ?? '2000', 10),
  };
}

function buildScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  observed: { gotChannelList: boolean },
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('chan', verbose);
    if (args.channels.length === 0) throw new Error('--channels is required (comma-separated ids)');

    ctx.requestChannelList();
    try {
      await ctx.waitForMessage(ChatRoomList, { timeoutMs: args.waitListMs });
      observed.gotChannelList = true;
      log('received ChatRoomList');
    } catch {
      log('no ChatRoomList within wait window (continuing anyway)');
    }

    const deadline = Date.now() + totalMs;
    let cycle = 0;
    let posts = 0;
    while (Date.now() < deadline) {
      for (const ch of args.channels) {
        if (Date.now() >= deadline) break;
        ctx.sendToChannel(ch, `${args.message} (cycle=${cycle})`);
        posts++;
        log(`posted to channel ${ch} (cycle ${cycle})`);
      }
      cycle++;
      await ctx.wait(args.cycleMs);
    }
    log(`channel-bot done: ${posts} posts over ${cycle} cycles`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Post a rotating message to each known channel every cycle.', [
      '  --channels=A,B,C         comma-separated channel ids (required)',
      '  --cycle-ms=N             ms between full-cycle posts (default 10000)',
      '  --message=STR            post body (default "channel-bot here ...")',
      '  --wait-list-ms=N         wait for ChatRoomList before posting (default 2000)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const observed = { gotChannelList: false };
  const scenario = buildScenario(script, totalMs, args.verbose, observed);
  const { summary } = await runScenario(args, scenario);
  summary.extra = { ...script, gotChannelList: observed.gotChannelList };
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
