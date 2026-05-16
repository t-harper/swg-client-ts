/**
 * Live integration test for Fleet multi-client orchestration.
 *
 * Gated on `LIVE=1`. Runs 2 concurrent clients against the real swg-server.
 *
 * Asserts:
 *   - Both clients reach CharacterSelected cleanly (skipGameStage to keep fast)
 *   - Per-outcome `lifecycleResult` populated
 *   - Aggregate `summary.succeeded === 2`
 *   - No ErrorMessage in either transcript
 *
 * Uses fresh timestamp-suffixed accounts so re-runs don't collide with
 * existing characters in the DB. Each client gets its own account (the
 * server rejects same-account concurrent logins).
 */
import { describe, expect, it } from 'vitest';

import { Fleet } from '../../src/client/fleet.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live fleet (2 concurrent clients, Stage 1 + 2 only)', () => {
  it('runs two clients in parallel and aggregates per-client outcomes', async () => {
    // Server caps account at MAX_ACCOUNT_NAME_LENGTH=15. Use shared compact
    // run tag + per-client suffix so we stay well under 15 chars.
    const runTag = (Date.now() % 100_000_000).toString(36);

    const fleet = new Fleet({ loginServer: { host: HOST, port: PORT } });
    const result = await fleet.run(
      [
        {
          account: `tsfl${runTag}a`,
          characterName: `TsFleetA${Date.now() % 1_000_000}`,
          planet: 'mos_eisley',
          skipGameStage: true,
        },
        {
          account: `tsfl${runTag}b`,
          characterName: `TsFleetB${Date.now() % 1_000_000}`,
          planet: 'mos_eisley',
          skipGameStage: true,
        },
      ],
      // Small stagger to spread out the simultaneous LoginServer hits a bit.
      { staggerMs: 100 },
    );

    // Both clients succeeded.
    expect(result.summary.totalClients).toBe(2);

    // Graceful skip when the server has disabled character creation
    // (canCreateRegularCharacter=false — happens when the cluster hits
    // its max-characters cap from accumulated test leakage). The test
    // can't synthesize fresh characters in this state; not a code bug.
    const blocked = result.summary.errorMessages.some((e) =>
      e.includes('canCreateRegularCharacter=false'),
    );
    if (blocked) {
      console.warn(
        '[live-fleet] Server rejected character creation; skipping. ' +
          'Re-run after the cluster admin re-enables creation or after ' +
          'sweeping leaked test characters.',
      );
      return;
    }

    expect(
      result.summary.succeeded,
      `expected 2 successes; errors=${result.summary.errorMessages.join(' | ')}`,
    ).toBe(2);
    expect(result.summary.failed).toBe(0);

    // Per-outcome lifecycle results populated.
    for (let i = 0; i < result.outcomes.length; i++) {
      const outcome = result.outcomes[i];
      expect(outcome, `outcome[${i}] present`).toBeDefined();
      if (outcome === undefined) continue;
      expect(outcome.error, `outcome[${i}] no error`).toBeUndefined();
      expect(outcome.lifecycleResult, `outcome[${i}] lifecycleResult present`).toBeDefined();
      const lr = outcome.lifecycleResult;
      if (lr === undefined) continue;

      // Cluster + character look sane.
      expect(lr.chosenCluster.name).toBe('swg');
      expect(lr.character.networkId).toBeTypeOf('bigint');
      expect(lr.character.networkId).not.toBe(0n);

      // Stage 3 was skipped.
      expect(lr.stages.game).toBeNull();
      expect(lr.zonedInAt).toBeNull();

      // ClientPermissionsMessage was received (== CharacterSelected was reached).
      const recvNames = lr.transcript
        .filter((e) => e.direction === 'recv')
        .map((e) => e.messageName);
      expect(recvNames).toContain('ClientPermissionsMessage');

      // No ErrorMessage in transcript.
      expect(lr.receivedErrorMessage).toBe(false);
    }

    // Per-client wall-clock should easily fit under the test timeout.
    expect(result.summary.totalElapsedMs).toBeLessThan(15_000);

    // Aggregated summary captures the standard handshake messages.
    expect(result.summary.messageCounts.LoginClientId?.sent ?? 0).toBeGreaterThanOrEqual(2);
    expect(result.summary.messageCounts.ClientPermissionsMessage?.recv ?? 0).toBeGreaterThanOrEqual(
      2,
    );

    expect(result.summary.clientsWithErrorMessage).toBe(0);
  }, 60_000);
});
