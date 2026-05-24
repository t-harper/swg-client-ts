/**
 * Live integration test: Smuggler combat behavior.
 *
 * Notes:
 *   - The bundled rotation is the PISTOL build (most common). With a melee
 *     weapon equipped, `sm_*` PISTOL-gated slots skip and the rotation
 *     falls back to `attack`. For full provisioning + kill validation set
 *     `LIVE_COMBAT_REQUIRE_KILLS=1`.
 */
import { describe, it } from 'vitest';

import { runProfessionCombatTest } from './live-combat-profession-helper.js';

const LIVE = process.env.LIVE === '1';

describe.skipIf(!LIVE)('live combat / smuggler', () => {
  it('engages on aggro, runs rotation, survives 3 hostiles', async () => {
    await runProfessionCombatTest({ profession: 'smuggler', prefix: 'sm' });
  }, 300_000);
});
