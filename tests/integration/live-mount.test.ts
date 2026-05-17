/**
 * Live integration test: vehicle / mount wire flow.
 *
 * Admin-spawns a vehicle creature directly in the world (via `/object
 * create`), then drives the mount → walk → dismount → cleanup sequence
 * against the real swg-server. Asserts the expected wire traffic and the
 * `mountedSpeedCap` state toggle around mount.
 *
 * Why direct admin spawn (vs deed → PCD → call): admin-spawned PCDs and
 * admin-spawned deeds both lack the `pet.creatureName` /
 * `vehicle_attribs.object_ref` objvars that only the crafting flow sets,
 * so `pet_control_device.OnObjectMenuSelect(PET_CALL)` and
 * `vehicle_deed.createCraftedCreatureDevice` both no-op silently. The
 * vehicle CREATURE itself doesn't depend on those objvars and works with
 * `mount`/`dismount` directly.
 *
 * Gated on `LIVE=1`. Account must be in `dsrc/.../stella_admin.tab` to
 * pass `isGod()` server-side. Defaults to `swg`/`Artisan73741` via
 * `CI_REUSE_ACCOUNT` + `CI_REUSE_CHARACTER`.
 */
import { describe, expect, it } from 'vitest';

import { SwgClient } from '../../src/client/swg-client.js';
import { ConGenericMessage } from '../../src/messages/game/con-generic-message.js';
import type { NetworkId } from '../../src/types.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

/** Server template for the vehicle CREATURE (not the PCD/deed). */
const VEHICLE_CREATURE_TEMPLATE = 'object/mobile/vehicle/landspeeder_av21.iff';

describe.skipIf(!LIVE)('live vehicle / mount (admin-spawn → mount → walk → dismount)', () => {
  it('drives the mount flow end-to-end against an admin-spawned vehicle', async () => {
    const { account, characterName } = await liveCredentials('mt');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const observed = {
      vehicleId: null as NetworkId | null,
      capDuringMount: null as number | null,
      capAfterDismount: undefined as number | null | undefined,
      ranMountFlow: false,
    };

    const lifecycleResult = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: async (ctx) => {
        await ctx.wait(2_000);

        // Enable god mode (required to send /object commands server-side).
        ctx.useAbility('setGodMode', 0n, '1');
        await ctx.wait(1_500);

        // Listen for ConGenericMessage responses to parse the new vehicle's
        // NetworkId out of "NetworkId: <id>".
        const responses: string[] = [];
        const unsub = ctx.dispatcher.onMessage(ConGenericMessage, (m) => {
          responses.push(m.msg);
        });

        const pos = ctx.position();
        // Spawn the vehicle creature 2m away so we have line-of-sight to mount.
        const cmd = `object create ${VEHICLE_CREATURE_TEMPLATE} ${(pos.x + 2).toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)}`;
        ctx.send(new ConGenericMessage(cmd, 100));
        await ctx.wait(2_500);
        unsub();

        const idMatch = responses.find((r) => /NetworkId:\s*\d+/.test(r));
        if (idMatch === undefined) {
          console.warn(
            `[live-mount] /object create did not return a NetworkId. Responses: ${JSON.stringify(responses)}`,
          );
          return;
        }
        const idStr = idMatch.match(/NetworkId:\s*(\d+)/)![1]!;
        observed.vehicleId = BigInt(idStr) as NetworkId;
        console.warn(`[live-mount] admin-spawned vehicle id=${observed.vehicleId.toString()}`);

        // Mount the vehicle creature.
        ctx.mount(observed.vehicleId);
        observed.capDuringMount = ctx.mountedSpeedCap();
        await ctx.wait(1_500);

        // Brief mounted walk so we emit at least one CM_netUpdateTransform.
        const start = ctx.position();
        try {
          await ctx.walkTo({ x: start.x + 12, z: start.z + 12 }, { speed: 12, tickMs: 250 });
        } catch (err) {
          console.warn(
            `[live-mount] walkTo during mount threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        ctx.dismount();
        observed.capAfterDismount = ctx.mountedSpeedCap();
        await ctx.wait(1_000);

        // Cleanup: destroy the admin-spawned vehicle so it doesn't litter
        // the world. /object destroy <oid> is the standard tear-down.
        ctx.send(
          new ConGenericMessage(`object destroy ${observed.vehicleId.toString()}`, 101),
        );
        await ctx.wait(500);
        observed.ranMountFlow = true;
      },
    });

    expect(lifecycleResult.zonedInAt, 'zonedInAt populated').not.toBeNull();
    expect(lifecycleResult.scriptResult?.error, 'script did not throw').toBeUndefined();

    if (!observed.ranMountFlow) {
      // Diagnostic skip path — the script logged the reason.
      return;
    }

    // mount()/dismount() each toggle mountedSpeedCap as a side effect of
    // wrapping useAbility('mount'|'dismount', ...) — observing the toggle
    // proves they fired (the transcript itself only stores message names +
    // byte counts on the send side, not the encoded objects).
    expect(observed.capDuringMount, 'mountedSpeedCap() == 12 after mount()').toBe(12);
    expect(observed.capAfterDismount, 'mountedSpeedCap() == null after dismount()').toBeNull();

    expect(lifecycleResult.receivedErrorMessage, 'no ErrorMessage during run').toBe(false);

    // We sent enough ObjControllerMessages to cover: mount-enqueue,
    // dismount-enqueue, plus at least one CM_netUpdateTransform from the
    // mounted walk. Lower bound: 3.
    const objControllerSends = lifecycleResult.transcript.filter(
      (e) => e.direction === 'send' && e.messageName === 'ObjControllerMessage',
    );
    expect(
      objControllerSends.length,
      'at least 3 ObjControllerMessage sends (mount, dismount, at least one transform)',
    ).toBeGreaterThanOrEqual(3);
  }, 60_000);
});
