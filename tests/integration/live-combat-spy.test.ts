/**
 * Live integration test: Spy combat behavior.
 *
 * Notes:
 *   - Spy's `sp_stealth_*_*` openers require active stealth state, which
 *     the framework can't reliably detect from the wire alone — the bundled
 *     rotation omits those and relies on `sp_assassins_mark` + `sp_hd_*`
 *     damage. Set `LIVE_COMBAT_REQUIRE_KILLS=1` to enforce full kills.
 */
import { describe, it } from 'vitest';

import { runProfessionCombatTest } from './live-combat-profession-helper.js';

const LIVE = process.env.LIVE === '1';

describe.skipIf(!LIVE)('live combat / spy', () => {
  it('engages on aggro, runs rotation, survives 3 hostiles', async () => {
    await runProfessionCombatTest({ profession: 'spy', prefix: 'sp' });
  }, 300_000);
});
