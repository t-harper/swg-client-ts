/**
 * Unit tests for CraftingSessionCacheImpl + ctx.crafting wiring.
 */
import { describe, expect, it } from 'vitest';

import { ByteStream } from '../archive/byte-stream.js';
import {
  CraftingIngredientType,
  type ManufactureSchematicData,
  ManufactureSchematicDecoder,
} from '../messages/game/crafting/index.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import {
  CLIENT_TO_AUTH_SERVER_FLAGS,
} from '../messages/game/command-queue/index.js';
import {
  type CraftingResultData,
  CraftingResultDecoder,
  ObjControllerSubtypeIds,
} from '../messages/game/obj-controller/index.js';
import { CraftingSessionCacheImpl } from './crafting-session.js';
import { createFakeContext } from './script/test-helpers.js';

/** Helper: build the inbound ObjControllerMessage that opens a session with one slot. */
function makeDraftSlotsMsg(
  toolId: bigint,
  manfSchemId: bigint,
  slotName: string,
  optional: boolean,
): ObjControllerMessage {
  const data: ManufactureSchematicData = {
    toolId,
    manfSchemId,
    prototypeId: 0n,
    volume: 1,
    canManufacture: false,
    slots: [
      {
        name: { table: 'craft_artisan_n', index: 0, text: slotName },
        optional,
        options: [
          {
            name: { table: '', index: 0, text: '' },
            ingredient: 'iron',
            type: CraftingIngredientType.ResourceClass,
            amountNeeded: 10,
          },
        ],
        hardpoint: '',
      },
    ],
  };
  const stream = new ByteStream();
  ManufactureSchematicDecoder.encode(stream, data);
  return new ObjControllerMessage(
    0x01,
    ObjControllerSubtypeIds.CM_draftSlotsMessage,
    toolId,
    0,
    stream.toBytes(),
    { kind: ManufactureSchematicDecoder.kind, data },
  );
}

function makeCraftingResultMsg(requestId: number, response: number): ObjControllerMessage {
  const data: CraftingResultData = { requestId, response, sequenceId: 1 };
  const stream = new ByteStream();
  CraftingResultDecoder.encode(stream, data);
  return new ObjControllerMessage(
    0x01,
    ObjControllerSubtypeIds.CM_craftingResult,
    0n,
    0,
    stream.toBytes(),
    { kind: CraftingResultDecoder.kind, data },
  );
}

describe('CraftingSessionCacheImpl', () => {
  it('session starts as { active: false }', () => {
    const { ctx } = createFakeContext();
    expect(ctx.crafting.session.active).toBe(false);
  });

  it('flips to active after a DraftSlots message arrives', () => {
    const { ctx, simulateRecv } = createFakeContext();
    simulateRecv(makeDraftSlotsMsg(0x100n, 0x200n, 'Slot_Metal', false));
    const sess = ctx.crafting.session;
    expect(sess.active).toBe(true);
    if (!sess.active) throw new Error('unreachable');
    expect(sess.schematic.id).toBe(0x200n);
    expect(sess.slots).toHaveLength(1);
    expect(sess.slots[0]?.name).toBe('Slot_Metal');
    expect(sess.slots[0]?.optional).toBe(false);
    expect(sess.slots[0]?.assignedId).toBeNull();
    // No assignments yet, and the slot is required → canFinish is false.
    expect(sess.canFinish).toBe(false);
  });

  it('canFinish is true when all required slots are assigned', () => {
    const { ctx, simulateRecv } = createFakeContext();
    simulateRecv(makeDraftSlotsMsg(0x100n, 0x200n, 'Slot_Metal', false));
    // assignCraftingSlot mirrors the assignment into the cache.
    ctx.assignCraftingSlot(0, 0xabcn);
    const sess = ctx.crafting.session;
    if (!sess.active) throw new Error('expected active');
    expect(sess.slots[0]?.assignedId).toBe(0xabcn);
    expect(sess.canFinish).toBe(true);
  });

  it('clearCraftingSlot un-assigns the slot and flips canFinish back to false', () => {
    const { ctx, simulateRecv } = createFakeContext();
    simulateRecv(makeDraftSlotsMsg(0x100n, 0x200n, 'Slot_Metal', false));
    ctx.assignCraftingSlot(0, 0xabcn);
    expect(ctx.crafting.session.active && ctx.crafting.session.canFinish).toBe(true);
    ctx.clearCraftingSlot(0);
    const sess = ctx.crafting.session;
    if (!sess.active) throw new Error('expected active');
    expect(sess.slots[0]?.assignedId).toBeNull();
    expect(sess.canFinish).toBe(false);
  });

  it('optional slots without assignments do NOT block canFinish', () => {
    const { ctx, simulateRecv } = createFakeContext();
    simulateRecv(makeDraftSlotsMsg(0x100n, 0x200n, 'OptionalSlot', true /* optional */));
    expect(ctx.crafting.session.active && ctx.crafting.session.canFinish).toBe(true);
  });

  it('CraftingResult(requestId=CM_createPrototype, response>0) resets the session', () => {
    const { ctx, simulateRecv } = createFakeContext();
    simulateRecv(makeDraftSlotsMsg(0x100n, 0x200n, 'Slot', false));
    expect(ctx.crafting.session.active).toBe(true);
    // Success on createPrototype ⇒ session closed.
    simulateRecv(makeCraftingResultMsg(ObjControllerSubtypeIds.CM_createPrototype, 1));
    expect(ctx.crafting.session.active).toBe(false);
  });

  it('CraftingResult(requestId=CM_createPrototype, response=0 / failure) preserves session', () => {
    const { ctx, simulateRecv } = createFakeContext();
    simulateRecv(makeDraftSlotsMsg(0x100n, 0x200n, 'Slot', false));
    simulateRecv(makeCraftingResultMsg(ObjControllerSubtypeIds.CM_createPrototype, 0));
    expect(ctx.crafting.session.active).toBe(true);
  });

  it('detach() resets state — fresh cache starts at { active: false }', () => {
    const { ctx, simulateRecv } = createFakeContext();
    const cache = new CraftingSessionCacheImpl(ctx.dispatcher);
    cache.attach();
    simulateRecv(makeDraftSlotsMsg(0x100n, 0x200n, 'Slot', false));
    expect(cache.session.active).toBe(true);
    cache.detach();
    expect(cache.session.active).toBe(false);
    // After detach, further inbound shouldn't reactivate.
    simulateRecv(makeDraftSlotsMsg(0x100n, 0x200n, 'Slot', false));
    expect(cache.session.active).toBe(false);
  });

  // Reference an import we'd otherwise dead-code-eliminate.
  void CLIENT_TO_AUTH_SERVER_FLAGS;
});
