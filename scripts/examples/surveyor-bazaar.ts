#!/usr/bin/env node --import tsx
/**
 * surveyor-bazaar.ts — solo surveyor → sampler → bazaar lister.
 *
 * End-to-end demonstration of the full survey → sample → list-for-sale
 * chain. The script:
 *
 *   1. Zones in, finds a survey tool in inventory.
 *   2. Calls `ctx.fetchSurveyResources(toolId)` to discover which resource
 *      types are currently spawned for the tool's class.
 *   3. Surveys EVERY spawned type and picks the one with the highest
 *      single-point peak concentration. That's our target resource.
 *   4. Walks to the peak sample's (x, z) so the sample-loop starts on the
 *      sweet spot.
 *   5. Sampling loop: alternates `ctx.sample(toolId, name)` with
 *      `ctx.waitForSampleEvent`, counting `'located'` events as
 *      successful harvests. Bails at `--target-units` (default 6) OR
 *      `--sample-timeout-ms` (default 120000).
 *   6. Calls `ctx.cancelSampling()` (walks 2.5m to bust the server loop)
 *      then settles for the inventory to reflect the freshly-stacked
 *      RCNO crate.
 *   7. Fetches the resource's full stats (OQ/CR/DR/...) via
 *      `ctx.fetchResourceAttributes([resourceId])`.
 *   8. Walks toward the nearest bazaar terminal in `ctx.world`. If none
 *      is in scene we soft-fail and skip listing — `mos_eisley`'s
 *      buildout doesn't include bazaars (see `live-bazaar.test.ts`
 *      preamble for the gory details), so this is the expected path on
 *      a fresh stock cluster.
 *   9. `browseBazaar(terminalId, { textFilterAll: resourceName })` to
 *      discover comps; computes median asking price.
 *  10. `listForSale(stackItemId, terminalId, { price: medianPrice, ... })`
 *      and records the resulting auctionId.
 *  11. Logs out cleanly.
 *
 * Soft-fails (with `--soft-fail-on=...` recorded in `summary.assertionFailures`):
 *   - no survey tool in inventory
 *   - no resource types spawned for any available class
 *   - no successful samples within the deadline (empty stack)
 *   - no bazaar terminal in scene
 *   - listing rejected by the server
 *
 * Example:
 *   LIVE=1 pnpm exec tsx scripts/examples/surveyor-bazaar.ts \
 *     --user=tslive02 --character=ExSurveyor --minutes=8
 *
 * The default 8 minutes is enough for the survey-pick → walk → 6 sample
 * ticks → bazaar discovery cycle on a healthy cluster. Increase
 * `--minutes` (and `--sample-timeout-ms`) for slower spawns.
 */

import type {
  AttributePair,
  AuctionListing,
  NetworkId,
  ResourceListItem,
  ScenarioFn,
  ScriptContext,
  SurveyPoint,
  WorldObject,
} from '../../src/index.js';
import { findSurveyTools } from './_lib-survey.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/surveyor-bazaar.ts';

interface ScriptArgs {
  targetUnits: number;
  sampleTimeoutMs: number;
  perSampleTickMs: number;
  surveyTimeoutMs: number;
  walkSpeed: number;
  bazaarScanMs: number;
  bazaarMaxRadiusM: number;
  listingDurationHours: number;
  defaultPrice: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    targetUnits: Number.parseInt(extra.get('target-units') ?? '6', 10),
    sampleTimeoutMs: Number.parseInt(extra.get('sample-timeout-ms') ?? '120000', 10),
    perSampleTickMs: Number.parseInt(extra.get('per-sample-tick-ms') ?? '35000', 10),
    surveyTimeoutMs: Number.parseInt(extra.get('survey-timeout-ms') ?? '8000', 10),
    walkSpeed: Number.parseFloat(extra.get('walk-speed') ?? '6'),
    bazaarScanMs: Number.parseInt(extra.get('bazaar-scan-ms') ?? '5000', 10),
    bazaarMaxRadiusM: Number.parseFloat(extra.get('bazaar-max-radius') ?? '800'),
    listingDurationHours: Number.parseInt(extra.get('listing-duration-hours') ?? '24', 10),
    defaultPrice: Number.parseInt(extra.get('default-price') ?? '500', 10),
  };
}

interface PeakPick {
  /** The resource type the peak belongs to. */
  resource: ResourceListItem;
  /** The single sample point with the highest density. */
  peakPoint: SurveyPoint;
  /** That density as a 0..1 efficiency. */
  peakEfficiency: number;
}

/**
 * Survey every type the tool advertises and pick the one with the
 * single highest peak sample. Ties are broken by first-seen. Returns
 * `null` when no type returns any sample at all.
 *
 * Distinct from `findBestResource.ts`'s strategy (which optimises across
 * a planet-wide walking grid): here we're surveying ONE location, and we
 * want the most-concentrated single sweet spot of any spawned resource.
 */
async function pickBestResourceAtLocation(
  ctx: ScriptContext,
  toolId: NetworkId,
  types: ResourceListItem[],
  surveyTimeoutMs: number,
  log: (msg: string) => void,
): Promise<PeakPick | null> {
  let best: PeakPick | null = null;
  for (const type of types) {
    ctx.survey(toolId, type.resourceName);
    try {
      const { points } = await ctx.waitForSurvey({ timeoutMs: surveyTimeoutMs });
      let typePeak: SurveyPoint | null = null;
      for (const p of points) {
        if (typePeak === null || p.efficiency > typePeak.efficiency) typePeak = p;
      }
      const peakPct = typePeak === null ? 0 : typePeak.efficiency * 100;
      log(`  ${type.resourceName}: ${points.length} pts, peak ${peakPct.toFixed(1)}%`);
      if (typePeak !== null && (best === null || typePeak.efficiency > best.peakEfficiency)) {
        best = { resource: type, peakPoint: typePeak, peakEfficiency: typePeak.efficiency };
      }
    } catch {
      log(`  ${type.resourceName}: survey timed out`);
    }
  }
  return best;
}

const BAZAAR_PATTERN = /bazaar|terminal_bazaar|vendor_bazaar/i;

function isBazaarObject(o: WorldObject): boolean {
  const t = o.templateName;
  return t !== undefined && BAZAAR_PATTERN.test(t);
}

/**
 * Sweep `ctx.world` for the nearest bazaar terminal, polling for up to
 * `scanMs` because baselines after zone-in can take a beat to land.
 * Returns the nearest within `maxRadiusM`, or `undefined`.
 */
async function findNearestBazaar(
  ctx: ScriptContext,
  scanMs: number,
  maxRadiusM: number,
  log: (msg: string) => void,
): Promise<WorldObject | undefined> {
  const here = ctx.position();
  const maxR2 = maxRadiusM * maxRadiusM;
  const deadline = Date.now() + scanMs;
  let pollMs = 250;
  while (Date.now() < deadline) {
    const candidates = ctx.world.filter(isBazaarObject);
    let nearest: WorldObject | undefined;
    let nearestD2 = Number.POSITIVE_INFINITY;
    for (const o of candidates) {
      const dx = o.position.x - here.x;
      const dz = o.position.z - here.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > maxR2) continue;
      if (d2 < nearestD2) {
        nearest = o;
        nearestD2 = d2;
      }
    }
    if (nearest !== undefined) {
      log(
        `bazaar in scene: id=0x${nearest.id.toString(16)} ` +
          `template=${nearest.templateName} dist=${Math.sqrt(nearestD2).toFixed(1)}m`,
      );
      return nearest;
    }
    await ctx.wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    pollMs = Math.min(1000, pollMs * 2);
  }
  return undefined;
}

/** Compute the median listing price, biased toward `buyNowPrice` then `highBid`. */
function medianPrice(listings: readonly AuctionListing[]): number | null {
  const prices = listings
    .map((l) => (l.buyNowPrice > 0 ? l.buyNowPrice : l.highBid))
    .filter((p) => p > 0)
    .sort((a, b) => a - b);
  if (prices.length === 0) return null;
  const mid = Math.floor(prices.length / 2);
  if (prices.length % 2 === 1) return prices[mid] ?? null;
  const lo = prices[mid - 1];
  const hi = prices[mid];
  if (lo === undefined || hi === undefined) return null;
  return Math.round((lo + hi) / 2);
}

/**
 * Convert attribute pairs into a flat `{key: value}` for the JSON
 * summary, normalising the keys to the SWG short-form (OQ/CR/DR/...).
 */
function attrsToObject(pairs: readonly AttributePair[]): Record<string, string> {
  const SHORT: Record<string, string> = {
    quality: 'OQ',
    cold_resist: 'CR',
    cold_resistance: 'CR',
    conductivity: 'CD',
    decay_resist: 'DR',
    decay_resistance: 'DR',
    entangle_resistance: 'ER',
    flavor: 'FL',
    heat_resist: 'HR',
    heat_resistance: 'HR',
    malleability: 'MA',
    potential_energy: 'PE',
    shock_resistance: 'SR',
    toughness: 'UT',
    unit_toughness: 'UT',
    class_name: 'class',
    parent_class_name: 'parentClass',
  };
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const tail = p.key.replace(/^@obj_attr_n:/, '').replace(/^res_/, '');
    out[SHORT[tail] ?? tail] = p.value;
  }
  return out;
}

interface RunSummary {
  toolId: string | null;
  bestResource: string | null;
  peakConcentrationPct: number;
  peakAt: { x: number; z: number } | null;
  unitsHarvested: number;
  sampleEvents: Record<string, number>;
  attributes: Record<string, string> | null;
  bazaarTerminalId: string | null;
  bazaarTerminalDistanceM: number | null;
  compsCount: number;
  compsAskingPriceMedian: number | null;
  listedPrice: number | null;
  listingId: string | null;
  listingError: string | null;
  status: string;
}

function buildScenario(args: ScriptArgs, verbose: boolean, out: RunSummary): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('survbz', verbose);
    out.status = 'starting';

    // Let baselines + containment settle so inventory is queryable.
    await ctx.wait(2_500);

    // ── 1. Find a survey tool ─────────────────────────────────────────
    const tools = findSurveyTools(ctx);
    if (tools.size === 0) {
      const reason = 'no survey tool in inventory';
      ctx.fail(reason);
      out.status = reason;
      log(reason);
      await ctx.logout();
      return;
    }
    // Prefer the universal `*` tool when present; otherwise the first
    // class-specific tool. Either way records its id.
    const [chosenClass, chosenToolId] = pickPrimaryTool(tools);
    out.toolId = `0x${chosenToolId.toString(16)}`;
    log(`using ${chosenClass} tool ${out.toolId}`);

    // ── 2. Resource list for this tool ────────────────────────────────
    let typeList: ResourceListItem[];
    try {
      typeList = await ctx.fetchSurveyResources(chosenToolId, {
        timeoutMs: args.surveyTimeoutMs,
      });
    } catch {
      const reason = `fetchSurveyResources timed out for tool ${out.toolId}`;
      ctx.fail(reason);
      out.status = reason;
      log(reason);
      await ctx.logout();
      return;
    }
    if (typeList.length === 0) {
      const reason = `no resources spawned for ${chosenClass} (empty list from server)`;
      ctx.fail(reason);
      out.status = reason;
      log(reason);
      await ctx.logout();
      return;
    }
    log(`resource list: ${typeList.length} type(s)`);

    // ── 3. Survey each type → pick highest-peak ───────────────────────
    const pick = await pickBestResourceAtLocation(
      ctx,
      chosenToolId,
      typeList,
      args.surveyTimeoutMs,
      log,
    );
    if (pick === null) {
      const reason = 'all surveys empty — nothing to harvest';
      ctx.fail(reason);
      out.status = reason;
      log(reason);
      await ctx.logout();
      return;
    }
    out.bestResource = pick.resource.resourceName;
    out.peakConcentrationPct = Math.round(pick.peakEfficiency * 1000) / 10;
    out.peakAt = { x: pick.peakPoint.location.x, z: pick.peakPoint.location.z };
    log(
      `peak: ${pick.resource.resourceName} @ ` +
        `(${pick.peakPoint.location.x.toFixed(1)}, ${pick.peakPoint.location.z.toFixed(1)}) ` +
        `= ${out.peakConcentrationPct}%`,
    );

    // ── 4. Walk to the peak sample point ──────────────────────────────
    await ctx.walkTo(out.peakAt, { speed: args.walkSpeed });
    await ctx.wait(1_500);
    log(`arrived at peak; starting sample loop (target ${args.targetUnits} units)`);

    // ── 5. Sampling loop ──────────────────────────────────────────────
    // Snapshot the resource type's existing crate quantity so we know
    // when our run actually adds units (sampling stacks into a matching
    // crate if one exists).
    const baselineUnits = currentUnitsFor(ctx, pick.resource.resourceId);
    log(`baseline crate quantity for ${pick.resource.resourceName}: ${baselineUnits}`);

    const sampleEvents: Record<string, number> = {};
    const sampleDeadline = Date.now() + args.sampleTimeoutMs;
    let located = 0;
    while (located < args.targetUnits && Date.now() < sampleDeadline) {
      ctx.sample(chosenToolId, pick.resource.resourceName);
      try {
        const ev = await ctx.waitForSampleEvent({
          timeoutMs: Math.min(args.perSampleTickMs, Math.max(0, sampleDeadline - Date.now())),
        });
        sampleEvents[ev.kind] = (sampleEvents[ev.kind] ?? 0) + 1;
        log(`sample event #${located + 1 + (sampleEvents.failed ?? 0)}: ${ev.kind}`);
        if (ev.kind === 'located') located++;
        if (ev.kind === 'mind' || ev.kind === 'density' || ev.kind === 'cancel') {
          log(`server ended the sample loop (${ev.kind}); stopping`);
          break;
        }
      } catch {
        sampleEvents.timeout = (sampleEvents.timeout ?? 0) + 1;
        log('sample tick timed out; bailing');
        break;
      }
    }
    out.sampleEvents = sampleEvents;
    out.unitsHarvested = located;

    // Always cancel the loop so we don't leave server-side state lingering.
    await ctx.cancelSampling();
    await ctx.wait(2_500);

    // ── 6. Fetch the resource's stats ─────────────────────────────────
    try {
      const attrMap = await ctx.fetchResourceAttributes([pick.resource.resourceId], {
        timeoutMs: 8_000,
      });
      const pairs = attrMap.get(pick.resource.resourceId);
      out.attributes = pairs !== undefined ? attrsToObject(pairs) : null;
      if (out.attributes !== null) {
        log(
          `stats: ${Object.entries(out.attributes)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}`,
        );
      }
    } catch {
      log('fetchResourceAttributes failed; skipping stats');
    }

    // ── 7. Find a bazaar terminal ─────────────────────────────────────
    // (The script always tries — even when 0 units harvested — so the
    // discovery path is exercised. The list step bails when we have
    // nothing to sell.)
    const bazaar = await findNearestBazaar(ctx, args.bazaarScanMs, args.bazaarMaxRadiusM, log);
    if (bazaar === undefined) {
      const reason = `no bazaar terminal in scene within ${args.bazaarMaxRadiusM}m`;
      ctx.fail(reason);
      out.status = reason;
      log(reason);
      await ctx.logout();
      return;
    }
    out.bazaarTerminalId = `0x${bazaar.id.toString(16)}`;
    const dx = bazaar.position.x - ctx.position().x;
    const dz = bazaar.position.z - ctx.position().z;
    out.bazaarTerminalDistanceM = Math.round(Math.sqrt(dx * dx + dz * dz) * 10) / 10;

    // Walk close enough to the terminal that the server accepts our
    // commodities ops (the live server uses an interactability check;
    // ~8m is well inside it).
    const approach = approachPoint(bazaar.position, ctx.position(), 6);
    await ctx.walkTo(approach, { speed: args.walkSpeed });
    await ctx.wait(1_500);

    // ── 8. Browse for comps + compute median ──────────────────────────
    let comps: AuctionListing[] = [];
    try {
      comps = await ctx.browseBazaar(bazaar.id, {
        textFilterAll: pick.resource.resourceName,
        timeoutMs: 8_000,
      });
    } catch {
      log('browseBazaar timed out; falling back to default-price');
    }
    out.compsCount = comps.length;
    const med = medianPrice(comps);
    out.compsAskingPriceMedian = med;
    const askPrice = med ?? args.defaultPrice;
    log(`comps: ${comps.length} listings, median=${med ?? '(none)'}, listing at ${askPrice}`);

    // ── 9. Find our freshly-stacked crate ─────────────────────────────
    // The sample loop stacks new units into an existing crate of the
    // same resourceType OR creates a new crate (RCNO) in inventory.
    // Either way it shows up in `ctx.inventory.resources()`.
    if (located === 0 && baselineUnits === 0) {
      const reason = 'no units harvested and no pre-existing crate — nothing to list';
      ctx.fail(reason);
      out.status = reason;
      log(reason);
      await ctx.logout();
      return;
    }
    const crate = ctx.inventory
      .resources()
      .find((c) => c.resourceType === pick.resource.resourceId);
    if (crate === undefined) {
      const reason = `crate for ${pick.resource.resourceName} not visible in inventory yet`;
      ctx.fail(reason);
      out.status = reason;
      log(reason);
      await ctx.logout();
      return;
    }
    log(
      `crate id=0x${crate.containerId.toString(16)} quantity=${crate.quantity} ` +
        `(harvested this run: ${crate.quantity - baselineUnits})`,
    );

    // ── 10. List it for sale ──────────────────────────────────────────
    const description =
      `${pick.resource.resourceName} — ` +
      `${crate.quantity} units${out.attributes !== null ? ` (${formatAttrsShort(out.attributes)})` : ''}`;
    out.listedPrice = askPrice;
    try {
      const r = await ctx.listForSale(bazaar.id, crate.containerId, {
        price: askPrice,
        durationHours: args.listingDurationHours,
        description,
        timeoutMs: 10_000,
      });
      if (r.success && r.auctionId !== undefined) {
        out.listingId = `0x${r.auctionId.toString(16)}`;
        out.status = 'ok';
        log(`listed: auctionId=${out.listingId} resultCode=${r.resultCode}`);
      } else {
        const reason = `listing rejected (resultCode=${r.resultCode}${
          r.errorReason !== undefined ? ` reason="${r.errorReason}"` : ''
        })`;
        out.listingError = reason;
        out.status = reason;
        ctx.fail(reason);
        log(reason);
      }
    } catch (err) {
      const reason = `listForSale threw: ${err instanceof Error ? err.message : String(err)}`;
      out.listingError = reason;
      out.status = reason;
      ctx.fail(reason);
      log(reason);
    }

    await ctx.logout();
  };
}

/**
 * Prefer the universal `*` tool (one tool handles every class), else
 * return the first entry in iteration order. Both are valid for our
 * purposes — the caller doesn't care which class won.
 */
function pickPrimaryTool(tools: Map<string, NetworkId>): [string, NetworkId] {
  const universal = tools.get('*');
  if (universal !== undefined) return ['*', universal];
  const first = tools.entries().next();
  if (first.done === true) {
    throw new Error('pickPrimaryTool: caller must check tools.size first');
  }
  return first.value;
}

/**
 * Current quantity of a resource crate whose `resourceType` matches
 * `resourceId`. Returns 0 if no matching crate exists (sampling will
 * create one).
 */
function currentUnitsFor(ctx: ScriptContext, resourceId: NetworkId): number {
  const crate = ctx.inventory.resources().find((c) => c.resourceType === resourceId);
  return crate?.quantity ?? 0;
}

/**
 * Step `step` meters from `from` toward `target` (clamped if target is
 * already closer than `step`). Used to approach a terminal without
 * walking THROUGH it.
 */
function approachPoint(
  target: { x: number; z: number },
  from: { x: number; z: number },
  step: number,
): { x: number; z: number } {
  const dx = from.x - target.x;
  const dz = from.z - target.z;
  const dist = Math.hypot(dx, dz);
  if (dist <= step) return { x: target.x, z: target.z };
  return { x: target.x + (dx / dist) * step, z: target.z + (dz / dist) * step };
}

function formatAttrsShort(attrs: Record<string, string>): string {
  const ORDER = ['OQ', 'CR', 'DR', 'PE', 'SR', 'UT', 'CD', 'HR', 'MA', 'FL', 'ER'];
  const parts: string[] = [];
  for (const key of ORDER) {
    const v = attrs[key];
    if (v !== undefined) parts.push(`${key}=${v}`);
  }
  return parts.join(' ');
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2), {
    minutes: 8,
  });
  if (args.help) {
    usage(SCRIPT, 'Surveyor-to-bazaar — full survey/sample/list-for-sale chain.', [
      '  --target-units=N             stop sampling after this many "located" events (default 6)',
      '  --sample-timeout-ms=N        overall sampling budget in ms (default 120000)',
      '  --per-sample-tick-ms=N       per-tick timeout while sampling (default 35000)',
      '  --survey-timeout-ms=N        per-type survey response timeout (default 8000)',
      '  --walk-speed=N               m/s (default 6)',
      '  --bazaar-scan-ms=N           ms to wait for a bazaar baseline (default 5000)',
      '  --bazaar-max-radius=N        ignore bazaars farther than this from spawn (m, default 800)',
      '  --listing-duration-hours=N   auction window (default 24)',
      '  --default-price=N            credits when no comps exist (default 500)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const _totalMs = durationMs(args.minutes);
  const out: RunSummary = {
    toolId: null,
    bestResource: null,
    peakConcentrationPct: 0,
    peakAt: null,
    unitsHarvested: 0,
    sampleEvents: {},
    attributes: null,
    bazaarTerminalId: null,
    bazaarTerminalDistanceM: null,
    compsCount: 0,
    compsAskingPriceMedian: null,
    listedPrice: null,
    listingId: null,
    listingError: null,
    status: 'unstarted',
  };
  const scenario = buildScenario(script, args.verbose, out);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    ...out,
    config: script,
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
