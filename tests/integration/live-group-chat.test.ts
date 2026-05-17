/**
 * Live integration test for `ctx.group` and `ctx.chat` against the real
 * `swg-server`.
 *
 * Two-client Fleet (mirrors live-group-trade.test.ts for the form-up
 * flow, then layers on `ctx.group` / `ctx.chat` assertions):
 *
 *   1. Lookup phase — Stage 1+2 to grab each character's NetworkId.
 *   2. Run phase:
 *      - Both    : admin-warp to a shared mos_eisley coord so they're
 *                  within the 100m default spatial-chat range. Admin-pool
 *                  characters retain their last logged-out positions and
 *                  can otherwise be 1000s of meters apart.
 *      - Leader  : disband stale state → invite invitee → wait for
 *                  group-formed wire delta → say "follow me everyone!"
 *                  → dwell → disband.
 *      - Invitee : disband stale state → arm `ctx.chat.onSay(...)` AND
 *                  `ctx.chat.onSystemMessage(...)` (the latter validates
 *                  the registration path even when nothing matches)
 *                  → wait for the m_groupInviter delta → useAbility('join')
 *                  → wait for own m_group delta → dwell → snapshot
 *                  `ctx.group.id` / `.members` / `.leader` →
 *                  useAbility('leaveGroup').
 *
 * Assertions:
 *   - Both sides received the wire-level m_group delta with non-zero groupId.
 *   - The invitee's `ctx.group.id !== null` while the group is live.
 *   - The invitee's `ctx.group.members[]` contains the leader's NetworkId.
 *   - The invitee's `onSay` handler fired for the leader's "follow me".
 *
 * Gated on `LIVE=1`. Same admin-pool pattern as live-group-trade.
 */

import { describe, expect, it } from 'vitest';

import { Fleet } from '../../src/client/fleet.js';
import {
  DeltasMessage,
  decodeGroupDelta,
  decodeGroupInviterDelta,
} from '../../src/messages/game/baselines/deltas-message.js';
import type { NetworkId } from '../../src/types.js';
import { liveCredentials } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live group + chat (2 clients, ctx.group + ctx.chat)', () => {
  it('forms a group, mirrors membership in ctx.group, and fires onSay on the invitee', async () => {
    const leader = await liveCredentials('gcl');
    const invitee = await liveCredentials('gci');
    // Drain prior-test logout settle window. The character pool's per-process
    // LRU map doesn't persist between `pnpm test` invocations, so back-to-back
    // runs reuse `tslive01`/`tslive02` and can collide with the server's
    // ~10-12s post-logout connection hold. Wait once up front.
    await new Promise((r) => setTimeout(r, 10_000));
    const leaderAccount = leader.account;
    const inviteeAccount = invitee.account;
    const leaderCharacter = leader.characterName;
    const inviteeCharacter = invitee.characterName;

    // Phase 1: lookup NetworkIds via Stage 1+2 only.
    const lookupFleet = new Fleet({ loginServer: { host: HOST, port: PORT } });
    const lookup = await lookupFleet.run(
      [
        {
          account: leaderAccount,
          characterName: leaderCharacter,
          planet: 'mos_eisley',
          skipGameStage: true,
        },
        {
          account: inviteeAccount,
          characterName: inviteeCharacter,
          planet: 'mos_eisley',
          skipGameStage: true,
        },
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

    // Per-client side-channels for assertions back in the test.
    const onSayCalls: Array<{ text: string; senderId: bigint | null; senderName: string }> = [];
    let inviteeGroupId: NetworkId | null = null;
    let inviteeGroupMembers: Array<{ id: bigint; name: string }> = [];
    let inviteeGroupSize = 0;
    let inviteeGroupLeaderName: string | null = null;

    // Phase 2: run the group-chat scenario for both clients. Same form-up
    // pattern as live-group-trade.test.ts (which is known-good).
    const fleet = new Fleet({ loginServer: { host: HOST, port: PORT } });
    const result = await fleet.run(
      [
        {
          account: leaderAccount,
          characterName: leaderCharacter,
          planet: 'mos_eisley',
          holdZonedInMs: 0,
          script: async (ctx) => {
            const selfId = ctx.sceneStart.playerNetworkId;
            // Admin-warp to a shared meet-up so we're within the default
            // 50m spatial-chat range with the invitee. Admin-pool
            // characters retain their last logout positions and can be
            // 1000s of meters apart otherwise. The warp command is
            // `planetwarp` → `admin_planetwarp` server-side; admin-pool
            // accounts (tslive*) are in stella_admin.tab.
            ctx.useAbility('planetwarp', undefined, 'tatooine 3528 5 -4804');
            ctx.setPose({ x: 3528, y: 5, z: -4804 }, 0);
            await ctx.wait(1_500);

            ctx.useAbility('disband');
            await ctx.wait(250);
            await ctx.wait(1_000);
            ctx.useAbility('invite', inviteeId);
            await ctx.expectWithin(DeltasMessage, 10_000, {
              predicate: (m) => {
                if (m.target !== selfId) return false;
                const d = decodeGroupDelta(m);
                return d !== null && d.groupId !== 0n;
              },
              soft: true,
            });

            // Brief settle, then broadcast spatial chat. The invitee's
            // ctx.chat.onSay handler should catch this — both clients
            // admin-warped to (3528, 5, -4804) at the start so they're
            // co-located.
            await ctx.wait(750);
            ctx.say('follow me everyone!');

            // Hold long enough for the invitee to snapshot ctx.group
            // BEFORE we disband. If the leader disbands first, the
            // server propagates m_group=0 to the invitee, which clears
            // ctx.character.groupId. The invitee's snapshot fires at
            // form-up + ~2.5s, so we hold for at least 4s.
            await ctx.wait(4_000);
            ctx.useAbility('disband');
            await ctx.wait(300);
          },
        },
        {
          account: inviteeAccount,
          characterName: inviteeCharacter,
          planet: 'mos_eisley',
          holdZonedInMs: 0,
          script: async (ctx) => {
            const selfId = ctx.sceneStart.playerNetworkId;
            // Admin-warp to the shared meet-up so we're within spatial
            // chat range with the leader.
            ctx.useAbility('planetwarp', undefined, 'tatooine 3528 5 -4804');
            ctx.setPose({ x: 3528, y: 5, z: -4804 }, 0);
            await ctx.wait(1_500);

            ctx.useAbility('decline');
            await ctx.wait(150);
            ctx.useAbility('disband');
            await ctx.wait(150);

            // Arm chat handlers BEFORE the leader speaks. Subscriptions
            // are detached automatically during runScript cleanup but
            // we explicitly unsubscribe at end-of-script to demonstrate
            // the lifetime.
            const unsubSay = ctx.chat.onSay(/follow me/i, (text, sender) => {
              onSayCalls.push({ text, senderId: sender.id, senderName: sender.name });
            });
            // Sanity-arm onSystemMessage on a never-matching regex to
            // verify the registration path doesn't throw.
            const unsubSys = ctx.chat.onSystemMessage(/__sentinel_never_matches__/, () => {
              // intentionally empty — used only for registration coverage
            });

            const invite = await ctx.expectWithin(DeltasMessage, 10_000, {
              predicate: (m) => {
                if (m.target !== selfId) return false;
                const d = decodeGroupInviterDelta(m);
                return d !== null && d.inviterId !== 0n;
              },
              soft: true,
            });
            if (invite !== undefined) {
              ctx.useAbility('join');
              await ctx.expectWithin(DeltasMessage, 10_000, {
                predicate: (m) => {
                  if (m.target !== selfId) return false;
                  const d = decodeGroupDelta(m);
                  return d !== null && d.groupId !== 0n;
                },
                soft: true,
              });
            }

            // Wait for the GroupObject SHARED_NP baseline to land AND for
            // the leader's "follow me" broadcast to round-trip. Both
            // happen post-group-formation; the leader's `await
            // ctx.wait(750)` + `ctx.say(...)` gives us ~750ms+chat-RTT
            // after the m_group delta we just awaited. The leader holds
            // for 5s before disbanding, so we have time.
            await ctx.wait(2_500);

            // Snapshot ctx.group + ctx.character for the post-run
            // assertions in the outer test scope.
            inviteeGroupId = ctx.group.id;
            inviteeGroupSize = ctx.group.size;
            inviteeGroupMembers = ctx.group.members.map((m) => ({ id: m.id, name: m.name }));
            inviteeGroupLeaderName = ctx.group.leader?.name ?? null;

            unsubSay();
            unsubSys();
            ctx.useAbility('leaveGroup');
            await ctx.wait(300);
          },
        },
      ],
      { staggerMs: 200 },
    );

    expect(
      result.summary.succeeded,
      `expected 2 successes; errors=${result.summary.errorMessages.join(' | ')}`,
    ).toBe(2);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.clientsWithErrorMessage).toBe(0);

    const leaderLr = result.outcomes[0]?.lifecycleResult;
    const inviteeLr = result.outcomes[1]?.lifecycleResult;
    expect(leaderLr).toBeDefined();
    expect(inviteeLr).toBeDefined();
    if (leaderLr === undefined || inviteeLr === undefined) return;

    expect(leaderLr.scriptResult?.assertionFailures ?? []).toEqual([]);
    expect(inviteeLr.scriptResult?.assertionFailures ?? []).toEqual([]);

    // Wire-level proofs: both sides received their own m_group delta.
    // Identical assertions to live-group-trade.test.ts.
    const sawGroupAccept = (lr: typeof leaderLr, selfId: bigint): boolean =>
      lr.transcript.some((e) => {
        if (e.direction !== 'recv') return false;
        if (!(e.decoded instanceof DeltasMessage)) return false;
        if (e.decoded.target !== selfId) return false;
        const d = decodeGroupDelta(e.decoded);
        return d !== null && d.groupId !== 0n;
      });
    expect(sawGroupAccept(leaderLr, leaderId), 'leader received m_group delta with non-zero groupId').toBe(true);
    expect(sawGroupAccept(inviteeLr, inviteeId), 'invitee received m_group delta with non-zero groupId').toBe(true);

    // `ctx.group` was populated for the invitee while the group was live.
    expect(inviteeGroupId, 'ctx.group.id populated on invitee').not.toBeNull();
    expect(inviteeGroupSize, 'ctx.group.size > 0 on invitee').toBeGreaterThan(0);
    expect(
      inviteeGroupMembers.some((m) => m.id === leaderId),
      `leader ${leaderId.toString(16)} present in invitee's ctx.group.members; got=${JSON.stringify(
        inviteeGroupMembers.map((m) => ({ id: m.id.toString(16), name: m.name })),
      )}`,
    ).toBe(true);
    expect(inviteeGroupLeaderName, 'invitee sees a leader name').not.toBeNull();

    // The `onSay` handler caught the leader's "follow me" — proves the
    // ctx.chat subscription fires from inbound CM_spatialChatReceive.
    const inviteeInboundChats = inviteeLr.transcript.filter(
      (e) =>
        e.direction === 'recv' &&
        e.messageName === 'ObjControllerMessage' &&
        'decoded' in e &&
        e.decoded !== null &&
        typeof e.decoded === 'object' &&
        (e.decoded as { message?: number }).message === 244 /* CM_spatialChatReceive */,
    ).length;
    const onSayCallsSerializable = onSayCalls.map((c) => ({
      text: c.text,
      senderName: c.senderName,
      senderId: c.senderId === null ? null : c.senderId.toString(16),
    }));
    expect(
      onSayCalls.some((c) => /follow me/i.test(c.text)),
      `onSay should have fired for "follow me"; got=${JSON.stringify(onSayCallsSerializable)}; invitee inbound CM_spatialChatReceive=${inviteeInboundChats}`,
    ).toBe(true);
  }, 120_000);
});
