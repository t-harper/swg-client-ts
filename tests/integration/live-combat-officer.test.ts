/**
 * Live integration test: Officer combat behavior.
 *
 * Notes:
 *   - Officer's MELEE-only slots (`of_decapitate_*`, `of_vortex_*`,
 *     `of_leg_strike_*`) skip when a ranged weapon is equipped. PISTOL-only
 *     slots (`of_pistol_dm`, `of_pistol_bleed`) skip when melee. The combo
 *     is weapon-agnostic where possible and degrades gracefully. Set
 *     `LIVE_COMBAT_REQUIRE_KILLS=1` for full validation.
 */
import { describe, it } from 'vitest';

import { runProfessionCombatTest } from './live-combat-profession-helper.js';

const LIVE = process.env.LIVE === '1';

describe.skipIf(!LIVE)('live combat / officer', () => {
  it('engages on aggro, runs rotation, survives 3 hostiles', async () => {
    await runProfessionCombatTest({ profession: 'officer', prefix: 'of' });
  }, 300_000);
});
