/**
 * Unit tests for the CharacterPool check-out database.
 *
 * Pool storage uses a unique tmpdir path per test so we never touch the
 * user's real pool at `~/.swg-ts-client/character-pool.json`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CharacterPool } from './character-pool.js';

describe('CharacterPool', () => {
  let dir: string;
  let path: string;
  let pool: CharacterPool;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'character-pool-test-'));
    path = join(dir, 'pool.json');
    pool = new CharacterPool({ path, defaultLeaseMs: 60_000 });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts empty and `list()` returns []', async () => {
    expect(await pool.list()).toEqual([]);
  });

  it('add() is idempotent and merges metadata on re-add', async () => {
    const first = await pool.add('acct1', 'CharA', { planet: 'tatooine' });
    expect(first.account).toBe('acct1');
    expect(first.characterName).toBe('CharA');
    expect(first.proven).toBe(false);
    expect(first.metadata).toEqual({ planet: 'tatooine' });

    // Re-add with different metadata — should NOT create a duplicate.
    const second = await pool.add('acct1', 'CharA-renamed', { profession: 'medic' });
    const all = await pool.list();
    expect(all).toHaveLength(1);
    expect(second.characterName).toBe('CharA-renamed');
    expect(second.metadata).toEqual({ planet: 'tatooine', profession: 'medic' });
  });

  it('remove() removes and returns whether existed', async () => {
    await pool.add('acct1', 'CharA');
    expect(await pool.remove('acct1')).toBe(true);
    expect(await pool.list()).toEqual([]);
    expect(await pool.remove('nonexistent')).toBe(false);
  });

  it('checkout() returns a free character and sets the lease', async () => {
    await pool.add('acct1', 'CharA');
    const { character, release } = await pool.checkout({ leasedBy: 'test1' });

    expect(character.account).toBe('acct1');
    expect(character.characterName).toBe('CharA');

    // Pool now shows the lease.
    const listed = await pool.list();
    expect(listed[0]?.leasedBy).toBe('test1');
    expect(listed[0]?.leaseExpiresAt).not.toBeNull();

    await release();
    const cleared = await pool.list();
    expect(cleared[0]?.leasedBy).toBeNull();
    expect(cleared[0]?.leaseExpiresAt).toBeNull();
  });

  it('checkout() throws when the pool is empty', async () => {
    await expect(pool.checkout()).rejects.toThrow(/no characters available/);
  });

  it('checkout() throws when all characters are leased', async () => {
    await pool.add('acct1', 'CharA');
    const { release } = await pool.checkout({ leasedBy: 'first' });
    await expect(pool.checkout({ leasedBy: 'second' })).rejects.toThrow(/no characters available/);
    await release();
  });

  it('checkout() prefers proven characters', async () => {
    await pool.add('acct-unproven', 'CharU');
    await pool.add('acct-proven', 'CharP');
    await pool.markProven('acct-proven');

    const { character, release } = await pool.checkout();
    expect(character.account).toBe('acct-proven');
    await release();
  });

  it('checkout() with require filter only returns matching characters', async () => {
    await pool.add('acct1', 'CharA', { planet: 'tatooine' });
    await pool.add('acct2', 'CharB', { planet: 'naboo' });

    const { character, release } = await pool.checkout({
      require: (c) => c.metadata?.planet === 'naboo',
    });
    expect(character.account).toBe('acct2');
    await release();

    // After release, asking for tatooine-only also works.
    await pool.add('acct3', 'CharC', { planet: 'tatooine' });
    const { character: c2, release: r2 } = await pool.checkout({
      require: (c) => c.metadata?.planet === 'tatooine',
    });
    expect(['acct1', 'acct3']).toContain(c2.account);
    await r2();
  });

  it('release() only clears the lease if the holder still matches', async () => {
    await pool.add('acct1', 'CharA');
    // Manually checkout with a short lease, simulate expiry, let a second
    // checkout steal it, then verify the first release is a no-op.
    const shortPool = new CharacterPool({ path, defaultLeaseMs: 5 });
    const { release: firstRelease } = await shortPool.checkout({ leasedBy: 'holder-A' });
    // Wait until the lease has expired.
    await sleep(20);
    const stolen = await shortPool.checkout({ leasedBy: 'holder-B' });
    // Now the original release shouldn't clobber B's lease.
    await firstRelease();
    const list = await pool.list();
    expect(list[0]?.leasedBy).toBe('holder-B');
    await stolen.release();
  });

  it('checkoutMany(N) returns N distinct characters atomically', async () => {
    for (let i = 0; i < 5; i++) {
      await pool.add(`acct${i}`, `Char${i}`);
    }
    const { characters, releaseAll } = await pool.checkoutMany(3, { leasedBy: 'fleet' });
    expect(characters).toHaveLength(3);
    const accounts = new Set(characters.map((c) => c.account));
    expect(accounts.size).toBe(3);

    const listed = await pool.list();
    expect(listed.filter((c) => c.leasedBy === 'fleet')).toHaveLength(3);
    await releaseAll();
    const cleared = await pool.list();
    expect(cleared.filter((c) => c.leasedBy !== null)).toHaveLength(0);
  });

  it('checkoutMany() is all-or-nothing — throws and leaves no leases when insufficient', async () => {
    await pool.add('only', 'Solo');
    await expect(pool.checkoutMany(3)).rejects.toThrow(/can only satisfy/);
    const list = await pool.list();
    expect(list[0]?.leasedBy).toBeNull();
  });

  it('checkoutMany(0) is a no-op', async () => {
    await pool.add('acct1', 'CharA');
    const { characters, releaseAll } = await pool.checkoutMany(0);
    expect(characters).toHaveLength(0);
    await releaseAll();
  });

  it('sweepExpired() reclaims abandoned leases', async () => {
    await pool.add('acct1', 'CharA');
    const shortPool = new CharacterPool({ path, defaultLeaseMs: 5 });
    await shortPool.checkout({ leasedBy: 'short-lived' });
    await sleep(20);
    const reclaimed = await pool.sweepExpired();
    expect(reclaimed).toBe(1);
    const listed = await pool.list();
    expect(listed[0]?.leasedBy).toBeNull();
    expect(listed[0]?.leaseExpiresAt).toBeNull();
  });

  it('markProven() updates proven + lastSeenAt', async () => {
    await pool.add('acct1', 'CharA');
    const before = (await pool.list())[0];
    expect(before?.proven).toBe(false);
    expect(before?.lastSeenAt).toBeNull();

    await pool.markProven('acct1');
    const after = (await pool.list())[0];
    expect(after?.proven).toBe(true);
    expect(after?.lastSeenAt).toBeInstanceOf(Date);
  });

  it('markProven() throws if the account is unknown', async () => {
    await expect(pool.markProven('nonexistent')).rejects.toThrow(/not in pool/);
  });

  it('concurrent checkout() from two callers returns two different characters', async () => {
    await pool.add('acct1', 'CharA');
    await pool.add('acct2', 'CharB');

    const [a, b] = await Promise.all([
      pool.checkout({ leasedBy: 'a' }),
      pool.checkout({ leasedBy: 'b' }),
    ]);
    expect(a.character.account).not.toBe(b.character.account);

    await a.release();
    await b.release();
  });

  it('concurrent checkout() with only one free slot — one succeeds, one rejects', async () => {
    await pool.add('acct1', 'CharA');
    const results = await Promise.allSettled([
      pool.checkout({ leasedBy: 'a' }),
      pool.checkout({ leasedBy: 'b' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (fulfilled[0]?.status === 'fulfilled') {
      await fulfilled[0].value.release();
    }
  });

  it('survives across CharacterPool instances pointing at the same file', async () => {
    await pool.add('acct1', 'CharA', { foo: 'bar' });
    const other = new CharacterPool({ path });
    const list = await other.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.account).toBe('acct1');
    expect(list[0]?.metadata).toEqual({ foo: 'bar' });
  });

  it('creates parent directory if missing', async () => {
    const nested = join(dir, 'deep', 'nested', 'pool.json');
    const np = new CharacterPool({ path: nested });
    await np.add('acct1', 'CharA');
    const listed = await np.list();
    expect(listed).toHaveLength(1);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}
