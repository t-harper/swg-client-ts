/**
 * Unit tests for the `group-trade` bundled scenario.
 *
 * The scenario coordinates two clients (a "leader" who invites and a
 * "invitee" who accepts) plus an optional trade-window step. These tests
 * verify each role's wire output with a fake context, and use
 * `simulateRecv` to feed simulated server responses so the `expectWithin`
 * waiters resolve.
 */

import { describe, expect, it } from 'vitest';
import { ByteStream } from '../archive/byte-stream.js';
import { ReadIterator } from '../archive/read-iterator.js';
import { runScript } from '../client/script/context.js';
import { createFakeContext } from '../client/script/test-helpers.js';
import {
  CLIENT_TO_AUTH_SERVER_FLAGS,
  CM_COMMAND_QUEUE_ENQUEUE,
  CommandQueueEnqueue,
  hashCommand,
} from '../messages/game/command-queue/index.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import {
  GroupAcceptDecoder,
  GroupInviteDecoder,
  ObjControllerSubtypeIds,
  TradeMessageId,
  TradeStartDecoder,
} from '../messages/game/obj-controller/index.js';
import {
  BeginTradeMessage,
  TradeCompleteMessage,
  VerifyTradeMessage,
} from '../messages/game/trade/index.js';
import { scenarios } from './index.js';

const LEADER_ID = 0xaa11n;
const INVITEE_ID = 0xbb22n;
const GROUP_ID = 0xcc33n;

/** Helper — build a fake inbound `ObjControllerMessage` with a known subtype trailer. */
function buildInboundGroupInvite(inviterId: bigint, inviterName = 'Han'): ObjControllerMessage {
  const stream = new ByteStream();
  GroupInviteDecoder.encode(stream, { inviterName, inviterId, inviterShipId: 0n });
  return new ObjControllerMessage(
    0,
    ObjControllerSubtypeIds.CM_setGroupInviter,
    inviterId,
    0,
    stream.toBytes(),
    {
      kind: GroupInviteDecoder.kind,
      data: { inviterName, inviterId, inviterShipId: 0n },
    },
  );
}

function buildInboundGroupAccept(
  groupId: bigint,
  disbandingCurrentGroup = false,
): ObjControllerMessage {
  const stream = new ByteStream();
  GroupAcceptDecoder.encode(stream, { disbandingCurrentGroup, groupId });
  return new ObjControllerMessage(
    0,
    ObjControllerSubtypeIds.CM_setGroup,
    groupId,
    0,
    stream.toBytes(),
    {
      kind: GroupAcceptDecoder.kind,
      data: { disbandingCurrentGroup, groupId },
    },
  );
}

describe('group-trade scenario — factory validation', () => {
  it('is registered under the name "group-trade"', () => {
    expect(scenarios['group-trade']).toBeDefined();
  });

  it('throws when role is missing', () => {
    const factory = scenarios['group-trade'];
    if (!factory) throw new Error('group-trade not registered');
    expect(() => factory({ otherId: '0x42' })).toThrow(/role=leader\|invitee/);
  });

  it('throws when role is an unknown value', () => {
    const factory = scenarios['group-trade'];
    if (!factory) throw new Error('group-trade not registered');
    expect(() => factory({ role: 'follower', otherId: '0x42' })).toThrow(/role=leader\|invitee/);
  });

  it('throws when otherId is missing', () => {
    const factory = scenarios['group-trade'];
    if (!factory) throw new Error('group-trade not registered');
    expect(() => factory({ role: 'leader' })).toThrow(/otherId/);
  });

  it('throws when otherId is unparseable', () => {
    const factory = scenarios['group-trade'];
    if (!factory) throw new Error('group-trade not registered');
    expect(() => factory({ role: 'leader', otherId: 'not-a-number' })).toThrow(/NetworkId/);
  });

  it('accepts hex and decimal otherId', () => {
    const factory = scenarios['group-trade'];
    if (!factory) throw new Error('group-trade not registered');
    expect(() => factory({ role: 'leader', otherId: '0xbb22' })).not.toThrow();
    expect(() => factory({ role: 'invitee', otherId: '12345' })).not.toThrow();
  });
});

describe('group-trade scenario — leader role', () => {
  // The leader sleeps 1000ms before sending the invite — schedule recvs
  // AFTER that so the waiter is already registered.
  const POST_INITIAL_DELAY_MS = 1_100;

  it('queues `invite` against otherId, then `disband` after group forms', async () => {
    const factory = scenarios['group-trade'];
    if (!factory) throw new Error('group-trade not registered');
    const fn = factory({
      role: 'leader',
      otherId: `0x${INVITEE_ID.toString(16)}`,
      waitForOtherMs: '500',
      dwellMs: '50',
    });
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: LEADER_ID });

    // Run scenario in background; feed it a fake CM_setGroup so the
    // `expectWithin` waiter resolves before its timeout.
    const runPromise = runScript(fn, ctx);
    setTimeout(() => simulateRecv(buildInboundGroupAccept(GROUP_ID)), POST_INITIAL_DELAY_MS);
    const result = await runPromise;

    expect(result.error).toBeUndefined();
    // Should have sent at least 2 ObjControllerMessages: invite + disband.
    expect(sent.length).toBeGreaterThanOrEqual(2);
    const commands = sent.map((m) => {
      const obj = m as ObjControllerMessage;
      expect(obj.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
      return CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
    });
    // First send is the invite (with INVITEE_ID as the target).
    expect(commands[0]?.commandHash).toBe(hashCommand('invite'));
    expect(commands[0]?.targetId).toBe(INVITEE_ID);
    // Last send is disband (no target).
    const last = commands[commands.length - 1];
    expect(last?.commandHash).toBe(hashCommand('disband'));
    // No soft-assertion failures since the group formed in time.
    expect(result.assertionFailures).toEqual([]);
  });

  it('records a soft failure when CM_setGroup never arrives', async () => {
    const factory = scenarios['group-trade'];
    if (!factory) throw new Error('group-trade not registered');
    const fn = factory({
      role: 'leader',
      otherId: `0x${INVITEE_ID.toString(16)}`,
      waitForOtherMs: '50',
      dwellMs: '10',
    });
    const { ctx } = createFakeContext({ playerNetworkId: LEADER_ID });
    const result = await runScript(fn, ctx);

    expect(result.error).toBeUndefined();
    // expectWithin({soft:true}) auto-records one timeout message.
    expect(result.assertionFailures).toHaveLength(1);
    expect(result.assertionFailures[0]).toMatch(/Timed out.*ObjControllerMessage/);
  });

  it('drives the full SecureTrade handshake when tradeAmount > 0', async () => {
    const factory = scenarios['group-trade'];
    if (!factory) throw new Error('group-trade not registered');
    const fn = factory({
      role: 'leader',
      otherId: `0x${INVITEE_ID.toString(16)}`,
      tradeAmount: '100',
      waitForOtherMs: '500',
      dwellMs: '10',
    });
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: LEADER_ID });

    const runPromise = runScript(fn, ctx);
    setTimeout(() => simulateRecv(buildInboundGroupAccept(GROUP_ID)), POST_INITIAL_DELAY_MS);
    // After the trade starts, feed each handshake step so it completes.
    setTimeout(() => simulateRecv(new BeginTradeMessage(INVITEE_ID)), POST_INITIAL_DELAY_MS + 100);
    setTimeout(() => simulateRecv(new VerifyTradeMessage()), POST_INITIAL_DELAY_MS + 200);
    setTimeout(() => simulateRecv(new TradeCompleteMessage()), POST_INITIAL_DELAY_MS + 300);
    const result = await runPromise;
    expect(result.error).toBeUndefined();

    // The initial RequestTrade went via CM_secureTrade ObjController.
    const trade = sent.find(
      (m) =>
        m instanceof ObjControllerMessage &&
        (m as ObjControllerMessage).message === ObjControllerSubtypeIds.CM_secureTrade,
    ) as ObjControllerMessage | undefined;
    expect(trade).toBeDefined();
    if (trade === undefined) return;
    expect(trade.flags).toBe(CLIENT_TO_AUTH_SERVER_FLAGS);
    const decoded = TradeStartDecoder.decode(new ReadIterator(trade.data));
    expect(decoded.tradeMessageId).toBe(TradeMessageId.RequestTrade);
    expect(decoded.initiatorId).toBe(LEADER_ID);
    expect(decoded.recipientId).toBe(INVITEE_ID);

    // No assertion failures since the handshake completed.
    expect(result.assertionFailures).toEqual([]);
  });

  it('does NOT emit a CM_secureTrade when tradeAmount is 0 (default)', async () => {
    const factory = scenarios['group-trade'];
    if (!factory) throw new Error('group-trade not registered');
    const fn = factory({
      role: 'leader',
      otherId: `0x${INVITEE_ID.toString(16)}`,
      waitForOtherMs: '500',
      dwellMs: '10',
    });
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: LEADER_ID });

    const runPromise = runScript(fn, ctx);
    setTimeout(() => simulateRecv(buildInboundGroupAccept(GROUP_ID)), POST_INITIAL_DELAY_MS);
    await runPromise;

    const trade = sent.find(
      (m) =>
        m instanceof ObjControllerMessage &&
        (m as ObjControllerMessage).message === ObjControllerSubtypeIds.CM_secureTrade,
    );
    expect(trade).toBeUndefined();
  });

  it('skips the group-formed wait gracefully if a "clear-group" (groupId=0) shows up', async () => {
    // The predicate must ignore the clear-group "groupId=0" form.
    const factory = scenarios['group-trade'];
    if (!factory) throw new Error('group-trade not registered');
    const fn = factory({
      role: 'leader',
      otherId: `0x${INVITEE_ID.toString(16)}`,
      waitForOtherMs: '300',
      dwellMs: '10',
    });
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: LEADER_ID });

    const runPromise = runScript(fn, ctx);
    // Send a clear-group (groupId=0); the predicate should ignore this and time out.
    setTimeout(() => simulateRecv(buildInboundGroupAccept(0n)), POST_INITIAL_DELAY_MS);
    const result = await runPromise;

    expect(result.assertionFailures).toHaveLength(1);
    expect(result.assertionFailures[0]).toMatch(/Timed out.*ObjControllerMessage/);
  });
});

describe('group-trade scenario — invitee role', () => {
  it('waits for invite, then queues `join` and `leaveGroup`', async () => {
    const factory = scenarios['group-trade'];
    if (!factory) throw new Error('group-trade not registered');
    const fn = factory({
      role: 'invitee',
      otherId: `0x${LEADER_ID.toString(16)}`,
      waitForOtherMs: '500',
      dwellMs: '50',
    });
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: INVITEE_ID });

    const runPromise = runScript(fn, ctx);
    // Step 1: the inbound invite. The invitee accepts immediately.
    setTimeout(() => simulateRecv(buildInboundGroupInvite(LEADER_ID)), 30);
    // Step 2: the inbound group-accept; needs to land after the `join` ability fires.
    setTimeout(() => simulateRecv(buildInboundGroupAccept(GROUP_ID)), 100);
    const result = await runPromise;

    expect(result.error).toBeUndefined();
    expect(result.assertionFailures).toEqual([]);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    const commands = sent.map((m) => {
      const obj = m as ObjControllerMessage;
      expect(obj.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
      return CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
    });
    // First send is the `join` ability (no target).
    expect(commands[0]?.commandHash).toBe(hashCommand('join'));
    // Last send is `leaveGroup`.
    const last = commands[commands.length - 1];
    expect(last?.commandHash).toBe(hashCommand('leaveGroup'));
  });

  it('ignores a clear-inviter (inviterId=0) and times out cleanly', async () => {
    // A clear-inviter is CM_setGroupInviter with inviterId=0; the invitee
    // should NOT accept this and should time out the wait.
    const factory = scenarios['group-trade'];
    if (!factory) throw new Error('group-trade not registered');
    const fn = factory({
      role: 'invitee',
      otherId: `0x${LEADER_ID.toString(16)}`,
      waitForOtherMs: '100',
      dwellMs: '10',
    });
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: INVITEE_ID });

    const runPromise = runScript(fn, ctx);
    // Inject a clear-inviter (a "decline / timeout" message).
    setTimeout(() => simulateRecv(buildInboundGroupInvite(0n, '')), 30);
    const result = await runPromise;

    expect(result.error).toBeUndefined();
    // Single failure from the soft expectWithin auto-timeout.
    expect(result.assertionFailures).toHaveLength(1);
    expect(result.assertionFailures[0]).toMatch(/Timed out.*ObjControllerMessage/);

    // Only the leaveGroup send (no `join` since no real invite arrived).
    const commands = sent.map((m) => {
      const obj = m as ObjControllerMessage;
      return CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
    });
    expect(commands.find((c) => c.commandHash === hashCommand('join'))).toBeUndefined();
    expect(commands.find((c) => c.commandHash === hashCommand('leaveGroup'))).toBeDefined();
  });

  it('records a separate soft failure if CM_setGroup never arrives after the invite was accepted', async () => {
    const factory = scenarios['group-trade'];
    if (!factory) throw new Error('group-trade not registered');
    const fn = factory({
      role: 'invitee',
      otherId: `0x${LEADER_ID.toString(16)}`,
      waitForOtherMs: '100',
      dwellMs: '10',
    });
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: INVITEE_ID });

    const runPromise = runScript(fn, ctx);
    setTimeout(() => simulateRecv(buildInboundGroupInvite(LEADER_ID)), 20);
    // Never send CM_setGroup; expectWithin({soft:true}) auto-records its timeout.
    const result = await runPromise;

    // One failure from the inner CM_setGroup wait.
    expect(result.assertionFailures).toHaveLength(1);
    expect(result.assertionFailures[0]).toMatch(/Timed out.*ObjControllerMessage/);
  });
});
