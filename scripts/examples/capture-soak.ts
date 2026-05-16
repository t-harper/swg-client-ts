#!/usr/bin/env node --import tsx
/**
 * capture-soak.ts — start a long-running capture of a character idling for N
 * minutes; emit NDJSON to a file.
 *
 * Useful for collecting baseline traffic for regression checks (e.g. swap
 * server submodules, replay the capture, verify drift).
 *
 * Example:
 *   pnpm exec tsx scripts/examples/capture-soak.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --output=/tmp/idle-capture.ndjson --minutes=5
 */

import { createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { type CapturedEvent, captureLifecycle, transcriptToNdjson } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/capture-soak.ts';

interface ScriptArgs {
  output: string;
  cluster: string | undefined;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    output: extra.get('output') ?? '/tmp/swg-capture.ndjson',
    cluster: extra.get('cluster'),
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Capture an idle character session as NDJSON for replay.', [
      '  --output=PATH            NDJSON output file (default /tmp/swg-capture.ndjson)',
      '  --cluster=NAME           cluster name (default: first cluster)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  if (args.user === '') {
    process.stderr.write('--user is required\n');
    return 2;
  }
  if (args.character === '') {
    process.stderr.write('--character is required\n');
    return 2;
  }

  const log = makeLogger('cap', args.verbose);
  const totalMs = durationMs(args.minutes);

  // Stream events to disk as they arrive so we don't buffer hundreds of MB.
  const handle = await open(script.output, 'w');
  const stream = createWriteStream('', { fd: handle.fd, autoClose: false });
  let count = 0;

  const onEvent = (e: CapturedEvent): void => {
    const line = transcriptToNdjson([e]);
    stream.write(line);
    count++;
    if (count % 100 === 0) log(`captured ${count} events`);
  };

  log(`capturing for ${(totalMs / 1000).toFixed(0)}s → ${script.output}`);
  const t0 = Date.now();
  const result = await captureLifecycle({
    loginServer: { host: args.host, port: args.port },
    account: args.user,
    characterName: args.character,
    holdZonedInMs: totalMs,
    onEvent,
    ...(script.cluster !== undefined ? { clusterName: script.cluster } : {}),
  });
  const elapsed = Date.now() - t0;

  await new Promise<void>((resolve) => stream.end(resolve));
  await handle.close();

  const summary = {
    ok: !result.receivedErrorMessage,
    host: args.host,
    account: args.user,
    character: args.character,
    output: script.output,
    eventsCaptured: result.events.length,
    eventsStreamed: count,
    durationMs: elapsed,
    serverErrorMessage: result.receivedErrorMessage,
    characterWasCreated: result.characterWasCreated,
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
