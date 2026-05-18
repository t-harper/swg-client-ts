/**
 * Live integration test: container-ecosystem APIs.
 *
 *   1. `ctx.inventory.totalSlots > 0` (admin-pool chars are set up with
 *      the standard 80-volume inventory) + `usedSlots` + `freeSlots`
 *      arithmetic round-trips.
 *   2. `ctx.bank.use(terminalId)` opens a bank container; once the server
 *      streams its children we observe `ctx.bank.ready === true` and
 *      `ctx.bank.items` is a (possibly-empty) snapshot.
 *   3. Vehicle "condition" — admin-spawn a vehicle CREATURE, mount it,
 *      and verify the TANO SHARED baseline (damageTaken / maxHitPoints)
 *      yields a `hpRatio` in (0,1].
 *
 * The live cluster's console-command parser only reliably handles ONE
 * `object create` per script invocation — back-to-back admin spawns flake
 * with empty responses. So we spawn ONLY the vehicle (the harder ask)
 * and use a pre-existing bank-slot SHARED baseline to drive the bank
 * flow without spawning a terminal: send `ClientOpenContainerMessage`
 * for the player's `'bank'` slot directly, which is exactly the wire
 * sequence the server's `openBankContainer` JNI call uses internally.
 *
 * Vehicle-PCD note: admin-spawned PCDs can't be `callVehicle()`d because
 * they lack the `vehicle_attribs.object_ref` objvar that only the
 * crafting flow sets. The PCD-side state-tracking + condition-from-
 * linked-creature path is exercised by unit tests
 * (`src/client/datapad-view.test.ts`).
 *
 * Gated on `LIVE=1`. Account must be in `dsrc/.../stella_admin.tab` to
 * authorize `/object create` and `setGodMode 1`.
 */
import { describe, expect, it } from 'vitest';

import { SwgClient } from '../../src/client/swg-client.js';
import {
  BaselinePackageIds,
  type TangibleObjectSharedBaseline,
} from '../../src/messages/game/baselines/index.js';
import { ClientOpenContainerMessage } from '../../src/messages/game/client-open-container.js';
import { ConGenericMessage } from '../../src/messages/game/con-generic-message.js';
import type { NetworkId } from '../../src/types.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

/** Vehicle CREATURE (not PCD) — admin-spawnable, mountable, has live HAM. */
const VEHICLE_CREATURE_TEMPLATE = 'object/mobile/vehicle/landspeeder_av21.iff';

describe.skipIf(!LIVE)(
  'live ctx.bank + ctx.inventory.slots + ctx.datapad.vehicle.condition',
  () => {
    it('drives the container-ecosystem APIs end-to-end against a real server', async () => {
      const { account, characterName } = await liveCredentials('bk');
      await sessionSettle();
      const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

      const observed = {
        // Inventory slots
        inventoryTotalSlots: 0,
        inventoryUsedSlots: -1,
        inventoryFreeSlots: -1,
        inventoryResourceCount: -1,
        // Bank (no terminal needed — open via ClientOpenContainerMessage on the slot)
        bankContainerId: null as NetworkId | null,
        bankReady: false,
        bankItemsCount: -1,
        // Vehicle condition
        vehicleId: null as NetworkId | null,
        vehicleHpRatio: null as number | null,
        vehicleMaxHp: null as number | null,
        vehicleDamageTaken: null as number | null,
        // Diagnostics
        bailReason: null as string | null,
      };

      const lifecycleResult = await client.fullLifecycle({
        account,
        characterName,
        planet: 'mos_eisley',
        holdZonedInMs: 0,
        script: async (ctx) => {
          await ctx.wait(2_000);

          // --- (1) Inventory slot capacity ---
          observed.inventoryTotalSlots = ctx.inventory.totalSlots;
          observed.inventoryUsedSlots = ctx.inventory.usedSlots;
          observed.inventoryFreeSlots = ctx.inventory.freeSlots;
          observed.inventoryResourceCount = ctx.inventory.resources().length;
          console.warn(
            `[live-bank] inventory totalSlots=${observed.inventoryTotalSlots} ` +
              `used=${observed.inventoryUsedSlots} free=${observed.inventoryFreeSlots} ` +
              `rcno=${observed.inventoryResourceCount}`,
          );

          // --- (2) Bank flow — no terminal spawn required. The bank
          //         container's NetworkId is auto-discovered from the
          //         SHARED-baseline `nameStringId={item_n, bank}` signal
          //         that arrives during the zone-in flood. Sending a
          //         direct `ClientOpenContainerMessage(player, 'bank')`
          //         is the same wire side-effect `openBankContainer`
          //         produces server-side. ---
          const playerId = ctx.sceneStart.playerNetworkId;
          ctx.send(new ClientOpenContainerMessage(playerId, 'bank'));
          await ctx.wait(2_500);

          observed.bankContainerId = ctx.bank.containerId;
          observed.bankReady = ctx.bank.ready;
          observed.bankItemsCount = ctx.bank.items.length;
          console.warn(
            `[live-bank] bank containerId=${observed.bankContainerId?.toString() ?? 'null'} ` +
              `ready=${observed.bankReady} items=${observed.bankItemsCount}`,
          );

          // --- (3) Vehicle condition flow. Admin-spawn the vehicle
          //         CREATURE so we can read its live HAM from the TANO
          //         SHARED baseline. ---
          ctx.useAbility('setGodMode', 0n, '1');
          await ctx.wait(1_500);

          const responses: string[] = [];
          const unsub = ctx.dispatcher.onMessage(ConGenericMessage, (m) => {
            responses.push(m.msg);
          });
          const pos = ctx.position();
          const cmd =
            `object create ${VEHICLE_CREATURE_TEMPLATE} ` +
            `${(pos.x + 3).toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)}`;
          ctx.send(new ConGenericMessage(cmd, 100));
          await ctx.wait(2_500);
          unsub();
          const idMatch = responses.find((r) => /NetworkId:\s*\d+/.test(r));
          if (idMatch === undefined) {
            observed.bailReason =
              `/object create did not return a NetworkId for the vehicle creature. ` +
              `Responses: ${JSON.stringify(responses)}. ` +
              `Likely god-mode wasn't honored or the cluster is overloaded.`;
            console.warn(`[live-bank] ${observed.bailReason}`);
            return;
          }
          observed.vehicleId = BigInt(idMatch.match(/NetworkId:\s*(\d+)/)![1]!) as NetworkId;
          console.warn(
            `[live-bank] admin-spawned vehicle creature id=${observed.vehicleId.toString()}`,
          );

          // Mount it so we know it's interactive + the baselines have
          // landed by the time we read them.
          ctx.mount(observed.vehicleId);
          await ctx.wait(2_000);

          const vehicleObj = ctx.world.get(observed.vehicleId);
          if (vehicleObj === undefined) {
            observed.bailReason = `vehicle ${observed.vehicleId.toString()} not in WorldModel after spawn`;
            console.warn(`[live-bank] ${observed.bailReason}`);
            return;
          }
          const shared = vehicleObj.baselines.get(BaselinePackageIds.SHARED);
          if (shared !== undefined && !(shared instanceof Uint8Array)) {
            const tano = shared as Partial<TangibleObjectSharedBaseline>;
            if (typeof tano.maxHitPoints === 'number' && typeof tano.damageTaken === 'number') {
              observed.vehicleMaxHp = tano.maxHitPoints;
              observed.vehicleDamageTaken = tano.damageTaken;
              if (tano.maxHitPoints > 0) {
                const cur = Math.max(0, tano.maxHitPoints - tano.damageTaken);
                observed.vehicleHpRatio = Math.min(1, cur / tano.maxHitPoints);
              }
            }
          }
          console.warn(
            `[live-bank] vehicle maxHP=${observed.vehicleMaxHp} damageTaken=${observed.vehicleDamageTaken} hpRatio=${observed.vehicleHpRatio}`,
          );

          // Cleanup.
          ctx.dismount();
          await ctx.wait(500);
          if (observed.vehicleId !== null) {
            ctx.send(new ConGenericMessage(`object destroy ${observed.vehicleId.toString()}`, 200));
          }
          await ctx.wait(500);
        },
      });

      expect(lifecycleResult.zonedInAt, 'zonedInAt populated').not.toBeNull();
      expect(lifecycleResult.scriptResult?.error, 'script did not throw').toBeUndefined();

      // --- Hard assertions (no soft-skips per project policy) ---

      // (1) Inventory slot capacity.
      expect(
        observed.inventoryTotalSlots,
        'ctx.inventory.totalSlots must be > 0 (default 80 for admin-pool chars)',
      ).toBeGreaterThan(0);
      expect(
        observed.inventoryUsedSlots,
        'usedSlots is a non-negative count',
      ).toBeGreaterThanOrEqual(0);
      expect(observed.inventoryFreeSlots, 'freeSlots = totalSlots - usedSlots').toBe(
        observed.inventoryTotalSlots - observed.inventoryUsedSlots,
      );

      // (2) Bank flow.
      expect(
        observed.bankContainerId,
        'ctx.bank.containerId must be discovered from the player-slot SHARED baseline at zone-in',
      ).not.toBeNull();
      expect(observed.bankReady, 'ctx.bank.ready must be true once the container is bound').toBe(
        true,
      );
      expect(
        observed.bankItemsCount,
        'ctx.bank.items.length must be a non-negative number (0 for an empty bank is fine)',
      ).toBeGreaterThanOrEqual(0);

      // (3) Vehicle condition path.
      expect(
        observed.vehicleId,
        `vehicle CREO must be admin-spawnable. bailReason=${observed.bailReason ?? 'unknown'}`,
      ).not.toBeNull();
      expect(
        observed.vehicleMaxHp,
        'vehicle must have a positive maxHitPoints from its TANO SHARED baseline',
      ).toBeGreaterThan(0);
      expect(
        observed.vehicleHpRatio,
        'vehicle condition (HP ratio) must compute to a value in (0,1]',
      ).toBeGreaterThan(0);
      expect(observed.vehicleHpRatio!).toBeLessThanOrEqual(1);
    }, 90_000);
  },
);
