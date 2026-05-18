#!/usr/bin/env node --import tsx
/**
 * cross-planet-pilgrim.ts — solo shuttle traveller + mission round-trip.
 *
 * Demonstrates the ctx.travel API end-to-end:
 *   1. (optional) admin-warp to a starport anchor for repeatable test runs
 *      (`--warp-to-x` / `--warp-to-z` + an `--admin-deposit=N` top-up so the
 *      `purchaseTicket` server-side cost check passes for a fresh character).
 *   2. Find the nearest ticket-vendor terminal via `ctx.travel.findTicketVendor`.
 *   3. Enumerate destinations via `ctx.travel.listDestinations` and pick one
 *      on a different planet from where we spawned.
 *   4. Buy a ticket via `ctx.travel.buyTicket`. The helper drives the full
 *      EnterTicketPurchaseMode → PlanetTravelPointListRequest/Response →
 *      `purchaseTicket` command-queue → inventory-poll handshake internally.
 *   5. Walk to the ticket collector, board via `ctx.travel.useTicket`.
 *   6. Wait for the destination's CmdStartScene + SceneEndBaselines to fire,
 *      ack with CmdSceneReady (the orchestrator already does this for the
 *      initial zone-in; the re-zone is on us).
 *   7. At the destination, find a mission terminal, accept the top-payout
 *      mission, then `removeMission` to round-trip the wire path.
 *
 * Soft-fails (recorded in `summary.bailReason`):
 *   - no ticket vendor in scene (walk distance too far for default radius)
 *   - vendor has no destinations on a different planet
 *   - `buyTicket` rejected (insufficient credits, point name mismatch)
 *   - no ticket collector / shuttle in scene after purchase
 *   - re-zone CmdStartScene never arrives within timeout
 *   - no mission terminal at the destination
 *
 * Example:
 *   LIVE=1 pnpm exec tsx scripts/examples/cross-planet-pilgrim.ts \
 *     --user=tslive18 --character=ExPilgrim \
 *     --warp-to-x=3528 --warp-to-z=-4806 --admin-deposit=20000 \
 *     --destination=bestine
 */

import {
  CmdSceneReady,
  CmdStartScene,
  ConGenericMessage,
  type NetworkId,
  type ScenarioFn,
  SceneEndBaselines,
  type ScriptContext,
} from '../../src/index.js';
import { formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/cross-planet-pilgrim.ts';

interface ScriptArgs {
  destination: string;
  destinationPlanet: string | null;
  scanMs: number;
  vendorRadiusM: number;
  walkSpeed: number;
  rezoneTimeoutMs: number;
  warpToX: number | null;
  warpToZ: number | null;
  adminDeposit: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const warpX = extra.get('warp-to-x');
  const warpZ = extra.get('warp-to-z');
  return {
    destination: extra.get('destination') ?? 'bestine',
    destinationPlanet: extra.get('destination-planet') ?? null,
    scanMs: Number.parseInt(extra.get('scan-ms') ?? '5000', 10),
    vendorRadiusM: Number.parseFloat(extra.get('vendor-radius') ?? '120'),
    walkSpeed: Number.parseFloat(extra.get('walk-speed') ?? '6'),
    rezoneTimeoutMs: Number.parseInt(extra.get('rezone-timeout-ms') ?? '30000', 10),
    warpToX: warpX !== undefined && warpX !== '' ? Number.parseFloat(warpX) : null,
    warpToZ: warpZ !== undefined && warpZ !== '' ? Number.parseFloat(warpZ) : null,
    adminDeposit: Number.parseInt(extra.get('admin-deposit') ?? '0', 10),
  };
}

interface PilgrimSummary {
  startPlanet: string | null;
  destPlanet: string | null;
  destPoint: string | null;
  ticketPurchased: boolean;
  ticketUsed: boolean;
  arrivedAtDest: boolean;
  missionAccepted: boolean;
  missionId: string | null;
  startCredits: number;
  endCredits: number;
  bailReason: string | null;
  totalElapsedMs: number;
}

const MISSION_TERMINAL_RE = /terminal_mission|mission_terminal/i;

async function adminTopUp(
  ctx: ScriptContext,
  deposit: number,
  log: (m: string) => void,
): Promise<void> {
  if (deposit <= 0) return;
  const playerOid = ctx.sceneStart.playerNetworkId.toString();
  log(`admin: setGodMode 1, deposit ${deposit}`);
  ctx.useAbility('setGodMode', 0n, '1');
  await ctx.wait(500);
  ctx.send(new ConGenericMessage(`money namedTransfer ${playerOid} customerService -${deposit}`));
  await ctx.wait(500);
}

async function adminWarp(
  ctx: ScriptContext,
  x: number,
  z: number,
  log: (m: string) => void,
): Promise<void> {
  const playerOid = ctx.sceneStart.playerNetworkId.toString();
  log(`admin warp to (${x}, ${z})`);
  ctx.send(new ConGenericMessage(`object move ${playerOid} ${x} 0 ${z}`));
  await ctx.wait(2_000);
  await ctx.ackPendingTeleports();
  const playerObj = ctx.world.get(ctx.sceneStart.playerNetworkId);
  if (playerObj !== undefined) {
    ctx.setPose(
      { x: playerObj.position.x, y: playerObj.position.y, z: playerObj.position.z },
      playerObj.yaw,
    );
  }
}

async function waitForRezone(ctx: ScriptContext, timeoutMs: number): Promise<boolean> {
  try {
    await ctx.waitForMessage(CmdStartScene, { timeoutMs });
    await ctx.waitForMessage(SceneEndBaselines, { timeoutMs });
    ctx.send(new CmdSceneReady());
    await ctx.wait(500);
    await ctx.ackPendingTeleports();
    return true;
  } catch {
    return false;
  }
}

function buildScenario(args: ScriptArgs, verbose: boolean, out: PilgrimSummary): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('pilgrim', verbose);
    const startedAt = Date.now();
    out.startCredits = ctx.character.bankBalance + ctx.character.cashBalance;
    out.startPlanet = normalizePlanet(ctx.sceneStart.sceneName);

    if (args.adminDeposit > 0 && out.startCredits < args.adminDeposit) {
      await adminTopUp(ctx, args.adminDeposit, log);
    }
    if (args.warpToX !== null && args.warpToZ !== null) {
      await adminWarp(ctx, args.warpToX, args.warpToZ, log);
    }

    const vendor = ctx.travel.findTicketVendor({ maxRadiusM: args.vendorRadiusM });
    if (vendor === undefined) {
      out.bailReason = `no ticket vendor within ${args.vendorRadiusM}m of (${ctx.position().x.toFixed(0)}, ${ctx.position().z.toFixed(0)})`;
      log(out.bailReason);
      await ctx.logout();
      out.totalElapsedMs = Date.now() - startedAt;
      return;
    }
    log(`vendor: 0x${vendor.id.toString(16)} template=${vendor.templateName}`);

    const destinations = await ctx.travel.listDestinations({ vendorId: vendor.id });
    log(`vendor offers ${destinations.length} destinations`);
    const targetPlanet = (args.destinationPlanet ?? '').toLowerCase();
    const pick = destinations.find(
      (d) =>
        d.point.toLowerCase().includes(args.destination.toLowerCase()) &&
        (targetPlanet === '' || d.planet.toLowerCase() === targetPlanet) &&
        d.planet.toLowerCase() !== (out.startPlanet ?? ''),
    );
    if (pick === undefined) {
      out.bailReason = `no destination matching "${args.destination}" on a different planet (start=${out.startPlanet})`;
      log(out.bailReason);
      await ctx.logout();
      out.totalElapsedMs = Date.now() - startedAt;
      return;
    }
    out.destPlanet = pick.planet;
    out.destPoint = pick.point;
    log(`buying ticket → ${pick.planet}/${pick.point} (${pick.cost}c)`);

    let ticketId: NetworkId;
    try {
      ticketId = await ctx.travel.buyTicket({
        vendorId: vendor.id,
        destination: pick.point,
        destinationPlanet: pick.planet,
      });
      out.ticketPurchased = true;
      log(`ticket acquired: 0x${ticketId.toString(16)}`);
    } catch (err) {
      out.bailReason = `buyTicket failed: ${err instanceof Error ? err.message : String(err)}`;
      log(out.bailReason);
      await ctx.logout();
      out.totalElapsedMs = Date.now() - startedAt;
      return;
    }

    const collector = ctx.travel.findTicketCollector({ maxRadiusM: args.vendorRadiusM });
    if (collector === undefined) {
      out.bailReason = `no ticket collector within ${args.vendorRadiusM}m`;
      log(out.bailReason);
      await ctx.logout();
      out.totalElapsedMs = Date.now() - startedAt;
      return;
    }
    const here = ctx.position();
    const dx = collector.position.x - here.x;
    const dz = collector.position.z - here.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 3) {
      const approach = {
        x: collector.position.x - (dx / dist) * 2,
        z: collector.position.z - (dz / dist) * 2,
      };
      await ctx.walkTo(approach, { speed: args.walkSpeed });
    }

    try {
      const result = await ctx.travel.useTicket({ ticketId, collectorId: collector.id });
      out.ticketUsed = true;
      out.arrivedAtDest = true;
      out.destPlanet = result.destinationPlanet;
      log(
        `arrived at ${result.destinationPlanet} (${result.destinationPosition.x.toFixed(0)}, ${result.destinationPosition.z.toFixed(0)})`,
      );
    } catch (err) {
      out.bailReason = `useTicket failed: ${err instanceof Error ? err.message : String(err)}`;
      log(out.bailReason);
      await ctx.logout();
      out.totalElapsedMs = Date.now() - startedAt;
      return;
    }

    if (!(await waitForRezone(ctx, args.rezoneTimeoutMs))) {
      out.bailReason = `re-zone CmdStartScene did not arrive within ${args.rezoneTimeoutMs}ms`;
      log(out.bailReason);
      await ctx.logout();
      out.totalElapsedMs = Date.now() - startedAt;
      return;
    }
    await ctx.wait(args.scanMs);

    const terminal = ctx.world.filter(
      (o) => o.templateName !== undefined && MISSION_TERMINAL_RE.test(o.templateName),
    )[0];
    if (terminal !== undefined) {
      log(`mission terminal: 0x${terminal.id.toString(16)}`);
      try {
        ctx.requestMissionList(terminal.id, { flags: 0 });
        await ctx.wait(2_000);
        const m = ctx.missions.bestPayout() ?? ctx.missions.active[0];
        if (m !== undefined) {
          ctx.acceptMission(m.id, terminal.id);
          await ctx.wait(1_000);
          out.missionAccepted = true;
          out.missionId = `0x${m.id.toString(16)}`;
          log(`accepted mission ${out.missionId}; sending removeMission to round-trip`);
          ctx.removeMission(m.id, terminal.id);
        }
      } catch (err) {
        log(`mission step failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    out.endCredits = ctx.character.bankBalance + ctx.character.cashBalance;
    out.totalElapsedMs = Date.now() - startedAt;
    await ctx.logout();
  };
}

function normalizePlanet(sceneName: string | null | undefined): string | null {
  if (sceneName === null || sceneName === undefined || sceneName === '') return null;
  const m = sceneName.match(/(?:terrain\/)?([a-z_]+)(?:\.trn)?$/i);
  return m?.[1]?.toLowerCase() ?? sceneName.toLowerCase();
}

async function main(): Promise<void> {
  const args = parseCommonArgs(process.argv.slice(2), {
    user: 'tslive18',
    character: 'ExPilgrim',
    minutes: 5,
  });
  if (args.help) {
    usage(SCRIPT, 'Cross-planet shuttle traveller + mission round-trip.', [
      '  --destination=NAME           travel-point substring to pick (default "bestine")',
      '  --destination-planet=PLANET  restrict destination planet (default: any planet other than spawn)',
      '  --vendor-radius=M            search radius for vendor + collector (default 120)',
      '  --scan-ms=N                  settle window after re-zone (default 5000)',
      '  --walk-speed=N               m/s while walking to the collector (default 6)',
      '  --rezone-timeout-ms=N        wait budget for arrival CmdStartScene (default 30000)',
      '  --warp-to-x=X --warp-to-z=Z  admin-warp to (x,z) before searching (test convenience)',
      '  --admin-deposit=N            top-up credits via console (god-mode required; default 0)',
    ]);
    process.exit(0);
  }

  const scriptArgs = parseScriptArgs(args.extra);
  const out: PilgrimSummary = {
    startPlanet: null,
    destPlanet: null,
    destPoint: null,
    ticketPurchased: false,
    ticketUsed: false,
    arrivedAtDest: false,
    missionAccepted: false,
    missionId: null,
    startCredits: 0,
    endCredits: 0,
    bailReason: null,
    totalElapsedMs: 0,
  };
  const { summary } = await runScenario(args, buildScenario(scriptArgs, args.verbose, out));
  summary.extra = { ...out };
  process.stdout.write(formatJson(summary, args.pretty));
  process.exit(summary.ok ? 0 : 1);
}

await main();
