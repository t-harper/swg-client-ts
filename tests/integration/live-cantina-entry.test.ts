/**
 * Live integration test: portal-aware cell entry into the Mos Eisley cantina.
 *
 * Two scenarios end-to-end against the SWG server (Track E acceptance test):
 *
 *   1. **Single-hop entry** — `ctx.navigate({ buildingId, cellName: '' })`
 *      lands the bot in the cantina's first public cell. Verifies the
 *      portal-aware plan from Tracks A+B+C+D works end-to-end: template ->
 *      `.pob` -> `findCellPath(layout, 0, N)` -> N walkThroughPortal steps ->
 *      `verifyCellEntry`. Assertion is `ctx.location.cell !== null` AND
 *      `cell.buildingId === CANTINA_BUILDING_OID` within 5 seconds.
 *
 *   2. **Multi-hop entry** — `cellName: 'cell5'` (an interior cell that is
 *      NOT a direct exterior-portal neighbor of cell 0). Exercises the BFS
 *      pathfinder + multi-hop `walkThroughPortal` emission. The plan crosses
 *      foyer -> cantina main floor -> alcove on the way to cell 5. Same
 *      assertion against the named cell.
 *
 * Gated on `LIVE=1`. Uses the admin pool helper (account must be in
 * `stella_admin.tab`; admin god-mode is required for the `planetwarp`
 * teleport into Mos Eisley).
 *
 * Per memory `skips_are_errors.md`: the outer `describe.skipIf(!LIVE)` is
 * the only acceptable skip path. Any inner prerequisite that's missing must
 * throw a hard error — silent fallthrough hides wire-format regressions.
 */
import { describe, expect, it } from 'vitest';

import { adminGodModeOn, adminPlanetWarp } from '../../scripts/build-city/admin.js';
import { findCellPath } from '../../src/client/cell-graph.js';
import { SwgClient } from '../../src/client/swg-client.js';
import type { NetworkId } from '../../src/types.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

/**
 * Mos Eisley cantina BUIO. Static OID assigned by the buildout file
 * `tatooine_6_2_ws.tab:43` (preserved verbatim at runtime by
 * `ServerBuildoutManager`). Same value the entertainer-bot uses.
 */
const CANTINA_BUILDING_OID = 1082874n;
/** Cantina anchor coords (world coords; derived from the buildout entry). */
const CANTINA_X = 3432;
const CANTINA_Z = -4819;
/** Portal layout filename the cantina template points at. */
const CANTINA_POB = 'appearance/thm_tato_cantina.pob';

/** Poll `ctx.location.cell` until it lands in the expected building. */
async function waitForBuildingCell(
  ctx: {
    location: { cell: { buildingId: NetworkId; cellNumber: number; cellName: string } | null };
    wait: (ms: number) => Promise<void>;
  },
  buildingId: NetworkId,
  timeoutMs: number,
): Promise<{ cellNumber: number; cellName: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = ctx.location.cell;
    if (c !== null && c.buildingId === buildingId) {
      return { cellNumber: c.cellNumber, cellName: c.cellName };
    }
    await ctx.wait(250);
  }
  return null;
}

describe.skipIf(!LIVE)('live cantina entry — portal-aware multi-hop navigate', () => {
  it('walks into the cantina first-public cell (single-hop)', async () => {
    const { account, characterName } = await liveCredentials('cn');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const observed = {
      cellAtStart: null as object | null,
      cellAfter: null as { buildingId: NetworkId; cellNumber: number; cellName: string } | null,
      navigateErr: null as string | null,
      lastTransformsWithParent: [] as Array<{ at: number; bytes: number }>,
      cellPathHopCount: null as number | null,
    };

    const result = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: async (ctx) => {
        await ctx.wait(2_500);
        // Admin warp directly to the cantina anchor — the bot's normal
        // multi-hop "show-off" hop chain isn't needed for this test.
        await adminGodModeOn(ctx);
        await adminPlanetWarp(ctx, 'tatooine', CANTINA_X, 0, CANTINA_Z);
        await ctx.wait(2_500); // let BUIO + cell SCLTs flood in

        observed.cellAtStart = ctx.location.cell;

        try {
          await ctx.navigate(
            { buildingId: CANTINA_BUILDING_OID, cellName: '' },
            { useMount: 'never' },
          );
        } catch (err) {
          observed.navigateErr = err instanceof Error ? err.message : String(err);
          // Diagnostic: also resolve the cell path that the planner would
          // have computed, so the test failure tells us "we wanted 0->1->3"
          // not just "navigate threw".
          try {
            const layout = await ctx.knowledge.buildings.portalLayoutFor(CANTINA_POB);
            const path = findCellPath(layout, 0, 1) ?? [];
            observed.cellPathHopCount = path.length;
          } catch {
            // ignored — layout itself may be unavailable
          }
        }

        // Poll for cell entry up to 5 seconds — verifyCellEntry inside
        // navigate() polls for 3s and is non-throwing, so we re-check here
        // with a wider window.
        const final = await waitForBuildingCell(ctx, CANTINA_BUILDING_OID, 5_000);
        if (final !== null) {
          observed.cellAfter = {
            buildingId: CANTINA_BUILDING_OID,
            cellNumber: final.cellNumber,
            cellName: final.cellName,
          };
        }
      },
    });

    // Capture transcript diagnostics for the failure path.
    observed.lastTransformsWithParent = result.transcript
      .filter((e) => e.direction === 'send' && e.messageName === 'ObjControllerMessage')
      .slice(-5)
      .map((e) => ({ at: e.at, bytes: e.bytes }));

    expect(result.zonedInAt, 'zonedInAt').not.toBeNull();
    expect(result.scriptResult?.error, 'script did not throw').toBeUndefined();

    // Hard requirements: navigate did not throw, the player ended up inside
    // a cell of the cantina BUIO. The diagnostic dump goes into the failure
    // message so we can see WHY the server rejected the re-parent.
    if (observed.navigateErr !== null || observed.cellAfter === null) {
      const dump = JSON.stringify(
        {
          cellAtStart: observed.cellAtStart,
          cellAfter: observed.cellAfter,
          navigateErr: observed.navigateErr,
          cellPathHopCount: observed.cellPathHopCount,
          lastTransformsWithParent: observed.lastTransformsWithParent,
        },
        (_k, v) => (typeof v === 'bigint' ? `${v.toString()}n` : v),
        2,
      );
      throw new Error(`single-hop cantina entry failed: ${dump}`);
    }

    // Sanity-check: the cantina BUIO has a public cell with cellNumber > 0
    // (cell 0 is exterior); first-public picks the lowest-numbered public
    // cell, which is one of the foyers.
    expect(observed.cellAfter.cellNumber, 'cellNumber > 0').toBeGreaterThan(0);
    expect(result.receivedErrorMessage, 'no ErrorMessage during run').toBe(false);
  }, 120_000);

  it('walks into cantina cell5 (multi-hop)', async () => {
    // Settle window between LIVE tests in the same file — same pattern as
    // live-navigate.test.ts. The admin-pool LRU avoids re-handing-out the
    // same account too fast, but the server's session-release cycle adds
    // ~12-15s of latency before the same character can re-attach.
    await new Promise((r) => setTimeout(r, 15_000));
    const { account, characterName } = await liveCredentials('cm');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    /** Target cell — cellNumber === 5. Resolved by `findCellByName` via the cellN regex. */
    const TARGET_CELL_NAME = 'cell5';
    /** Wire `cellNumber` we expect to see in `ctx.location.cell.cellNumber`. */
    const TARGET_CELL_NUMBER = 5;

    const observed = {
      cellAfter: null as { buildingId: NetworkId; cellNumber: number; cellName: string } | null,
      navigateErr: null as string | null,
      lastTransformsWithParent: [] as Array<{ at: number; bytes: number }>,
      cellPathHopCount: null as number | null,
    };

    const result = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: async (ctx) => {
        await ctx.wait(2_500);
        await adminGodModeOn(ctx);
        await adminPlanetWarp(ctx, 'tatooine', CANTINA_X, 0, CANTINA_Z);
        await ctx.wait(2_500);

        try {
          await ctx.navigate(
            { buildingId: CANTINA_BUILDING_OID, cellName: TARGET_CELL_NAME },
            { useMount: 'never' },
          );
        } catch (err) {
          observed.navigateErr = err instanceof Error ? err.message : String(err);
          try {
            const layout = await ctx.knowledge.buildings.portalLayoutFor(CANTINA_POB);
            const path = findCellPath(layout, 0, TARGET_CELL_NUMBER) ?? [];
            observed.cellPathHopCount = path.length;
          } catch {
            // ignored
          }
        }

        const final = await waitForBuildingCell(ctx, CANTINA_BUILDING_OID, 8_000);
        if (final !== null) {
          observed.cellAfter = {
            buildingId: CANTINA_BUILDING_OID,
            cellNumber: final.cellNumber,
            cellName: final.cellName,
          };
        }
      },
    });

    observed.lastTransformsWithParent = result.transcript
      .filter((e) => e.direction === 'send' && e.messageName === 'ObjControllerMessage')
      .slice(-5)
      .map((e) => ({ at: e.at, bytes: e.bytes }));

    expect(result.zonedInAt, 'zonedInAt').not.toBeNull();
    expect(result.scriptResult?.error, 'script did not throw').toBeUndefined();

    if (
      observed.navigateErr !== null ||
      observed.cellAfter === null ||
      observed.cellAfter.cellNumber !== TARGET_CELL_NUMBER
    ) {
      const dump = JSON.stringify(
        {
          cellAfter: observed.cellAfter,
          navigateErr: observed.navigateErr,
          cellPathHopCount: observed.cellPathHopCount,
          lastTransformsWithParent: observed.lastTransformsWithParent,
          wanted: { cellName: TARGET_CELL_NAME, cellNumber: TARGET_CELL_NUMBER },
        },
        (_k, v) => (typeof v === 'bigint' ? `${v.toString()}n` : v),
        2,
      );
      throw new Error(`multi-hop cantina entry to cell5 failed: ${dump}`);
    }

    expect(observed.cellAfter.cellNumber, `walked into cell${TARGET_CELL_NUMBER}`).toBe(
      TARGET_CELL_NUMBER,
    );
    expect(result.receivedErrorMessage, 'no ErrorMessage during run').toBe(false);
  }, 120_000);
});
