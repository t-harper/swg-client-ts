/**
 * Live integration test for the full SecureTrade handshake.
 *
 * Drives a 2-client Fleet against the real `swg-server`:
 *   - Both clients zone in with admin accounts (swg / swg2 by default).
 *   - Leader walks to a known meet-up coordinate; invitee walks to the same.
 *   - Leader: `ctx.tradeWith(inviteeId, { credits })` (initiator path).
 *   - Invitee: `ctx.acceptIncomingTrade({ credits: 0 })` (responder path —
 *     waits for TMI_TradeRequested, sends TMI_AcceptTrade, completes).
 *
 * Asserts:
 *   - Both lifecycles reach zoned-in.
 *   - Leader's `tradeWith` resolves `{ completed: true }`.
 *   - Invitee's `acceptIncomingTrade` resolves `{ completed: true }`.
 *   - `TradeCompleteMessage` arrives on BOTH transcripts (server-side commit).
 *
 * Gated on `LIVE=1`. Server-side `stella_admin.tab` restricts character
 * creation to admin accounts, so we default to two admins (swg / swg2)
 * which already have pre-existing characters at mos_eisley. Override via
 * `LIVE_TRADE_LEADER` / `LIVE_TRADE_INVITEE` env vars.
 */

import { describe, expect, it } from 'vitest';

import type { TranscriptEvent } from '../../src/client/dispatcher.js';
import { Fleet } from '../../src/client/fleet.js';
import type { NetworkId } from '../../src/types.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

// Pre-existing admin-account chars on this cluster have 0 cash (depleted by
// prior test runs). Use credits=0 so the handshake validates end-to-end
// without requiring stocked balances. To exercise the actual money transfer,
// admin-stage some cash onto the leader char first and set this to >0.
const TRADE_AMOUNT = Number(process.env.LIVE_TRADE_AMOUNT ?? '0');

// Meet-up coord at the mos_eisley spawn point — both characters walk here
// so they're guaranteed within trade-window range.
const MEETUP_X = 3528;
const MEETUP_Z = -4804;

function hasInbound(transcript: readonly TranscriptEvent[], name: string): boolean {
  return transcript.some((e) => e.direction === 'recv' && e.messageName === name);
}

describe.skipIf(!LIVE)('live trade (full SecureTrade handshake)', () => {
  it('completes a credits transfer between two admin-account characters', async () => {
    const leaderAccount = process.env.LIVE_TRADE_LEADER ?? 'swg';
    const inviteeAccount = process.env.LIVE_TRADE_INVITEE ?? 'swg2';

    // Phase 1: Stage 1+2 lookup to grab each existing character's NetworkId.
    const lookupFleet = new Fleet({ loginServer: { host: HOST, port: PORT } });
    const lookup = await lookupFleet.run(
      [
        { account: leaderAccount, planet: 'mos_eisley', skipGameStage: true },
        { account: inviteeAccount, planet: 'mos_eisley', skipGameStage: true },
      ],
      { staggerMs: 100 },
    );
    expect(
      lookup.summary.succeeded,
      `lookup phase failed: ${lookup.summary.errorMessages.join(' | ')}`,
    ).toBe(2);
    const leaderId = lookup.outcomes[0]?.lifecycleResult?.character.networkId;
    const inviteeId = lookup.outcomes[1]?.lifecycleResult?.character.networkId;
    expect(leaderId, 'leader NetworkId resolved').toBeDefined();
    expect(inviteeId, 'invitee NetworkId resolved').toBeDefined();
    if (leaderId === undefined || inviteeId === undefined) return;

    // Phase 2: real trade. Both walk to the meet-up, leader initiates, invitee
    // accepts. Stagger so the invitee's acceptIncomingTrade is listening
    // before the leader fires RequestTrade.
    const fleet = new Fleet({ loginServer: { host: HOST, port: PORT } });
    const tradeResults: { leader?: unknown; invitee?: unknown } = {};

    const result = await fleet.run(
      [
        {
          account: leaderAccount,
          planet: 'mos_eisley',
          holdZonedInMs: 0,
          script: async (ctx) => {
            await ctx.wait(2_000);
            await ctx.walkTo({ x: MEETUP_X, z: MEETUP_Z }, { tickMs: 400 });
            // Wait an extra 4s so the invitee's listener is armed before we
            // fire RequestTrade.
            await ctx.wait(4_000);
            const r = await ctx.tradeWith(inviteeId as NetworkId, {
              credits: TRADE_AMOUNT,
              beginTimeoutMs: 20_000,
              acceptTimeoutMs: 20_000,
              verifyTimeoutMs: 20_000,
            });
            tradeResults.leader = r;
            // Brief settle so the server pushes TradeCompleteMessage before
            // our logout closes the connection.
            await ctx.wait(2_000);
          },
        },
        {
          account: inviteeAccount,
          planet: 'mos_eisley',
          holdZonedInMs: 0,
          script: async (ctx) => {
            await ctx.wait(2_000);
            await ctx.walkTo({ x: MEETUP_X, z: MEETUP_Z }, { tickMs: 400 });
            // Be ready before the leader fires.
            const r = await ctx.acceptIncomingTrade({
              requestTimeoutMs: 30_000,
              beginTimeoutMs: 20_000,
              acceptTimeoutMs: 20_000,
              verifyTimeoutMs: 20_000,
            });
            tradeResults.invitee = r;
            await ctx.wait(2_000);
          },
        },
      ],
      { staggerMs: 200 },
    );

    expect(
      result.summary.succeeded,
      `expected 2 successes; errors=${result.summary.errorMessages.join(' | ')}`,
    ).toBe(2);

    const leaderLr = result.outcomes[0]?.lifecycleResult;
    const inviteeLr = result.outcomes[1]?.lifecycleResult;
    expect(leaderLr).toBeDefined();
    expect(inviteeLr).toBeDefined();
    if (leaderLr === undefined || inviteeLr === undefined) return;

    expect(leaderLr.zonedInAt, 'leader zoned in').not.toBeNull();
    expect(inviteeLr.zonedInAt, 'invitee zoned in').not.toBeNull();

    // Trade actually completed end-to-end on both sides.
    expect(tradeResults.leader, 'leader tradeWith result populated').toBeDefined();
    expect(tradeResults.invitee, 'invitee acceptIncomingTrade result populated').toBeDefined();
    expect(
      (tradeResults.leader as { completed: boolean; abortReason?: string } | undefined)?.completed,
      `leader trade did not complete: ${JSON.stringify(tradeResults.leader)}`,
    ).toBe(true);
    expect(
      (tradeResults.invitee as { completed: boolean; abortReason?: string } | undefined)?.completed,
      `invitee trade did not complete: ${JSON.stringify(tradeResults.invitee)}`,
    ).toBe(true);

    // Wire-level proof: TradeCompleteMessage arrived on both transcripts.
    expect(
      hasInbound(leaderLr.transcript, 'TradeCompleteMessage'),
      'leader received TradeCompleteMessage',
    ).toBe(true);
    expect(
      hasInbound(inviteeLr.transcript, 'TradeCompleteMessage'),
      'invitee received TradeCompleteMessage',
    ).toBe(true);

    // No server-side ErrorMessage on either side.
    expect(result.summary.clientsWithErrorMessage).toBe(0);
  }, 180_000);
});
