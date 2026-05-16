#!/usr/bin/env node --import tsx
/**
 * chat-spam.ts — rate-limited chat for total duration, exercising the chat
 * pipeline. Configurable to spam via tell, channel post, or spatial say.
 *
 * The default `mode=say` uses the spatial chat ObjController subtype.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/chat-spam.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --mode=say --interval-ms=3000 --minutes=5
 *
 *   pnpm exec tsx scripts/examples/chat-spam.ts \
 *     --mode=tell --target=Friend --interval-ms=5000 --minutes=2 \
 *     --user=ci-test --character=TsTest
 */

import type { ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/chat-spam.ts';

type Mode = 'say' | 'tell' | 'channel';

interface ScriptArgs {
  mode: Mode;
  intervalMs: number;
  message: string;
  target: string;
  channelId: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const m = (extra.get('mode') ?? 'say') as Mode;
  if (m !== 'say' && m !== 'tell' && m !== 'channel') {
    throw new Error(`--mode must be one of: say, tell, channel (got ${m})`);
  }
  return {
    mode: m,
    intervalMs: Number.parseInt(extra.get('interval-ms') ?? '3000', 10),
    message: extra.get('message') ?? 'hello world from the swg-ts-client demo bot',
    target: extra.get('target') ?? '',
    channelId: Number.parseInt(extra.get('channel-id') ?? '0', 10),
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('chat', verbose);
    log(`mode=${args.mode} interval=${args.intervalMs}ms`);
    if (args.mode === 'tell' && args.target === '') {
      throw new Error('--target is required when --mode=tell');
    }
    if (args.mode === 'channel' && !args.channelId) {
      throw new Error(
        '--channel-id is required when --mode=channel (use requestChannelList from a prior run to find one)',
      );
    }

    const deadline = Date.now() + totalMs;
    let sent = 0;
    while (Date.now() < deadline) {
      const tagged = `${args.message} #${sent}`;
      switch (args.mode) {
        case 'say':
          ctx.say(tagged);
          break;
        case 'tell':
          ctx.tell(args.target, tagged);
          break;
        case 'channel':
          ctx.sendToChannel(args.channelId, tagged);
          break;
      }
      sent++;
      log(`sent #${sent}: ${tagged.slice(0, 40)}`);
      await ctx.wait(args.intervalMs);
    }
    log(`chat finished: ${sent} messages`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Rate-limited chat spam (say / tell / channel post).', [
      '  --mode=say|tell|channel  chat mode (default say)',
      '  --interval-ms=N          ms between sends (default 3000)',
      '  --message=STR            message body (default "hello world ...")',
      '  --target=NAME            target name (required for --mode=tell)',
      '  --channel-id=N           channel id (required for --mode=channel)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const scenario = buildScenario(script, totalMs, args.verbose);
  const { summary } = await runScenario(args, scenario);
  summary.extra = { ...script };
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
