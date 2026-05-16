import { describe, expect, it } from 'vitest';
import { ReadIterator } from '../../archive/read-iterator.js';
import {
  ChatInstantMessageToCharacter,
  ChatPersistentMessageToServer,
  ChatRequestRoomList,
  ChatSendToRoom,
} from '../../messages/game/chat/index.js';
import { ClientOpenContainerMessage } from '../../messages/game/client-open-container.js';
import {
  CLIENT_TO_AUTH_SERVER_FLAGS,
  CM_COMMAND_QUEUE_ENQUEUE,
  CommandQueueEnqueue,
  hashCommand,
} from '../../messages/game/command-queue/index.js';
import { HeartBeat } from '../../messages/game/heart-beat.js';
import { LogoutMessage } from '../../messages/game/logout-message.js';
import { ObjControllerMessage } from '../../messages/game/obj-controller-message.js';
import {
  type CraftingExperimentData,
  CraftingExperimentDecoder,
  type CraftingSlotAssignData,
  CraftingSlotAssignDecoder,
  type CraftingSlotEmptyData,
  CraftingSlotEmptyDecoder,
  ObjControllerSubtypeIds,
  type SpatialChatData,
  SpatialChatSendKind,
  SpatialChatType,
} from '../../messages/game/obj-controller/index.js';
import { didScriptLogout, runScript } from './context.js';
import { createFakeContext } from './test-helpers.js';

describe('ScriptContext', () => {
  it('wait() resolves after the requested delay', async () => {
    const { ctx } = createFakeContext();
    const t0 = Date.now();
    await ctx.wait(80);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(60); // allow some scheduler slack
  });

  it('wait() rejects when the signal aborts', async () => {
    const { ctx, abort } = createFakeContext();
    const p = ctx.wait(10_000);
    setTimeout(() => abort(), 20);
    await expect(p).rejects.toThrow(/aborted/);
  });

  it('openPlayerInventory sends ClientOpenContainerMessage(player, "inventory")', () => {
    const playerId = 0x42n;
    const { ctx, sent } = createFakeContext({ playerNetworkId: playerId });
    ctx.openPlayerInventory();
    expect(sent.length).toBe(1);
    const m = sent[0];
    expect(m).toBeInstanceOf(ClientOpenContainerMessage);
    const c = m as ClientOpenContainerMessage;
    expect(c.containerId).toBe(playerId);
    expect(c.slot).toBe('inventory');
  });

  it('openContainer with explicit slot works', () => {
    const { ctx, sent } = createFakeContext();
    ctx.openContainer(0xabcn, 'bank_1');
    const c = sent[0] as ClientOpenContainerMessage;
    expect(c.slot).toBe('bank_1');
    expect(c.containerId).toBe(0xabcn);
  });

  it('closeContainer emits nothing on the wire', () => {
    const { ctx, sent } = createFakeContext();
    ctx.closeContainer(0x42n);
    expect(sent).toHaveLength(0);
  });

  it('send() escape hatch counts toward sendsCount', async () => {
    const { ctx } = createFakeContext();
    const result = await runScript(async (c) => {
      c.send(new HeartBeat());
      c.send(new HeartBeat());
    }, ctx);
    expect(result.sendsCount).toBe(2);
    expect(result.didLogout).toBe(false);
  });

  it('logout() sends LogoutMessage and marks didLogout', async () => {
    const { ctx, sent } = createFakeContext();
    const result = await runScript(async (c) => {
      await c.logout();
    }, ctx);
    expect(sent.some((m) => m instanceof LogoutMessage)).toBe(true);
    expect(result.didLogout).toBe(true);
    expect(didScriptLogout(ctx)).toBe(true);
  });

  it('runScript captures thrown errors instead of rethrowing', async () => {
    const { ctx } = createFakeContext();
    const result = await runScript(async () => {
      throw new Error('boom');
    }, ctx);
    expect(result.error).toBe('boom');
  });
});

describe('ScriptContext: combat / command-queue primitives', () => {
  it('useAbility sends one ObjControllerMessage with the right CM subtype and inner enqueue', () => {
    const playerId = 0x100n;
    const { ctx, sent } = createFakeContext({ playerNetworkId: playerId });
    const seq = ctx.useAbility('attack', 0x42n);
    expect(seq).toBe(1);
    expect(sent.length).toBe(1);
    const wrapped = sent[0];
    expect(wrapped).toBeInstanceOf(ObjControllerMessage);
    const obj = wrapped as ObjControllerMessage;
    expect(obj.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    expect(obj.flags).toBe(CLIENT_TO_AUTH_SERVER_FLAGS);
    expect(obj.networkId).toBe(playerId);

    const inner = CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
    expect(inner.sequenceId).toBe(1);
    expect(inner.commandHash).toBe(hashCommand('attack'));
    expect(inner.targetId).toBe(0x42n);
    expect(inner.params).toBe('');
  });

  it('useAbility increments the sequence counter (separate from movement)', () => {
    const { ctx } = createFakeContext();
    expect(ctx.useAbility('attack', 0x42n)).toBe(1);
    expect(ctx.useAbility('attack', 0x42n)).toBe(2);
    expect(ctx.useAbility('prone')).toBe(3);
    // Movement sequence should be untouched.
    expect(ctx.nextSequenceNumber()).toBe(1);
  });

  it('useAbility defaults targetId to 0n (NO_TARGET) and params to ""', () => {
    const { ctx, sent } = createFakeContext();
    ctx.useAbility('prone');
    const inner = CommandQueueEnqueue.unpack(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    expect(inner.targetId).toBe(0n);
    expect(inner.params).toBe('');
  });

  it('useAbility passes custom params through (e.g. ability arguments)', () => {
    const { ctx, sent } = createFakeContext();
    ctx.useAbility('macro', 0n, 'some-args');
    const inner = CommandQueueEnqueue.unpack(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    expect(inner.params).toBe('some-args');
  });

  it('attackTarget is sugar for useAbility("attack", target)', () => {
    const { ctx, sent } = createFakeContext();
    ctx.attackTarget(0xc0den);
    const inner = CommandQueueEnqueue.unpack(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    expect(inner.commandHash).toBe(hashCommand('attack'));
    expect(inner.targetId).toBe(0xc0den);
  });

  it('changePosture maps friendly names to server command names', () => {
    const { ctx, sent } = createFakeContext();
    ctx.changePosture('standing');
    ctx.changePosture('crouched');
    ctx.changePosture('prone');
    ctx.changePosture('sitting');
    const expectedCommands = ['stand', 'crouch', 'prone', 'sit'];
    for (let i = 0; i < 4; i++) {
      const m = sent[i];
      if (!(m instanceof ObjControllerMessage)) throw new Error('not ObjControllerMessage');
      const inner = CommandQueueEnqueue.unpack(new ReadIterator(m.data));
      expect(inner.commandHash).toBe(hashCommand(expectedCommands[i] as string));
      // No target for postures.
      expect(inner.targetId).toBe(0n);
    }
  });

  it('nextCommandSequence returns sequential values starting from 1', () => {
    const { ctx } = createFakeContext();
    expect(ctx.nextCommandSequence()).toBe(1);
    expect(ctx.nextCommandSequence()).toBe(2);
    expect(ctx.nextCommandSequence()).toBe(3);
  });

  it('combat sends count toward sendsCount', async () => {
    const { ctx } = createFakeContext();
    const result = await runScript(async (c) => {
      c.attackTarget(0x42n);
      c.attackTarget(0x42n);
      c.changePosture('prone');
    }, ctx);
    expect(result.sendsCount).toBe(3);
  });
});

describe('ScriptContext: chat primitives', () => {
  it('tell sends one ChatInstantMessageToCharacter with the target avatar', () => {
    const { ctx, sent } = createFakeContext();
    const seq = ctx.tell('FriendName', 'hello');
    expect(seq).toBe(1);
    expect(sent.length).toBe(1);
    const m = sent[0];
    expect(m).toBeInstanceOf(ChatInstantMessageToCharacter);
    const tell = m as ChatInstantMessageToCharacter;
    expect(tell.characterName.name).toBe('FriendName');
    expect(tell.message).toBe('hello');
    expect(tell.sequence).toBe(1);
  });

  it('sendToChannel sends one ChatSendToRoom with the right channel id', () => {
    const { ctx, sent } = createFakeContext();
    ctx.sendToChannel(42, 'in channel');
    expect(sent.length).toBe(1);
    const m = sent[0] as ChatSendToRoom;
    expect(m).toBeInstanceOf(ChatSendToRoom);
    expect(m.roomId).toBe(42);
    expect(m.message).toBe('in channel');
  });

  it('sendMail sends one ChatPersistentMessageToServer', () => {
    const { ctx, sent } = createFakeContext();
    ctx.sendMail('PenPal', 'subject', 'body');
    const m = sent[0];
    expect(m).toBeInstanceOf(ChatPersistentMessageToServer);
  });

  it('requestChannelList sends one ChatRequestRoomList', () => {
    const { ctx, sent } = createFakeContext();
    ctx.requestChannelList();
    expect(sent[0]).toBeInstanceOf(ChatRequestRoomList);
  });

  it('nextChatSequence increments independently of movement/command', () => {
    const { ctx } = createFakeContext();
    expect(ctx.nextChatSequence()).toBe(1);
    expect(ctx.nextChatSequence()).toBe(2);
    expect(ctx.nextSequenceNumber()).toBe(1);
    expect(ctx.nextCommandSequence()).toBe(1);
  });

  it('chat sends count toward sendsCount', async () => {
    const { ctx } = createFakeContext();
    const result = await runScript(async (c) => {
      c.tell('A', 'hi');
      c.sendToChannel(1, 'hi');
      c.requestChannelList();
    }, ctx);
    expect(result.sendsCount).toBe(3);
  });

  it('say sends one ObjControllerMessage with CM_spatialChatSend and embedded text', () => {
    const playerId = 0x501n;
    const { ctx, sent } = createFakeContext({ playerNetworkId: playerId });
    const seq = ctx.say('hello world');
    expect(seq).toBe(1);
    expect(sent.length).toBe(1);
    const wrapped = sent[0];
    expect(wrapped).toBeInstanceOf(ObjControllerMessage);
    const om = wrapped as ObjControllerMessage;
    expect(om.message).toBe(ObjControllerSubtypeIds.CM_spatialChatSend);
    expect(om.networkId).toBe(playerId);
    // The decoded subtype should be SpatialChatSend (kind set on the
    // send-side decoder) with our text and sane defaults.
    expect(om.decodedSubtype?.kind).toBe(SpatialChatSendKind);
    const data = om.decodedSubtype?.data as SpatialChatData;
    expect(data.sourceId).toBe(playerId);
    expect(data.targetId).toBe(0n);
    expect(data.text).toBe('hello world');
    expect(data.chatType).toBe(SpatialChatType.Say);
  });

  it('say with chatType=Shout overrides the default', () => {
    const { ctx, sent } = createFakeContext({ playerNetworkId: 0x42n });
    ctx.say('WHAT?!', { chatType: SpatialChatType.Shout });
    const om = sent[0] as ObjControllerMessage;
    const data = om.decodedSubtype?.data as SpatialChatData;
    expect(data.chatType).toBe(SpatialChatType.Shout);
    expect(data.text).toBe('WHAT?!');
  });

  it('say with targetId issues a whisper-style directed chat', () => {
    const { ctx, sent } = createFakeContext({ playerNetworkId: 0x42n });
    ctx.say('psst', { targetId: 0x100n, chatType: SpatialChatType.Whisper });
    const om = sent[0] as ObjControllerMessage;
    const data = om.decodedSubtype?.data as SpatialChatData;
    expect(data.targetId).toBe(0x100n);
    expect(data.chatType).toBe(SpatialChatType.Whisper);
  });

  it('say uses the chat-sequence counter (shared with tell/sendToChannel)', () => {
    const { ctx } = createFakeContext();
    expect(ctx.say('a')).toBe(1);
    expect(ctx.tell('Friend', 'b')).toBe(2);
    expect(ctx.say('c')).toBe(3);
  });

  // ReadIterator is imported for parity with combat tests if future chat
  // round-trips need it inline.
  void ReadIterator;
});

describe('ScriptContext: crafting primitives', () => {
  it('beginCrafting sends one ObjControllerMessage with command-queue + requestCraftingSession hash', () => {
    const playerId = 0x100n;
    const toolId = 0x200n;
    const { ctx, sent } = createFakeContext({ playerNetworkId: playerId });
    const seq = ctx.beginCrafting(toolId);
    expect(seq).toBe(1);
    expect(sent.length).toBe(1);
    const wrapped = sent[0];
    expect(wrapped).toBeInstanceOf(ObjControllerMessage);
    const obj = wrapped as ObjControllerMessage;
    expect(obj.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    expect(obj.flags).toBe(CLIENT_TO_AUTH_SERVER_FLAGS);
    // The inner enqueue carries the requestCraftingSession command + tool target.
    const inner = CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
    expect(inner.commandHash).toBe(hashCommand('requestCraftingSession'));
    expect(inner.targetId).toBe(toolId);
    expect(inner.params).toBe('');
  });

  it('beginCrafting passes the schematicCrc hint through as params', () => {
    const { ctx, sent } = createFakeContext();
    ctx.beginCrafting(0x100n, 0xdead_beef);
    const inner = CommandQueueEnqueue.unpack(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    expect(inner.params).toBe(String(0xdead_beef));
  });

  it('selectCraftingSchematic sends selectDraftSchematic with the index as params', () => {
    const { ctx, sent } = createFakeContext();
    const seq = ctx.selectCraftingSchematic(3);
    expect(seq).toBe(1);
    expect(sent.length).toBe(1);
    const inner = CommandQueueEnqueue.unpack(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    expect(inner.commandHash).toBe(hashCommand('selectDraftSchematic'));
    expect(inner.targetId).toBe(0n);
    expect(inner.params).toBe('3');
  });

  it('assignCraftingSlot sends a bare ObjControllerMessage(CM_fillSchematicSlotMessage)', () => {
    const playerId = 0x100n;
    const { ctx, sent } = createFakeContext({ playerNetworkId: playerId });
    const seq = ctx.assignCraftingSlot(2, 0x300n);
    expect(seq).toBe(1);
    expect(sent.length).toBe(1);
    const wrapped = sent[0] as ObjControllerMessage;
    expect(wrapped.message).toBe(ObjControllerSubtypeIds.CM_fillSchematicSlotMessage);
    expect(wrapped.flags).toBe(CLIENT_TO_AUTH_SERVER_FLAGS);
    expect(wrapped.networkId).toBe(playerId);
    // The trailer should decode to CraftingSlotAssign data.
    const decoded = CraftingSlotAssignDecoder.decode(new ReadIterator(wrapped.data));
    expect(decoded.slotIndex).toBe(2);
    expect(decoded.ingredientId).toBe(0x300n);
    expect(decoded.optionIndex).toBe(0);
    expect(decoded.sequenceId).toBe(1);
    // And the pre-populated decodedSubtype mirrors the payload for transcripts.
    expect(wrapped.decodedSubtype?.kind).toBe('CraftingSlotAssign');
    const ds = wrapped.decodedSubtype?.data as CraftingSlotAssignData;
    expect(ds.slotIndex).toBe(2);
  });

  it('assignCraftingSlot honors optionIndex override', () => {
    const { ctx, sent } = createFakeContext();
    ctx.assignCraftingSlot(0, 0x10n, { optionIndex: 4 });
    const wrapped = sent[0] as ObjControllerMessage;
    const decoded = CraftingSlotAssignDecoder.decode(new ReadIterator(wrapped.data));
    expect(decoded.optionIndex).toBe(4);
  });

  it('clearCraftingSlot defaults the targetContainer to the player NetworkId', () => {
    const playerId = 0xaaaan;
    const { ctx, sent } = createFakeContext({ playerNetworkId: playerId });
    const seq = ctx.clearCraftingSlot(1);
    expect(seq).toBe(1);
    const wrapped = sent[0] as ObjControllerMessage;
    expect(wrapped.message).toBe(ObjControllerSubtypeIds.CM_emptySchematicSlotMessage);
    const decoded = CraftingSlotEmptyDecoder.decode(new ReadIterator(wrapped.data));
    expect(decoded.slotIndex).toBe(1);
    expect(decoded.targetContainer).toBe(playerId);
  });

  it('clearCraftingSlot honors an explicit targetContainer', () => {
    const { ctx, sent } = createFakeContext();
    ctx.clearCraftingSlot(0, 0xbeefn);
    const decoded = CraftingSlotEmptyDecoder.decode(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    expect(decoded.targetContainer).toBe(0xbeefn);
  });

  it('craftExperiment sends a bare ObjControllerMessage(CM_experimentMessage) with the right payload', () => {
    const { ctx, sent } = createFakeContext();
    const seq = ctx.craftExperiment([
      { attribute: 0, points: 5 },
      { attribute: 2, points: 3 },
    ]);
    expect(seq).toBe(1);
    const wrapped = sent[0] as ObjControllerMessage;
    expect(wrapped.message).toBe(ObjControllerSubtypeIds.CM_experimentMessage);
    const decoded = CraftingExperimentDecoder.decode(new ReadIterator(wrapped.data));
    expect(decoded.experiments).toHaveLength(2);
    expect(decoded.experiments[0]).toEqual({ attributeIndex: 0, experimentPoints: 5 });
    expect(decoded.experiments[1]).toEqual({ attributeIndex: 2, experimentPoints: 3 });
    expect(decoded.coreLevel).toBe(0);
    expect(decoded.sequenceId).toBe(1);
    expect(wrapped.decodedSubtype?.kind).toBe('CraftingExperiment');
    const ds = wrapped.decodedSubtype?.data as CraftingExperimentData;
    expect(ds.experiments).toHaveLength(2);
  });

  it('craftExperiment honors coreLevel override', () => {
    const { ctx, sent } = createFakeContext();
    ctx.craftExperiment([{ attribute: 0, points: 1 }], { coreLevel: 7 });
    const decoded = CraftingExperimentDecoder.decode(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    expect(decoded.coreLevel).toBe(7);
  });

  it('finishCrafting sends createPrototype via the command queue with seq/realProto params', () => {
    const toolId = 0x100n;
    const { ctx, sent } = createFakeContext();
    const seq = ctx.finishCrafting(toolId);
    expect(seq).toBe(1); // command-queue sequence (not the craft sequence)
    expect(sent.length).toBe(1);
    const wrapped = sent[0] as ObjControllerMessage;
    expect(wrapped.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    const inner = CommandQueueEnqueue.unpack(new ReadIterator(wrapped.data));
    expect(inner.commandHash).toBe(hashCommand('createPrototype'));
    expect(inner.targetId).toBe(toolId);
    // params = "<craftSeq> <realProtoBool>" — default seq=1, realProto=true → "1 1"
    expect(inner.params).toBe('1 1');
  });

  it('finishCrafting with realPrototype=false sends "1 0" in params', () => {
    const { ctx, sent } = createFakeContext();
    ctx.finishCrafting(0n, { realPrototype: false });
    const inner = CommandQueueEnqueue.unpack(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    expect(inner.params).toBe('1 0');
  });

  it('craft-session sequence increments independently of command/movement/chat counters', () => {
    const { ctx } = createFakeContext();
    // craft-side mutations
    expect(ctx.assignCraftingSlot(0, 0x1n)).toBe(1);
    expect(ctx.clearCraftingSlot(0)).toBe(2);
    expect(ctx.craftExperiment([{ attribute: 0, points: 1 }])).toBe(3);
    // Other counters should be untouched (still at 1 for next).
    expect(ctx.nextSequenceNumber()).toBe(1);
    expect(ctx.nextCommandSequence()).toBe(1);
    expect(ctx.nextChatSequence()).toBe(1);
  });

  it('craft sends count toward sendsCount', async () => {
    const { ctx } = createFakeContext();
    const result = await runScript(async (c) => {
      c.beginCrafting(0x10n);
      c.selectCraftingSchematic(0);
      c.assignCraftingSlot(0, 0x20n);
      c.craftExperiment([{ attribute: 0, points: 1 }]);
      c.finishCrafting(0x10n);
    }, ctx);
    expect(result.sendsCount).toBe(5);
  });
});
