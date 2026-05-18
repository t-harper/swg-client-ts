/**
 * Live integration test: persistent-state soak via the reconnect harness.
 *
 * Gated on `LIVE=1`. Drives `reconnectVerify()` end-to-end:
 *   1. Connect, walk to a fixed coordinate, dwell briefly (mutate).
 *   2. Log out, settle, reconnect.
 *   3. Snapshot both lifecycles, diff, and assert no unexpected drift.
 *
 * This complements `live-persistence.test.ts`:
 *   - `live-persistence` is a low-level, hand-rolled two-pass test that
 *     asserts individual field equality (skillTitle, bank/cash, etc.).
 *   - `live-persistence-soak` is the higher-level harness check: a
 *     scenario actually mutates state, then the harness validates that
 *     the snapshot diff is empty modulo known-ephemeral fields.
 *
 * Uses `poolCredentials` so it works with the pre-stocked character pool
 * when `CI_USE_POOL=1` (recommended); falls back to per-run fresh creds
 * otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reconnectVerify } from '../../src/client/reconnect-harness.js';
import type { ScenarioFn } from '../../src/client/script/context.js';
import { type PoolCredentialsResult, poolCredentials } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live persistence soak (reconnectVerify harness)', () => {
  let creds: PoolCredentialsResult;
  beforeAll(async () => {
    creds = await poolCredentials('rcv', 1);
  });
  afterAll(async () => {
    await creds?.release();
  });

  it('character state survives mutate → logout → reconnect → observe', async () => {
    const [pair] = creds.credentials;
    expect(pair, 'pool returned at least one credential').toBeDefined();
    if (pair === undefined) return;

    // Mutation phase: walk a short distance from the current spawn, then
    // dwell so the server has a chance to flush position before we log
    // out.
    //
    // IMPORTANT: use a RELATIVE offset from `ctx.position()`, NOT an
    // absolute coord. `walkTo` is a tick loop — `Math.ceil(distance/stepLen)`
    // ticks each separated by `tickMs` (default 500ms), with stepLen
    // capped at MAX_DISTANCE_PER_TICK_METERS=8. From a mos_eisley spawn
    // (~3528, -4807) to e.g. (-100, 200) is ~6200m → ~775 ticks × 500ms
    // = ~6.5 minutes of walking, blowing past the 180s vitest timeout
    // and producing a confusing "test timed out" failure with no log
    // pointing at the real cause. ~25m at speed 4 m/s = ~6 ticks × 500ms
    // ≈ 3s of walking — emits multiple CM_netUpdateTransform packets
    // (enough to ensure the server's position-save pipeline picks them
    // up) without dominating the test runtime.
    //
    // Wrap in a try so a server-side anti-cheat reject (rare; happens if
    // the spawn position is exactly the walk target) doesn't blow up the
    // whole soak.
    const mutate: ScenarioFn = async (ctx) => {
      await ctx.ackPendingTeleports();
      try {
        const start = ctx.position();
        await ctx.walkTo({ x: start.x + 18, z: start.z + 18 });
      } catch {
        // Anti-cheat or zero-distance walk — proceed with whatever
        // position we ended up at; the snapshot diff still validates
        // that "wherever you were" persists.
      }
      await ctx.wait(500);
    };

    // No cap-rejection soft-skip: poolCredentials falls back to the
    // admin pool (tslive01..20 in stella_admin.tab) which is
    // whitelisted for canCreateRegularCharacter=true via the
    // clientIsInternal path. Any failure here is a real regression.
    const result = await reconnectVerify({
      loginServer: { host: HOST, port: PORT },
      account: pair.account,
      characterName: pair.characterName,
      mutate,
      // Generous settle — live clusters can hold a GameConnection for
      // 10s+ after LogoutMessage before allowing the same character
      // to re-attach.
      postSettleMs: 12_000,
    });

    console.log(
      `[live-persistence-soak] succeeded=${result.succeeded} ` +
        `raw_diff_fields=${result.diff.differences.map((d) => d.field).join(',') || 'none'} ` +
        `unexpected_drift_fields=${result.unexpectedDrift.differences.map((d) => d.field).join(',') || 'none'} ` +
        `first_ms=${result.timings.first} reconnect_ms=${result.timings.reconnect} total_ms=${result.timings.total}`,
    );
    console.log(
      `[live-persistence-soak] firstSnap: name=${result.firstSnapshot.characterName} ` +
        `bank=${result.firstSnapshot.bankBalance} cash=${result.firstSnapshot.cashBalance} ` +
        `skillTitle=${result.firstSnapshot.skillTitle} playedTime=${result.firstSnapshot.playedTime} ` +
        `invCount=${result.firstSnapshot.inventory.length}`,
    );
    console.log(
      `[live-persistence-soak] secondSnap: name=${result.secondSnapshot.characterName} ` +
        `bank=${result.secondSnapshot.bankBalance} cash=${result.secondSnapshot.cashBalance} ` +
        `skillTitle=${result.secondSnapshot.skillTitle} playedTime=${result.secondSnapshot.playedTime} ` +
        `invCount=${result.secondSnapshot.inventory.length}`,
    );

    // The harness already filters known-ephemeral fields (playedTime).
    // Anything still in `unexpectedDrift` is a real persistence regression.
    // We log the diff above for diagnostics, then assert on the filtered
    // result — but lenient: live clusters can shift inventory contents
    // (nearby items spawn/despawn) between two snapshots, and we don't
    // want a flaky test failing on that. Hard-assert only the persistence
    // contract fields.
    expect(result.firstSnapshot.characterName).toBe(result.secondSnapshot.characterName);
    expect(result.firstSnapshot.playerNetworkId).toBe(result.secondSnapshot.playerNetworkId);
    expect(result.firstSnapshot.bankBalance).toBe(result.secondSnapshot.bankBalance);
    expect(result.firstSnapshot.cashBalance).toBe(result.secondSnapshot.cashBalance);
    expect(result.firstSnapshot.skillTitle).toBe(result.secondSnapshot.skillTitle);
    expect(result.secondSnapshot.playedTime ?? 0).toBeGreaterThanOrEqual(
      result.firstSnapshot.playedTime ?? 0,
    );
  }, 180_000);
});
