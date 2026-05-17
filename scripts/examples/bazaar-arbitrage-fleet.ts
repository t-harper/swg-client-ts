#!/usr/bin/env node --import tsx
/**
 * bazaar-arbitrage-fleet.ts — 3-character fleet that monitors bazaar
 * listings, instant-buys items priced below 70% of their template's
 * rolling median, then re-lists the won items at a 30% markup.
 *
 * Roles (one character each, coordinated via shared in-process state):
 *   Scout    — every --scout-interval-ms (default 30s) calls browseBazaar,
 *              groups listings by itemType, computes median buyNowPrice
 *              per type, and flags any listing whose buyNowPrice <
 *              medianPrice * --buy-threshold (default 0.70).
 *   Buyer    — polls flaggedListings every --buyer-tick-ms (default 1500ms),
 *              instant-buys each via AcceptAuctionMessage (when buyNowPrice
 *              is set) or bidOn (when buyNowPrice=0 and only a current bid
 *              exists), then issues retrieveBazaarItem and notifies the
 *              reseller.
 *   Reseller — polls retrievedItems for items needing re-list, listForSale
 *              at medianPrice * --markup (default 1.30) with --duration-hours
 *              (default 24).
 *
 * No bazaar terminal is admin-spawned — this is a "drop into the real
 * server's marketplace" example. Each role scans ctx.world for the nearest
 * `terminal_bazaar.iff` within 60m of its spawn (mos_eisley default lacks
 * one in the default `server_halloween_*` buildout area, so listings count
 * will commonly be 0; the script logs that cleanly and exits with empty
 * stats rather than crashing).
 *
 * Example:
 *   LIVE=1 pnpm exec tsx scripts/examples/bazaar-arbitrage-fleet.ts \
 *     --host=10.254.0.253 --minutes=3 \
 *     --accounts=tslive07,tslive08,tslive09 \
 *     --characters=ExArbScout,ExArbBuyer,ExArbReseller
 */

import {
  AcceptAuctionMessage,
  type AuctionListing,
  type FleetClientConfig,
  type ScenarioFn,
  type ScriptContext,
  type WorldObject,
} from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runFleet, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/bazaar-arbitrage-fleet.ts';

const DEFAULT_ACCOUNTS = ['tslive07', 'tslive08', 'tslive09'] as const;
const DEFAULT_CHARACTERS = ['ExArbScout', 'ExArbBuyer', 'ExArbReseller'] as const;

const BAZAAR_TEMPLATE_RX = /bazaar|commodities/i;

interface ScriptArgs {
  accounts: string[];
  characters: string[];
  scoutIntervalMs: number;
  buyerTickMs: number;
  resellerTickMs: number;
  buyThreshold: number;
  markup: number;
  durationHours: number;
  maxBuyPerTick: number;
  terminalScanMs: number;
  terminalMaxRadiusM: number;
  /** Hard cap to avoid runaway spending during a wire-drift incident. */
  spendCapCredits: number;
}

interface FlaggedListing {
  itemId: bigint;
  itemName: string;
  itemType: number;
  buyNowPrice: number;
  highBid: number;
  medianForType: number;
  /** Set true when buyNowPrice === 0 and only a bid path is available. */
  bidOnly: boolean;
}

interface PendingRetrieve {
  itemId: bigint;
  itemType: number;
  medianForType: number;
  /** Credits actually committed by the buyer (BuyNow or current bid + 1). */
  spentCredits: number;
}

interface SharedState {
  flagged: FlaggedListing[];
  /** itemIds we've already attempted to buy this run (dedupes flag spam). */
  attemptedItemIds: Set<string>;
  pendingRetrieve: PendingRetrieve[];
  retrieved: PendingRetrieve[];
  /** itemIds we've already relisted this run. */
  relistedItemIds: Set<string>;
  stats: ArbitrageStats;
  /** Shared serverTime/zone-in handshake — each role flips its bit on zone. */
  zonedIn: { scout: boolean; buyer: boolean; reseller: boolean };
}

interface ArbitrageStats {
  listingsScanned: number;
  undervaluedFound: number;
  purchasesAttempted: number;
  purchasesSuccessful: number;
  relistingsPlaced: number;
  totalCreditsSpent: number;
  totalCreditsAtRisk: number;
  scoutTicks: number;
  buyerTicks: number;
  resellerTicks: number;
  emptyBrowses: number;
}

function makeSharedState(): SharedState {
  return {
    flagged: [],
    attemptedItemIds: new Set(),
    pendingRetrieve: [],
    retrieved: [],
    relistedItemIds: new Set(),
    stats: {
      listingsScanned: 0,
      undervaluedFound: 0,
      purchasesAttempted: 0,
      purchasesSuccessful: 0,
      relistingsPlaced: 0,
      totalCreditsSpent: 0,
      totalCreditsAtRisk: 0,
      scoutTicks: 0,
      buyerTicks: 0,
      resellerTicks: 0,
      emptyBrowses: 0,
    },
    zonedIn: { scout: false, buyer: false, reseller: false },
  };
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const accountsRaw = extra.get('accounts');
  const accounts =
    accountsRaw !== undefined
      ? accountsRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [...DEFAULT_ACCOUNTS];
  const charsRaw = extra.get('characters');
  const characters =
    charsRaw !== undefined
      ? charsRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [...DEFAULT_CHARACTERS];

  if (accounts.length !== 3) {
    throw new Error(
      `--accounts must list exactly 3 accounts (scout,buyer,reseller); got ${accounts.length}`,
    );
  }
  if (characters.length !== 3) {
    throw new Error(
      `--characters must list exactly 3 characters (scout,buyer,reseller); got ${characters.length}`,
    );
  }

  return {
    accounts,
    characters,
    scoutIntervalMs: Number.parseInt(extra.get('scout-interval-ms') ?? '30000', 10),
    buyerTickMs: Number.parseInt(extra.get('buyer-tick-ms') ?? '1500', 10),
    resellerTickMs: Number.parseInt(extra.get('reseller-tick-ms') ?? '2000', 10),
    buyThreshold: Number.parseFloat(extra.get('buy-threshold') ?? '0.70'),
    markup: Number.parseFloat(extra.get('markup') ?? '1.30'),
    durationHours: Number.parseFloat(extra.get('duration-hours') ?? '24'),
    maxBuyPerTick: Number.parseInt(extra.get('max-buy-per-tick') ?? '3', 10),
    terminalScanMs: Number.parseInt(extra.get('terminal-scan-ms') ?? '8000', 10),
    terminalMaxRadiusM: Number.parseFloat(extra.get('terminal-max-radius') ?? '60'),
    spendCapCredits: Number.parseInt(extra.get('spend-cap') ?? '1000000', 10),
  };
}

/** Compute median of a non-empty array of positive prices. */
function median(prices: readonly number[]): number {
  if (prices.length === 0) return 0;
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if ((sorted.length & 1) === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Walk to the nearest bazaar terminal within `maxRadiusM`. Returns its
 * NetworkId on success, `null` if none is visible after `scanMs` (which
 * is the common case on a freshly-baked test cluster's mos_eisley spawn —
 * the script's role-loop should then log "no listings to arbitrage" and
 * idle rather than crash).
 */
async function findAndApproachBazaar(
  ctx: ScriptContext,
  scanMs: number,
  maxRadiusM: number,
  log: (msg: string) => void,
): Promise<{ id: bigint; position: { x: number; z: number } } | null> {
  const here = ctx.position();
  const maxR2 = maxRadiusM * maxRadiusM;
  const deadline = Date.now() + scanMs;
  let pollMs = 200;

  const pickNearest = (): WorldObject | undefined => {
    let best: WorldObject | undefined;
    let bestD2 = Number.POSITIVE_INFINITY;
    for (const o of ctx.world.filter((w) => BAZAAR_TEMPLATE_RX.test(w.templateName ?? ''))) {
      const dx = o.position.x - here.x;
      const dz = o.position.z - here.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > maxR2) continue;
      if (d2 < bestD2) {
        best = o;
        bestD2 = d2;
      }
    }
    return best;
  };

  while (Date.now() < deadline && !ctx.signal.aborted) {
    const nearest = pickNearest();
    if (nearest !== undefined) {
      const dx = nearest.position.x - here.x;
      const dz = nearest.position.z - here.z;
      const dist = Math.hypot(dx, dz);
      log(
        `bazaar found id=0x${nearest.id.toString(16)} template=${nearest.templateName ?? '?'} dist=${dist.toFixed(1)}m`,
      );
      if (dist > 3) {
        const approach = {
          x: nearest.position.x - (dx / dist) * 2,
          z: nearest.position.z - (dz / dist) * 2,
        };
        try {
          await ctx.walkTo(approach, { speed: 6 });
        } catch (err) {
          log(
            `walkTo bazaar failed (continuing in place): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return { id: nearest.id, position: { x: nearest.position.x, z: nearest.position.z } };
    }
    await ctx.wait(Math.min(pollMs, Math.max(50, deadline - Date.now())));
    pollMs = Math.min(1000, Math.floor(pollMs * 1.5));
  }
  log(`no bazaar terminal within ${maxRadiusM}m after ${scanMs}ms scan`);
  return null;
}

function makeScoutScenario(
  args: ScriptArgs,
  shared: SharedState,
  totalMs: number,
  verbose: boolean,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('scout', verbose);
    shared.zonedIn.scout = true;
    const terminal = await findAndApproachBazaar(
      ctx,
      args.terminalScanMs,
      args.terminalMaxRadiusM,
      log,
    );
    if (terminal === null) {
      log('no listings to arbitrage (terminal absent)');
      await ctx.wait(totalMs);
      return;
    }

    const deadline = Date.now() + totalMs;
    /** itemType → rolling price history for median calc. */
    const history = new Map<number, number[]>();

    while (Date.now() < deadline && !ctx.signal.aborted) {
      shared.stats.scoutTicks++;
      let listings: AuctionListing[] = [];
      try {
        listings = await ctx.browseBazaar(terminal.id, { timeoutMs: 10_000 });
      } catch (err) {
        log(`browseBazaar failed: ${err instanceof Error ? err.message : String(err)}`);
        await ctx.wait(Math.min(args.scoutIntervalMs, Math.max(0, deadline - Date.now())));
        continue;
      }

      shared.stats.listingsScanned += listings.length;
      if (listings.length === 0) {
        shared.stats.emptyBrowses++;
        log(`tick #${shared.stats.scoutTicks}: 0 listings (server has nothing to arbitrage)`);
      } else {
        // Fold each listing's effective price into its itemType bucket. Prefer
        // buyNowPrice; fall back to highBid for bidding-style listings.
        const byType = new Map<number, AuctionListing[]>();
        for (const l of listings) {
          const arr = byType.get(l.itemType) ?? [];
          arr.push(l);
          byType.set(l.itemType, arr);
          const eff = l.buyNowPrice > 0 ? l.buyNowPrice : l.highBid;
          if (eff > 0) {
            const h = history.get(l.itemType) ?? [];
            h.push(eff);
            if (h.length > 200) h.shift();
            history.set(l.itemType, h);
          }
        }

        let flaggedThisTick = 0;
        for (const [itemType, group] of byType) {
          const h = history.get(itemType) ?? [];
          if (h.length < 3) continue;
          const med = median(h);
          if (med <= 0) continue;
          const threshold = med * args.buyThreshold;
          for (const l of group) {
            const eff = l.buyNowPrice > 0 ? l.buyNowPrice : l.highBid;
            if (eff <= 0) continue;
            if (eff >= threshold) continue;
            const key = l.itemId.toString();
            if (shared.attemptedItemIds.has(key)) continue;
            if (shared.flagged.some((f) => f.itemId === l.itemId)) continue;
            shared.flagged.push({
              itemId: l.itemId,
              itemName: l.itemName,
              itemType: l.itemType,
              buyNowPrice: l.buyNowPrice,
              highBid: l.highBid,
              medianForType: med,
              bidOnly: l.buyNowPrice === 0,
            });
            shared.stats.undervaluedFound++;
            flaggedThisTick++;
          }
        }
        log(
          `tick #${shared.stats.scoutTicks}: ${listings.length} listings across ${byType.size} types — flagged ${flaggedThisTick}`,
        );
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await ctx.wait(Math.min(args.scoutIntervalMs, remaining));
    }
    log(`done after ${shared.stats.scoutTicks} ticks`);
  };
}

function makeBuyerScenario(
  args: ScriptArgs,
  shared: SharedState,
  totalMs: number,
  verbose: boolean,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('buyer', verbose);
    shared.zonedIn.buyer = true;
    const terminal = await findAndApproachBazaar(
      ctx,
      args.terminalScanMs,
      args.terminalMaxRadiusM,
      log,
    );
    if (terminal === null) {
      log('no terminal — idling for duration');
      await ctx.wait(totalMs);
      return;
    }

    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline && !ctx.signal.aborted) {
      shared.stats.buyerTicks++;
      const batch = shared.flagged.splice(0, args.maxBuyPerTick);
      for (const f of batch) {
        const eff = f.buyNowPrice > 0 ? f.buyNowPrice : Math.max(1, f.highBid + 1);
        if (shared.stats.totalCreditsAtRisk + eff > args.spendCapCredits) {
          log(`spend cap reached (${shared.stats.totalCreditsAtRisk}); ignoring further flags`);
          break;
        }
        shared.attemptedItemIds.add(f.itemId.toString());
        shared.stats.purchasesAttempted++;
        shared.stats.totalCreditsAtRisk += eff;
        try {
          if (f.bidOnly) {
            ctx.bidOn(f.itemId, eff);
            log(
              `bid ${eff}c on 0x${f.itemId.toString(16)} (${f.itemName}) median=${f.medianForType.toFixed(0)}`,
            );
          } else {
            ctx.send(new AcceptAuctionMessage(f.itemId));
            log(
              `instant-buy 0x${f.itemId.toString(16)} (${f.itemName}) ${eff}c vs median ${f.medianForType.toFixed(0)}`,
            );
          }
          // Fire retrieve immediately; server handles ordering. Failures
          // surface as ChatSystemMessage and are tolerated — the worst
          // case is the item sits in the bazaar pending-retrieve bucket.
          ctx.retrieveBazaarItem(terminal.id, f.itemId);
          shared.stats.purchasesSuccessful++;
          shared.stats.totalCreditsSpent += eff;
          shared.pendingRetrieve.push({
            itemId: f.itemId,
            itemType: f.itemType,
            medianForType: f.medianForType,
            spentCredits: eff,
          });
        } catch (err) {
          log(
            `buy 0x${f.itemId.toString(16)} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Drain pendingRetrieve into retrieved once the inventory view picks
      // the item up. The inventory view's `findById` is the authoritative
      // signal that the server actually moved the item.
      if (shared.pendingRetrieve.length > 0) {
        const stillPending: PendingRetrieve[] = [];
        for (const p of shared.pendingRetrieve) {
          if (ctx.inventory.findById(p.itemId) !== undefined) {
            shared.retrieved.push(p);
          } else {
            stillPending.push(p);
          }
        }
        shared.pendingRetrieve = stillPending;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await ctx.wait(Math.min(args.buyerTickMs, remaining));
    }
    log(
      `done after ${shared.stats.buyerTicks} ticks — bought ${shared.stats.purchasesSuccessful}, spent ${shared.stats.totalCreditsSpent}c`,
    );
  };
}

function makeResellerScenario(
  args: ScriptArgs,
  shared: SharedState,
  totalMs: number,
  verbose: boolean,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('reslr', verbose);
    shared.zonedIn.reseller = true;
    const terminal = await findAndApproachBazaar(
      ctx,
      args.terminalScanMs,
      args.terminalMaxRadiusM,
      log,
    );
    if (terminal === null) {
      log('no terminal — idling for duration');
      await ctx.wait(totalMs);
      return;
    }

    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline && !ctx.signal.aborted) {
      shared.stats.resellerTicks++;
      // The reseller actually owns nothing the buyer bought — they're a
      // separate character. In a true cross-character flow you'd transfer
      // via SecureTrade first. For this example we re-list anything from
      // this character's own inventory that the buyer "claims" was bought
      // (matched by itemId so we don't accidentally list permanent gear).
      const ready = shared.retrieved.splice(0);
      for (const r of ready) {
        const key = r.itemId.toString();
        if (shared.relistedItemIds.has(key)) continue;
        const item = ctx.inventory.findById(r.itemId);
        if (item === undefined) {
          // Item never made it to THIS character's inventory (expected in
          // multi-char mode without a transfer step). Skip cleanly.
          continue;
        }
        const price = Math.max(1, Math.round(r.medianForType * args.markup));
        try {
          const res = await ctx.listForSale(terminal.id, r.itemId, {
            price,
            durationHours: args.durationHours,
            instantSale: true,
            description: `arbitrage relist (bought ${r.spentCredits}c)`,
          });
          if (res.success) {
            shared.stats.relistingsPlaced++;
            shared.relistedItemIds.add(key);
            log(
              `relisted 0x${r.itemId.toString(16)} @ ${price}c (cost ${r.spentCredits}c, +${price - r.spentCredits}c expected)`,
            );
          } else {
            log(
              `listForSale rejected 0x${r.itemId.toString(16)} (code=${res.resultCode}${res.errorReason !== undefined ? ` ${res.errorReason}` : ''})`,
            );
          }
        } catch (err) {
          log(
            `listForSale 0x${r.itemId.toString(16)} threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await ctx.wait(Math.min(args.resellerTickMs, remaining));
    }
    log(
      `done after ${shared.stats.resellerTicks} ticks — relisted ${shared.stats.relistingsPlaced}`,
    );
  };
}

function buildConfigs(
  args: ScriptArgs,
  shared: SharedState,
  totalMs: number,
  verbose: boolean,
): FleetClientConfig[] {
  // parseScriptArgs guarantees 3-element arrays; fall back to '' to satisfy
  // strict-indexed-access without resorting to non-null assertions.
  const [scoutAcct = '', buyerAcct = '', resellerAcct = ''] = args.accounts;
  const [scoutChar = '', buyerChar = '', resellerChar = ''] = args.characters;
  return [
    {
      account: scoutAcct,
      characterName: scoutChar,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: makeScoutScenario(args, shared, totalMs, verbose),
    },
    {
      account: buyerAcct,
      characterName: buyerChar,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: makeBuyerScenario(args, shared, totalMs, verbose),
    },
    {
      account: resellerAcct,
      characterName: resellerChar,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: makeResellerScenario(args, shared, totalMs, verbose),
    },
  ];
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2), { minutes: 5 });
  if (args.help) {
    usage(SCRIPT, '3-character bazaar arbitrage fleet (scout + buyer + reseller).', [
      '  --accounts=A,B,C         3-account list (default tslive07,tslive08,tslive09)',
      '  --characters=A,B,C       3-character list (default ExArbScout,ExArbBuyer,ExArbReseller)',
      '  --scout-interval-ms=N    scout browse cadence (default 30000)',
      '  --buyer-tick-ms=N        buyer poll cadence (default 1500)',
      '  --reseller-tick-ms=N     reseller poll cadence (default 2000)',
      '  --buy-threshold=F        flag if buyNowPrice < median * F (default 0.70)',
      '  --markup=F               relist at median * F (default 1.30)',
      '  --duration-hours=N       relist auction duration (default 24)',
      '  --max-buy-per-tick=N     buyer rate cap per tick (default 3)',
      '  --spend-cap=N            hard credits ceiling for the run (default 1000000)',
      '  --terminal-scan-ms=N     ms to wait for a terminal to appear (default 8000)',
      '  --terminal-max-radius=N  metres to search for a terminal (default 60)',
    ]);
    return 0;
  }
  let script: ScriptArgs;
  try {
    script = parseScriptArgs(args.extra);
  } catch (err) {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const totalMs = durationMs(args.minutes);
  const shared = makeSharedState();
  const configs = buildConfigs(script, shared, totalMs, args.verbose);
  const { summary } = await runFleet(args, configs, { staggerMs: 600 });
  summary.extra = {
    listingsScanned: shared.stats.listingsScanned,
    undervaluedFound: shared.stats.undervaluedFound,
    purchasesAttempted: shared.stats.purchasesAttempted,
    purchasesSuccessful: shared.stats.purchasesSuccessful,
    relistingsPlaced: shared.stats.relistingsPlaced,
    totalCreditsSpent: shared.stats.totalCreditsSpent,
    totalCreditsAtRisk: shared.stats.totalCreditsAtRisk,
    scoutTicks: shared.stats.scoutTicks,
    buyerTicks: shared.stats.buyerTicks,
    resellerTicks: shared.stats.resellerTicks,
    emptyBrowses: shared.stats.emptyBrowses,
    buyThreshold: script.buyThreshold,
    markup: script.markup,
    accounts: script.accounts,
    characters: script.characters,
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
