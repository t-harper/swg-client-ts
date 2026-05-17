#!/usr/bin/env node --import tsx
/**
 * inventory-open-close.ts — open inventory, dwell, close, dwell, repeat.
 *
 * Soak-tests the container UI handler. With the always-on auto-sync
 * inventory view (`ctx.inventory.items`), the explicit open/close cycle
 * is now informational only — the view is fresh from the moment zone-in
 * completes regardless. Each cycle:
 *   1. ctx.openPlayerInventory()                      (wire send — UI hint)
 *   2. wait `--open-ms`, optionally log `ctx.inventory.items.length`
 *   3. ctx.closeContainer(playerNetworkId)            (no-op wire send)
 *   4. wait `--close-ms`
 *
 * Example:
 *   pnpm exec tsx scripts/examples/inventory-open-close.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --open-ms=2000 --close-ms=1000 --minutes=5
 */

import type { ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/inventory-open-close.ts';

interface ScriptArgs {
  openMs: number;
  closeMs: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    openMs: Number.parseInt(extra.get('open-ms') ?? '2000', 10),
    closeMs: Number.parseInt(extra.get('close-ms') ?? '1000', 10),
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('inv', verbose);
    const playerId = ctx.sceneStart.playerNetworkId;
    log(`open-close cycle: open=${args.openMs}ms close=${args.closeMs}ms`);

    const deadline = Date.now() + totalMs;
    let cycle = 0;
    while (Date.now() < deadline) {
      ctx.openPlayerInventory();
      await ctx.wait(args.openMs);
      const items = ctx.inventory.items;
      if (cycle === 0 || cycle % 10 === 0) {
        log(`cycle ${cycle}: ctx.inventory has ${items.length} items (containerId=${
          ctx.inventory.containerId === null ? 'null' : `0x${ctx.inventory.containerId.toString(16)}`
        })`);
      }
      ctx.closeContainer(playerId);
      await ctx.wait(args.closeMs);
      cycle++;
    }
    log(`done: ${cycle} open/close cycles`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Open/close inventory in a loop — container UI soak test.', [
      '  --open-ms=N              ms held with inventory open (default 2000)',
      '  --close-ms=N             ms idle after close (default 1000)',
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
