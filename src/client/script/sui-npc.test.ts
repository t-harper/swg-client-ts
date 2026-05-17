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
import { StopNpcConversationDecoder } from '../../messages/game/npc/stop-npc-conversation.js';
import { ObjControllerMessage } from '../../messages/game/obj-controller-message.js';
import { ObjControllerSubtypeIds } from '../../messages/game/obj-controller/registry.js';
import { SuiCreatePageMessage } from '../../messages/game/sui/sui-create-page-message.js';
import { SuiEventNotification } from '../../messages/game/sui/sui-event-notification.js';
import { SuiForceClosePage } from '../../messages/game/sui/sui-force-close-page.js';
import { SuiUpdatePageMessage } from '../../messages/game/sui/sui-update-page-message.js';
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

describe('ctx.sui — high-level autoRespond + active', () => {
  it('autoRespond fires SuiEventNotification with the right pageId on a matching SuiCreatePageMessage', () => {
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    const unsub = ctx.sui.autoRespond((p) => p.pageName === 'Script.areYouSure', 'ok');
    expect(typeof unsub).toBe('function');

    // Non-matching page first — should not fire.
    simulateRecv(
      new SuiCreatePageMessage({
        ...makeFakePageData(1),
        pageName: 'Script.notMatching',
      }),
    );
    expect(sent.length).toBe(0);

    // Matching page — should fire one SuiEventNotification with pageId=42.
    simulateRecv(
      new SuiCreatePageMessage({
        ...makeFakePageData(42),
        pageName: 'Script.areYouSure',
      }),
    );
    expect(sent.length).toBe(1);
    const reply = sent[0];
    expect(reply).toBeInstanceOf(SuiEventNotification);
    if (!(reply instanceof SuiEventNotification)) throw new Error('typeguard');
    expect(reply.pageId).toBe(42);
    expect(reply.subscribedEventIndex).toBe(0); // 'ok' → event 0
    expect(reply.returnList).toEqual([]);

    // Unsubscribe — further matching pages should NOT fire.
    unsub();
    simulateRecv(
      new SuiCreatePageMessage({
        ...makeFakePageData(99),
        pageName: 'Script.areYouSure',
      }),
    );
    expect(sent.length).toBe(1);
  });

  it("autoRespond 'cancel' fires event 1", () => {
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    ctx.sui.autoRespond(() => true, 'cancel');
    simulateRecv(new SuiCreatePageMessage(makeFakePageData(7)));
    expect(sent.length).toBe(1);
    const reply = sent[0];
    if (!(reply instanceof SuiEventNotification)) throw new Error('typeguard');
    expect(reply.subscribedEventIndex).toBe(1);
  });

  it('autoRespond explicit {eventType, returnList} sends those values verbatim', () => {
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    ctx.sui.autoRespond(() => true, { eventType: 5, returnList: ['NewCity', 'foo'] });
    simulateRecv(new SuiCreatePageMessage(makeFakePageData(8)));
    expect(sent.length).toBe(1);
    const reply = sent[0];
    if (!(reply instanceof SuiEventNotification)) throw new Error('typeguard');
    expect(reply.subscribedEventIndex).toBe(5);
    expect(reply.returnList).toEqual(['NewCity', 'foo']);
  });

  it('first registered handler whose predicate matches wins; later handlers do not fire', () => {
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    ctx.sui.autoRespond((p) => p.pageName === 'A', { eventType: 11, returnList: [] });
    ctx.sui.autoRespond((p) => p.pageName === 'A', { eventType: 22, returnList: [] });
    simulateRecv(
      new SuiCreatePageMessage({ ...makeFakePageData(3), pageName: 'A' }),
    );
    expect(sent.length).toBe(1);
    const reply = sent[0];
    if (!(reply instanceof SuiEventNotification)) throw new Error('typeguard');
    expect(reply.subscribedEventIndex).toBe(11);
  });

  it('autoRespond also fires on SuiUpdatePageMessage (server may mutate before user responds)', () => {
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    ctx.sui.autoRespond((p) => p.pageId === 17, 'ok');
    simulateRecv(new SuiUpdatePageMessage(makeFakePageData(17)));
    expect(sent.length).toBe(1);
  });

  it('predicate exceptions are swallowed; later handlers still get a chance', () => {
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    ctx.sui.autoRespond(() => {
      throw new Error('boom');
    }, 'ok');
    ctx.sui.autoRespond((p) => p.pageId === 4, 'ok');
    simulateRecv(new SuiCreatePageMessage(makeFakePageData(4)));
    expect(sent.length).toBe(1);
  });

  it('active mirrors create/close cycle', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    expect(ctx.sui.active).toEqual([]);
    simulateRecv(
      new SuiCreatePageMessage({
        ...makeFakePageData(5),
        pageName: 'banker.main',
        commands: [
          {
            type: 'setProperty',
            targetWidget: 'cmp.title',
            propertyName: 'Text',
            propertyValue: 'Banker',
          },
        ],
      }),
    );
    expect(ctx.sui.active.length).toBe(1);
    expect(ctx.sui.active[0]?.pageId).toBe(5);
    expect(ctx.sui.active[0]?.title).toBe('Banker');
    expect(ctx.sui.active[0]?.pageName).toBe('banker.main');

    // ForceClose for pageId 5 — active should drop back to empty.
    simulateRecv(new SuiForceClosePage(5));
    expect(ctx.sui.active).toEqual([]);
  });

  it('active.title falls back to the first setProperty value when no known widget matches', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    simulateRecv(
      new SuiCreatePageMessage({
        ...makeFakePageData(6),
        commands: [
          {
            type: 'setProperty',
            targetWidget: 'unknown.widget',
            propertyName: 'Text',
            propertyValue: 'Fallback title',
          },
        ],
      }),
    );
    expect(ctx.sui.active[0]?.title).toBe('Fallback title');
  });

  it('multiple concurrently-open pages tracked in active', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    simulateRecv(new SuiCreatePageMessage(makeFakePageData(1)));
    simulateRecv(new SuiCreatePageMessage(makeFakePageData(2)));
    simulateRecv(new SuiCreatePageMessage(makeFakePageData(3)));
    expect(ctx.sui.active.length).toBe(3);
    const ids = ctx.sui.active.map((p) => p.pageId).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3]);
    simulateRecv(new SuiForceClosePage(2));
    expect(ctx.sui.active.map((p) => p.pageId).sort((a, b) => a - b)).toEqual([1, 3]);
  });
});

describe('ctx.npc — high-level converse + lastDialog', () => {
  it('converse(npcId, [label]) walks the dialog tree with one selectDialog call', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    const npcId: NetworkId = 0xfeedn;
    const conversePromise = ctx.npc.converse(npcId, ['greet']);

    // Wait for talkTo to be sent first.
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.length).toBe(1);

    // Server pushes prompt + responses for step 1.
    simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'How may I help you?'));
    await new Promise((r) => setTimeout(r, 10));
    simulateRecv(buildNpcResponsesMessage(PLAYER_ID, ['Greet me kindly', 'Tell me a story']));

    // Wait for selectDialog send.
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.length).toBe(2);

    // converse() waits for one more dialog ("closing prose") — push it.
    simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'Goodbye, friend.'));
    await new Promise((r) => setTimeout(r, 350)); // > pairWindowMs so it flushes solo

    const final = await conversePromise;
    expect(final).toBe('Goodbye, friend.');

    // We expect: talkTo + 1 selectDialog + endConversation = 3 sends.
    expect(sent.length).toBe(3);

    // talkTo
    expect(sent[0]).toBeInstanceOf(ObjControllerMessage);
    const start = unwrapEnqueue(sent[0] as ObjControllerMessage);
    expect(start.commandHash).toBe(hashCommand('npcConversationStart'));

    // selectDialog(0) — 'greet' matched first option ('Greet me kindly')
    const select = unwrapEnqueue(sent[1] as ObjControllerMessage);
    expect(select.commandHash).toBe(hashCommand('npcConversationSelect'));
    expect(select.params).toBe('0');

    // endConversation
    const stop = unwrapEnqueue(sent[2] as ObjControllerMessage);
    expect(stop.commandHash).toBe(hashCommand('npcConversationStop'));
  });

  it('converse(npcId, [label1, label2]) issues two selectDialog calls', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    const npcId: NetworkId = 0xdeadn;
    const path = ['greet', 'inquire'];
    const conversePromise = ctx.npc.converse(npcId, path);

    await new Promise((r) => setTimeout(r, 10));
    // talkTo issued.

    // Step 1: prompt + 3-option menu including 'greet me'.
    simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'Yes?'));
    await new Promise((r) => setTimeout(r, 10));
    simulateRecv(
      buildNpcResponsesMessage(PLAYER_ID, ['Greet me', 'Inquire further', 'Leave']),
    );
    await new Promise((r) => setTimeout(r, 10));

    // Step 2: new prompt + menu containing 'inquire'.
    simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'About what?'));
    await new Promise((r) => setTimeout(r, 10));
    simulateRecv(
      buildNpcResponsesMessage(PLAYER_ID, ['Tell me a story', 'Inquire about the weather']),
    );
    await new Promise((r) => setTimeout(r, 10));

    // Closing prose — let the pairWindow flush.
    simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'Have a nice day.'));
    await new Promise((r) => setTimeout(r, 350));

    const final = await conversePromise;
    expect(final).toBe('Have a nice day.');

    // Expected sends: talkTo + 2 selectDialog + endConversation = 4.
    expect(sent.length).toBe(4);
    // Pick out the selectDialog params — they should be 0 ('greet' first match)
    // and 1 ('inquire' first appears in the second option).
    const selectParams: string[] = [];
    for (const m of sent) {
      if (!(m instanceof ObjControllerMessage)) continue;
      const inner = unwrapEnqueue(m);
      if (inner.commandHash === hashCommand('npcConversationSelect')) {
        selectParams.push(inner.params);
      }
    }
    expect(selectParams).toEqual(['0', '1']);
  });

  it('converse(npcId, [0, 1]) selects by numeric index instead of label', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    const npcId: NetworkId = 0x123n;
    const conversePromise = ctx.npc.converse(npcId, [0, 1]);

    await new Promise((r) => setTimeout(r, 10));
    simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'Yes?'));
    await new Promise((r) => setTimeout(r, 10));
    simulateRecv(buildNpcResponsesMessage(PLAYER_ID, ['First', 'Second', 'Third']));
    await new Promise((r) => setTimeout(r, 10));
    simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'Next.'));
    await new Promise((r) => setTimeout(r, 10));
    simulateRecv(buildNpcResponsesMessage(PLAYER_ID, ['Alpha', 'Beta']));
    await new Promise((r) => setTimeout(r, 10));
    simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'Bye.'));
    await new Promise((r) => setTimeout(r, 350));

    await conversePromise;

    const selectParams: string[] = [];
    for (const m of sent) {
      if (!(m instanceof ObjControllerMessage)) continue;
      const inner = unwrapEnqueue(m);
      if (inner.commandHash === hashCommand('npcConversationSelect')) {
        selectParams.push(inner.params);
      }
    }
    expect(selectParams).toEqual(['0', '1']);
  });

  it('converse throws when a label does not match any option', async () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    const npcId: NetworkId = 0x99n;
    const conversePromise = ctx.npc.converse(npcId, ['nonexistent'], { timeoutMs: 1_000 });

    await new Promise((r) => setTimeout(r, 5));
    simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'Yes?'));
    await new Promise((r) => setTimeout(r, 5));
    simulateRecv(buildNpcResponsesMessage(PLAYER_ID, ['Alpha', 'Beta']));

    await expect(conversePromise).rejects.toThrow(
      /step 1\/1 selector label "nonexistent" did not match any of/,
    );
  });

  it('converse throws when a numeric index is out of range', async () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    const npcId: NetworkId = 0x88n;
    const conversePromise = ctx.npc.converse(npcId, [99], { timeoutMs: 1_000 });

    await new Promise((r) => setTimeout(r, 5));
    simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'Yes?'));
    await new Promise((r) => setTimeout(r, 5));
    simulateRecv(buildNpcResponsesMessage(PLAYER_ID, ['only one option']));

    await expect(conversePromise).rejects.toThrow(/selector index 99 did not match/);
  });

  it('lastDialog populates after a prompt + responses pair', async () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    expect(ctx.npc.lastDialog).toBeNull();

    simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'Greetings, traveler.'));
    simulateRecv(buildNpcResponsesMessage(PLAYER_ID, ['Hello', 'Goodbye']));

    // Allow the pair to settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.npc.lastDialog).not.toBeNull();
    expect(ctx.npc.lastDialog?.text).toBe('Greetings, traveler.');
    expect(ctx.npc.lastDialog?.options).toEqual(['Hello', 'Goodbye']);
  });

  it('lastDialog flushes as auto-advance ({text, options:[]}) when responses do not arrive in window', async () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'I have nothing for you.'));
    // Wait past pairWindowMs (default 250)
    await new Promise((r) => setTimeout(r, 320));
    expect(ctx.npc.lastDialog?.text).toBe('I have nothing for you.');
    expect(ctx.npc.lastDialog?.options).toEqual([]);
  });

  it('lastDialog clears on CM_npcConversationStop', async () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    simulateRecv(buildNpcPromptMessage(PLAYER_ID, 'Hi'));
    simulateRecv(buildNpcResponsesMessage(PLAYER_ID, ['ok']));
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.npc.lastDialog).not.toBeNull();

    // Push a Stop.
    const stopStream = new ByteStream();
    StopNpcConversationDecoder.encode(stopStream, {
      npc: 0x1n,
      finalMessageId: { table: '', textIndex: 0, text: '' },
      finalMessageProse: 'bye',
      finalResponse: '',
    });
    simulateRecv(
      new ObjControllerMessage(
        0,
        ObjControllerSubtypeIds.CM_npcConversationStop,
        PLAYER_ID,
        0,
        stopStream.toBytes(),
        {
          kind: StopNpcConversationDecoder.kind,
          data: {
            npc: 0x1n,
            finalMessageId: { table: '', textIndex: 0, text: '' },
            finalMessageProse: 'bye',
            finalResponse: '',
          },
        },
      ),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(ctx.npc.lastDialog).toBeNull();
  });

  it('lastDialog ignores prompts addressed to other players', async () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    const otherId: NetworkId = 0xbabean;
    simulateRecv(buildNpcPromptMessage(otherId, 'For someone else.'));
    simulateRecv(buildNpcResponsesMessage(otherId, ['Not for us']));
    await new Promise((r) => setTimeout(r, 320));
    expect(ctx.npc.lastDialog).toBeNull();
  });
});
