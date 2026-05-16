#!/usr/bin/env node --import tsx
/**
 * bank-tourist.ts — walk to a bank coordinate, "open" the bank container
 * (open a stub NetworkId if not given), dwell, then walk away.
 *
 * Designed to exercise the open-container + walk-away-equals-close pattern
 * over long durations. Without a real bank NetworkId from the cluster you're
 * testing, this falls back to opening the player inventory as a stand-in.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/bank-tourist.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --bank-x=20 --bank-z=20 --bank-id=0x9999 --dwell-ms=4000 --minutes=5
 */

import type { NetworkId, ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/bank-tourist.ts';

interface ScriptArgs {
  bankX: number;
  bankZ: number;
  bankId: NetworkId | null;
  dwellMs: number;
  walkAwayDistance: number;
  speed: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const idRaw = extra.get('bank-id');
  return {
    bankX: Number.parseFloat(extra.get('bank-x') ?? '15'),
    bankZ: Number.parseFloat(extra.get('bank-z') ?? '15'),
    bankId: idRaw !== undefined && idRaw !== '' ? (BigInt(idRaw) as NetworkId) : null,
    dwellMs: Number.parseInt(extra.get('dwell-ms') ?? '4000', 10),
    walkAwayDistance: Number.parseFloat(extra.get('walk-away') ?? '15'),
    speed: Number.parseFloat(extra.get('speed') ?? '5'),
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('bank', verbose);
    const spawn = ctx.sceneStart.startPosition;
    const playerId = ctx.sceneStart.playerNetworkId;
    const bankWorld = { x: spawn.x + args.bankX, z: spawn.z + args.bankZ };
    const awayWorld = { x: spawn.x - args.bankX, z: spawn.z - args.bankZ };
    log(
      `bank @ (${bankWorld.x.toFixed(1)}, ${bankWorld.z.toFixed(1)}) bankId=${args.bankId ?? '<inventory>'}`,
    );

    const deadline = Date.now() + totalMs;
    let trips = 0;
    while (Date.now() < deadline) {
      // 1. Walk to the bank
      log(`trip ${trips}: walking to bank`);
      await ctx.walkTo(bankWorld, { speed: args.speed });
      // 2. Open the container
      if (args.bankId !== null) {
        ctx.openContainer(args.bankId);
      } else {
        ctx.openPlayerInventory();
      }
      // 3. Dwell
      await ctx.wait(args.dwellMs);
      // 4. Walk away
      if (Date.now() < deadline) {
        await ctx.walkTo(awayWorld, { speed: args.speed });
      }
      trips++;
    }
    log(`done: ${trips} bank visits`);
    void playerId;
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Walk to a bank, open container, dwell, walk away. Loop.', [
      '  --bank-x=N               bank x offset from spawn (default 15)',
      '  --bank-z=N               bank z offset from spawn (default 15)',
      '  --bank-id=N              bank NetworkId (default: use player inventory)',
      '  --dwell-ms=N             ms held with bank open (default 4000)',
      '  --walk-away=N            distance to walk in the opposite direction (default 15)',
      '  --speed=N                walk speed (default 5)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const scenario = buildScenario(script, totalMs, args.verbose);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    ...script,
    bankId: script.bankId === null ? null : `0x${script.bankId.toString(16)}`,
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
