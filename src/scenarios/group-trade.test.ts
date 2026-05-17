/**
 * Unit tests for the `group-trade` bundled scenario.
 *
 * The scenario coordinates two clients (a "leader" who invites and a
 * "invitee" who accepts) plus an optional trade-window step. These tests
 * verify each role's wire output with a fake context, and use
 * `simulateRecv` to feed simulated server responses so the `expectWithin`
 * waiters resolve.
 *
 * The scenario uses `DeltasMessage` on the CREO SHARED_NP package to
 * detect both the invite (m_groupInviter at idx 14) and the group-formed
 * (m_group at idx 13) wire events — see scenarios/index.ts for the
 * single-vs-cross-server-authority rationale.
 */

import { describe, expect, it } from 'vitest';
import { ByteStream } from '../archive/byte-stream.js';
import { ReadIterator } from '../archive/read-iterator.js';
import { runScript } from '../client/script/context.js';
import { createFakeContext } from '../client/script/test-helpers.js';
import {
  CreoSharedNpIndices,
  DeltasMessage,
} from '../messages/game/baselines/deltas-message.js';
import { BaselinePackageIds, ObjectTypeTags } from '../messages/game/baselines/registry.js';
import {
  CLIENT_TO_AUTH_SERVER_FLAGS,
  CM_COMMAND_QUEUE_ENQUEUE,
  CommandQueueEnqueue,
  hashCommand,
} from '../messages/game/command-queue/index.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import {
  ObjControllerSubtypeIds,
  TradeMessageId,
  TradeStartDecoder,
} from '../messages/game/obj-controller/index.js';
import {
  BeginTradeMessage,
  TradeCompleteMessage,
  BeginVerificationMessage,
} from '../messages/game/trade/index.js';
import { writeStdString } from '../archive/string.js';
import { scenarios } from './index.js';

const LEADER_ID = 0xaa11n;
const INVITEE_ID = 0xbb22n;
const GROUP_ID = 0xcc33n;

/**
 * Helper — build a fake `DeltasMessage` carrying an `m_groupInviter`
 * change (CREO SHARED_NP, idx 14). The `target` is the invitee whose
 * inviter slot changed; on the wire this is what arrives when the leader's
 * `useAbility('invite', invitee)` lands on a single-server cluster.
 */
function buildInboundGroupInvite(
  target: bigint,
  inviterId: bigint,
  inviterName = 'Han',
): DeltasMessage {
  const pkg = new ByteStream();
  pkg.writeU16(1); // dirtyCount
  pkg.writeU16(CreoSharedNpIndices.M_GROUP_INVITER); // index = 14
  pkg.writeI64(inviterId);
  writeStdString(pkg, inviterName);
  pkg.writeI64(0n); // inviterShipId
  return new DeltasMessage(
    target,
    ObjectTypeTags.CREO,
    BaselinePackageIds.SHARED_NP,
    pkg.toBytes(),
  );
}

/**
 * Helper — build a fake `DeltasMessage` carrying an `m_group` change
 * (CREO SHARED_NP, idx 13). The `target` is the creature whose group
 * pointer changed; on the wire this is what arrives when `setGroup`
 * runs on the auth server.
 */
function buildInboundGroupAccept(target: bigint, groupId: bigint): DeltasMessage {
  const pkg = new ByteStream();
  pkg.writeU16(1); // dirtyCount
  pkg.writeU16(CreoSharedNpIndices.M_GROUP); // index = 13
  pkg.writeI64(groupId);
  return new DeltasMessage(
    target,
    ObjectTypeTags.CREO,
    BaselinePackageIds.SHARED_NP,
    pkg.toBytes(),
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
  // The leader sends a `disband` preflight (250ms wait), then sleeps 1000ms
  // before sending the invite — schedule recvs AFTER ~1300ms so the waiter
  // is registered.
  const POST_INITIAL_DELAY_MS = 1_400;

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

    // Run scenario in background; feed it a fake m_group delta on the
    // LEADER's own NetworkId so the `expectWithin` waiter resolves.
    const runPromise = runScript(fn, ctx);
    setTimeout(() => simulateRecv(buildInboundGroupAccept(LEADER_ID, GROUP_ID)), POST_INITIAL_DELAY_MS);
    const result = await runPromise;

    expect(result.error).toBeUndefined();
    // Expected wire output: stale-clear disband, then invite, then final disband.
    expect(sent.length).toBeGreaterThanOrEqual(3);
    const commands = sent.map((m) => {
      const obj = m as ObjControllerMessage;
      expect(obj.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
      return CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
    });
    // First send is the stale-clear disband.
    expect(commands[0]?.commandHash).toBe(hashCommand('disband'));
    // The invite (targeting INVITEE_ID) must appear in the queue.
    const invite = commands.find((c) => c.commandHash === hashCommand('invite'));
    expect(invite).toBeDefined();
    expect(invite?.targetId).toBe(INVITEE_ID);
    // Last send is the post-trade disband (no target).
    const last = commands[commands.length - 1];
    expect(last?.commandHash).toBe(hashCommand('disband'));
    // No soft-assertion failures since the group formed in time.
    expect(result.assertionFailures).toEqual([]);
  });

  it('records a soft failure when the m_group delta never arrives', async () => {
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
    expect(result.assertionFailures[0]).toMatch(/Timed out.*DeltasMessage/);
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
    setTimeout(() => simulateRecv(buildInboundGroupAccept(LEADER_ID, GROUP_ID)), POST_INITIAL_DELAY_MS);
    // After the trade starts, feed each handshake step so it completes.
    setTimeout(() => simulateRecv(new BeginTradeMessage(INVITEE_ID)), POST_INITIAL_DELAY_MS + 100);
    setTimeout(() => simulateRecv(new BeginVerificationMessage()), POST_INITIAL_DELAY_MS + 200);
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
    setTimeout(() => simulateRecv(buildInboundGroupAccept(LEADER_ID, GROUP_ID)), POST_INITIAL_DELAY_MS);
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
    setTimeout(() => simulateRecv(buildInboundGroupAccept(LEADER_ID, 0n)), POST_INITIAL_DELAY_MS);
    const result = await runPromise;

    expect(result.assertionFailures).toHaveLength(1);
    expect(result.assertionFailures[0]).toMatch(/Timed out.*DeltasMessage/);
  });

  it('ignores a m_group delta targeted at a different creature', async () => {
    // The predicate must filter by `target == selfId` so a neighbor's
    // group change can't spuriously satisfy our wait.
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
    setTimeout(() => simulateRecv(buildInboundGroupAccept(0xdeadn, GROUP_ID)), POST_INITIAL_DELAY_MS);
    const result = await runPromise;

    expect(result.assertionFailures).toHaveLength(1);
    expect(result.assertionFailures[0]).toMatch(/Timed out.*DeltasMessage/);
  });
});

describe('group-trade scenario — invitee role', () => {
  // The invitee sends `decline` then `disband` (300ms total stale-clear)
  // before starting to wait for the invite. Schedule recvs after ~350ms.
  const POST_PREFLIGHT_MS = 400;

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
    // Step 1: the inbound invite (target == invitee, idx=14, inviterId != 0).
    setTimeout(() => simulateRecv(buildInboundGroupInvite(INVITEE_ID, LEADER_ID)), POST_PREFLIGHT_MS);
    // Step 2: the inbound group-accept (target == invitee, idx=13, groupId != 0).
    setTimeout(() => simulateRecv(buildInboundGroupAccept(INVITEE_ID, GROUP_ID)), POST_PREFLIGHT_MS + 100);
    const result = await runPromise;

    expect(result.error).toBeUndefined();
    expect(result.assertionFailures).toEqual([]);
    // Sends: decline (preflight), disband (preflight), join, leaveGroup.
    expect(sent.length).toBeGreaterThanOrEqual(4);
    const commands = sent.map((m) => {
      const obj = m as ObjControllerMessage;
      expect(obj.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
      return CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
    });
    // Preflight: decline + disband (in either order, both must be present).
    expect(commands.find((c) => c.commandHash === hashCommand('decline'))).toBeDefined();
    expect(commands.find((c) => c.commandHash === hashCommand('disband'))).toBeDefined();
    // `join` ability fires after the invite arrives.
    expect(commands.find((c) => c.commandHash === hashCommand('join'))).toBeDefined();
    // Last send is `leaveGroup`.
    const last = commands[commands.length - 1];
    expect(last?.commandHash).toBe(hashCommand('leaveGroup'));
  });

  it('ignores a clear-inviter (inviterId=0) and times out cleanly', async () => {
    // A clear-inviter is the m_groupInviter delta with inviterId=0; the
    // invitee should NOT accept this and should time out the wait.
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
    setTimeout(() => simulateRecv(buildInboundGroupInvite(INVITEE_ID, 0n, '')), POST_PREFLIGHT_MS);
    const result = await runPromise;

    expect(result.error).toBeUndefined();
    // Single failure from the soft expectWithin auto-timeout.
    expect(result.assertionFailures).toHaveLength(1);
    expect(result.assertionFailures[0]).toMatch(/Timed out.*DeltasMessage/);

    // No `join` since no real invite arrived.
    const commands = sent.map((m) => {
      const obj = m as ObjControllerMessage;
      return CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
    });
    expect(commands.find((c) => c.commandHash === hashCommand('join'))).toBeUndefined();
    expect(commands.find((c) => c.commandHash === hashCommand('leaveGroup'))).toBeDefined();
  });

  it('ignores an m_groupInviter delta targeted at a different creature', async () => {
    // Predicate must filter by `target == selfId` — a neighbor's invite
    // (e.g. someone else in the cell got invited) must not satisfy our wait.
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
    // A bystander (not us) received an invite; we must ignore it.
    setTimeout(() => simulateRecv(buildInboundGroupInvite(0xbeefn, LEADER_ID)), POST_PREFLIGHT_MS);
    const result = await runPromise;

    expect(result.assertionFailures).toHaveLength(1);
    expect(result.assertionFailures[0]).toMatch(/Timed out.*DeltasMessage/);
  });

  it('records a separate soft failure if the m_group delta never arrives after the invite was accepted', async () => {
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
    setTimeout(() => simulateRecv(buildInboundGroupInvite(INVITEE_ID, LEADER_ID)), POST_PREFLIGHT_MS);
    // Never send the m_group delta; expectWithin({soft:true}) auto-records its timeout.
    const result = await runPromise;

    // One failure from the inner m_group wait.
    expect(result.assertionFailures).toHaveLength(1);
    expect(result.assertionFailures[0]).toMatch(/Timed out.*DeltasMessage/);
  });
});
