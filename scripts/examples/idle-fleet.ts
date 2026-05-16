#!/usr/bin/env node --import tsx
/**
 * idle-fleet.ts — Fleet of N characters that all log in, do nothing for the
 * duration, then log out. Pure connection-count load test.
 *
 * No script body: characters just sit through `holdZonedInMs`. Use this to
 * stress-test "N concurrent zoned-in clients" without confounding traffic
 * from movement or chat.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/idle-fleet.ts \
 *     --host=10.254.0.253 --count=10 --minutes=2
 */

import type { FleetClientConfig } from '../../src/index.js';
import { durationMs, formatJson, parseCommonArgs, runFleet, unique15, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/idle-fleet.ts';

interface ScriptArgs {
  count: number;
  prefix: string;
  staggerMs: number;
  maxConcurrent: number;
}

function parseScriptArgs(extra: Map<string, string>, defaultPrefix: string): ScriptArgs {
  return {
    count: Number.parseInt(extra.get('count') ?? '10', 10),
    prefix: extra.get('prefix') ?? defaultPrefix,
    staggerMs: Number.parseInt(extra.get('stagger-ms') ?? '200', 10),
    maxConcurrent: Number.parseInt(extra.get('max-concurrent') ?? '0', 10),
  };
}

function buildConfigs(args: ScriptArgs, runTag: string, holdMs: number): FleetClientConfig[] {
  const cfgs: FleetClientConfig[] = [];
  for (let i = 0; i < args.count; i++) {
    const account = unique15(`${args.prefix}${runTag}`, i);
    const characterName = `Idle${runTag}${i}`;
    cfgs.push({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: holdMs,
    });
  }
  return cfgs;
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2), { minutes: 1 });
  if (args.help) {
    usage(SCRIPT, 'Fleet of idle characters — connection-count load test.', [
      '  --count=N                concurrent characters (default 10)',
      '  --prefix=STR             account prefix (default "idle")',
      '  --stagger-ms=N           launch stagger between clients (default 200)',
      '  --max-concurrent=N       cap on parallel clients (default = count)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra, 'idle');
  const holdMs = durationMs(args.minutes);
  const runTag = (Date.now() % 1_000_000).toString(36);
  const configs = buildConfigs(script, runTag, holdMs);
  const runOpts: { staggerMs: number; maxConcurrent?: number } = { staggerMs: script.staggerMs };
  if (script.maxConcurrent > 0) runOpts.maxConcurrent = script.maxConcurrent;
  const { summary } = await runFleet(args, configs, runOpts);
  summary.extra = {
    count: script.count,
    holdMs,
    runTag,
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
