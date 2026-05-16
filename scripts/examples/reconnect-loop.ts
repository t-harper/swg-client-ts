#!/usr/bin/env node --import tsx
/**
 * reconnect-loop.ts — log in, hold for K seconds, log out, wait, repeat.
 *
 * Useful for testing session lifecycle robustness over time. Each iteration
 * is its own complete `SwgClient.fullLifecycle()`.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/reconnect-loop.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --hold-ms=5000 --wait-ms=2000 --minutes=10
 */

import { SwgClient } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/reconnect-loop.ts';

interface ScriptArgs {
  holdMs: number;
  waitMs: number;
  cluster?: string;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const out: ScriptArgs = {
    holdMs: Number.parseInt(extra.get('hold-ms') ?? '5000', 10),
    waitMs: Number.parseInt(extra.get('wait-ms') ?? '2000', 10),
  };
  const cluster = extra.get('cluster');
  if (cluster !== undefined) out.cluster = cluster;
  return out;
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Login/hold/logout/wait loop — session lifecycle soak.', [
      '  --hold-ms=N              ms held zoned-in per iteration (default 5000)',
      '  --wait-ms=N              ms paused between iterations (default 2000)',
      '  --cluster=NAME           cluster name (default: first cluster)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  if (args.user === '' || args.character === '') {
    process.stderr.write('--user and --character are required\n');
    return 2;
  }

  const log = makeLogger('rc', args.verbose);
  const totalMs = durationMs(args.minutes);
  const deadline = Date.now() + totalMs;

  const iterations: Array<{
    iter: number;
    ok: boolean;
    durationMs: number;
    error?: string;
    baseline: number;
  }> = [];

  let iter = 0;
  while (Date.now() < deadline) {
    log(`iter ${iter} starting`);
    const t0 = Date.now();
    try {
      const client = new SwgClient({ loginServer: { host: args.host, port: args.port } });
      const lr = await client.fullLifecycle({
        account: args.user,
        characterName: args.character,
        holdZonedInMs: script.holdMs,
        ...(script.cluster !== undefined ? { clusterName: script.cluster } : {}),
      });
      iterations.push({
        iter,
        ok: !lr.receivedErrorMessage,
        durationMs: Date.now() - t0,
        baseline: lr.baselineObjectCount,
      });
      log(`iter ${iter} OK ${Date.now() - t0}ms`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      iterations.push({ iter, ok: false, durationMs: Date.now() - t0, error: msg, baseline: 0 });
      log(`iter ${iter} ERROR ${msg}`);
    }
    iter++;
    if (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, script.waitMs));
    }
  }

  const oks = iterations.filter((i) => i.ok).length;
  const summary = {
    ok: oks === iterations.length,
    host: args.host,
    account: args.user,
    character: args.character,
    iterations: iterations.length,
    succeeded: oks,
    failed: iterations.length - oks,
    avgDurationMs:
      iterations.length === 0
        ? 0
        : iterations.reduce((s, i) => s + i.durationMs, 0) / iterations.length,
    iterationsTail: iterations.slice(-10),
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
