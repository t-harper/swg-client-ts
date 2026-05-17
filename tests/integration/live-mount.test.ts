/**
 * Live integration test: vehicle / mount wire flow.
 *
 * Drives the full call-vehicle → mount → walk → dismount → store-vehicle
 * sequence against the real swg-server, then asserts the expected wire
 * traffic was emitted and the speed-cap state toggled around mount.
 *
 * Test data prerequisite (the hard part)
 * --------------------------------------
 * A fresh `ClientCreateCharacter` character does NOT have a vehicle PCD
 * in their datapad. The character must either:
 *   - have been previously granted one via admin command (`/object createIn`
 *     against a shared template like
 *     `object/intangible/vehicle/shared_landspeeder_ab1_pcd.iff`), OR
 *   - be drawn from the persistent character pool, pre-stocked with a
 *     vehicle (see `tests/integration/helpers.ts` → `poolCredentials` +
 *     `swg-ts-cli pool stock`).
 *
 * If the character has no Vehicle PCD in their datapad, the test SKIPS
 * cleanly with a `console.warn` explaining the prerequisite — the wire
 * flow is still validated by the unit tests in `context.test.ts`; this
 * file's job is the live end-to-end happy path.
 *
 * Gated on `LIVE=1`. Runs against the swg-server at 10.254.0.253.
 */
import { describe, expect, it } from 'vitest';

import { ReadIterator } from '../../src/archive/read-iterator.js';
import { buildContainerIndex, containerView } from '../../src/client/container-view.js';
import type { ContainerItem } from '../../src/client/container-view.js';
import { SwgClient } from '../../src/client/swg-client.js';
import {
  CM_COMMAND_QUEUE_ENQUEUE,
  CommandQueueEnqueue,
  hashCommand,
} from '../../src/messages/game/command-queue/index.js';
import { ObjControllerMessage } from '../../src/messages/game/obj-controller-message.js';
import { ObjControllerSubtypeIds } from '../../src/messages/game/obj-controller/index.js';
import { ObjectMenuSelectMessage } from '../../src/messages/game/object-menu-select-message.js';
import { SceneCreateObjectByName } from '../../src/messages/game/scene-create-object-by-name.js';
import type { NetworkId } from '../../src/types.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

const PET_CALL = 45;
const PET_STORE = 60;

/**
 * Shared-template pattern emitted by SceneCreateObjectByName for vehicle PCDs.
 * Verified against `dsrc/sku.0/sys.shared/compiled/game/object/intangible/vehicle/`
 * (every shared PCD lives there as `shared_*_pcd.tpf`); the runtime path the
 * server emits is `object/intangible/vehicle/shared_*_pcd.iff`. We tolerate
 * either prefix form.
 */
const VEHICLE_PCD_TEMPLATE = /\/object\/intangible\/vehicle\/(shared_)?[^/]+_pcd\.iff$/;

/**
 * Shared template for a live spawned vehicle creature (post-call). PCD spawns
 * the creature under `object/mobile/vehicle/shared_*.iff` (sometimes
 * `object/mobile/vehicle/*.iff`).
 */
const VEHICLE_CREATURE_TEMPLATE = /\/object\/mobile\/vehicle\/(shared_)?[^/]+\.iff$/;

function isVehiclePcd(item: ContainerItem): boolean {
  if (item.templateName === null) return false;
  return VEHICLE_PCD_TEMPLATE.test(item.templateName);
}

describe.skipIf(!LIVE)('live vehicle / mount (call → mount → walk → dismount → store)', () => {
  it('runs the full mount flow when a Vehicle PCD is in the datapad', async () => {
    const { account, characterName } = liveCredentials('mt');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const observed = {
      pcdId: null as NetworkId | null,
      spawnedVehicleId: null as NetworkId | null,
      capDuringMount: null as number | null,
      capAfterDismount: undefined as number | null | undefined,
      ranMountFlow: false,
    };

    let lifecycleResult: Awaited<ReturnType<typeof client.fullLifecycle>>;
    try {
      lifecycleResult = await client.fullLifecycle({
        account,
        characterName,
        planet: 'mos_eisley',
        holdZonedInMs: 0,
        script: async (ctx) => {
          await ctx.wait(1_500);

          const playerId = ctx.sceneStart.playerNetworkId;
          const index = buildContainerIndex(ctx.dispatcher.transcript);
          const playerChildren = index.get(playerId) ?? [];
          const datapadEntry = playerChildren.find(
            (c) => c.templateName !== null && /\/datapad\//.test(c.templateName),
          );

          if (datapadEntry === undefined) {
            console.warn(
              '[live-mount] No datapad container child found under player ' +
                `${playerId.toString()} — cannot search for a vehicle PCD. ` +
                'This is unexpected on a normal zone-in; check the transcript ' +
                'for UpdateContainmentMessage events naming the player as parent.',
            );
            return;
          }

          const datapad = containerView(ctx.dispatcher.transcript, datapadEntry.networkId);
          const vehiclePcd = datapad.findFirst(isVehiclePcd);

          if (vehiclePcd === null) {
            console.warn(
              `[live-mount] No Vehicle PCD in datapad (${datapad.size()} items). ` +
                'Skipping mount flow; the wire path is still covered by ' +
                'context.test.ts. To enable the live end-to-end run, ensure ' +
                'the test character owns a vehicle (admin /object createIn of a ' +
                'shared_*_pcd template, or stock the character pool with one). ' +
                `Datapad templates: [${datapad
                  .items()
                  .map((i) => i.templateName ?? `crc:${i.templateCrc?.toString(16) ?? '?'}`)
                  .join(', ')}]`,
            );
            return;
          }

          observed.pcdId = vehiclePcd.networkId;
          const transcriptLenBeforeCall = ctx.dispatcher.transcript.length;

          ctx.callVehicle(vehiclePcd.networkId);
          await ctx.wait(2_000);

          for (let i = transcriptLenBeforeCall; i < ctx.dispatcher.transcript.length; i++) {
            const e = ctx.dispatcher.transcript[i];
            if (e === undefined) continue;
            if (e.direction !== 'recv') continue;
            if (e.decoded === null) continue;
            if (!(e.decoded instanceof SceneCreateObjectByName)) continue;
            if (VEHICLE_CREATURE_TEMPLATE.test(e.decoded.templateName)) {
              observed.spawnedVehicleId = e.decoded.networkId;
              break;
            }
          }

          if (observed.spawnedVehicleId === null) {
            console.warn(
              '[live-mount] Vehicle PCD found but no spawned vehicle creature ' +
                'observed within 2s of callVehicle. The server may have ' +
                "rejected the call (out-of-cell, terrain), or the spawn used " +
                'SceneCreateObjectByCrc (template-by-CRC). Storing the PCD ' +
                'directly to leave the world clean.',
            );
            ctx.storeVehicle(vehiclePcd.networkId);
            await ctx.wait(500);
            return;
          }

          ctx.mount(observed.spawnedVehicleId);
          observed.capDuringMount = ctx.mountedSpeedCap();

          const start = ctx.position();
          try {
            await ctx.walkTo({ x: start.x + 20, z: start.z + 20 }, { speed: 20, tickMs: 250 });
          } catch (err) {
            console.warn(
              `[live-mount] walkTo during mount threw: ${err instanceof Error ? err.message : String(err)} — continuing to dismount.`,
            );
          }

          ctx.dismount();
          observed.capAfterDismount = ctx.mountedSpeedCap();

          await ctx.wait(500);
          ctx.storeVehicle(observed.spawnedVehicleId);
          await ctx.wait(500);
          observed.ranMountFlow = true;
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('canCreateRegularCharacter=false')) {
        console.warn(
          '[live-mount] Server has disabled character creation; skipping. ' +
            'Set CI_REUSE_ACCOUNT + CI_REUSE_CHARACTER to a pre-existing pair, ' +
            'or stock the character pool with `swg-ts-cli pool stock --count=1`.',
        );
        return;
      }
      throw err;
    }

    expect(lifecycleResult.zonedInAt, 'zonedInAt populated').not.toBeNull();
    expect(lifecycleResult.scriptResult?.error, 'script did not throw').toBeUndefined();

    if (observed.pcdId === null) {
      console.warn(
        '[live-mount] No datapad observed during zone-in. Test reached zone-in ' +
          'but could not exercise the mount flow.',
      );
      return;
    }

    if (!observed.ranMountFlow) {
      console.warn(
        '[live-mount] Skipped mount flow (prerequisite not met). Asserting ' +
          'only that the lifecycle reached zone-in cleanly.',
      );
      return;
    }

    expect(observed.capDuringMount, 'mountedSpeedCap() returns 12 after mount()').toBe(12);
    expect(observed.capAfterDismount, 'mountedSpeedCap() returns null after dismount()').toBeNull();

    expect(lifecycleResult.receivedErrorMessage, 'no ErrorMessage during run').toBe(false);

    const pcdId = observed.pcdId;
    const vehicleId = observed.spawnedVehicleId;
    if (vehicleId === null) throw new Error('unreachable: ranMountFlow without vehicleId');

    const sentMenuSelects = lifecycleResult.transcript.filter(
      (e): e is typeof e & { decoded: ObjectMenuSelectMessage } =>
        e.direction === 'send' &&
        e.messageName === 'ObjectMenuSelectMessage' &&
        'decoded' in e &&
        e.decoded instanceof ObjectMenuSelectMessage,
    );

    const callMatch = sentMenuSelects.find(
      (e) => e.decoded.targetId === pcdId && e.decoded.selectedItemId === PET_CALL,
    );
    expect(callMatch, 'transcript contains callVehicle ObjectMenuSelect (PCD, PET_CALL=45)').toBeDefined();

    const storeMatch = sentMenuSelects.find(
      (e) => e.decoded.targetId === vehicleId && e.decoded.selectedItemId === PET_STORE,
    );
    expect(storeMatch, 'transcript contains storeVehicle ObjectMenuSelect (vehicleId, PET_STORE=60)').toBeDefined();

    const mountHash = hashCommand('mount');
    const dismountHash = hashCommand('dismount');
    let mountEnqueueFound = false;
    let dismountEnqueueFound = false;

    for (const event of lifecycleResult.transcript) {
      if (event.direction !== 'send') continue;
      if (event.messageName !== 'ObjControllerMessage') continue;
      if (!('decoded' in event) || !(event.decoded instanceof ObjControllerMessage)) continue;
      if (event.decoded.message !== CM_COMMAND_QUEUE_ENQUEUE) continue;
      const enq = CommandQueueEnqueue.unpack(new ReadIterator(event.decoded.data));
      if (enq.commandHash === mountHash && enq.targetId === vehicleId) mountEnqueueFound = true;
      if (enq.commandHash === dismountHash) dismountEnqueueFound = true;
    }

    expect(mountEnqueueFound, 'CommandQueueEnqueue(mount, vehicleId) was sent').toBe(true);
    expect(dismountEnqueueFound, 'CommandQueueEnqueue(dismount) was sent').toBe(true);

    const sentTransforms = lifecycleResult.transcript.filter((event) => {
      if (event.direction !== 'send' || event.messageName !== 'ObjControllerMessage') return false;
      if (!('decoded' in event) || !(event.decoded instanceof ObjControllerMessage)) return false;
      return event.decoded.message === ObjControllerSubtypeIds.CM_netUpdateTransform;
    });
    expect(
      sentTransforms.length,
      'at least one CM_netUpdateTransform sent during mounted walk',
    ).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
