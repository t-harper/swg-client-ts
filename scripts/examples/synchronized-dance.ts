#!/usr/bin/env node --import tsx
/**
 * synchronized-dance.ts — Fleet of N characters all start the same dance at
 * the same time and hold for `--dance-seconds`.
 *
 * Each client:
 *   1. Waits for an absolute wall-clock anchor time so they all dance in lock
 *      step (we set the anchor to `Date.now() + startup-ms` at fleet launch).
 *   2. Stands up, calls `useAbility('startdance', 0n, <style>)`.
 *   3. Holds for the dance duration, then stops.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/synchronized-dance.ts \
 *     --host=10.254.0.253 --count=4 --dance-seconds=30 --minutes=1
 */

import type { FleetClientConfig, ScenarioFn } from '../../src/index.js';
import {
  durationMs,
  formatJson,
  makeLogger,
  parseCommonArgs,
  runFleet,
  unique15,
  usage,
} from './_lib.js';

const SCRIPT = 'scripts/examples/synchronized-dance.ts';

interface ScriptArgs {
  count: number;
  prefix: string;
  style: string;
  danceSeconds: number;
  startupMs: number;
  staggerMs: number;
}

function parseScriptArgs(extra: Map<string, string>, defaultPrefix: string): ScriptArgs {
  return {
    count: Number.parseInt(extra.get('count') ?? '4', 10),
    prefix: extra.get('prefix') ?? defaultPrefix,
    style: extra.get('style') ?? 'basic',
    danceSeconds: Number.parseInt(extra.get('dance-seconds') ?? '20', 10),
    startupMs: Number.parseInt(extra.get('startup-ms') ?? '6000', 10),
    staggerMs: Number.parseInt(extra.get('stagger-ms') ?? '300', 10),
  };
}

function makeScenario(
  args: ScriptArgs,
  anchorEpochMs: number,
  label: string,
  verbose: boolean,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger(label, verbose);
    const lag = anchorEpochMs - Date.now();
    log(`anchor in ${lag}ms`);
    if (lag > 0) await ctx.wait(lag);
    ctx.changePosture('standing');
    ctx.useAbility('startdance', 0n, args.style);
    log(`dancing ${args.style} for ${args.danceSeconds}s`);
    await ctx.wait(args.danceSeconds * 1000);
    ctx.useAbility('stopdance');
    await ctx.wait(500);
    log('done');
  };
}

function buildConfigs(
  args: ScriptArgs,
  runTag: string,
  anchorMs: number,
  verbose: boolean,
): FleetClientConfig[] {
  const cfgs: FleetClientConfig[] = [];
  for (let i = 0; i < args.count; i++) {
    const account = unique15(`${args.prefix}${runTag}`, i);
    const characterName = `Sync${runTag}${i}`;
    cfgs.push({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: makeScenario(args, anchorMs, `s${i}`, verbose),
    });
  }
  return cfgs;
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2), { minutes: 1 });
  if (args.help) {
    usage(SCRIPT, 'Synchronized dance — N characters start the same dance simultaneously.', [
      '  --count=N                characters (default 4)',
      '  --prefix=STR             account prefix (default "syncdnc")',
      '  --style=NAME             performance style (default "basic")',
      '  --dance-seconds=N        seconds to hold the dance (default 20)',
      '  --startup-ms=N           ms after launch when the dance begins (default 6000)',
      '  --stagger-ms=N           launch stagger between clients (default 300)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra, 'syncdnc');
  const totalMs = durationMs(args.minutes);
  void totalMs;
  const runTag = (Date.now() % 1_000_000).toString(36);
  const anchorMs = Date.now() + script.startupMs;
  const configs = buildConfigs(script, runTag, anchorMs, args.verbose);
  const { summary } = await runFleet(args, configs, { staggerMs: script.staggerMs });
  summary.extra = {
    count: script.count,
    style: script.style,
    danceSeconds: script.danceSeconds,
    anchorIso: new Date(anchorMs).toISOString(),
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
