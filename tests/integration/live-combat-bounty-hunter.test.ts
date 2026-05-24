/**
 * Live integration test: Bounty Hunter combat behavior.
 *
 * Spawns 3 hostile NPCs around an admin-pool character, installs the
 * Bounty Hunter rotation (`installCombatBehavior(ctx, { profession: 'bounty_hunter' })`),
 * aggros them, and asserts the framework engaged, fired at least one
 * rotation ability, kept the character alive, and ran without errors.
 *
 * Solo-multiple-NPCs is the aspirational requirement — gated by
 * `LIVE_COMBAT_REQUIRE_KILLS=1` for environments where the character has
 * been fully provisioned (skills + expertise + level 90 + equipped weapon —
 * pattern in `scripts/buff-bot.ts`).
 */
import { describe, it } from 'vitest';

import { runProfessionCombatTest } from './live-combat-profession-helper.js';

const LIVE = process.env.LIVE === '1';

describe.skipIf(!LIVE)('live combat / bounty hunter', () => {
  it('engages on aggro, runs rotation, survives 3 hostiles', async () => {
    await runProfessionCombatTest({ profession: 'bounty_hunter', prefix: 'bh' });
  }, 300_000);
});
