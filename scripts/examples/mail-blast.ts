#!/usr/bin/env node --import tsx
/**
 * mail-blast.ts — send M in-game mails to N different targets, spaced out
 * over the configured duration.
 *
 * Each mail uses `ctx.sendMail(target, subject, body)`. Targets are taken
 * from the comma-separated `--targets` flag. The script visits them in
 * round-robin, optionally appending an index suffix per mail.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/mail-blast.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --targets=Alice,Bob,Charlie --count=12 --minutes=2
 */

import type { ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/mail-blast.ts';

interface ScriptArgs {
  targets: string[];
  count: number;
  subject: string;
  body: string;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('targets') ?? '';
  const targets = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    targets,
    count: Number.parseInt(extra.get('count') ?? '6', 10),
    subject: extra.get('subject') ?? 'Hello from swg-ts-client',
    body: extra.get('body') ?? 'This is an automated test mail from the swg-ts-client demo bot.',
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('mail', verbose);
    if (args.targets.length === 0) throw new Error('--targets is required (comma-separated names)');
    const intervalMs = Math.max(500, Math.floor(totalMs / Math.max(1, args.count)));
    log(
      `blasting ${args.count} mails across ${args.targets.length} targets, ~${intervalMs}ms apart`,
    );

    let sent = 0;
    const failures: Array<{ idx: number; target: string; error: string }> = [];
    for (let i = 0; i < args.count; i++) {
      const target = args.targets[i % args.targets.length] ?? args.targets[0];
      if (target === undefined) break;
      const subject = `${args.subject} #${i}`;
      const body = `${args.body}\n\nMail index: ${i}\nTarget: ${target}\n`;
      try {
        ctx.sendMail(target, subject, body);
        sent++;
        log(`mail ${i} → ${target}`);
      } catch (err) {
        failures.push({ idx: i, target, error: (err as Error).message });
      }
      if (i < args.count - 1) await ctx.wait(intervalMs);
    }
    log(`mail blast done: ${sent}/${args.count} sent, ${failures.length} failures`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Send a fixed number of mails to a list of targets.', [
      '  --targets=A,B,C          comma-separated recipient names (required)',
      '  --count=N                total mails (default 6)',
      '  --subject=STR            mail subject (default "Hello ...")',
      '  --body=STR               mail body (default short text)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const scenario = buildScenario(script, totalMs, args.verbose);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    targets: script.targets,
    count: script.count,
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
