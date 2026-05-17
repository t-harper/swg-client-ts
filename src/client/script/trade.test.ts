import { describe, expect, it } from 'vitest';

import { CLIENT_TO_AUTH_SERVER_FLAGS } from '../../messages/game/command-queue/index.js';
import { ObjControllerMessage } from '../../messages/game/obj-controller-message.js';
import {
  ObjControllerSubtypeIds,
  TradeMessageId,
  type TradeStartData,
} from '../../messages/game/obj-controller/index.js';
import {
  AbortTradeMessage,
  AcceptTransactionMessage,
  AddItemMessage,
  BeginTradeMessage,
  BeginVerificationMessage,
  GiveMoneyMessage,
  TradeCompleteMessage,
  VerifyTradeMessage,
} from '../../messages/game/trade/index.js';
import type { GameNetworkMessage } from '../../messages/interface.js';
import { createFakeContext } from './test-helpers.js';

const PLAYER_ID = 0x1234n;
const OTHER_ID = 0xabcdn;

function findRequestTrade(sent: GameNetworkMessage[]): {
  msg: ObjControllerMessage;
  data: TradeStartData;
} | null {
  for (const m of sent) {
    if (!(m instanceof ObjControllerMessage)) continue;
    if (m.message !== ObjControllerSubtypeIds.CM_secureTrade) continue;
    if (m.decodedSubtype?.kind !== 'TradeStart') continue;
    return { msg: m, data: m.decodedSubtype.data as TradeStartData };
  }
  return null;
}

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ctx.tradeWith — happy path', () => {
  it('drives the full handshake when the server cooperates', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });

    const promise = ctx.tradeWith(OTHER_ID, {
      items: [0xa11n, 0xa22n, 0xa33n],
      credits: 5_000,
      beginTimeoutMs: 500,
      acceptTimeoutMs: 500,
      verifyTimeoutMs: 500,
    });

    await tick();
    simulateRecv(new BeginTradeMessage(OTHER_ID));
    await tick();
    simulateRecv(new BeginVerificationMessage());
    await tick();
    simulateRecv(new TradeCompleteMessage());

    const result = await promise;
    expect(result).toEqual({ completed: true });

    const req = findRequestTrade(sent);
    expect(req).not.toBeNull();
    if (req === null) throw new Error('typeguard');
    expect(req.data.tradeMessageId).toBe(TradeMessageId.RequestTrade);
    expect(req.data.initiatorId).toBe(PLAYER_ID);
    expect(req.data.recipientId).toBe(OTHER_ID);
    expect(req.msg.flags).toBe(CLIENT_TO_AUTH_SERVER_FLAGS);

    const addItems = sent.filter((m): m is AddItemMessage => m instanceof AddItemMessage);
    expect(addItems.map((m) => m.object)).toEqual([0xa11n, 0xa22n, 0xa33n]);

    const giveMoney = sent.find((m): m is GiveMoneyMessage => m instanceof GiveMoneyMessage);
    expect(giveMoney?.amount).toBe(5_000);

    const accept = sent.find(
      (m): m is AcceptTransactionMessage => m instanceof AcceptTransactionMessage,
    );
    expect(accept).toBeDefined();

    const verifies = sent.filter((m): m is VerifyTradeMessage => m instanceof VerifyTradeMessage);
    expect(verifies.length).toBe(1);
  });

  it('skips GiveMoneyMessage when credits is 0 or undefined', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });

    const promise = ctx.tradeWith(OTHER_ID, {
      items: [0xa11n],
      beginTimeoutMs: 500,
      acceptTimeoutMs: 500,
      verifyTimeoutMs: 500,
    });

    await tick();
    simulateRecv(new BeginTradeMessage(OTHER_ID));
    await tick();
    simulateRecv(new BeginVerificationMessage());
    await tick();
    simulateRecv(new TradeCompleteMessage());

    const result = await promise;
    expect(result.completed).toBe(true);

    const giveMoney = sent.find((m): m is GiveMoneyMessage => m instanceof GiveMoneyMessage);
    expect(giveMoney).toBeUndefined();
  });

  it('handles a zero-item / zero-credit trade (open-then-confirm)', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });

    const promise = ctx.tradeWith(OTHER_ID, {
      beginTimeoutMs: 500,
      acceptTimeoutMs: 500,
      verifyTimeoutMs: 500,
    });

    await tick();
    simulateRecv(new BeginTradeMessage(OTHER_ID));
    await tick();
    simulateRecv(new BeginVerificationMessage());
    await tick();
    simulateRecv(new TradeCompleteMessage());

    const result = await promise;
    expect(result.completed).toBe(true);

    expect(sent.filter((m) => m instanceof AddItemMessage)).toHaveLength(0);
    expect(sent.filter((m) => m instanceof GiveMoneyMessage)).toHaveLength(0);
    expect(sent.filter((m) => m instanceof AcceptTransactionMessage)).toHaveLength(1);
  });
});

describe('ctx.tradeWith — failure modes', () => {
  it('returns no-begin when the server never confirms', async () => {
    const { ctx, sent } = createFakeContext({ playerNetworkId: PLAYER_ID });

    const result = await ctx.tradeWith(OTHER_ID, {
      beginTimeoutMs: 30,
      acceptTimeoutMs: 30,
      verifyTimeoutMs: 30,
    });

    expect(result).toEqual({ completed: false, abortReason: 'no-begin' });
    const req = findRequestTrade(sent);
    expect(req).not.toBeNull();
    expect(sent.filter((m) => m instanceof AddItemMessage)).toHaveLength(0);
    expect(sent.filter((m) => m instanceof AcceptTransactionMessage)).toHaveLength(0);
  });

  it('returns aborted when the other party aborts BEFORE BeginTradeMessage', async () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });

    const promise = ctx.tradeWith(OTHER_ID, {
      beginTimeoutMs: 500,
      acceptTimeoutMs: 500,
      verifyTimeoutMs: 500,
    });

    await tick();
    simulateRecv(new AbortTradeMessage());

    const result = await promise;
    expect(result).toEqual({ completed: false, abortReason: 'aborted' });
  });

  it('returns aborted when the other party aborts MID-TRADE', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });

    const promise = ctx.tradeWith(OTHER_ID, {
      items: [0xa11n],
      credits: 10,
      beginTimeoutMs: 500,
      acceptTimeoutMs: 500,
      verifyTimeoutMs: 500,
    });

    await tick();
    simulateRecv(new BeginTradeMessage(OTHER_ID));
    await tick();
    simulateRecv(new AbortTradeMessage());

    const result = await promise;
    expect(result).toEqual({ completed: false, abortReason: 'aborted' });

    expect(sent.filter((m) => m instanceof AcceptTransactionMessage)).toHaveLength(1);
    expect(sent.filter((m) => m instanceof VerifyTradeMessage)).toHaveLength(0);
  });

  it('returns no-verify on verify-timeout (server stops responding)', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });

    const promise = ctx.tradeWith(OTHER_ID, {
      beginTimeoutMs: 500,
      acceptTimeoutMs: 30,
      verifyTimeoutMs: 500,
    });

    await tick();
    simulateRecv(new BeginTradeMessage(OTHER_ID));

    const result = await promise;
    expect(result).toEqual({ completed: false, abortReason: 'no-verify' });
    expect(sent.filter((m) => m instanceof AcceptTransactionMessage)).toHaveLength(1);
    expect(sent.filter((m) => m instanceof VerifyTradeMessage)).toHaveLength(0);
  });

  it('returns no-complete when TradeCompleteMessage never arrives', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });

    const promise = ctx.tradeWith(OTHER_ID, {
      beginTimeoutMs: 500,
      acceptTimeoutMs: 500,
      verifyTimeoutMs: 30,
    });

    await tick();
    simulateRecv(new BeginTradeMessage(OTHER_ID));
    await tick();
    simulateRecv(new BeginVerificationMessage());

    const result = await promise;
    expect(result).toEqual({ completed: false, abortReason: 'no-complete' });
    expect(sent.filter((m) => m instanceof VerifyTradeMessage)).toHaveLength(1);
  });
});

describe('ctx.tradeWith — defaults', () => {
  it('completes with default timeouts when responses are fast', async () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });

    const promise = ctx.tradeWith(OTHER_ID);

    await tick();
    simulateRecv(new BeginTradeMessage(OTHER_ID));
    await tick();
    simulateRecv(new BeginVerificationMessage());
    await tick();
    simulateRecv(new TradeCompleteMessage());

    const result = await promise;
    expect(result).toEqual({ completed: true });
  });
});
