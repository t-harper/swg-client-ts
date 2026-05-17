/**
 * Shared helpers for live integration tests.
 *
 * By default each test generates a fresh timestamp-suffixed (account,
 * character) pair, which leaks rows into the SWG database (no cleanup
 * pass exists — see CLAUDE.md "Known limitations"). To avoid this in CI,
 * set both:
 *
 *   CI_REUSE_ACCOUNT=<existing-account>
 *   CI_REUSE_CHARACTER=<existing-character>
 *
 * The pair is then reused across every live test run. The character must
 * already exist on that account (run the suite once without these vars to
 * create one, then pin them). This mode pins ONE character, which only
 * works for tests that don't need multiple simultaneous accounts.
 *
 * For tests that DO want multiple distinct characters (e.g. live-fleet),
 * use `poolCredentials(prefix, count)` — it draws from the persistent
 * character pool at ~/.swg-ts-client/character-pool.json (populated via
 * `swg-ts-cli pool stock --count=N`). To activate pool-backed credentials
 * test-wide, set:
 *
 *   CI_USE_POOL=1
 *
 * When `CI_USE_POOL` is unset OR the pool is empty, `poolCredentials`
 * silently falls back to `liveCredentials(prefix)` (fresh per-run).
 *
 * `prefix` should be 2–4 lowercase chars; the server caps account names
 * at 15 chars (MAX_ACCOUNT_NAME_LENGTH in CommonAPI.cpp).
 */
import { CharacterPool } from '../../src/client/character-pool.js';

export interface LiveCredentials {
  account: string;
  characterName: string;
  /** True if these were reused from CI_REUSE_*; false if freshly generated. */
  reused: boolean;
}

/**
 * Pre-stocked admin-whitelisted accounts (tslive01..tslive20 in stella_admin.tab).
 * These are guaranteed `canCreateRegularCharacter=true` because they bypass the
 * cluster's player-limit/tutorial-limit checks via the `clientIsInternal` path
 * (LoginServer.cpp:946-950). Set `LIVE_ADMIN_POOL=0` to disable and fall back
 * to fresh timestamp-suffixed accounts.
 */
const ADMIN_POOL_PREFIX = 'tslive';
const ADMIN_POOL_SIZE = 20;
// Seed the cursor from PID so concurrent vitest worker processes don't all
// race on tslive01 — each worker gets a different starting offset.
let adminPoolCursor = process.pid % ADMIN_POOL_SIZE;

function nextAdminPoolAccount(): string {
  const idx = (adminPoolCursor++ % ADMIN_POOL_SIZE) + 1;
  return `${ADMIN_POOL_PREFIX}${idx.toString().padStart(2, '0')}`;
}

export function liveCredentials(prefix: string): LiveCredentials {
  const reuseAcct = process.env.CI_REUSE_ACCOUNT;
  const reuseChar = process.env.CI_REUSE_CHARACTER;
  if (reuseAcct !== undefined && reuseAcct !== '' && reuseChar !== undefined && reuseChar !== '') {
    return { account: reuseAcct, characterName: reuseChar, reused: true };
  }
  // Default to the admin-whitelisted account pool — fresh per-run accounts
  // would hit cluster player-limit gating which silently disables char creation.
  if (process.env.LIVE_ADMIN_POOL !== '0') {
    const account = nextAdminPoolAccount();
    return {
      account,
      characterName: `Ts${prefix}${Date.now() % 1_000_000}`,
      reused: false,
    };
  }
  return {
    account: `${prefix}${(Date.now() % 100_000_000).toString(36)}`,
    characterName: `Ts${prefix}${Date.now() % 1_000_000}`,
    reused: false,
  };
}

/**
 * Wait briefly to let any prior session on the SAME reuse character finish
 * tearing down server-side. Only meaningful in reuse mode — the server
 * holds a GameConnection open ~5-10s after LogoutMessage before allowing
 * the same character to re-attach.
 *
 * Tests that immediately call `client.fullLifecycle()` after another live
 * test on the pinned character should `await sessionSettle()` first.
 */
export async function sessionSettle(ms = 8_000): Promise<void> {
  if (process.env.CI_REUSE_ACCOUNT === undefined || process.env.CI_REUSE_ACCOUNT === '') return;
  await new Promise((r) => setTimeout(r, ms));
}


/**
 * For Stage-1-only tests (live-login) — returns just an account name.
 * Honors CI_REUSE_ACCOUNT; ignores CI_REUSE_CHARACTER.
 */
export function liveAccount(prefix: string): string {
  const reuseAcct = process.env.CI_REUSE_ACCOUNT;
  if (reuseAcct !== undefined && reuseAcct !== '') return reuseAcct;
  // Default to admin pool (see liveCredentials comment).
  if (process.env.LIVE_ADMIN_POOL !== '0') return nextAdminPoolAccount();
  return `${prefix}${(Date.now() % 100_000_000).toString(36)}`;
}

/** Shared singleton — one CharacterPool per process. */
const sharedPool = new CharacterPool();

export interface PoolCredentialsResult {
  credentials: Array<{ account: string; characterName: string }>;
  /** Release all leased characters. Call from `afterAll`. Idempotent. */
  release: () => Promise<void>;
}

/**
 * Check out `count` characters from the persistent pool.
 *
 * Behavior:
 *   - If `CI_USE_POOL=1` is set AND the pool has enough characters, leases
 *     `count` from the pool and returns their credentials.
 *   - Otherwise, falls back to `liveCredentials(prefix)` `count` times
 *     (fresh per-run accounts/characters). The returned `release()` is a
 *     no-op in fallback mode.
 *
 * Intended usage:
 *
 *   let creds: PoolCredentialsResult;
 *   beforeAll(async () => { creds = await poolCredentials('fl', 2); });
 *   afterAll(async () => { await creds.release(); });
 *
 *   it('runs two clients', async () => {
 *     const [a, b] = creds.credentials;
 *     // ...use a.account, a.characterName, b.account, b.characterName...
 *   });
 *
 * The lease duration is the pool default (10 minutes) — long enough for
 * any single test file's `vitest` timeout. If a test crashes without
 * calling `release()`, the lease expires automatically and a subsequent
 * `pool sweep` (or any `checkout`) reclaims it.
 */
export async function poolCredentials(prefix: string, count = 1): Promise<PoolCredentialsResult> {
  const usePool = process.env.CI_USE_POOL === '1';
  if (usePool) {
    try {
      const { characters, releaseAll } = await sharedPool.checkoutMany(count, {
        leasedBy: `pid-${process.pid}-${prefix}`,
      });
      return {
        credentials: characters.map((c) => ({
          account: c.account,
          characterName: c.characterName,
        })),
        release: releaseAll,
      };
    } catch (err) {
      // Pool was set but came up short. Fall through to per-run creds so
      // the test still runs — but log so the operator notices.
      // eslint-disable-next-line no-console
      console.warn(
        `[poolCredentials] CI_USE_POOL=1 but pool can't satisfy ${count} characters ` +
          `for '${prefix}' (${err instanceof Error ? err.message : String(err)}). ` +
          `Falling back to per-run creds. Try \`swg-ts-cli pool stock --count=${count}\`.`,
      );
    }
  }
  const credentials: Array<{ account: string; characterName: string }> = [];
  for (let i = 0; i < count; i++) {
    const { account, characterName } = liveCredentials(`${prefix}${i}`);
    credentials.push({ account, characterName });
  }
  return {
    credentials,
    release: async () => undefined,
  };
}
