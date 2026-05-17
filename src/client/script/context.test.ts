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
  SpatialChatType,
} from '../../messages/game/obj-controller/index.js';
import { SurveyMessage } from '../../messages/game/survey/index.js';
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

  // --- ctx.say(): real spatial chat via the CommandQueue spatialChatInternal path ---
  //
  // `ctx.say()` wraps a `CommandQueueEnqueue` for the server's
  // `spatialChatInternal` command. We don't use the direct
  // `CM_spatialChatSend` path because the server's
  // `ControllerMessageFactory::allowFromClient` registry has
  // CM_spatialChatSend=false for non-admin clients (the message is logged
  // as a HackAttempts entry and dropped). The CommandQueue path passes
  // through the standard command-allow-list and the server itself builds
  // the MessageQueueSpatialChat (with the right volume, chat-spam limits,
  // etc) before broadcasting CM_spatialChatReceive(244) to observers.
  //
  // Wire shape: ObjControllerMessage(CM_commandQueueEnqueue=278) with
  //   flags=0x23, networkId=player, trailer = CommandQueueEnqueue with
  //   commandHash=hashCommand('spatialChatInternal') and
  //   params="<targetId> <chatType> <mood> <flags> <language> <text>".

  it('say sends one ObjControllerMessage wrapping CommandQueueEnqueue(spatialChatInternal)', () => {
    const playerId = 0x501n;
    const { ctx, sent } = createFakeContext({ playerNetworkId: playerId });
    const seq = ctx.say('hello world');
    expect(seq).toBe(1);
    expect(sent.length).toBe(1);
    const wrapped = sent[0];
    expect(wrapped).toBeInstanceOf(ObjControllerMessage);
    const om = wrapped as ObjControllerMessage;
    // Wrapper is the standard CommandQueue ObjController, not the direct
    // CM_spatialChatSend subtype (the latter is rejected server-side).
    expect(om.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    expect(om.flags).toBe(CLIENT_TO_AUTH_SERVER_FLAGS);
    expect(om.flags).toBe(0x23);
    expect(om.networkId).toBe(playerId);
    expect(om.value).toBe(0);

    // Inner enqueue carries the server-side command + params.
    const inner = CommandQueueEnqueue.unpack(new ReadIterator(om.data));
    expect(inner.commandHash).toBe(hashCommand('spatialChatInternal'));
    expect(inner.targetId).toBe(0n); // no target for the wrapper enqueue
    // params: "<targetId> <chatType> <mood> <flags> <language> <text>"
    //   defaults: "0 0 0 0 0 hello world"
    expect(inner.params).toBe('0 0 0 0 0 hello world');

    // Crucially: say() must NOT route through the tell-to-self placeholder.
    // No ChatInstantMessageToCharacter should appear among the sent messages.
    expect(sent.some((m) => m instanceof ChatInstantMessageToCharacter)).toBe(false);
    // And it must NOT send a raw CM_spatialChatSend either (server rejects).
    expect(om.message).not.toBe(ObjControllerSubtypeIds.CM_spatialChatSend);
  });

  it('say with targetId+chatType encodes them as params for spatialChatInternal', () => {
    const { ctx, sent } = createFakeContext({ playerNetworkId: 0x501n });
    ctx.say('quiet', { chatType: SpatialChatType.Whisper, targetId: 0x42n });
    expect(sent.length).toBe(1);
    const om = sent[0] as ObjControllerMessage;
    expect(om.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    const inner = CommandQueueEnqueue.unpack(new ReadIterator(om.data));
    expect(inner.commandHash).toBe(hashCommand('spatialChatInternal'));
    // Whisper chatType=2, target=0x42=66, defaults for mood/flags/language=0
    expect(inner.params).toBe(`${(0x42).toString()} 2 0 0 0 quiet`);
    expect(sent.some((m) => m instanceof ChatInstantMessageToCharacter)).toBe(false);
  });

  it('say with chatType=Shout puts the right chatType in params', () => {
    const { ctx, sent } = createFakeContext();
    ctx.say('WHAT?!', { chatType: SpatialChatType.Shout });
    const inner = CommandQueueEnqueue.unpack(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    expect(inner.params).toBe('0 1 0 0 0 WHAT?!');
  });

  it('say with mood/flags/language overrides flows them into params', () => {
    const { ctx, sent } = createFakeContext();
    ctx.say('greet', { moodType: 7, flags: 0x10, language: 3 });
    const inner = CommandQueueEnqueue.unpack(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    expect(inner.params).toBe('0 0 7 16 3 greet');
  });

  it('say preserves unicode text in the params string', () => {
    const { ctx, sent } = createFakeContext();
    ctx.say('héllo 世界');
    const inner = CommandQueueEnqueue.unpack(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    // The text is passed through verbatim as the trailing tokens of the
    // params string; the wire encoding (Unicode::String) is handled by
    // CommandQueueEnqueue itself.
    expect(inner.params.endsWith('héllo 世界')).toBe(true);
  });

  it('say uses the chat-sequence counter (shared with tell/sendToChannel)', () => {
    const { ctx } = createFakeContext();
    expect(ctx.say('a')).toBe(1);
    expect(ctx.tell('Friend', 'b')).toBe(2);
    expect(ctx.say('c')).toBe(3);
  });

  it('say also bumps the command-queue counter (since it routes through useAbility)', () => {
    const { ctx } = createFakeContext();
    expect(ctx.nextCommandSequence()).toBe(1); // 1 → 2 (used here)
    ctx.say('hi'); // useAbility consumes 2 → 3
    expect(ctx.nextCommandSequence()).toBe(3);
  });

  // ReadIterator is imported for use above (intentional).
  void ReadIterator;
});

describe('ScriptContext: survey primitives', () => {
  const TOOL_ID = 0x389671787n;

  it('survey() sends one ObjControllerMessage wrapping CommandQueueEnqueue with requestsurvey + (toolId target, resource type name params)', () => {
    const playerId = 0x501n;
    const { ctx, sent } = createFakeContext({ playerNetworkId: playerId });
    const seq = ctx.survey(TOOL_ID, 'Resotine');
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
    expect(inner.commandHash).toBe(hashCommand('requestsurvey'));
    // CRITICAL: target is the TOOL's NetworkId, not 0n, and params is a
    // SPECIFIC RESOURCE TYPE NAME (e.g. "Resotine"), not a class like
    // "mineral" — server's TaskSurvey looks up the type by exact name.
    expect(inner.targetId).toBe(TOOL_ID);
    expect(inner.params).toBe('Resotine');
  });

  it('survey() consumes from the command-queue sequence counter', () => {
    const { ctx } = createFakeContext();
    expect(ctx.survey(TOOL_ID, 'Resotine')).toBe(1);
    expect(ctx.survey(TOOL_ID, 'Yponaco')).toBe(2);
    expect(ctx.useAbility('attack', 0x42n)).toBe(3);
  });

  it('survey() command name hashes case-insensitively to requestsurvey', () => {
    const { ctx, sent } = createFakeContext();
    ctx.survey(TOOL_ID, 'Resotine');
    const inner = CommandQueueEnqueue.unpack(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    expect(inner.commandHash).toBe(hashCommand('requestsurvey'));
    expect(inner.commandHash).toBe(hashCommand('REQUESTSURVEY'));
  });

  it('waitForSurvey() resolves with the parsed sample points when SurveyMessage arrives', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    const pending = ctx.waitForSurvey({ timeoutMs: 1_000 });
    simulateRecv(
      new SurveyMessage([
        { location: { x: 1, y: 2, z: 3 }, efficiency: 0.5 },
        { location: { x: 4, y: 5, z: 6 }, efficiency: 0.9 },
      ]),
    );
    const result = await pending;
    expect(result.points).toHaveLength(2);
    const first = result.points[0];
    const second = result.points[1];
    if (first === undefined || second === undefined) throw new Error('missing points');
    expect(first.efficiency).toBeCloseTo(0.5, 5);
    expect(second.efficiency).toBeCloseTo(0.9, 5);
    expect(first.location).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('waitForSurvey() rejects with a timeout if no SurveyMessage arrives', async () => {
    const { ctx } = createFakeContext();
    await expect(ctx.waitForSurvey({ timeoutMs: 30 })).rejects.toThrow(/Timed out/);
  });

  it('survey() sends count toward sendsCount', async () => {
    const { ctx } = createFakeContext();
    const result = await runScript(async (c) => {
      c.survey(TOOL_ID, 'Resotine');
      c.survey(TOOL_ID, 'Yponaco');
    }, ctx);
    expect(result.sendsCount).toBe(2);
  });

  it('fetchSurveyResources() sends ObjectMenuRequest + ObjectMenuSelectMessage and resolves with the list', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext();
    const promise = ctx.fetchSurveyResources(TOOL_ID, { timeoutMs: 1_000 });

    // After the two sends, simulate the server response.
    // Two sends: CM_objectMenuRequest (ObjControllerMessage), then top-level
    // ObjectMenuSelectMessage.
    expect(sent.length).toBe(2);
    expect(sent[0]).toBeInstanceOf(ObjControllerMessage);
    const objReq = sent[0] as ObjControllerMessage;
    expect(objReq.message).toBe(326); // CM_objectMenuRequest

    const objSelect = sent[1] as { targetId?: bigint; selectedItemId?: number };
    expect(objSelect.targetId).toBe(TOOL_ID);
    expect(objSelect.selectedItemId).toBe(21); // ITEM_USE

    // Simulate the server's ResourceListForSurveyMessage response.
    const { ResourceListForSurveyMessage } = await import(
      '../../messages/game/survey/resource-list-for-survey-message.js'
    );
    simulateRecv(
      new ResourceListForSurveyMessage(
        [
          { resourceName: 'Resotine', resourceId: 1n, parentClassName: 'iron_class_3' },
          { resourceName: 'Yponaco', resourceId: 2n, parentClassName: 'iron_class_4' },
        ],
        'inorganic_mineral_metal_ferrous_iron',
        TOOL_ID,
      ),
    );

    const list = await promise;
    expect(list).toHaveLength(2);
    expect(list[0]?.resourceName).toBe('Resotine');
    expect(list[1]?.resourceName).toBe('Yponaco');
  });

  it('fetchResourceAttributes() batches getAttributesBatch and collects per-id AttributeListMessages', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext();
    const idA = 0x10000564n;
    const idB = 0x10000565n;
    const promise = ctx.fetchResourceAttributes([idA, idB], { timeoutMs: 1_000 });

    // One outbound CommandQueueEnqueue carrying getAttributesBatch + "<idA> -1 <idB> -1"
    expect(sent.length).toBe(1);
    const obj = sent[0] as ObjControllerMessage;
    expect(obj.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    const cq = CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
    expect(cq.commandHash).toBe(hashCommand('getAttributesBatch'));
    expect(cq.params).toBe(`${idA.toString()} -1 ${idB.toString()} -1`);

    // Simulate the two AttributeListMessages.
    const { AttributeListMessage } = await import('../../messages/game/attribute-list-message.js');
    simulateRecv(
      new AttributeListMessage(
        idA,
        '',
        [
          { key: '@obj_attr_n:res_quality', value: '987' },
          { key: '@obj_attr_n:res_cold_resist', value: '512' },
        ],
        0,
      ),
    );
    simulateRecv(
      new AttributeListMessage(idB, '', [{ key: '@obj_attr_n:res_quality', value: '450' }], 0),
    );

    const result = await promise;
    expect(result.size).toBe(2);
    expect(result.get(idA)).toHaveLength(2);
    expect(result.get(idB)).toHaveLength(1);
    expect(result.get(idA)?.[0]?.key).toBe('@obj_attr_n:res_quality');
    expect(result.get(idA)?.[0]?.value).toBe('987');
  });

  it('fetchResourceAttributes() returns partial map when some ids time out', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    const idA = 0x100n;
    const idB = 0x200n;
    const promise = ctx.fetchResourceAttributes([idA, idB], { timeoutMs: 50 });
    const { AttributeListMessage } = await import('../../messages/game/attribute-list-message.js');
    // Only respond for A; B times out.
    simulateRecv(new AttributeListMessage(idA, '', [{ key: 'oq', value: '900' }], 0));
    const result = await promise;
    expect(result.size).toBe(1);
    expect(result.has(idA)).toBe(true);
    expect(result.has(idB)).toBe(false);
  });

  it('fetchResourceAttributes() with empty array returns immediately without sending', async () => {
    const { ctx, sent } = createFakeContext();
    const result = await ctx.fetchResourceAttributes([]);
    expect(result.size).toBe(0);
    expect(sent.length).toBe(0);
  });

  it('fetchResourceAttributes() splits a large id list into chunks of maxBatchSize', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext();
    // 60 ids with default maxBatchSize=25 → 3 chunks (25, 25, 10).
    const ids = Array.from({ length: 60 }, (_, i) => BigInt(0x1000 + i));
    const promise = ctx.fetchResourceAttributes(ids, { timeoutMs: 1_000 });
    expect(sent.length).toBe(3);
    const { AttributeListMessage } = await import('../../messages/game/attribute-list-message.js');
    // Verify each chunk's params has the right number of id-rev pairs.
    for (const msg of sent) {
      const obj = msg as ObjControllerMessage;
      const cq = CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
      expect(cq.commandHash).toBe(hashCommand('getAttributesBatch'));
      const pairs = cq.params.split(' ').length / 2;
      expect(pairs).toBeGreaterThanOrEqual(10);
      expect(pairs).toBeLessThanOrEqual(25);
    }
    // Respond for every id.
    for (const id of ids) {
      simulateRecv(new AttributeListMessage(id, '', [{ key: 'oq', value: String(id) }], 0));
    }
    const result = await promise;
    expect(result.size).toBe(60);
  });

  it('fetchResourceAttributes() respects custom maxBatchSize', async () => {
    const { ctx, sent } = createFakeContext();
    const ids = Array.from({ length: 10 }, (_, i) => BigInt(i));
    ctx.fetchResourceAttributes(ids, { timeoutMs: 50, maxBatchSize: 3 });
    // 10 / 3 → 4 chunks (3, 3, 3, 1)
    expect(sent.length).toBe(4);
  });

  it('sample() emits a CommandQueueEnqueue with cmd=requestcoresample and resource name as params', () => {
    const playerId = 0x501n;
    const { ctx, sent } = createFakeContext({ playerNetworkId: playerId });
    const TOOL = 0x17354b8bn;
    const seq = ctx.sample(TOOL, 'Carboseuweroris');
    expect(seq).toBe(1);
    expect(sent.length).toBe(1);
    const obj = sent[0] as ObjControllerMessage;
    expect(obj.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    expect(obj.networkId).toBe(playerId);
    const cq = CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
    expect(cq.commandHash).toBe(hashCommand('requestcoresample'));
    expect(cq.targetId).toBe(TOOL);
    expect(cq.params).toBe('Carboseuweroris');
  });

  it('waitForSampleEvent() classifies sample_located → "located"', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    const { ChatSystemMessage } = await import('../../messages/game/chat/index.js');
    // Build a fake oob with "sample_located" packed into UTF-16 (low+high byte pairs).
    // Easiest: re-use the same logic the production code uses — encode chars
    // as raw bytes packed into u16 codepoints.
    const oobAscii = '\0\0\0\0\0\0survey\0sample_located\0Carboseuweroris';
    let oob = '';
    for (let i = 0; i < oobAscii.length; i += 2) {
      const lo = oobAscii.charCodeAt(i);
      const hi = i + 1 < oobAscii.length ? oobAscii.charCodeAt(i + 1) : 0;
      oob += String.fromCharCode((hi << 8) | lo);
    }
    const promise = ctx.waitForSampleEvent({ timeoutMs: 1_000 });
    simulateRecv(new ChatSystemMessage(0, '', oob));
    const evt = await promise;
    expect(evt.kind).toBe('located');
    expect(evt.raw).toContain('sample_located');
    expect(evt.raw).toContain('Carboseuweroris');
  });

  it('waitForSampleEvent() classifies the common STF tokens', async () => {
    const { decodeSampleOob } = await import('./context.js');
    void decodeSampleOob; // imported for completeness
    const { ChatSystemMessage } = await import('../../messages/game/chat/index.js');
    function makeOob(token: string): string {
      const ascii = `\0\0\0\0\0\0survey\0${token}\0`;
      let oob = '';
      for (let i = 0; i < ascii.length; i += 2) {
        const lo = ascii.charCodeAt(i);
        const hi = i + 1 < ascii.length ? ascii.charCodeAt(i + 1) : 0;
        oob += String.fromCharCode((hi << 8) | lo);
      }
      return oob;
    }
    const cases: Array<[string, string]> = [
      ['sample_failed', 'failed'],
      ['sample_cancel', 'cancel'],
      ['already_sampling', 'in_progress'],
      ['start_sampling', 'start'],
      ['sample_mind', 'mind'],
      ['density_below_threshold', 'density'],
      ['trace_amt', 'trace'],
    ];
    for (const [token, expectedKind] of cases) {
      const { ctx, simulateRecv } = createFakeContext();
      const promise = ctx.waitForSampleEvent({ timeoutMs: 500 });
      simulateRecv(new ChatSystemMessage(0, '', makeOob(token)));
      const evt = await promise;
      expect(evt.kind).toBe(expectedKind);
    }
  });

  it('waitForSampleEvent() ignores unrelated ChatSystemMessages (kind=other)', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    const { ChatSystemMessage } = await import('../../messages/game/chat/index.js');
    const promise = ctx.waitForSampleEvent({ timeoutMs: 100 });
    // Send an unrelated message — predicate filters it out
    simulateRecv(new ChatSystemMessage(0, 'random combat narration', ''));
    await expect(promise).rejects.toThrow(/Timed out/);
  });

  it('fetchSurveyResources() filters by surveyToolId — ignores responses for a different tool', async () => {
    const OTHER_TOOL = 0x999n;
    const { ctx, simulateRecv } = createFakeContext();
    const promise = ctx.fetchSurveyResources(TOOL_ID, { timeoutMs: 200 });

    const { ResourceListForSurveyMessage } = await import(
      '../../messages/game/survey/resource-list-for-survey-message.js'
    );
    // Response for the OTHER tool — should be ignored.
    simulateRecv(
      new ResourceListForSurveyMessage(
        [{ resourceName: 'Wrong', resourceId: 99n, parentClassName: 'foo' }],
        'foo',
        OTHER_TOOL,
      ),
    );

    // Promise should still be pending → time out.
    await expect(promise).rejects.toThrow(/Timed out/);
  });
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

describe('ScriptContext: mission primitives', () => {
  it('requestMissionList sends one ObjControllerMessage(CM_missionListRequest)', () => {
    const playerId = 0x100n;
    const terminalId = 0x4321n;
    const { ctx, sent } = createFakeContext({ playerNetworkId: playerId });
    const seq = ctx.requestMissionList(terminalId);
    expect(seq).toBe(1);
    expect(sent.length).toBe(1);

    const wrapped = sent[0];
    expect(wrapped).toBeInstanceOf(ObjControllerMessage);
    const obj = wrapped as ObjControllerMessage;
    expect(obj.message).toBe(ObjControllerSubtypeIds.CM_missionListRequest);
    expect(obj.flags).toBe(CLIENT_TO_AUTH_SERVER_FLAGS);
    expect(obj.networkId).toBe(playerId);

    // The trailer is a 10-byte MissionListRequest payload.
    const trailer = obj.data;
    expect(trailer.length).toBe(10);
    expect(trailer[0]).toBe(0x00); // flags=0
    expect(trailer[1]).toBe(0x01); // sequenceId=1
    expect(trailer[2]).toBe(0x21); // terminalId LSB (0x4321 & 0xff)
    expect(trailer[3]).toBe(0x43); // terminalId next byte
  });

  it('requestMissionList honors the flags option (MineOnly)', () => {
    const { ctx, sent } = createFakeContext();
    ctx.requestMissionList(0x42n, { flags: 0x01 });
    const obj = sent[0] as ObjControllerMessage;
    expect(obj.data[0]).toBe(0x01); // flags = MineOnly
  });

  it('requestMissionList consumes from the mission-sequence counter', () => {
    const { ctx } = createFakeContext();
    expect(ctx.requestMissionList(0x10n)).toBe(1);
    expect(ctx.requestMissionList(0x20n)).toBe(2);
    expect(ctx.acceptMission(0x30n, 0x10n)).toBe(3);
  });

  it('acceptMission sends one ObjControllerMessage(CM_missionAcceptRequest)', () => {
    const playerId = 0x100n;
    const missionId = 0xabc1n;
    const terminalId = 0x4321n;
    const { ctx, sent } = createFakeContext({ playerNetworkId: playerId });
    const seq = ctx.acceptMission(missionId, terminalId);
    expect(seq).toBe(1);
    expect(sent.length).toBe(1);

    const obj = sent[0] as ObjControllerMessage;
    expect(obj.message).toBe(ObjControllerSubtypeIds.CM_missionAcceptRequest);
    expect(obj.flags).toBe(CLIENT_TO_AUTH_SERVER_FLAGS);
    expect(obj.networkId).toBe(playerId);

    // Trailer = NetworkId(8) + NetworkId(8) + u8 = 17 bytes
    expect(obj.data.length).toBe(17);
    expect(obj.data[0]).toBe(0xc1); // missionId LSB
    expect(obj.data[1]).toBe(0xab);
    expect(obj.data[8]).toBe(0x21); // terminalId LSB
    expect(obj.data[9]).toBe(0x43);
    expect(obj.data[16]).toBe(0x01); // sequenceId
  });

  it('removeMission shares wire layout with acceptMission but uses CM_missionRemoveRequest', () => {
    const playerId = 0x100n;
    const missionId = 0xabc1n;
    const terminalId = 0x4321n;
    const { ctx, sent } = createFakeContext({ playerNetworkId: playerId });
    const seq = ctx.removeMission(missionId, terminalId);
    expect(seq).toBe(1);
    const obj = sent[0] as ObjControllerMessage;
    expect(obj.message).toBe(ObjControllerSubtypeIds.CM_missionRemoveRequest);
    expect(obj.data.length).toBe(17);
  });

  it('abortMission sends ObjControllerMessage(CM_missionAbort) with just a NetworkId trailer', () => {
    const missionId = 0xfeedn;
    const { ctx, sent } = createFakeContext();
    ctx.abortMission(missionId);
    expect(sent.length).toBe(1);
    const obj = sent[0] as ObjControllerMessage;
    expect(obj.message).toBe(ObjControllerSubtypeIds.CM_missionAbort);
    expect(obj.flags).toBe(CLIENT_TO_AUTH_SERVER_FLAGS);
    // Trailer is just a NetworkId.
    expect(obj.data.length).toBe(8);
    expect(obj.data[0]).toBe(0xed); // missionId LSB
    expect(obj.data[1]).toBe(0xfe);
    for (let i = 2; i < 8; i++) expect(obj.data[i]).toBe(0x00);
  });

  it('abortMission does NOT consume from the mission sequence counter', () => {
    const { ctx, sent } = createFakeContext();
    ctx.abortMission(0xfeedn);
    expect(sent.length).toBe(1);
    // The next acceptMission gets seq=1 (abort did not touch the counter).
    expect(ctx.acceptMission(0x10n, 0x20n)).toBe(1);
  });

  it('mission sends count toward sendsCount', async () => {
    const { ctx } = createFakeContext();
    const result = await runScript(async (c) => {
      const seq = c.requestMissionList(0x10n);
      void seq;
      c.acceptMission(0x20n, 0x10n);
      c.abortMission(0x20n);
    }, ctx);
    expect(result.sendsCount).toBe(3);
  });

  it('decoder is registered so a round-trip parse identifies the kind', () => {
    const { ctx, sent } = createFakeContext();
    ctx.acceptMission(0x42n, 0x101n);
    const obj = sent[0] as ObjControllerMessage;
    // The decoder we set the inline preview to wins:
    expect(obj.decodedSubtype?.kind).toBe('MissionAcceptRequest');
  });
});

describe('ScriptContext: vehicle / mount / pet primitives', () => {
  it('callVehicle sends ObjectMenuSelectMessage(datapadId, PET_CALL=45)', async () => {
    const { ctx, sent } = createFakeContext();
    const datapadId = 0xa1a1n;
    const seq = ctx.callVehicle(datapadId);
    expect(seq).toBe(1); // first command-queue seq
    expect(sent.length).toBe(1);
    const { ObjectMenuSelectMessage } = await import(
      '../../messages/game/object-menu-select-message.js'
    );
    expect(sent[0]).toBeInstanceOf(ObjectMenuSelectMessage);
    const m = sent[0] as InstanceType<typeof ObjectMenuSelectMessage>;
    expect(m.targetId).toBe(datapadId);
    expect(m.selectedItemId).toBe(45); // PET_CALL
  });

  it('storeVehicle sends ObjectMenuSelectMessage(vehicleId, PET_STORE=60)', async () => {
    const { ctx, sent } = createFakeContext();
    const vehicleId = 0xbeef_cafen;
    const seq = ctx.storeVehicle(vehicleId);
    expect(seq).toBe(1);
    const { ObjectMenuSelectMessage } = await import(
      '../../messages/game/object-menu-select-message.js'
    );
    const m = sent[0] as InstanceType<typeof ObjectMenuSelectMessage>;
    expect(m.targetId).toBe(vehicleId);
    expect(m.selectedItemId).toBe(60); // PET_STORE
  });

  it('mount() emits useAbility("mount", vehicleId) — one ObjControllerMessage(CM_commandQueueEnqueue)', () => {
    const playerId = 0x111n;
    const vehicleId = 0x222n;
    const { ctx, sent } = createFakeContext({ playerNetworkId: playerId });
    ctx.mount(vehicleId);
    expect(sent.length).toBe(1);
    const obj = sent[0] as ObjControllerMessage;
    expect(obj.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    expect(obj.networkId).toBe(playerId);
    const cq = CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
    expect(cq.commandHash).toBe(hashCommand('mount'));
    expect(cq.targetId).toBe(vehicleId);
  });

  it('mount() sets mountedSpeedCap to the default speeder-bike cap (12 m/s)', () => {
    const { ctx } = createFakeContext();
    expect(ctx.mountedSpeedCap()).toBeNull();
    ctx.mount(0xabn);
    expect(ctx.mountedSpeedCap()).toBe(12);
  });

  it('mount({ speedCap }) honors the explicit cap', () => {
    const { ctx } = createFakeContext();
    ctx.mount(0xabn, { speedCap: 17.5 });
    expect(ctx.mountedSpeedCap()).toBe(17.5);
  });

  it('dismount() emits useAbility("dismount") (no target) and clears the speed cap', () => {
    const { ctx, sent } = createFakeContext();
    ctx.mount(0xabn);
    expect(ctx.mountedSpeedCap()).toBe(12);
    sent.length = 0;
    ctx.dismount();
    expect(ctx.mountedSpeedCap()).toBeNull();
    expect(sent.length).toBe(1);
    const obj = sent[0] as ObjControllerMessage;
    const cq = CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
    expect(cq.commandHash).toBe(hashCommand('dismount'));
    expect(cq.targetId).toBe(0n); // NO_TARGET
  });

  it('callPet sends ObjectMenuSelectMessage(controlDeviceId, PET_CALL=45)', async () => {
    const { ctx, sent } = createFakeContext();
    const pcdId = 0x3333n;
    ctx.callPet(pcdId);
    const { ObjectMenuSelectMessage } = await import(
      '../../messages/game/object-menu-select-message.js'
    );
    const m = sent[0] as InstanceType<typeof ObjectMenuSelectMessage>;
    expect(m.targetId).toBe(pcdId);
    expect(m.selectedItemId).toBe(45);
  });

  it('storePet sends ObjectMenuSelectMessage(petId, PET_STORE=60)', async () => {
    const { ctx, sent } = createFakeContext();
    const petId = 0x4444n;
    ctx.storePet(petId);
    const { ObjectMenuSelectMessage } = await import(
      '../../messages/game/object-menu-select-message.js'
    );
    const m = sent[0] as InstanceType<typeof ObjectMenuSelectMessage>;
    expect(m.targetId).toBe(petId);
    expect(m.selectedItemId).toBe(60);
  });

  it('petCommand maps "follow" → PET_FOLLOW (225), no target preamble', async () => {
    const { ctx, sent } = createFakeContext();
    const petId = 0x5555n;
    ctx.petCommand(petId, 'follow');
    const { ObjectMenuSelectMessage } = await import(
      '../../messages/game/object-menu-select-message.js'
    );
    expect(sent.length).toBe(1);
    const m = sent[0] as InstanceType<typeof ObjectMenuSelectMessage>;
    expect(m.targetId).toBe(petId);
    expect(m.selectedItemId).toBe(225);
  });

  it('petCommand maps "stay" → PET_STAY (226)', async () => {
    const { ctx, sent } = createFakeContext();
    ctx.petCommand(0x10n, 'stay');
    const { ObjectMenuSelectMessage } = await import(
      '../../messages/game/object-menu-select-message.js'
    );
    expect((sent[0] as InstanceType<typeof ObjectMenuSelectMessage>).selectedItemId).toBe(226);
  });

  it('petCommand maps "patrol" → PET_PATROL (230)', async () => {
    const { ctx, sent } = createFakeContext();
    ctx.petCommand(0x10n, 'patrol');
    const { ObjectMenuSelectMessage } = await import(
      '../../messages/game/object-menu-select-message.js'
    );
    expect((sent[0] as InstanceType<typeof ObjectMenuSelectMessage>).selectedItemId).toBe(230);
  });

  it('petCommand("attack", targetId) pre-sends setCombatTarget, then PET_ATTACK', async () => {
    const { ctx, sent } = createFakeContext();
    const petId = 0x10n;
    const enemyId = 0xdeadn;
    ctx.petCommand(petId, 'attack', enemyId);
    expect(sent.length).toBe(2);
    // First: useAbility('setCombatTarget', enemyId) — an ObjControllerMessage.
    const first = sent[0] as ObjControllerMessage;
    expect(first.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    const cq = CommandQueueEnqueue.unpack(new ReadIterator(first.data));
    expect(cq.commandHash).toBe(hashCommand('setCombatTarget'));
    expect(cq.targetId).toBe(enemyId);
    // Second: ObjectMenuSelectMessage(petId, PET_ATTACK=229).
    const { ObjectMenuSelectMessage } = await import(
      '../../messages/game/object-menu-select-message.js'
    );
    const second = sent[1] as InstanceType<typeof ObjectMenuSelectMessage>;
    expect(second.targetId).toBe(petId);
    expect(second.selectedItemId).toBe(229);
  });

  it('petCommand("guard", targetId) also sets the combat target first', async () => {
    const { ctx, sent } = createFakeContext();
    ctx.petCommand(0x10n, 'guard', 0xfeedn);
    expect(sent.length).toBe(2);
    const cq = CommandQueueEnqueue.unpack(new ReadIterator((sent[0] as ObjControllerMessage).data));
    expect(cq.commandHash).toBe(hashCommand('setCombatTarget'));
    expect(cq.targetId).toBe(0xfeedn);
  });

  it('petCommand("follow", targetId) ignores targetId (follow doesn\'t take one)', () => {
    const { ctx, sent } = createFakeContext();
    ctx.petCommand(0x10n, 'follow', 0xfeedn);
    expect(sent.length).toBe(1); // no setCombatTarget preamble
  });

  it('vehicle/pet sends count toward sendsCount', async () => {
    const { ctx } = createFakeContext();
    const result = await runScript(async (c) => {
      c.callVehicle(0x10n);
      c.mount(0x20n);
      c.dismount();
      c.storeVehicle(0x20n);
      c.callPet(0x30n);
      c.storePet(0x30n);
      c.petCommand(0x30n, 'follow');
    }, ctx);
    expect(result.sendsCount).toBe(7);
  });

  it('setMountedSpeedCap directly updates the cap without sending wire traffic', () => {
    const { ctx, sent } = createFakeContext();
    expect(ctx.mountedSpeedCap()).toBeNull();
    ctx.setMountedSpeedCap(8);
    expect(ctx.mountedSpeedCap()).toBe(8);
    expect(sent.length).toBe(0);
    ctx.setMountedSpeedCap(null);
    expect(ctx.mountedSpeedCap()).toBeNull();
  });
});
