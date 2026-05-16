/**
 * Live integration test: character state must survive a logout/login cycle.
 *
 * Gated on `LIVE=1`. Runs two complete `fullLifecycle()` calls back-to-back
 * with a small settle window between, snapshots each, and asserts the
 * persistence-contract fields (character name, network id, bank/cash,
 * skill title, played time monotonic) survive the round-trip.
 *
 * The bigger picture: this is the only end-to-end test that exercises the
 * server's DB save/load pipeline. If the server fails to persist a field
 * across a logout, this test catches it; nothing else in the suite does.
 * `live-zone-in-and-logout.test.ts` validates the wire protocol but not
 * persistence; `live-baseline-decoder.test.ts` validates wire decoding but
 * not persistence either.
 *
 * Strongly prefers `CI_REUSE_ACCOUNT` + `CI_REUSE_CHARACTER` — a freshly
 * created character has a 0-second `playedTime`, no `skillTitle`, and an
 * uninitialized PLAY p1 (bank/cash both 0), which makes the diff less
 * informative. Pinning to a known character means the reconnect actually
 * tests persistence of *real* state.
 */

import { describe, expect, it } from 'vitest';

import { diffSnapshots, snapshot } from '../../src/client/snapshot.js';
import { SwgClient } from '../../src/client/swg-client.js';
import { liveCredentials } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live persistence (snapshot before/after reconnect)', () => {
  it('character state survives a logout+login cycle', async () => {
    const { account, characterName, reused } = liveCredentials('per');
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    // First lifecycle: zone in, dwell, log out. The server will persist
    // the post-zoned-in state during the logout/save pipeline.
    //
    // Graceful skip if the server has disabled character creation
    // (canCreateRegularCharacter=false — happens when the cluster hits
    // its max-characters cap from accumulated test leakage). If we don't
    // have a reused character to fall back to, the test can't run.
    let first: Awaited<ReturnType<typeof client.fullLifecycle>>;
    try {
      first = await client.fullLifecycle({
        account,
        characterName,
        planet: 'mos_eisley',
        holdZonedInMs: 3_000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('canCreateRegularCharacter=false') && !reused) {
        console.warn(
          '[live-persistence] Server rejected character creation and ' +
            'no CI_REUSE_* credentials set; skipping. Set ' +
            'CI_REUSE_ACCOUNT + CI_REUSE_CHARACTER for a more useful run.',
        );
        return;
      }
      throw err;
    }
    expect(first.zonedInAt, 'first lifecycle zoned in').not.toBeNull();
    const snapA = snapshot(first);

    // Wait for the server's save pipeline to flush AND for the prior
    // session's TCP/SOE state to release. The Windows client uses a 1s
    // settle, but on dev clusters under load the server can keep the
    // GameConnection around for ~10s after LogoutMessage before allowing
    // the same character to re-attach. 12s gives comfortable headroom.
    await new Promise((r) => setTimeout(r, 12_000));

    // Second lifecycle on the same character. The login flow re-reads from
    // DB; we snapshot what the server replays back to us.
    const second = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 3_000,
    });
    expect(second.zonedInAt, 'second lifecycle zoned in').not.toBeNull();
    const snapB = snapshot(second);

    // Field-level diff is informative even when the hash matches.
    const diff = diffSnapshots(snapA, snapB);
    console.log(
      `[live-persistence] hash_match=${snapA.hash === snapB.hash} diff_fields=`,
      diff.differences.map((d) => d.field),
    );
    console.log(
      `[live-persistence] snapA: name=${snapA.characterName} bank=${snapA.bankBalance} cash=${snapA.cashBalance} skillTitle=${snapA.skillTitle} playedTime=${snapA.playedTime} invCount=${snapA.inventory.length}`,
    );
    console.log(
      `[live-persistence] snapB: name=${snapB.characterName} bank=${snapB.bankBalance} cash=${snapB.cashBalance} skillTitle=${snapB.skillTitle} playedTime=${snapB.playedTime} invCount=${snapB.inventory.length}`,
    );

    // Hard-assert the fields that absolutely MUST be identical across
    // reconnects (the persistence contract). Inventory contents may shift
    // if items spawn/despawn around the player between runs, so we do
    // NOT hard-assert hash-equality.
    expect(snapB.characterName, 'characterName persists').toBe(snapA.characterName);
    expect(snapB.playerNetworkId, 'playerNetworkId persists').toBe(snapA.playerNetworkId);
    expect(snapB.bankBalance, 'bankBalance persists').toBe(snapA.bankBalance);
    expect(snapB.cashBalance, 'cashBalance persists').toBe(snapA.cashBalance);
    expect(snapB.skillTitle, 'skillTitle persists').toBe(snapA.skillTitle);
    // playedTime is monotonic (only ever increases). The second snapshot
    // should be >= the first because we held + connected for ~5s in-between.
    expect(snapB.playedTime ?? 0, 'playedTime monotonic').toBeGreaterThanOrEqual(
      snapA.playedTime ?? 0,
    );
  }, 120_000);
});
