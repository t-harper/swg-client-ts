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
 * create one, then pin them).
 *
 * `prefix` should be 2–4 lowercase chars; the server caps account names
 * at 15 chars (MAX_ACCOUNT_NAME_LENGTH in CommonAPI.cpp).
 */

export interface LiveCredentials {
  account: string;
  characterName: string;
  /** True if these were reused from CI_REUSE_*; false if freshly generated. */
  reused: boolean;
}

export function liveCredentials(prefix: string): LiveCredentials {
  const reuseAcct = process.env.CI_REUSE_ACCOUNT;
  const reuseChar = process.env.CI_REUSE_CHARACTER;
  if (reuseAcct !== undefined && reuseAcct !== '' && reuseChar !== undefined && reuseChar !== '') {
    return { account: reuseAcct, characterName: reuseChar, reused: true };
  }
  return {
    account: `${prefix}${(Date.now() % 100_000_000).toString(36)}`,
    characterName: `Ts${prefix}${Date.now() % 1_000_000}`,
    reused: false,
  };
}

/**
 * For Stage-1-only tests (live-login) — returns just an account name.
 * Honors CI_REUSE_ACCOUNT; ignores CI_REUSE_CHARACTER.
 */
export function liveAccount(prefix: string): string {
  const reuseAcct = process.env.CI_REUSE_ACCOUNT;
  if (reuseAcct !== undefined && reuseAcct !== '') return reuseAcct;
  return `${prefix}${(Date.now() % 100_000_000).toString(36)}`;
}
