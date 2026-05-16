/**
 * Live integration test for the `groupTradeScenario` bundled scenario.
 *
 * Gated on `LIVE=1`. Drives a 2-client Fleet against the real `swg-server`:
 *   1. Stage 1+2 lookup of each character's NetworkId
 *   2. Stage 1→4 run with `groupTradeScenario` for both clients
 *
 * Asserts:
 *   - Both clients reach the zoned-in state cleanly
 *   - The invitee's transcript contains a `CM_setGroupInviter` ObjController
 *     (subtype 351) — proving the invite reached them
 *   - The leader's transcript contains a `CM_setGroup` ObjController
 *     (subtype 421) with a non-zero groupId — proving the group formed
 *   - Neither side received an ErrorMessage
 *
 * The trade-window step is best-effort; we do NOT assert it succeeds.
 *
 * Gracefully skips when the server has disabled character creation
 * (`canCreateRegularCharacter=false` — same fallback as live-fleet.test.ts).
 */

import { describe, expect, it } from 'vitest';

import { Fleet } from '../../src/client/fleet.js';
import { groupTradeScenario } from '../../src/scenarios/index.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live group-trade (2 clients, invite → accept → disband)', () => {
  it('forms a group between two characters and disbands cleanly', async () => {
    // Distinct accounts (server allows one session per account).
    const runTag = (Date.now() % 100_000_000).toString(36);
    const leaderAccount = `gtl${runTag}`.slice(0, 15);
    const inviteeAccount = `gti${runTag}`.slice(0, 15);
    const leaderCharacter = `GtLead${Date.now() % 1_000_000}`;
    const inviteeCharacter = `GtInv${Date.now() % 1_000_000}`;

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

    const blocked = lookup.summary.errorMessages.some((e) =>
      e.includes('canCreateRegularCharacter=false'),
    );
    if (blocked) {
      console.warn(
        '[live-group-trade] Server rejected character creation; skipping. ' +
          'Re-run after the cluster admin re-enables creation or after ' +
          'sweeping leaked test characters.',
      );
      return;
    }

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

    const phase2Blocked = result.summary.errorMessages.some((e) =>
      e.includes('canCreateRegularCharacter=false'),
    );
    if (phase2Blocked) {
      console.warn('[live-group-trade] Phase 2 blocked by character-creation cap; skipping.');
      return;
    }

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

    // The invitee must have received a CM_setGroupInviter (351) with a
    // non-empty inviter — that's the wire signature of "you got an invite".
    const inviteeSawInvite = inviteeLr.transcript.some((e) => {
      if (e.direction !== 'recv') return false;
      if (e.messageName !== 'ObjControllerMessage') return false;
      const dec = e.decoded as {
        message?: number;
        decodedSubtype?: { data?: { inviterId?: bigint } };
      } | null;
      return dec?.message === 351 && (dec.decodedSubtype?.data?.inviterId ?? 0n) !== 0n;
    });
    expect(inviteeSawInvite, 'invitee received CM_setGroupInviter with non-empty inviterId').toBe(
      true,
    );

    // Both sides must have received CM_setGroup (421) with non-zero groupId
    // — that's the wire signature of "group formed".
    const sawGroupAccept = (lr: typeof leaderLr): boolean =>
      lr.transcript.some((e) => {
        if (e.direction !== 'recv') return false;
        if (e.messageName !== 'ObjControllerMessage') return false;
        const dec = e.decoded as {
          message?: number;
          decodedSubtype?: { data?: { groupId?: bigint } };
        } | null;
        return dec?.message === 421 && (dec.decodedSubtype?.data?.groupId ?? 0n) !== 0n;
      });
    expect(sawGroupAccept(leaderLr), 'leader received CM_setGroup with non-zero groupId').toBe(
      true,
    );
    expect(sawGroupAccept(inviteeLr), 'invitee received CM_setGroup with non-zero groupId').toBe(
      true,
    );

    // Soft-assertion failures (from the scenario's own expectWithin
    // checks) should be empty.
    expect(leaderLr.scriptResult?.assertionFailures ?? []).toEqual([]);
    expect(inviteeLr.scriptResult?.assertionFailures ?? []).toEqual([]);
  }, 60_000);
});
