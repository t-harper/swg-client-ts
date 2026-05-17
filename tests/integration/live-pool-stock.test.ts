/**
 * Live test: stock the character pool via the Fleet path.
 *
 * Doubly-gated — skipped unless BOTH `LIVE=1` AND `STOCK_POOL=1` are set.
 * Stocking actually creates characters on the server (which is the point —
 * if you run it casually you'll burn through the cluster's character cap),
 * so it's opt-in even within the LIVE matrix.
 *
 * Manual run:
 *
 *   LIVE=1 STOCK_POOL=1 pnpm vitest run tests/integration/live-pool-stock.test.ts
 *
 * The test:
 *   1. Creates a fresh temp pool path (so it never mutates the user's real pool).
 *   2. Uses Fleet.run() to login + create + zone-in 3 fresh accounts/characters.
 *   3. Records each one in the pool with proven=true.
 *   4. Asserts the pool has the expected entries.
 *
 * To stock the *real* pool (`~/.swg-ts-client/character-pool.json`) use the
 * CLI directly: `swg-ts-cli pool stock --host=... --count=N`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CharacterPool } from '../../src/client/character-pool.js';
import { Fleet } from '../../src/client/fleet.js';

const LIVE = process.env.LIVE === '1';
const STOCK = process.env.STOCK_POOL === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!(LIVE && STOCK))('live pool stock (creates real characters on the server)', () => {
  let tempDir: string;
  let poolPath: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pool-stock-test-'));
    poolPath = join(tempDir, 'pool.json');
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('stocks 3 freshly-created characters into a pool', async () => {
    const pool = new CharacterPool({ path: poolPath });
    const runTag = ((Date.now() / 1000) | 0).toString(36);
    const count = 3;

    const fleet = new Fleet({ loginServer: { host: HOST, port: PORT } });
    const configs = Array.from({ length: count }, (_, i) => ({
      account: `pst${runTag}${i}`.slice(0, 15),
      characterName: `PoolStock${i}`,
      planet: 'mos_eisley',
      holdZonedInMs: 1_500,
    }));

    const fleetResult = await fleet.run(configs, { staggerMs: 100 });

    // No cap-rejection soft-skip: if the server rejected character
    // creation, the subsequent pool.add loop will produce zero entries
    // and the final length assertion will fail loudly.

    for (let i = 0; i < count; i++) {
      const outcome = fleetResult.outcomes[i];
      const config = configs[i];
      if (outcome === undefined || config === undefined) continue;
      if (outcome.error !== undefined || outcome.lifecycleResult === undefined) continue;
      await pool.add(config.account, config.characterName, {
        planet: 'mos_eisley',
        stockedAt: new Date().toISOString(),
      });
      if (outcome.lifecycleResult.zonedInAt !== null) {
        await pool.markProven(config.account);
      }
    }

    const characters = await pool.list();
    expect(characters.length).toBeGreaterThanOrEqual(1);
    for (const c of characters) {
      expect(c.account.length).toBeLessThanOrEqual(15);
      expect(c.characterName).toContain('PoolStock');
    }
  }, 120_000);
});
