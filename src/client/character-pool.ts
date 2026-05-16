/**
 * CharacterPool — a JSON-backed check-out database for pre-created accounts/characters.
 *
 * Live integration tests historically created fresh timestamp-suffixed accounts
 * and characters every run. That accumulates rows in the server DB and eventually
 * trips the cluster's per-station character cap (`canCreateRegularCharacter=false`).
 * The `CI_REUSE_*` env vars pin a single character, which breaks tests that need
 * multiple distinct accounts simultaneously (e.g. live-fleet).
 *
 * The pool fixes both problems: pre-create N characters once, then have tests
 * **check-out** one (or several) for the duration of a run and **check-in**
 * when finished. Concurrent tests pick up distinct characters automatically,
 * and there's no per-run leakage.
 *
 * Storage is a single JSON file (default `~/.swg-ts-client/character-pool.json`).
 * Mutations go through a lockfile so multiple processes can share the pool
 * safely. No SQLite — keep deps light.
 *
 * Usage:
 *   const pool = new CharacterPool();
 *   await pool.add('ci-test', 'TsTest', { planet: 'tatooine' });
 *   const { character, release } = await pool.checkout({ leasedBy: 'live-zone-test' });
 *   try {
 *     // ...run lifecycle against (character.account, character.characterName)...
 *     await pool.markProven(character.account);
 *   } finally {
 *     await release();
 *   }
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface PooledCharacter {
  account: string;
  characterName: string;
  /** When this character was last successfully used. */
  lastSeenAt: Date | null;
  /** Lease holder (free-form string — usually `${process.pid}-${test-id}` or 'manual'). */
  leasedBy: string | null;
  /** Lease expiration. After this passes the lease is considered abandoned and can be re-claimed. */
  leaseExpiresAt: Date | null;
  /** True if this character has ever zoned-in successfully against the canonical test server. */
  proven: boolean;
  /** Optional metadata (planet, profession, etc.). */
  metadata?: Record<string, string>;
}

export interface PoolOptions {
  /** Path to the JSON pool file. Default: `~/.swg-ts-client/character-pool.json`. */
  path?: string;
  /** Default lease duration in ms. Default 10 minutes. */
  defaultLeaseMs?: number;
}

export interface CheckoutOptions {
  /** Lease duration in ms. Default: pool's `defaultLeaseMs`. */
  leaseMs?: number;
  /** Free-form lease-holder string. Default: `pid-${process.pid}`. */
  leasedBy?: string;
  /** Optional filter — only consider characters where the predicate returns true. */
  require?: (c: PooledCharacter) => boolean;
}

export interface CheckoutResult {
  character: PooledCharacter;
  release: () => Promise<void>;
}

export interface CheckoutManyResult {
  characters: PooledCharacter[];
  releaseAll: () => Promise<void>;
}

const DEFAULT_LEASE_MS = 10 * 60 * 1000; // 10 minutes
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 50;
/** Lock file age past which we consider the holder dead and steal the lock. */
const LOCK_STALE_MS = 30_000;

/** On-disk schema for the pool JSON. */
interface PoolFile {
  version: 1;
  characters: PooledCharacterJson[];
}

interface PooledCharacterJson {
  account: string;
  characterName: string;
  lastSeenAt: string | null;
  leasedBy: string | null;
  leaseExpiresAt: string | null;
  proven: boolean;
  metadata?: Record<string, string>;
}

export class CharacterPool {
  private readonly path: string;
  private readonly lockPath: string;
  private readonly defaultLeaseMs: number;

  constructor(opts: PoolOptions = {}) {
    this.path = opts.path ?? join(homedir(), '.swg-ts-client', 'character-pool.json');
    this.lockPath = `${this.path}.lock`;
    this.defaultLeaseMs = opts.defaultLeaseMs ?? DEFAULT_LEASE_MS;
  }

  /** Where the pool JSON lives on disk. */
  get filePath(): string {
    return this.path;
  }

  /** Add a (account, characterName) pair. Idempotent — updates metadata if already present. */
  async add(
    account: string,
    characterName: string,
    metadata?: Record<string, string>,
  ): Promise<PooledCharacter> {
    return this.withLock(async () => {
      const file = await this.readFile();
      const existing = file.characters.find((c) => c.account === account);
      if (existing !== undefined) {
        // Idempotent: keep the original lease/proven state, but refresh
        // characterName + metadata so re-runs of `pool add` can tweak them.
        existing.characterName = characterName;
        if (metadata !== undefined) existing.metadata = { ...existing.metadata, ...metadata };
        await this.writeFile(file);
        return jsonToPooled(existing);
      }
      const entry: PooledCharacterJson = {
        account,
        characterName,
        lastSeenAt: null,
        leasedBy: null,
        leaseExpiresAt: null,
        proven: false,
        ...(metadata !== undefined ? { metadata: { ...metadata } } : {}),
      };
      file.characters.push(entry);
      await this.writeFile(file);
      return jsonToPooled(entry);
    });
  }

  /** Remove a character by account. Returns true if it existed. */
  async remove(account: string): Promise<boolean> {
    return this.withLock(async () => {
      const file = await this.readFile();
      const idx = file.characters.findIndex((c) => c.account === account);
      if (idx < 0) return false;
      file.characters.splice(idx, 1);
      await this.writeFile(file);
      return true;
    });
  }

  /** List all characters (snapshot). Does not sweep expired leases. */
  async list(): Promise<PooledCharacter[]> {
    // Read-only: skip the lock; readFile is atomic, and a concurrent writer
    // either lands before or after our read.
    try {
      const file = await this.readFile();
      return file.characters.map(jsonToPooled);
    } catch {
      return [];
    }
  }

  /**
   * Check out one available character. Sweeps expired leases first.
   *
   * Selection order:
   *   1. Free + proven characters (oldest `lastSeenAt` first — least recently used).
   *   2. Free + unproven.
   *   3. Currently expired (will be reclaimed; same proven-first rule).
   *
   * If `require` is supplied, only matching characters are considered.
   * Throws if nothing is available.
   */
  async checkout(opts: CheckoutOptions = {}): Promise<CheckoutResult> {
    const leaseMs = opts.leaseMs ?? this.defaultLeaseMs;
    const leasedBy = opts.leasedBy ?? `pid-${process.pid}`;
    const require = opts.require;

    const entry = await this.withLock(async () => {
      const file = await this.readFile();
      this.sweepInPlace(file);
      const chosen = pickCheckoutCandidate(file.characters, require);
      if (chosen === undefined) {
        throw new Error(
          `no characters available in pool ${this.path} (total=${file.characters.length}; try \`swg-ts-cli pool stock --count=N\`)`,
        );
      }
      chosen.leasedBy = leasedBy;
      chosen.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      await this.writeFile(file);
      return chosen;
    });

    const character = jsonToPooled(entry);
    const release = async (): Promise<void> => {
      await this.releaseInternal(character.account, leasedBy);
    };
    return { character, release };
  }

  /**
   * Check out N characters atomically (all or none). If fewer than `count` are
   * available, the call throws and no leases are taken.
   */
  async checkoutMany(
    count: number,
    opts: { leaseMs?: number; leasedBy?: string; require?: (c: PooledCharacter) => boolean } = {},
  ): Promise<CheckoutManyResult> {
    if (count <= 0) {
      return { characters: [], releaseAll: async () => undefined };
    }
    const leaseMs = opts.leaseMs ?? this.defaultLeaseMs;
    const leasedBy = opts.leasedBy ?? `pid-${process.pid}`;
    const require = opts.require;

    const claimed = await this.withLock(async () => {
      const file = await this.readFile();
      this.sweepInPlace(file);

      const picks: PooledCharacterJson[] = [];
      const taken = new Set<string>();
      for (let i = 0; i < count; i++) {
        const remaining = file.characters.filter(
          (c) => !taken.has(c.account) && isCheckoutable(c, require),
        );
        const chosen = pickFromList(remaining);
        if (chosen === undefined) {
          throw new Error(
            `pool ${this.path} can only satisfy ${i}/${count} characters ` +
              `(total=${file.characters.length}; try \`swg-ts-cli pool stock --count=${count - i}\`)`,
          );
        }
        picks.push(chosen);
        taken.add(chosen.account);
      }

      const expiresAt = new Date(Date.now() + leaseMs).toISOString();
      for (const p of picks) {
        p.leasedBy = leasedBy;
        p.leaseExpiresAt = expiresAt;
      }
      await this.writeFile(file);
      return picks;
    });

    const characters = claimed.map(jsonToPooled);
    const releaseAll = async (): Promise<void> => {
      // Release everything we took, even if some individual releases fail.
      const errors: Error[] = [];
      for (const c of characters) {
        try {
          await this.releaseInternal(c.account, leasedBy);
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
      if (errors.length > 0) {
        throw new Error(`releaseAll: ${errors.map((e) => e.message).join('; ')}`);
      }
    };
    return { characters, releaseAll };
  }

  /** Mark a character as proven (zoned-in successfully). Updates `lastSeenAt` too. */
  async markProven(account: string): Promise<void> {
    await this.withLock(async () => {
      const file = await this.readFile();
      const entry = file.characters.find((c) => c.account === account);
      if (entry === undefined) {
        throw new Error(`markProven: account ${account} not in pool ${this.path}`);
      }
      entry.proven = true;
      entry.lastSeenAt = new Date().toISOString();
      await this.writeFile(file);
    });
  }

  /** Sweep expired leases. Returns the number of characters reclaimed. */
  async sweepExpired(): Promise<number> {
    return this.withLock(async () => {
      const file = await this.readFile();
      const reclaimed = this.sweepInPlace(file);
      if (reclaimed > 0) await this.writeFile(file);
      return reclaimed;
    });
  }

  /**
   * Internal: release a specific lease. Only clears if the current holder
   * matches (so a stolen-after-expiry lease isn't accidentally clobbered).
   */
  private async releaseInternal(account: string, leasedBy: string): Promise<void> {
    await this.withLock(async () => {
      const file = await this.readFile();
      const entry = file.characters.find((c) => c.account === account);
      if (entry === undefined) return;
      // Only clear if WE are still the holder. If something else stole it
      // after our lease expired, leave the new holder alone.
      if (entry.leasedBy !== leasedBy) return;
      entry.leasedBy = null;
      entry.leaseExpiresAt = null;
      await this.writeFile(file);
    });
  }

  /** Mutates `file` to clear any expired leases. Returns the count. */
  private sweepInPlace(file: PoolFile): number {
    const now = Date.now();
    let count = 0;
    for (const entry of file.characters) {
      if (
        entry.leaseExpiresAt !== null &&
        Date.parse(entry.leaseExpiresAt) < now &&
        entry.leasedBy !== null
      ) {
        entry.leasedBy = null;
        entry.leaseExpiresAt = null;
        count++;
      }
    }
    return count;
  }

  /** Read the pool file; return an empty pool if missing. */
  private async readFile(): Promise<PoolFile> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as PoolFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.characters)) {
        throw new Error(`unexpected pool schema in ${this.path}`);
      }
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, characters: [] };
      }
      throw err;
    }
  }

  /** Atomic write: write to a temp sibling then rename. */
  private async writeFile(file: PoolFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    const body = `${JSON.stringify(file, null, 2)}\n`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, this.path);
  }

  /**
   * Cross-process lock via a separate `.lock` file. Uses `wx` exclusive open;
   * if contended, polls until the lock is freed OR considered stale.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.lockPath), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let acquired = false;
    while (!acquired) {
      try {
        await writeFile(this.lockPath, `${process.pid}\n`, { flag: 'wx' });
        acquired = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // Lock held by someone else. Steal it if stale; otherwise wait.
        if (await this.lockIsStale()) {
          try {
            await rm(this.lockPath, { force: true });
          } catch {
            // race with another stealer — fine, loop and retry
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`lock contention timeout (${this.lockPath})`);
        }
        await delay(LOCK_POLL_MS);
      }
    }
    try {
      return await fn();
    } finally {
      try {
        await rm(this.lockPath, { force: true });
      } catch {
        // best-effort
      }
    }
  }

  private async lockIsStale(): Promise<boolean> {
    try {
      const s = await stat(this.lockPath);
      return Date.now() - s.mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

function jsonToPooled(j: PooledCharacterJson): PooledCharacter {
  return {
    account: j.account,
    characterName: j.characterName,
    lastSeenAt: j.lastSeenAt === null ? null : new Date(j.lastSeenAt),
    leasedBy: j.leasedBy,
    leaseExpiresAt: j.leaseExpiresAt === null ? null : new Date(j.leaseExpiresAt),
    proven: j.proven,
    ...(j.metadata !== undefined ? { metadata: { ...j.metadata } } : {}),
  };
}

/** True if this entry is currently checkout-able (free + matching `require`). */
function isCheckoutable(
  c: PooledCharacterJson,
  require: ((p: PooledCharacter) => boolean) | undefined,
): boolean {
  if (c.leasedBy !== null) return false;
  if (require === undefined) return true;
  return require(jsonToPooled(c));
}

/** Pick one entry from a filtered list using the ordering rules. */
function pickFromList(candidates: PooledCharacterJson[]): PooledCharacterJson | undefined {
  if (candidates.length === 0) return undefined;
  // Proven > unproven; within each, oldest `lastSeenAt` first (null = never used = oldest).
  const sorted = [...candidates].sort((a, b) => {
    if (a.proven !== b.proven) return a.proven ? -1 : 1;
    const at = a.lastSeenAt === null ? 0 : Date.parse(a.lastSeenAt);
    const bt = b.lastSeenAt === null ? 0 : Date.parse(b.lastSeenAt);
    return at - bt;
  });
  return sorted[0];
}

function pickCheckoutCandidate(
  all: PooledCharacterJson[],
  require: ((p: PooledCharacter) => boolean) | undefined,
): PooledCharacterJson | undefined {
  const free = all.filter((c) => isCheckoutable(c, require));
  return pickFromList(free);
}
