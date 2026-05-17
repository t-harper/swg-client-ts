/**
 * Live integration test for the `groupTradeScenario` bundled scenario.
 *
 * Gated on `LIVE=1`. Drives a 2-client Fleet against the real `swg-server`:
 *   1. Stage 1+2 lookup of each character's NetworkId
 *   2. Stage 1→4 run with `groupTradeScenario` for both clients
 *
 * Asserts:
 *   - Both clients reach the zoned-in state cleanly
 *   - The invitee's transcript contains a `DeltasMessage(target=inviteeId,
 *     CREO, SHARED_NP, idx=14)` whose payload decodes to a non-zero
 *     `inviterId` — proving the invite reached them at the wire level.
 *     (On a single-server cluster the server is authoritative for the
 *     invitee, so `setGroupInviter` writes the `m_groupInviter`
 *     AutoDeltaVariable directly — see CreatureObject.cpp:5655-5676. The
 *     `CM_setGroupInviter(351)` ObjController is cross-auth-server only and
 *     is NEVER emitted on a single-server cluster.)
 *   - Both sides' transcripts contain a `DeltasMessage(target=self, CREO,
 *     SHARED_NP, idx=13)` whose payload decodes to a non-zero `groupId` —
 *     proving the group formed. (Same authority story for `m_group` — see
 *     CreatureObject.cpp:5557.)
 *   - Neither side received an ErrorMessage
 *
 * The trade-window step is best-effort; we do NOT assert it succeeds.
 *
 * Gracefully skips when the server has disabled character creation
 * (`canCreateRegularCharacter=false` — same fallback as live-fleet.test.ts).
 */

import { describe, expect, it } from 'vitest';

import { Fleet } from '../../src/client/fleet.js';
import { DeltasMessage, decodeGroupDelta, decodeGroupInviterDelta } from '../../src/messages/game/baselines/deltas-message.js';
import { groupTradeScenario } from '../../src/scenarios/index.js';
import { liveCredentials } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live group-trade (2 clients, invite → accept → disband)', () => {
  it('forms a group between two characters and disbands cleanly', async () => {
    // Two distinct admin-pool accounts (tslive01..20). Fresh timestamp
    // accounts hit canCreateRegularCharacter=false and silently soft-skip.
    const leader = await liveCredentials('gtl');
    const invitee = await liveCredentials('gti');
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

    // Admin pool guarantees canCreateRegularCharacter=true (see helpers.ts).
    // Any creation failure here is a real server/wire regression.
    expect(
      lookup.summary.succeeded,
      `lookup phase failed: ${lookup.summary.errorMessages.join(' | ')}`,
    ).toBe(2);
    const leaderId = lookup.outcomes[0]?.lifecycleResult?.character.networkId;
    const inviteeId = lookup.outcomes[1]?.lifecycleResult?.character.networkId;
    expect(leaderId, 'leader NetworkId resolved').toBeDefined();
    expect(inviteeId, 'invitee NetworkId resolved').toBeDefined();
    if (leaderId === undefined || inviteeId === undefined) return;

    // Phase 2: run the group-trade scenario for both clients.
    const fleet = new Fleet({ loginServer: { host: HOST, port: PORT } });
    const result = await fleet.run(
      [
        {
          account: leaderAccount,
          characterName: leaderCharacter,
          planet: 'mos_eisley',
          holdZonedInMs: 0,
          script: groupTradeScenario({
            role: 'leader',
            otherId: `0x${inviteeId.toString(16)}`,
            waitForOtherMs: '10000',
            dwellMs: '500',
          }),
        },
        {
          account: inviteeAccount,
          characterName: inviteeCharacter,
          planet: 'mos_eisley',
          holdZonedInMs: 0,
          script: groupTradeScenario({
            role: 'invitee',
            otherId: `0x${leaderId.toString(16)}`,
            waitForOtherMs: '10000',
            dwellMs: '500',
          }),
        },
      ],
      { staggerMs: 200 },
    );

    // Both clients ran the lifecycle without thrown errors.
    expect(
      result.summary.succeeded,
      `expected 2 successes; errors=${result.summary.errorMessages.join(' | ')}`,
    ).toBe(2);
    expect(result.summary.failed).toBe(0);

    // Neither side received an ErrorMessage.
    expect(
      result.summary.clientsWithErrorMessage,
      'no client should have received a server ErrorMessage',
    ).toBe(0);

    // Walk each transcript to confirm the wire-level group flow happened.
    const leaderLr = result.outcomes[0]?.lifecycleResult;
    const inviteeLr = result.outcomes[1]?.lifecycleResult;
    expect(leaderLr).toBeDefined();
    expect(inviteeLr).toBeDefined();
    if (leaderLr === undefined || inviteeLr === undefined) return;

    // The invitee must have received a CREO SHARED_NP DeltasMessage on
    // their own NetworkId carrying the m_groupInviter (index 14) with a
    // non-zero inviterId. That's the wire signature of "you got an invite"
    // on a single-server cluster — the invite never travels as the
    // cross-server `CM_setGroupInviter(351)` ObjController. See the file
    // header for the C++ source pointer.
    const inviteeSawInvite = inviteeLr.transcript.some((e) => {
      if (e.direction !== 'recv') return false;
      if (!(e.decoded instanceof DeltasMessage)) return false;
      if (e.decoded.target !== inviteeId) return false;
      const decoded = decodeGroupInviterDelta(e.decoded);
      return decoded !== null && decoded.inviterId !== 0n;
    });
    expect(inviteeSawInvite, 'invitee received m_groupInviter delta with non-empty inviterId').toBe(
      true,
    );

    // Both sides must have received their own m_group delta (CREO
    // SHARED_NP, index 13) with a non-zero groupId — that's the wire
    // signature of "group formed". Same authority story as above:
    // `CM_setGroup(421)` is cross-server-only and never reaches us on a
    // single-server cluster.
    const sawGroupAccept = (lr: typeof leaderLr, selfId: bigint): boolean =>
      lr.transcript.some((e) => {
        if (e.direction !== 'recv') return false;
        if (!(e.decoded instanceof DeltasMessage)) return false;
        if (e.decoded.target !== selfId) return false;
        const decoded = decodeGroupDelta(e.decoded);
        return decoded !== null && decoded.groupId !== 0n;
      });
    expect(sawGroupAccept(leaderLr, leaderId), 'leader received m_group delta with non-zero groupId').toBe(
      true,
    );
    expect(sawGroupAccept(inviteeLr, inviteeId), 'invitee received m_group delta with non-zero groupId').toBe(
      true,
    );

    // Soft-assertion failures (from the scenario's own expectWithin
    // checks) should be empty.
    expect(leaderLr.scriptResult?.assertionFailures ?? []).toEqual([]);
    expect(inviteeLr.scriptResult?.assertionFailures ?? []).toEqual([]);
  }, 60_000);
});
