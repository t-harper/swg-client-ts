/**
 * Live integration test: Commando combat behavior.
 *
 * Notes:
 *   - Commando's signature `co_hw_*` abilities require a GROUND_TARGETTING
 *     heavy weapon equipped (flame thrower / acid rifle / lightning rifle).
 *     Without one, the rotation falls back to `co_dm_8` / `co_ae_dm_3` /
 *     `attack` — still validates the framework path.
 *   - For full provisioning + kill validation, set:
 *       LIVE_COMBAT_REQUIRE_KILLS=1
 */
import { describe, it } from 'vitest';

import { runProfessionCombatTest } from './live-combat-profession-helper.js';

const LIVE = process.env.LIVE === '1';

describe.skipIf(!LIVE)('live combat / commando', () => {
  it('engages on aggro, runs rotation, survives 3 hostiles', async () => {
    await runProfessionCombatTest({ profession: 'commando', prefix: 'co' });
  }, 300_000);
});
