/**
 * Live integration test: `ctx.datapad` is populated automatically after
 * zone-in, and reflects admin-spawned PCDs that drop into the datapad.
 *
 * Gated on `LIVE=1`. Runs the full Stage 1 → 4 lifecycle, then within the
 * scripted dwell:
 *   1. waits for `ctx.datapad.ready === true` (the datapad's
 *      SceneCreateObjectByName must have been processed)
 *   2. records baseline vehicle count (admin-spawned PCDs survive
 *      character resets so we don't assume 0)
 *   3. admin-spawns a fresh vehicle PCD INSIDE the datapad via
 *      `object createIn <datapadId> object/intangible/vehicle/landspeeder_av21_pcd.iff`
 *   4. waits for the new PCD to appear in `ctx.datapad.vehicles()`
 *
 * Account must be in `stella_admin.tab` for `/object createIn` to be
 * authorized server-side. Defaults to the `tslive*` admin pool.
 */
import { describe, expect, it } from 'vitest';

import { SwgClient } from '../../src/client/swg-client.js';
import { ConGenericMessage } from '../../src/messages/game/con-generic-message.js';
import type { NetworkId } from '../../src/types.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

/** Vehicle PCD that goes INSIDE the datapad (not the world creature). */
const VEHICLE_PCD_TEMPLATE = 'object/intangible/vehicle/landspeeder_av21_pcd.iff';

describe.skipIf(!LIVE)('live ctx.datapad auto-sync (Stages 1 → 2 → 3 → 4)', () => {
  it('populates ctx.datapad after zone-in and observes admin-spawned PCDs landing in it', async () => {
    const { account, characterName } = await liveCredentials('dp');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const observed = {
      datapadId: null as NetworkId | null,
      datapadReadyAt: null as number | null,
      baselineVehicleCount: -1,
      newVehicleSpawned: false,
      vehicleVisibleInDatapad: false,
      bailReason: null as string | null,
      // Catalog: dump every PCD we ever saw in the datapad. Useful for diagnosis.
      datapadKindsAtEnd: [] as Array<{
        networkId: string;
        templateName: string | null;
        templateCrc: string | null;
        name: string | null;
        kind: string;
      }>,
    };

    const lifecycleResult = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: async (ctx) => {
        // 1. Wait briefly for the datapad's SceneCreateObject to land. The
        //    live server sends it as ByCrc (template hash) within ~100ms of
        //    SceneEndBaselines. Hard-cap at 5s; failing means the auto-open
        //    or discovery wiring is broken — this is a load-bearing
        //    invariant for every downstream test that uses the datapad.
        const t0 = Date.now();
        while (!ctx.datapad.ready && Date.now() - t0 < 5_000) {
          await ctx.wait(100);
        }
        if (!ctx.datapad.ready) {
          observed.bailReason =
            'ctx.datapad.ready never became true within 5s of zone-in. ' +
            'The auto-open or discovery wiring is broken.';
          return;
        }
        observed.datapadId = ctx.datapad.containerId;
        observed.datapadReadyAt = Date.now() - t0;
        observed.baselineVehicleCount = ctx.datapad.vehicles().length;
        console.warn(
          `[live-datapad-auto] datapad id=${observed.datapadId?.toString()} (ready in ${observed.datapadReadyAt}ms); baseline vehicles=${observed.baselineVehicleCount}`,
        );

        // 2. Enable god mode (required for /object commands).
        ctx.useAbility('setGodMode', 0n, '1');
        await ctx.wait(1_000);

        // 3. Admin-spawn a vehicle PCD directly INSIDE the datapad.
        //    The container-aware variant `object createIn <containerId>
        //    <template>` parents the new object to <containerId> via the
        //    server-side ContainerInterface — exactly the path the
        //    crafting flow would take. Wait for the response to confirm.
        const responses: string[] = [];
        const unsub = ctx.dispatcher.onMessage(ConGenericMessage, (m) => {
          responses.push(m.msg);
        });
        // Syntax: `object createIn <template> <oid>` — template first,
        // container oid second. See ConsoleCommandParserObject.cpp:357.
        const cmd = `object createIn ${VEHICLE_PCD_TEMPLATE} ${observed.datapadId!.toString()}`;
        ctx.send(new ConGenericMessage(cmd, 200));
        await ctx.wait(3_000);
        unsub();
        observed.newVehicleSpawned = responses.some((r) => /NetworkId:\s*\d+/.test(r));
        if (!observed.newVehicleSpawned) {
          observed.bailReason =
            `/object createIn did not echo a NetworkId within 3s. ` +
            `Likely god-mode failed (account not in stella_admin.tab?) or the template path drifted. ` +
            `ConGenericMessage responses: ${JSON.stringify(responses)}`;
          return;
        }

        // 4. Wait for the new PCD to land in ctx.datapad.vehicles().
        //    The server should send (a) SceneCreateObjectByCrc/ByName for
        //    the new PCD, (b) an UpdateContainmentMessage parenting it to
        //    the datapad. Both flow through the WorldModel; the datapad
        //    view picks it up the moment the containment arrives.
        const t1 = Date.now();
        while (Date.now() - t1 < 5_000) {
          if (ctx.datapad.vehicles().length > observed.baselineVehicleCount) {
            observed.vehicleVisibleInDatapad = true;
            break;
          }
          await ctx.wait(150);
        }

        // 5. Cleanup. Destroy every vehicle PCD we spawned this run so the
        //    datapad doesn't accumulate clutter across runs.
        for (const v of ctx.datapad.vehicles()) {
          ctx.send(new ConGenericMessage(`object destroy ${v.networkId.toString()}`, 201));
        }
        await ctx.wait(500);

        // Final snapshot for the diagnostic log.
        observed.datapadKindsAtEnd = ctx.datapad.items.map((it) => ({
          networkId: it.networkId.toString(),
          templateName: it.templateName,
          templateCrc: it.templateCrc !== null ? `0x${it.templateCrc.toString(16)}` : null,
          name: it.name,
          kind: it.kind,
        }));
      },
    });

    expect(lifecycleResult.zonedInAt, 'zonedInAt populated').not.toBeNull();
    expect(lifecycleResult.scriptResult?.error, 'script did not throw').toBeUndefined();
    expect(
      observed.datapadId,
      `ctx.datapad.containerId should be set after zone-in. ` +
        `bailReason=${observed.bailReason ?? 'unknown'}`,
    ).not.toBeNull();
    expect(
      observed.newVehicleSpawned,
      `admin-spawned vehicle PCD via createIn. bailReason=${observed.bailReason ?? 'unknown'}`,
    ).toBe(true);
    expect(
      observed.vehicleVisibleInDatapad,
      `new PCD must appear in ctx.datapad.vehicles() within 5s of spawn. ` +
        `Final datapad contents: ${JSON.stringify(observed.datapadKindsAtEnd, null, 2)}`,
    ).toBe(true);

    console.warn(
      `[live-datapad-auto] FINAL datapad snapshot:\n${JSON.stringify(observed.datapadKindsAtEnd, null, 2)}`,
    );
  }, 60_000);
});
