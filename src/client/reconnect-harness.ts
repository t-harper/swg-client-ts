/**
 * reconnect-harness.ts — drive two full `SwgClient.fullLifecycle()` runs
 * back-to-back and assert that persistent character state survived the
 * round-trip.
 *
 * Flow:
 *   1. Connect, zone in, run the user-supplied `mutate` scenario
 *      (move waypoints, change posture, walk somewhere persistent, etc.)
 *   2. Snapshot first lifecycle's state via `snapshot()`
 *   3. Log out cleanly, wait `postSettleMs` for the server's DB save
 *      pipeline to land
 *   4. Reconnect to the SAME character on the SAME cluster, run the
 *      optional `observe` scenario (often a no-op that just gives the
 *      server time to re-replay baselines)
 *   5. Snapshot second lifecycle's state
 *   6. Diff the two snapshots and filter against `expectedDrift` —
 *      remaining entries are the "unexpected drift" that indicates a
 *      persistence regression.
 *
 * This is the production-grade companion to
 * `scripts/examples/reconnect-loop.ts` (which just loops without
 * snapshotting) and to `tests/integration/live-persistence.test.ts`
 * (which hard-codes one mutation scenario).
 */

import type { ServerEndpoint } from '../types.js';
import type { ScenarioFn } from './script/context.js';
import { type CharacterSnapshot, type SnapshotDiff, diffSnapshots, snapshot } from './snapshot.js';
import { type LifecycleResult, SwgClient } from './swg-client.js';

/**
 * Default `expectedDrift` keys. The server's `playedTime` is monotonically
 * increasing across sessions (it accumulates every dwell), so it can never
 * round-trip identical. Callers can pass additional keys via
 * `expectedDrift` — these defaults are merged in.
 *
 * Note: we intentionally do NOT default-allow `spawnPosition`/`spawnYaw` —
 * if the script walked the character somewhere, the second snapshot's
 * spawn position SHOULD match (that's the whole point of testing
 * persistence). Callers who don't care about position should add their
 * own entries.
 */
const DEFAULT_EXPECTED_DRIFT: ReadonlyArray<string | RegExp> = ['playedTime'];

export interface ReconnectHarnessOptions {
  loginServer: ServerEndpoint;
  account: string;
  password?: string;
  characterName: string;
  clusterName?: string;
  /** The mutation phase — runs after first zone-in, before snapshot. */
  mutate: ScenarioFn;
  /**
   * Optional second-pass scenario — runs after the reconnect zone-in,
   * before snapshot. Use this to walk back to the same coords for the
   * cleanest snapshot diff, or leave undefined for "passive observe".
   */
  observe?: ScenarioFn;
  /** How long to dwell after the mutation/observe scenario, ms. Default 2000. */
  postSettleMs?: number;
  /**
   * Keys allowed to differ between the two snapshots without failing
   * (e.g. server-side timers, last-login timestamp). The default list is
   * `['playedTime']` — `playedTime` is monotonic and increments every
   * session, so it can never match across reconnects. Strings match
   * field names exactly; regexes match field names via `.test()`. Custom
   * entries are MERGED with the defaults (not replaced).
   */
  expectedDrift?: ReadonlyArray<string | RegExp>;
  /**
   * Override the SwgClient hold-zoned-in window between the script
   * finishing and the LogoutMessage going out. Applied to both
   * lifecycles. Default: 1500ms (just enough for any final inbound
   * baselines to land after the script returns).
   */
  holdZonedInMs?: number;
  /**
   * Test-only seam. If provided, used in place of `new SwgClient(...)`.
   * Unit tests inject a mock to drive the harness through two crafted
   * `LifecycleResult` fixtures without needing real wire I/O.
   */
  clientFactory?: (loginServer: ServerEndpoint) => Pick<SwgClient, 'fullLifecycle'>;
}

export interface ReconnectHarnessResult {
  firstSnapshot: CharacterSnapshot;
  secondSnapshot: CharacterSnapshot;
  diff: SnapshotDiff;
  /** `diff.differences` minus anything matching `expectedDrift`. */
  unexpectedDrift: SnapshotDiff;
  /** `unexpectedDrift.differences.length === 0`. */
  succeeded: boolean;
  /** Wall-clock elapsed for each phase. */
  timings: { first: number; reconnect: number; total: number };
  /** Full per-pass lifecycle results so callers can inspect transcripts. */
  firstLifecycle: LifecycleResult;
  reconnectLifecycle: LifecycleResult;
}

function fieldMatchesDriftRule(field: string, rule: string | RegExp): boolean {
  if (typeof rule === 'string') return field === rule;
  return rule.test(field);
}

/**
 * Filter the raw `diffSnapshots` output against the allow-list. Anything
 * matching at least one rule in `allow` is removed; everything left is
 * an "unexpected" difference that should fail the harness.
 */
function filterDrift(diff: SnapshotDiff, allow: ReadonlyArray<string | RegExp>): SnapshotDiff {
  const kept = diff.differences.filter(
    (d) => !allow.some((r) => fieldMatchesDriftRule(d.field, r)),
  );
  return { identical: kept.length === 0, differences: kept };
}

const NOOP_SCENARIO: ScenarioFn = async () => undefined;

export async function reconnectVerify(
  opts: ReconnectHarnessOptions,
): Promise<ReconnectHarnessResult> {
  const postSettleMs = opts.postSettleMs ?? 2_000;
  const holdZonedInMs = opts.holdZonedInMs ?? 1_500;
  const expectedDrift = [...DEFAULT_EXPECTED_DRIFT, ...(opts.expectedDrift ?? [])];

  const factory =
    opts.clientFactory ?? ((endpoint: ServerEndpoint) => new SwgClient({ loginServer: endpoint }));

  const totalStart = Date.now();

  const firstClient = factory(opts.loginServer);
  const firstStart = Date.now();
  const firstLifecycle = await firstClient.fullLifecycle({
    account: opts.account,
    ...(opts.password !== undefined ? { password: opts.password } : {}),
    characterName: opts.characterName,
    ...(opts.clusterName !== undefined ? { clusterName: opts.clusterName } : {}),
    script: opts.mutate,
    holdZonedInMs,
  });
  const firstElapsed = Date.now() - firstStart;
  const firstSnapshot = snapshot(firstLifecycle);

  // Let the server's DB save pipeline land + the prior session's
  // GameConnection release before we try to re-attach as the same
  // character. The Windows client uses ~1s; live clusters under load
  // sometimes need 10s+ to release the old GameConnection.
  if (postSettleMs > 0) {
    await new Promise((r) => setTimeout(r, postSettleMs));
  }

  const reconnectClient = factory(opts.loginServer);
  const reconnectStart = Date.now();
  const reconnectLifecycle = await reconnectClient.fullLifecycle({
    account: opts.account,
    ...(opts.password !== undefined ? { password: opts.password } : {}),
    characterName: opts.characterName,
    ...(opts.clusterName !== undefined ? { clusterName: opts.clusterName } : {}),
    script: opts.observe ?? NOOP_SCENARIO,
    holdZonedInMs,
  });
  const reconnectElapsed = Date.now() - reconnectStart;
  const secondSnapshot = snapshot(reconnectLifecycle);

  const diff = diffSnapshots(firstSnapshot, secondSnapshot);
  const unexpectedDrift = filterDrift(diff, expectedDrift);

  return {
    firstSnapshot,
    secondSnapshot,
    diff,
    unexpectedDrift,
    succeeded: unexpectedDrift.identical,
    timings: {
      first: firstElapsed,
      reconnect: reconnectElapsed,
      total: Date.now() - totalStart,
    },
    firstLifecycle,
    reconnectLifecycle,
  };
}
