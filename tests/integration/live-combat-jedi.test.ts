/**
 * Live integration test: Jedi (Force Sensitive) combat behavior.
 *
 * Notes:
 *   - Most Jedi `fs_*` damage abilities require ALL_LIGHTSABERS or MELEE
 *     equipped. Without a saber, the rotation degrades to ranged force
 *     powers (`fs_dm_cc_*`, `fs_maelstrom_*`, `fs_ae_dm_cc_*`) + `attack`.
 *   - `fs_drain_*` is intentionally omitted from the bundled combo — it
 *     shares cooldown group `fs_sh` with the self-heal `fs_sh_3`, and we
 *     don't want the offensive ability to lock our heal.
 *   - For full provisioning + kill validation set `LIVE_COMBAT_REQUIRE_KILLS=1`.
 */
import { describe, it } from 'vitest';

import { runProfessionCombatTest } from './live-combat-profession-helper.js';

const LIVE = process.env.LIVE === '1';

describe.skipIf(!LIVE)('live combat / jedi', () => {
  it('engages on aggro, runs rotation, survives 3 hostiles', async () => {
    await runProfessionCombatTest({ profession: 'jedi', prefix: 'fs' });
  }, 300_000);
});
