/**
 * Live integration test: `ctx.character` reflects live server state.
 *
 * Gated on `LIVE=1`. Drives one full lifecycle and:
 *   - Asserts the basic character-sheet fields populate from the zone-in
 *     baseline flood: `ready=true`, `level >= 1`, `health.max > 0`,
 *     `posture === 'standing'` (Postures::Upright is the freshly-zoned
 *     state — `Postures.def:54`).
 *   - Sends `changePosture('prone')` and asserts `ctx.character.posture`
 *     flips to `'prone'` within a few seconds — exercises the CREO p3
 *     SHARED delta path (m_posture AutoDeltaVariable update). Then sends
 *     `changePosture('standing')` and asserts the inverse.
 *   - Confirms `cashBalance` / `bankBalance` read as numbers (the actual
 *     values are character-state-dependent for admin-pool characters).
 *
 * Why not test a money mutation: the `money deposit <oid> <amount>` server
 * console command moves cash → bank inside the same player; it does NOT
 * grant new credits. For a fresh admin-pool character with 0 cash, the
 * server returns "Invalid Container Transfer." (see
 * ConsoleCommandParserMoney.cpp:156-160). The posture round-trip is the
 * cheaper end-to-end smoke test for the live delta path that we control.
 *
 * Why prone (not crouched): the existing `Posture` type maps `'crouched' →
 * 'crouch'` (server command), but `crouch` isn't in `command_table.tab` —
 * only `kneel` (= the legacy alias) is registered server-side. That's a
 * pre-existing mapping bug to fix elsewhere; for this test we use `prone`
 * which is correctly registered.
 */
import { describe, expect, it } from 'vitest';

import { SwgClient } from '../../src/client/swg-client.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live character-sheet view', () => {
  it('populates from baselines, updates on a posture-change delta', async () => {
    const { account, characterName } = await liveCredentials('cs');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const observed = {
      readyAfterDwell: false,
      level: 0,
      healthMax: 0,
      healthCurrent: 0,
      bankBalance: 0,
      cashBalance: 0,
      skillTitle: null as string | null,
      postureInitial: 'unknown' as string,
      postureAfterProne: 'unknown' as string,
      postureAfterStand: 'unknown' as string,
    };

    const lifecycleResult = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: async (ctx) => {
        // 1. Let the baseline flood settle so CREO p1 / p3 / p6 land.
        await ctx.wait(3_000);

        observed.readyAfterDwell = ctx.character.ready;
        observed.level = ctx.character.level;
        observed.healthMax = ctx.character.health.max;
        observed.healthCurrent = ctx.character.health.current;
        observed.bankBalance = ctx.character.bankBalance;
        observed.cashBalance = ctx.character.cashBalance;
        observed.skillTitle = ctx.character.skillTitle;
        observed.postureInitial = ctx.character.posture;

        // 2. Trigger `prone` (a posture command that exists in the server's
        //    command_table.tab → fires `setPosture` cppHook → m_posture
        //    AutoDeltaVariable update + CM_setPosture ObjController broadcast).
        //    Use `prone` rather than `crouched` because the existing
        //    POSTURE_COMMAND mapping for `crouched` calls `crouch` which is
        //    not a registered command on the server side (only `kneel` is —
        //    the legacy alias — but that's a separate bug to fix elsewhere).
        ctx.changePosture('prone');
        const deadlineProne = Date.now() + 5_000;
        while (Date.now() < deadlineProne) {
          if (ctx.character.posture === 'prone') break;
          await ctx.wait(100);
        }
        observed.postureAfterProne = ctx.character.posture;

        // 3. Stand back up and confirm the delta path inverts.
        ctx.changePosture('standing');
        const deadlineStand = Date.now() + 5_000;
        while (Date.now() < deadlineStand) {
          if (ctx.character.posture === 'standing') break;
          await ctx.wait(100);
        }
        observed.postureAfterStand = ctx.character.posture;
      },
    });

    // Diagnostic: count baselines/deltas targeting the player so failures
    // surface whether the wire flood even existed.
    const playerOid = lifecycleResult.sceneStart?.playerNetworkId ?? 0n;
    let creoP3Baselines = 0;
    let creoP3Deltas = 0;
    for (const e of lifecycleResult.transcript) {
      if (e.direction !== 'recv') continue;
      const decoded = (e as { decoded?: unknown }).decoded;
      if (decoded === null || decoded === undefined) continue;
      const d = decoded as { target?: bigint; typeIdString?: string; packageId?: number };
      if (d.typeIdString === 'CREO' && d.packageId === 3 && d.target === playerOid) {
        if (e.messageName === 'BaselinesMessage') creoP3Baselines++;
        else if (e.messageName === 'DeltasMessage') creoP3Deltas++;
      }
    }
    console.log(
      `[live-character-sheet] CREO/p3 targeting player: baselines=${creoP3Baselines} deltas=${creoP3Deltas}`,
    );

    // Zone-in must succeed.
    expect(lifecycleResult.zonedInAt, 'zonedInAt present').not.toBeNull();
    expect(lifecycleResult.scriptResult?.error, 'script did not throw').toBeUndefined();

    // CharacterSheet sanity (these MUST hold for any admin-pool character).
    expect(observed.readyAfterDwell, 'character.ready true after dwell').toBe(true);
    expect(observed.level, 'level >= 1').toBeGreaterThanOrEqual(1);
    expect(observed.healthMax, 'health.max > 0 (CREO p1 maxAttributes landed)').toBeGreaterThan(0);
    expect(observed.healthCurrent, 'health.current > 0').toBeGreaterThan(0);
    // Standard fresh-zoned posture is Upright (display name 'standing').
    expect(observed.postureInitial, 'posture standing initially').toBe('standing');
    // Bank + cash are numbers (the specific values are character-dependent).
    expect(typeof observed.bankBalance).toBe('number');
    expect(typeof observed.cashBalance).toBe('number');

    // Posture round-trip — the load-bearing delta-path assertion.
    expect(observed.postureAfterProne, 'posture flipped to prone after delta').toBe('prone');
    expect(observed.postureAfterStand, 'posture flipped back to standing after delta').toBe(
      'standing',
    );

    console.log(
      `[live-character-sheet] level=${observed.level} ham=${observed.healthCurrent}/${observed.healthMax}` +
        ` posture=initial:${observed.postureInitial} prone:${observed.postureAfterProne} stand:${observed.postureAfterStand}` +
        ` bank=${observed.bankBalance} cash=${observed.cashBalance} skillTitle=${observed.skillTitle}`,
    );
  }, 60_000);
});
