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
  /** Optional explicit account list (comma-separated). When supplied,
   * overrides the generated `${prefix}${runTag}${i}` names — useful when
   * the test cluster only permits character creation on a pre-allowlisted
   * set of admin accounts (e.g. `swg,swg2,swg3,swg4,swg5`). */
  accounts: string[];
  /** Optional explicit character-name list (comma-separated). Pairs with
   * `accounts` 1:1. When omitted, names default to `Idle<runTag><i>`. */
  characters: string[];
}

function parseScriptArgs(extra: Map<string, string>, defaultPrefix: string): ScriptArgs {
  const accountsRaw = extra.get('accounts') ?? '';
  const accounts = accountsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const charsRaw = extra.get('characters') ?? '';
  const characters = charsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    count: Number.parseInt(extra.get('count') ?? '10', 10),
    prefix: extra.get('prefix') ?? defaultPrefix,
    staggerMs: Number.parseInt(extra.get('stagger-ms') ?? '200', 10),
    maxConcurrent: Number.parseInt(extra.get('max-concurrent') ?? '0', 10),
    accounts,
    characters,
  };
}

function buildConfigs(args: ScriptArgs, runTag: string, holdMs: number): FleetClientConfig[] {
  const cfgs: FleetClientConfig[] = [];
  // When --accounts is set, use exactly that list (ignoring --count).
  const explicit = args.accounts.length > 0;
  const n = explicit ? args.accounts.length : args.count;
  for (let i = 0; i < n; i++) {
    const account = explicit
      ? (args.accounts[i] ?? unique15(`${args.prefix}${runTag}`, i))
      : unique15(`${args.prefix}${runTag}`, i);
    const characterName =
      args.characters[i] !== undefined ? args.characters[i]! : `Idle${runTag}${i}`;
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
      '  --accounts=A,B,C         explicit account list (overrides --count + --prefix)',
      '  --characters=A,B,C       explicit character list (pairs 1:1 with --accounts)',
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
