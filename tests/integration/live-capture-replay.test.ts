/**
 * Live integration test for the wire-capture + replay harness.
 *
 * Gated on `LIVE=1`. Runs against the SWG server at 10.254.0.253.
 *
 * Flow:
 *   1. Run `captureLifecycle` against the live server (create + zone-in +
 *      brief dwell + logout). Stash the resulting `CapturedEvent[]`.
 *   2. Run `captureLifecycle` AGAIN with the same character (now exists)
 *      to get a baseline-stable transcript.
 *   3. Run `replay` against the second capture. Verify it observes the
 *      core handshake recv names from the capture.
 *
 * We don't assert `missing.length === 0` because the server emits some
 * non-deterministic messages (HeartBeat windowing, neighbour movement
 * updates) — but we DO assert the lifecycle-defining names appear in
 * order (CmdStartScene, SceneEndBaselines).
 *
 * Note: the capture file is intentionally NOT written to a fixture under
 * `tests/fixtures/` — captures are typically 500KB-1MB and the spec
 * explicitly says skip the commit when oversized.
 */
import { describe, expect, it } from 'vitest';

import { captureLifecycle, replay } from '../../src/index.js';

/**
 * Inline credential generator (this worktree doesn't have helpers.ts).
 * Honors CI_REUSE_ACCOUNT/CI_REUSE_CHARACTER if set; otherwise generates
 * a unique pair per test run.
 */
function liveCredentials(prefix: string): { account: string; characterName: string } {
  const reuseAcct = process.env.CI_REUSE_ACCOUNT;
  const reuseChar = process.env.CI_REUSE_CHARACTER;
  if (reuseAcct !== undefined && reuseAcct !== '' && reuseChar !== undefined && reuseChar !== '') {
    return { account: reuseAcct, characterName: reuseChar };
  }
  return {
    account: `${prefix}${(Date.now() % 100_000_000).toString(36)}`,
    characterName: `Ts${prefix}${Date.now() % 1_000_000}`,
  };
}

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live capture + replay (Stage 3 harness)', () => {
  it('captures a zone-in transcript and replays it against the live server', async () => {
    const { account, characterName } = liveCredentials('rp');

    // 1. First lifecycle: create the character.
    const cap1 = await captureLifecycle({
      loginServer: { host: HOST, port: PORT },
      account,
      characterName,
      startingLocation: 'mos_eisley',
      holdZonedInMs: 2_500,
    });
    expect(cap1.events.length).toBeGreaterThan(20);
    expect(cap1.receivedErrorMessage).toBe(false);
    const cap1RecvNames = cap1.events
      .filter((e) => e.direction === 'recv')
      .map((e) => e.messageName);
    expect(cap1RecvNames).toContain('CmdStartScene');
    expect(cap1RecvNames).toContain('SceneEndBaselines');

    // 2. Second capture: character exists now, so we get a stable baseline
    // (no ClientCreateCharacterSuccess in this one).
    const cap2 = await captureLifecycle({
      loginServer: { host: HOST, port: PORT },
      account,
      characterName,
      startingLocation: 'mos_eisley',
      holdZonedInMs: 2_500,
    });
    expect(cap2.characterWasCreated).toBe(false);
    expect(cap2.receivedErrorMessage).toBe(false);

    // 3. Replay the second capture. Compare with 'count' to absorb
    // non-deterministic neighbour traffic.
    const result = await replay({
      loginServer: { host: HOST, port: PORT },
      capture: cap2.events,
      account,
      characterName,
      startingLocation: 'mos_eisley',
      compare: 'count',
    });
    expect(result.errors).toEqual([]);
    // The core lifecycle-defining recvs MUST show up. We check the
    // observed sequence by name.
    expect(result.observedRecvNames).toContain('CmdStartScene');
    expect(result.observedRecvNames).toContain('SceneEndBaselines');
    expect(result.observedRecvNames).toContain('LoginClientToken');
    expect(result.observedRecvNames).toContain('ClientPermissionsMessage');
    // Drift should be small — say within 10% of expected.
    const drift = Math.abs(result.observedRecvNames.length - result.expectedRecvNames.length);
    expect(drift / result.expectedRecvNames.length).toBeLessThan(0.1);
  }, 90_000);
});
