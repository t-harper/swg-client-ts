/**
 * Unit tests for the `ctx.travel` view + the buyTicket / useTicket /
 * listDestinations action methods. Uses the fake-context test harness:
 * we simulate inbound `EnterTicketPurchaseModeMessage` /
 * `PlanetTravelPointListResponse` / `CmdStartScene` to drive the action
 * methods through their full state machines.
 */
import { describe, expect, it } from 'vitest';

// Side-effect: register baseline decoders so SHARED baselines decode
// into typed values inside the fake recv path.
import '../../messages/game/baselines/index.js';

import { ReadIterator } from '../../archive/read-iterator.js';
import { CmdStartScene } from '../../messages/game/cmd-start-scene.js';
import {
  CM_COMMAND_QUEUE_ENQUEUE,
  CommandQueueEnqueue,
  hashCommand,
} from '../../messages/game/command-queue/index.js';
import { ObjControllerMessage } from '../../messages/game/obj-controller-message.js';
import {
  ObjectMenuSelectMessage,
  RadialMenuTypes,
} from '../../messages/game/object-menu-select-message.js';
import { SceneCreateObjectByName } from '../../messages/game/scene-create-object-by-name.js';
import {
  EnterTicketPurchaseModeMessage,
  PlanetTravelPointListRequest,
  PlanetTravelPointListResponse,
} from '../../messages/game/travel/index.js';
import { UpdateContainmentMessage } from '../../messages/game/update-containment-message.js';
import { createFakeContext } from './test-helpers.js';
import { encodeTravelPointForCommand } from './travel.js';

const IDENTITY = { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } };

/** Walk a list of sent messages and decode any wrapping a CommandQueueEnqueue. */
function findEnqueue(
  sent: { message?: unknown; data?: Uint8Array; constructor: { name: string } }[],
  commandName: string,
): CommandQueueEnqueue | undefined {
  const wanted = hashCommand(commandName);
  for (const m of sent) {
    if (!(m instanceof ObjControllerMessage)) continue;
    if (m.message !== CM_COMMAND_QUEUE_ENQUEUE) continue;
    const decoded = CommandQueueEnqueue.unpack(new ReadIterator(m.data));
    if (decoded.commandHash === wanted) return decoded;
  }
  return undefined;
}

function findEnqueueWithTarget(
  sent: { message?: unknown; data?: Uint8Array; constructor: { name: string } }[],
  commandName: string,
): { enqueue: CommandQueueEnqueue; wrapper: ObjControllerMessage } | undefined {
  const wanted = hashCommand(commandName);
  for (const m of sent) {
    if (!(m instanceof ObjControllerMessage)) continue;
    if (m.message !== CM_COMMAND_QUEUE_ENQUEUE) continue;
    const decoded = CommandQueueEnqueue.unpack(new ReadIterator(m.data));
    if (decoded.commandHash === wanted) return { enqueue: decoded, wrapper: m };
  }
  return undefined;
}
const VENDOR_TEMPLATE = 'object/tangible/terminal/shared_terminal_travel.iff';
const COLLECTOR_TEMPLATE = 'object/tangible/travel/ticket_collector/shared_ticket_collector.iff';
const INVENTORY_TEMPLATE = 'object/tangible/inventory/shared_character_inventory.iff';
const TICKET_TEMPLATE = 'object/tangible/travel/travel_ticket/base/shared_base_travel_ticket.iff';
const SHUTTLE_TEMPLATE = 'object/creature/npc/theme_park/shared_lambda_shuttle.iff';

describe('encodeTravelPointForCommand', () => {
  it('replaces spaces with underscores', () => {
    expect(encodeTravelPointForCommand('Mos Eisley')).toBe('Mos_Eisley');
    expect(encodeTravelPointForCommand('theed')).toBe('theed');
    expect(encodeTravelPointForCommand('multi word name')).toBe('multi_word_name');
  });
});

describe('ctx.travel.findTicketVendor', () => {
  it('returns the nearest terminal_travel object', () => {
    const playerId = 0x1n;
    const { ctx, simulateRecv } = createFakeContext({
      playerNetworkId: playerId,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    simulateRecv(
      new SceneCreateObjectByName(
        0xa1n,
        { ...IDENTITY, position: { x: 10, y: 0, z: 0 } },
        VENDOR_TEMPLATE,
        false,
      ),
    );
    simulateRecv(
      new SceneCreateObjectByName(
        0xa2n,
        { ...IDENTITY, position: { x: 5, y: 0, z: 0 } },
        VENDOR_TEMPLATE,
        false,
      ),
    );
    const v = ctx.travel.findTicketVendor();
    expect(v?.id).toBe(0xa2n);
  });

  it('honours maxRadiusM', () => {
    const playerId = 0x1n;
    const { ctx, simulateRecv } = createFakeContext({
      playerNetworkId: playerId,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    simulateRecv(
      new SceneCreateObjectByName(
        0xa1n,
        { ...IDENTITY, position: { x: 200, y: 0, z: 0 } },
        VENDOR_TEMPLATE,
        false,
      ),
    );
    expect(ctx.travel.findTicketVendor()).toBeUndefined();
    expect(ctx.travel.findTicketVendor({ maxRadiusM: 300 })?.id).toBe(0xa1n);
  });

  it('returns undefined when no vendor is in range', () => {
    const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
    expect(ctx.travel.findTicketVendor()).toBeUndefined();
  });
});

describe('ctx.travel.findTicketCollector', () => {
  it('prefers ticket_collector templates over shuttle templates', () => {
    const playerId = 0x1n;
    const { ctx, simulateRecv } = createFakeContext({
      playerNetworkId: playerId,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    simulateRecv(
      new SceneCreateObjectByName(
        0xa1n,
        { ...IDENTITY, position: { x: 5, y: 0, z: 0 } },
        SHUTTLE_TEMPLATE,
        false,
      ),
    );
    simulateRecv(
      new SceneCreateObjectByName(
        0xa2n,
        { ...IDENTITY, position: { x: 8, y: 0, z: 0 } },
        COLLECTOR_TEMPLATE,
        false,
      ),
    );
    // Both in range — the collector wins even though the shuttle is closer.
    expect(ctx.travel.findTicketCollector()?.id).toBe(0xa2n);
  });

  it('falls back to a shuttle creature when no collector exists', () => {
    const playerId = 0x1n;
    const { ctx, simulateRecv } = createFakeContext({
      playerNetworkId: playerId,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    simulateRecv(
      new SceneCreateObjectByName(
        0xa1n,
        { ...IDENTITY, position: { x: 5, y: 0, z: 0 } },
        SHUTTLE_TEMPLATE,
        false,
      ),
    );
    expect(ctx.travel.findTicketCollector()?.id).toBe(0xa1n);
  });
});

describe('ctx.travel.currentTickets', () => {
  it('returns inventory items whose template matches travel_ticket', () => {
    const { ctx, simulateRecv } = createFakeContext({
      playerNetworkId: 0x1n,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    // Inventory container — required for InventoryView.items to populate.
    const invId = 0xc0ffeen;
    simulateRecv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));
    // One ticket + one non-ticket inside the inventory.
    simulateRecv(new SceneCreateObjectByName(0xd1n, IDENTITY, TICKET_TEMPLATE, false));
    simulateRecv(
      new SceneCreateObjectByName(
        0xb1n,
        IDENTITY,
        'object/tangible/loot/misc/shared_credit_chip.iff',
        false,
      ),
    );
    simulateRecv(new UpdateContainmentMessage(0xd1n, invId, 1));
    simulateRecv(new UpdateContainmentMessage(0xb1n, invId, 2));

    const tickets = ctx.travel.currentTickets();
    expect(tickets.map((t) => t.itemId)).toEqual([0xd1n]);
  });
});

describe('ctx.listDestinations', () => {
  it('sends ObjectMenuSelect + PlanetTravelPointListRequest then returns flattened list', async () => {
    const { ctx, simulateRecv, sent } = createFakeContext({
      playerNetworkId: 0x42n,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    simulateRecv(
      new SceneCreateObjectByName(
        0xfe1n,
        { ...IDENTITY, position: { x: 5, y: 0, z: 0 } },
        VENDOR_TEMPLATE,
        false,
      ),
    );

    const promise = ctx.listDestinations({ timeoutMs: 5_000 });
    // Yield so the helper sends ObjectMenuSelect and registers its waitFor.
    await new Promise((r) => setImmediate(r));
    simulateRecv(new EnterTicketPurchaseModeMessage('tatooine', 'mos_eisley', false));

    // Each PlanetTravelPointListRequest registers a waitFor; deliver one
    // response per request as they arrive.
    let safety = 0;
    while (safety++ < 50) {
      await new Promise((r) => setImmediate(r));
      const lastRequest = sent.findLast((m) => m instanceof PlanetTravelPointListRequest) as
        | PlanetTravelPointListRequest
        | undefined;
      if (lastRequest === undefined) break;
      // Reply once per unique planet.
      // The helper iterates planets sequentially; we feed one response per tick.
      const planet = lastRequest.planetName;
      const alreadyReplied = sent.filter(
        (m) => m instanceof PlanetTravelPointListRequest && m.planetName === planet,
      ).length;
      if (alreadyReplied > 1) break;
      if (planet === 'tatooine') {
        simulateRecv(
          new PlanetTravelPointListResponse(
            'tatooine',
            ['Mos Eisley', 'Bestine'],
            [
              { x: 3500, y: 5, z: -4800 },
              { x: -1300, y: 12, z: -3600 },
            ],
            [100, 100],
            [true, false],
          ),
        );
      } else if (planet === 'naboo') {
        simulateRecv(
          new PlanetTravelPointListResponse(
            'naboo',
            ['Theed'],
            [{ x: -5000, y: 8, z: 4000 }],
            [200],
            [true],
          ),
        );
      } else {
        // For all other planets reply with an empty list (server-side check
        // would normally drop these as "no such planet").
        simulateRecv(new PlanetTravelPointListResponse(planet, [], [], [], []));
      }
    }
    const list = await promise;
    expect(list).toContain('tatooine/Mos Eisley');
    expect(list).toContain('tatooine/Bestine');
    expect(list).toContain('naboo/Theed');

    // The first wire send must be ObjectMenuSelectMessage(vendor, ITEM_USE).
    const first = sent[0];
    expect(first).toBeInstanceOf(ObjectMenuSelectMessage);
    expect((first as ObjectMenuSelectMessage).targetId).toBe(0xfe1n);
    expect((first as ObjectMenuSelectMessage).selectedItemId).toBe(RadialMenuTypes.ITEM_USE);
  }, 15_000);

  it('throws when no vendor is in range', async () => {
    const { ctx } = createFakeContext({ playerNetworkId: 0x1n });
    await expect(ctx.listDestinations({ timeoutMs: 1_000 })).rejects.toThrow(/no ticket vendor/);
  });
});

describe('ctx.buyTicket', () => {
  it('sends purchaseTicket command with formatted params', async () => {
    const { ctx, simulateRecv, sent } = createFakeContext({
      playerNetworkId: 0x42n,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    // Vendor + inventory container.
    simulateRecv(
      new SceneCreateObjectByName(
        0xfe1n,
        { ...IDENTITY, position: { x: 5, y: 0, z: 0 } },
        VENDOR_TEMPLATE,
        false,
      ),
    );
    const invId = 0xc0ffeen;
    simulateRecv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));

    const promise = ctx.buyTicket({ destination: 'Bestine', timeoutMs: 8_000 });
    await new Promise((r) => setImmediate(r));
    simulateRecv(new EnterTicketPurchaseModeMessage('tatooine', 'mos_eisley', false));

    // Reply to the first PlanetTravelPointListRequest with a tatooine list
    // that includes 'Bestine'. Subsequent planets get empty responses.
    let purchaseCommand: CommandQueueEnqueue | undefined;
    const respondedPlanets = new Set<string>();
    let safety = 0;
    while (safety++ < 200) {
      await new Promise((r) => setImmediate(r));
      // After every nudge: respond to any unanswered planet request; check
      // for the purchaseTicket command + spawn the ticket item.
      const requests = sent.filter(
        (m): m is PlanetTravelPointListRequest => m instanceof PlanetTravelPointListRequest,
      );
      for (const req of requests) {
        if (respondedPlanets.has(req.planetName)) continue;
        respondedPlanets.add(req.planetName);
        if (req.planetName === 'tatooine') {
          simulateRecv(
            new PlanetTravelPointListResponse(
              'tatooine',
              ['Mos Eisley', 'Bestine'],
              [
                { x: 0, y: 0, z: 0 },
                { x: 0, y: 0, z: 0 },
              ],
              [100, 100],
              [false, false],
            ),
          );
        } else {
          simulateRecv(new PlanetTravelPointListResponse(req.planetName, [], [], [], []));
        }
      }
      // Detect the wrapped purchaseTicket enqueue (decoded from data bytes).
      if (purchaseCommand === undefined) {
        purchaseCommand = findEnqueue(sent, 'purchaseTicket');
        if (purchaseCommand !== undefined) {
          // Spawn the new ticket item inside the inventory.
          simulateRecv(new SceneCreateObjectByName(0xdead1n, IDENTITY, TICKET_TEMPLATE, false));
          simulateRecv(new UpdateContainmentMessage(0xdead1n, invId, 5));
        }
      }
      if (purchaseCommand !== undefined) {
        // Give the loop another tick to observe the ticket via the polling
        // loop in buyTicket.
        await new Promise((r) => setImmediate(r));
        break;
      }
    }
    // Drain pending timer / poll ticks so the action method observes the
    // ticket. The polling loop sleeps 250ms each iteration.
    await new Promise((r) => setTimeout(r, 400));
    const ticketId = await promise;
    expect(ticketId).toBe(0xdead1n);
    expect(purchaseCommand).toBeDefined();
    // params format: "<planet1> <point1> <planet2> <point2> <round> <instant>"
    expect(purchaseCommand?.params).toBe('tatooine mos_eisley tatooine Bestine 0 0');
  }, 20_000);

  it('throws when the destination is not offered by the vendor', async () => {
    const { ctx, simulateRecv, sent } = createFakeContext({
      playerNetworkId: 0x42n,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    simulateRecv(
      new SceneCreateObjectByName(
        0xfe1n,
        { ...IDENTITY, position: { x: 5, y: 0, z: 0 } },
        VENDOR_TEMPLATE,
        false,
      ),
    );
    const invId = 0xc0ffeen;
    simulateRecv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));

    // Attach a swallow handler so vitest doesn't flag the rejection as
    // unhandled while we drive the response loop.
    const promise = ctx.buyTicket({ destination: 'Mythicalplanet', timeoutMs: 6_000 });
    promise.catch(() => {
      /* observed by expect(...).rejects below */
    });
    await new Promise((r) => setImmediate(r));
    simulateRecv(new EnterTicketPurchaseModeMessage('tatooine', 'mos_eisley', false));

    // Respond with at least one planet that has a destination — but not the
    // one we asked for. That way `fetchAllDestinations` returns non-empty and
    // we hit the "not in vendor list" path instead of "vendor returned no
    // destinations".
    const responded = new Set<string>();
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setImmediate(r));
      const requests = sent.filter(
        (m): m is PlanetTravelPointListRequest => m instanceof PlanetTravelPointListRequest,
      );
      for (const req of requests) {
        if (responded.has(req.planetName)) continue;
        responded.add(req.planetName);
        if (req.planetName === 'tatooine') {
          simulateRecv(
            new PlanetTravelPointListResponse(
              'tatooine',
              ['Mos Eisley'],
              [{ x: 0, y: 0, z: 0 }],
              [100],
              [false],
            ),
          );
        } else {
          simulateRecv(new PlanetTravelPointListResponse(req.planetName, [], [], [], []));
        }
      }
    }
    await expect(promise).rejects.toThrow(/Mythicalplanet/);
  }, 20_000);
});

describe('ctx.useTicket', () => {
  it('sends boardShuttle command then waits for CmdStartScene', async () => {
    const { ctx, simulateRecv, sent } = createFakeContext({
      playerNetworkId: 0x42n,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    // Collector + inventory + ticket in inventory.
    simulateRecv(
      new SceneCreateObjectByName(
        0xc1n,
        { ...IDENTITY, position: { x: 5, y: 0, z: 0 } },
        COLLECTOR_TEMPLATE,
        false,
      ),
    );
    const invId = 0xc0ffeen;
    simulateRecv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));
    simulateRecv(new SceneCreateObjectByName(0xd1n, IDENTITY, TICKET_TEMPLATE, false));
    simulateRecv(new UpdateContainmentMessage(0xd1n, invId, 1));

    const promise = ctx.useTicket({ timeoutMs: 5_000 });
    await new Promise((r) => setImmediate(r));
    // Feed the inbound CmdStartScene the helper is waiting for.
    simulateRecv(
      new CmdStartScene({
        disableWorldSnapshot: false,
        playerNetworkId: 0x42n,
        sceneName: 'terrain/naboo.trn',
        startPosition: { x: -5000, y: 8, z: 4000 },
        startYaw: 0,
        templateName: '',
        serverTimeSeconds: 0n,
        serverEpoch: 0,
      }),
    );
    const result = await promise;
    expect(result.destinationPlanet).toBe('naboo');
    expect(result.destinationPosition.x).toBeCloseTo(-5000);
    expect(result.destinationPosition.z).toBeCloseTo(4000);

    // Verify a boardShuttle command went out to the collector with the ticket.
    const found = findEnqueueWithTarget(sent, 'boardShuttle');
    expect(found).toBeDefined();
    expect(found?.wrapper.networkId).toBe(0x42n);
    expect(found?.enqueue.targetId).toBe(0xc1n);
    expect(found?.enqueue.params).toBe('209'); // ticket NetworkId 0xd1n in decimal
  });

  it('throws when no ticket is in inventory', async () => {
    const { ctx, simulateRecv } = createFakeContext({
      playerNetworkId: 0x42n,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    simulateRecv(
      new SceneCreateObjectByName(
        0xc1n,
        { ...IDENTITY, position: { x: 5, y: 0, z: 0 } },
        COLLECTOR_TEMPLATE,
        false,
      ),
    );
    await expect(ctx.useTicket({ timeoutMs: 1_000 })).rejects.toThrow(/no ticket in inventory/);
  });

  it('throws when no collector is in range', async () => {
    const { ctx, simulateRecv } = createFakeContext({
      playerNetworkId: 0x42n,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    const invId = 0xc0ffeen;
    simulateRecv(new SceneCreateObjectByName(invId, IDENTITY, INVENTORY_TEMPLATE, false));
    simulateRecv(new SceneCreateObjectByName(0xd1n, IDENTITY, TICKET_TEMPLATE, false));
    simulateRecv(new UpdateContainmentMessage(0xd1n, invId, 1));
    await expect(ctx.useTicket({ timeoutMs: 1_000 })).rejects.toThrow(/no ticket collector/);
  });
});
