#!/usr/bin/env node --import tsx
/**
 * shuttle-traveler.ts — find the nearest ticket vendor, enumerate
 * destinations, buy a ticket to the requested destination, then board
 * the shuttle.
 *
 * Walks through every layer of `ctx.travel.*`:
 *   1. `ctx.travel.findTicketVendor()` — auto-resolve the nearby terminal.
 *   2. `ctx.travel.listDestinations()` — log every (planet, point) pair.
 *   3. `ctx.travel.buyTicket({ destination })` — execute the purchase.
 *   4. `ctx.travel.useTicket()` — board the shuttle and warp.
 *
 * Default account is `tslive20` (admin-allowlisted) with character
 * `ExShuttle`. Pass `--user=...` / `--character=...` to override.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/shuttle-traveler.ts \
 *     --host=10.254.0.253 --destination=bestine
 */

import type { ScenarioFn } from '../../src/index.js';
import { formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/shuttle-traveler.ts';

interface ScriptArgs {
  destination: string;
  destinationPlanet: string | null;
  /** Max ms to wait for the planet baseline flood to surface the vendor. */
  scanMs: number;
  /** If the vendor isn't in the initial baseline window, walk this far to find one. */
  maxRadiusM: number;
  /** Whether to actually board the shuttle after buying. */
  board: boolean;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    destination: extra.get('destination') ?? 'bestine',
    destinationPlanet: extra.get('destination-planet') ?? null,
    scanMs: Number.parseInt(extra.get('scan-ms') ?? '4000', 10),
    maxRadiusM: Number.parseFloat(extra.get('max-radius') ?? '250'),
    board: (extra.get('board') ?? 'true') !== 'false',
  };
}

function buildScenario(args: ScriptArgs, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('shuttle', verbose);

    await ctx.wait(args.scanMs);

    let vendor = ctx.travel.findTicketVendor();
    if (vendor === undefined) {
      const wide = ctx.travel.findTicketVendor({ maxRadiusM: args.maxRadiusM });
      if (wide === undefined) {
        log(`no ticket vendor within ${args.maxRadiusM}m of spawn; exiting`);
        await ctx.logout();
        return;
      }
      log(
        `vendor at (${wide.position.x.toFixed(1)}, ${wide.position.z.toFixed(1)}) — walking closer`,
      );
      await ctx.walkTo({ x: wide.position.x - 4, z: wide.position.z - 4 }, { speed: 8 });
      await ctx.wait(1_000);
      vendor = ctx.travel.findTicketVendor();
      if (vendor === undefined) vendor = wide;
    }
    log(`vendor: id=0x${vendor.id.toString(16)} template=${vendor.templateName ?? '<none>'}`);

    const destinations = await ctx.listDestinations({ timeoutMs: 12_000 });
    log(`destinations (${destinations.length}):\n  ${destinations.join('\n  ')}`);

    log(`buying ticket to ${args.destinationPlanet ?? '*'}/${args.destination}`);
    const buyOpts: Parameters<typeof ctx.buyTicket>[0] = {
      destination: args.destination,
      timeoutMs: 15_000,
    };
    if (args.destinationPlanet !== null) buyOpts.destinationPlanet = args.destinationPlanet;
    const ticketId = await ctx.buyTicket(buyOpts);
    log(`ticket purchased: id=0x${ticketId.toString(16)}`);

    if (!args.board) {
      log('--board=false → skipping useTicket; logging out');
      await ctx.logout();
      return;
    }

    const collector = ctx.travel.findTicketCollector({ maxRadiusM: 80 });
    if (collector === undefined) {
      log('no collector / shuttle in range; cannot board');
      await ctx.logout();
      return;
    }
    log(
      `collector: id=0x${collector.id.toString(16)} template=${collector.templateName ?? '<none>'} — walking up`,
    );
    await ctx.walkTo({ x: collector.position.x, z: collector.position.z }, { speed: 8 });
    await ctx.wait(1_000);
    const arrival = await ctx.useTicket({ ticketId, timeoutMs: 25_000 });
    log(
      `arrived at ${arrival.destinationPlanet} (${arrival.destinationPosition.x.toFixed(1)}, ${arrival.destinationPosition.z.toFixed(1)})`,
    );
    await ctx.wait(2_000);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2), {
    user: 'tslive20',
    character: 'ExShuttle',
  });
  if (args.help) {
    usage(SCRIPT, 'Buy a shuttle ticket and use it.', [
      '  --destination=NAME       travel point (default bestine)',
      '  --destination-planet=NM  override planet (otherwise: auto-detect)',
      '  --scan-ms=N              wait for vendor baseline (default 4000)',
      '  --max-radius=N           walking range to look for vendor (default 250)',
      '  --board=false            buy the ticket but skip boarding',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const scenario = buildScenario(script, args.verbose);
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
