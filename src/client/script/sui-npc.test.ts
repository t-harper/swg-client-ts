import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import {
  CM_COMMAND_QUEUE_ENQUEUE,
  CommandQueueEnqueue,
  hashCommand,
} from '../../messages/game/command-queue/index.js';
import { NpcConversationMessageDecoder } from '../../messages/game/npc/npc-conversation-message.js';
import { NpcConversationResponsesDecoder } from '../../messages/game/npc/npc-conversation-responses.js';
import { ObjControllerMessage } from '../../messages/game/obj-controller-message.js';
import { ObjControllerSubtypeIds } from '../../messages/game/obj-controller/registry.js';
import { SuiCreatePageMessage } from '../../messages/game/sui/sui-create-page-message.js';
import { SuiEventNotification } from '../../messages/game/sui/sui-event-notification.js';
import type { SuiPageData } from '../../messages/game/sui/sui-page-data.js';
import type { NetworkId } from '../../types.js';
import { createFakeContext } from './test-helpers.js';

function makeFakePageData(pageId: number): SuiPageData {
  return {
    pageId,
    pageName: '',
    commands: [],
    associatedObjectId: 0n,
    associatedLocation: { x: 0, y: 0, z: 0 },
    maxRangeFromObject: 0,
  };
}

function unwrapEnqueue(msg: ObjControllerMessage): CommandQueueEnqueue {
  return CommandQueueEnqueue.unpack(new ReadIterator(msg.data));
}

const PLAYER_ID: NetworkId = 0x1234n;

function buildNpcPromptMessage(playerId: NetworkId, text: string): ObjControllerMessage {
  const stream = new ByteStream();
  NpcConversationMessageDecoder.encode(stream, { npcMessage: text });
  return new ObjControllerMessage(
    0,
    ObjControllerSubtypeIds.CM_npcConversationMessage,
    playerId,
    0,
    stream.toBytes(),
    { kind: NpcConversationMessageDecoder.kind, data: { npcMessage: text } },
  );
}

function buildNpcResponsesMessage(playerId: NetworkId, responses: string[]): ObjControllerMessage {
  const stream = new ByteStream();
  NpcConversationResponsesDecoder.encode(stream, { responses });
  return new ObjControllerMessage(
    0,
    ObjControllerSubtypeIds.CM_npcConversationResponses,
    playerId,
    0,
    stream.toBytes(),
    { kind: NpcConversationResponsesDecoder.kind, data: { responses } },
  );
}

describe('SUI primitives', () => {
  it('waitForSui resolves to the next SuiCreatePageMessage', async () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    const p = ctx.waitForSui();
    const page: SuiPageData = {
      ...makeFakePageData(7),
      pageName: 'banker.main',
      commands: [
        { type: 'setProperty', targetWidget: 'cmp.title', propertyName: 'Text', propertyValue: 'Hi' },
      ],
    };
    setTimeout(() => simulateRecv(new SuiCreatePageMessage(page)), 5);
    const got = await p;
    expect(got).toBeInstanceOf(SuiCreatePageMessage);
    expect(got.pageId).toBe(7);
    expect(got.pageData.pageName).toBe('banker.main');
    expect(got.pageData.commands).toEqual(page.commands);
  });

  it('waitForSui respects the optional predicate', async () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    const p = ctx.waitForSui({ predicate: (m) => m.pageId === 42 });
    setTimeout(() => {
      simulateRecv(new SuiCreatePageMessage(makeFakePageData(7)));
      simulateRecv(new SuiCreatePageMessage(makeFakePageData(42)));
    }, 5);
    const got = await p;
    expect(got.pageId).toBe(42);
  });

  it('waitForSui rejects on timeout', async () => {
    const { ctx } = createFakeContext({ playerNetworkId: PLAYER_ID });
    await expect(ctx.waitForSui({ timeoutMs: 30 })).rejects.toThrow(
      /Timed out after 30ms waiting for SuiCreatePageMessage/,
    );
  });

  it('respondToSui sends a SuiEventNotification with the supplied returnList', () => {
    const { ctx, sent } = createFakeContext({ playerNetworkId: PLAYER_ID });
    ctx.respondToSui(99, 3, ['ok', 'cancel']);
    expect(sent.length).toBe(1);
    const first = sent[0];
    expect(first).toBeInstanceOf(SuiEventNotification);
    if (!(first instanceof SuiEventNotification)) throw new Error('typeguard');
    expect(first.pageId).toBe(99);
    expect(first.subscribedEventIndex).toBe(3);
    expect(first.returnList).toEqual(['ok', 'cancel']);
  });

  it('respondToSui defaults the returnList to []', () => {
    const { ctx, sent } = createFakeContext({ playerNetworkId: PLAYER_ID });
    ctx.respondToSui(1, 0);
    const first = sent[0];
    if (!(first instanceof SuiEventNotification)) throw new Error('typeguard');
    expect(first.returnList).toEqual([]);
  });
});

describe('NPC conversation primitives', () => {
  it('talkTo enqueues a npcConversationStart command-queue ability', () => {
    const { ctx, sent } = createFakeContext({ playerNetworkId: PLAYER_ID });
    const npcId: NetworkId = 0xabcdn;
    ctx.talkTo(npcId);

    expect(sent.length).toBe(1);
    const first = sent[0];
    expect(first).toBeInstanceOf(ObjControllerMessage);
    if (!(first instanceof ObjControllerMessage)) throw new Error('typeguard');
    expect(first.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    expect(first.networkId).toBe(PLAYER_ID);
    const inner = unwrapEnqueue(first);
    expect(inner.commandHash).toBe(hashCommand('npcConversationStart'));
    expect(inner.targetId).toBe(npcId);
    expect(inner.params).toBe('0 ');
  });

  it('selectDialog enqueues a npcConversationSelect with String(index) as params', () => {
    const { ctx, sent } = createFakeContext({ playerNetworkId: PLAYER_ID });
    ctx.selectDialog(2);

    expect(sent.length).toBe(1);
    const first = sent[0];
    if (!(first instanceof ObjControllerMessage)) throw new Error('typeguard');
    expect(first.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    const inner = unwrapEnqueue(first);
    expect(inner.commandHash).toBe(hashCommand('npcConversationSelect'));
    expect(inner.targetId).toBe(0n);
    expect(inner.params).toBe('2');
  });

  it('endConversation enqueues a npcConversationStop with empty params', () => {
    const { ctx, sent } = createFakeContext({ playerNetworkId: PLAYER_ID });
    ctx.endConversation();

    expect(sent.length).toBe(1);
    const first = sent[0];
    if (!(first instanceof ObjControllerMessage)) throw new Error('typeguard');
    expect(first.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    const inner = unwrapEnqueue(first);
    expect(inner.commandHash).toBe(hashCommand('npcConversationStop'));
    expect(inner.targetId).toBe(0n);
    expect(inner.params).toBe('');
  });

  it('waitForNpcDialog pairs the prompt and the responses menu', async () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    const p = ctx.waitForNpcDialog({ timeoutMs: 1_000, pairWindowMs: 200 });
    // Stagger the two recvs across separate ticks so the prompt's waiter
    // resolves and the responses' waiter has time to install before the
    // second simulateRecv fires.
    setTimeout(() => simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'Greetings.')), 5);
    setTimeout(() => simulateRecv(buildNpcResponsesMessage(PLAYER_ID, ['Yes', 'No'])), 20);
    const got = await p;
    expect(got.playerId).toBe(PLAYER_ID);
    expect(got.prompt).toBe('Greetings.');
    expect(got.options).toEqual(['Yes', 'No']);
  });

  it('waitForNpcDialog returns empty options when responses do not arrive in window', async () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    const p = ctx.waitForNpcDialog({ timeoutMs: 1_000, pairWindowMs: 30 });
    setTimeout(() => simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'Hello.')), 5);
    const got = await p;
    expect(got.prompt).toBe('Hello.');
    expect(got.options).toEqual([]);
  });

  it('waitForNpcDialog ignores messages for other players', async () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    const otherId: NetworkId = 0xfeedn;
    const p = ctx.waitForNpcDialog({ timeoutMs: 1_000, pairWindowMs: 200 });
    setTimeout(() => {
      // Wrong addressee — should be ignored.
      simulateRecv(buildNpcPromptMessage(otherId, 'Wrong target.'));
      // Now the right prompt.
      simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'Hi.'));
    }, 5);
    // Responses come on a later tick so the second waitFor is installed first.
    setTimeout(() => simulateRecv(buildNpcResponsesMessage(PLAYER_ID, ['ok'])), 25);
    const got = await p;
    expect(got.prompt).toBe('Hi.');
    expect(got.options).toEqual(['ok']);
  });

  it('waitForNpcDialog rejects on timeout when no prompt arrives', async () => {
    const { ctx } = createFakeContext({ playerNetworkId: PLAYER_ID });
    await expect(ctx.waitForNpcDialog({ timeoutMs: 30 })).rejects.toThrow(
      /Timed out after 30ms waiting for ObjControllerMessage/,
    );
  });

  it('also exercises the explicit command-queue import to ensure CommandQueueEnqueue is available', () => {
    expect(CommandQueueEnqueue).toBeDefined();
  });
});
