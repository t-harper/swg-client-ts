/**
 * Fleet — orchestrate N independent `SwgClient`s in parallel.
 *
 * Each entry in the input array spawns its own `SwgClient` with its own UDP
 * sockets, account, character, and (optionally) script. Failures are isolated
 * per client (`Promise.allSettled`-style); one client's crash doesn't abort
 * the rest.
 *
 * Usage:
 *   const fleet = new Fleet({ loginServer: { host: '10.254.0.253', port: 44453 } });
 *   const result = await fleet.run([
 *     { account: 'fleet-a-1', characterName: 'AlphaA' },
 *     { account: 'fleet-a-2', characterName: 'AlphaB' },
 *     { account: 'fleet-a-3', characterName: 'AlphaC' },
 *   ], { staggerMs: 500, maxConcurrent: 10 });
 *
 *   // result.summary.totalClients === 3
 *   // result.summary.succeeded counts the ones whose lifecycle finished cleanly
 *   // result.outcomes[i] === { config, lifecycleResult? , error? , elapsedMs }
 *
 * Aggregated `summary` keeps overall stats compact: per-client transcripts
 * stay attached to each outcome (callers can opt to strip them) but the
 * summary reports per-message-name counts + max elapsed time, not the full
 * transcript bodies.
 */
import type { ServerEndpoint } from '../types.js';
import { type Knowledge, defaultKnowledge } from './knowledge.js';
import type { ScenarioFn } from './script/context.js';
import {
  type FullLifecycleOptions,
  type LifecycleResult,
  SwgClient,
  type SwgClientOptions,
} from './swg-client.js';

/**
 * Per-client configuration. Most fields mirror `FullLifecycleOptions` and
 * are forwarded unchanged.
 */
export interface FleetClientConfig {
  /** Account name. Required. Must be unique per simultaneous client (same-account
   *  concurrent logins are rejected server-side). */
  account: string;
  /** Character name (create if missing). */
  characterName?: string;
  /** Optional password (dev mode ignores). */
  password?: string;
  /** Cluster to attach to. Default: first cluster returned. */
  clusterName?: string;
  /** starting_locations.iff city key (NOT a planet name). Default: 'mos_eisley'. */
  planet?: string;
  /** Profession on character creation. Default: 'combat_brawler'. */
  profession?: string;
  /** How long to hold zoned-in before logout (ms). Default: SwgClient's 5_000. */
  holdZonedInMs?: number;
  /** Forwarded scripting hook. Forward-compatible with the scripting layer. */
  script?: ScenarioFn;
  /** If true, run Stages 1+2 only; skip zone-in/logout. */
  skipGameStage?: boolean;
}

export interface FleetOptions {
  /** Login server (every client uses the same one). */
  loginServer: ServerEndpoint;
  /**
   * Optional override factory — useful for tests. Default constructs a
   * fresh `SwgClient` per config.
   */
  clientFactory?: (opts: SwgClientOptions) => SwgClient;
  /**
   * Shared knowledge base — passed to every spawned `SwgClient` so all
   * fleet members read from the same process-wide cache (terrain templates,
   * STF strings, ...). Defaults to the module-level `defaultKnowledge`
   * singleton — the recommended choice for production fleets so the N
   * clients on the same planet parse `<planet>.trn` exactly once. Tests
   * inject a fresh instance for isolation.
   */
  knowledge?: Knowledge;
}

export interface FleetRunOptions {
  /** Max concurrent in-flight clients. Default: N (everyone parallel). */
  maxConcurrent?: number;
  /** Delay between successive client launches (ms). Default: 0. */
  staggerMs?: number;
}

export interface FleetOutcome {
  /** The config the client was launched with. */
  config: FleetClientConfig;
  /** Wall-clock duration for this client's `fullLifecycle()`. */
  elapsedMs: number;
  /** Present iff the run resolved successfully. */
  lifecycleResult?: LifecycleResult;
  /** Present iff the run threw. */
  error?: Error;
}

export interface FleetMessageCount {
  /** Number of messages of this name sent across all clients. */
  sent: number;
  /** Number of messages of this name received across all clients. */
  recv: number;
}

export interface FleetSummary {
  /** Total clients launched. */
  totalClients: number;
  /** Clients whose `fullLifecycle()` resolved without throwing. */
  succeeded: number;
  /** Clients whose `fullLifecycle()` threw. */
  failed: number;
  /** Max elapsed time across all clients (ms). The "wall clock" of the fleet. */
  totalElapsedMs: number;
  /** Sum of per-client elapsed ms (a proxy for "compute spent"). */
  cumulativeElapsedMs: number;
  /** Sum of UpdateTransformMessage sends across all successful clients. */
  totalUpdateTransformsSent: number;
  /** Per-message-name aggregate counts (sent + recv) across the fleet. */
  messageCounts: Record<string, FleetMessageCount>;
  /** Number of clients whose transcript contained an ErrorMessage. */
  clientsWithErrorMessage: number;
  /** Compact `error.message` list, in the order outcomes appear. */
  errorMessages: string[];
}

export interface FleetResult {
  outcomes: FleetOutcome[];
  summary: FleetSummary;
}

export class Fleet {
  private readonly loginServer: ServerEndpoint;
  private readonly clientFactory: (opts: SwgClientOptions) => SwgClient;
  private readonly knowledge: Knowledge;

  constructor(opts: FleetOptions) {
    this.loginServer = opts.loginServer;
    this.clientFactory = opts.clientFactory ?? ((o) => new SwgClient(o));
    this.knowledge = opts.knowledge ?? defaultKnowledge;
  }

  async run(configs: FleetClientConfig[], runOpts: FleetRunOptions = {}): Promise<FleetResult> {
    const total = configs.length;
    const maxConcurrent = Math.max(1, runOpts.maxConcurrent ?? (total || 1));
    const staggerMs = Math.max(0, runOpts.staggerMs ?? 0);

    // Each outcome slot is reserved by index so the result preserves input order
    // even with concurrent completion.
    const outcomes: FleetOutcome[] = new Array(total);

    // Pull-based worker pool: at most `maxConcurrent` runs in flight at once.
    // Each task index targets a launch time of `i * staggerMs` after start so
    // the overall ramp is deterministic even when workers complete out-of-order.
    let nextIndex = 0;
    const workers: Promise<void>[] = [];
    const workerCount = Math.min(maxConcurrent, total);
    const startedAt = Date.now();

    for (let w = 0; w < workerCount; w++) {
      workers.push(
        (async () => {
          while (true) {
            const i = nextIndex++;
            if (i >= total) return;
            const config = configs[i];
            if (config === undefined) return;

            if (staggerMs > 0 && i > 0) {
              const targetAt = startedAt + staggerMs * i;
              const waitMs = targetAt - Date.now();
              if (waitMs > 0) await delay(waitMs);
            }
            outcomes[i] = await this.runOne(config);
          }
        })(),
      );
    }

    await Promise.allSettled(workers);

    return {
      outcomes,
      summary: summarize(outcomes),
    };
  }

  private async runOne(config: FleetClientConfig): Promise<FleetOutcome> {
    const client = this.clientFactory({
      loginServer: this.loginServer,
      knowledge: this.knowledge,
    });
    const startedAt = Date.now();
    try {
      const lifecycleResult = await client.fullLifecycle(forwardToLifecycle(config));
      return {
        config,
        elapsedMs: Date.now() - startedAt,
        lifecycleResult,
      };
    } catch (err) {
      return {
        config,
        elapsedMs: Date.now() - startedAt,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }
}

/** Map FleetClientConfig → FullLifecycleOptions (just renames + dropping Fleet-internal fields). */
function forwardToLifecycle(config: FleetClientConfig): FullLifecycleOptions {
  const out: FullLifecycleOptions = { account: config.account };
  if (config.characterName !== undefined) out.characterName = config.characterName;
  if (config.password !== undefined) out.password = config.password;
  if (config.clusterName !== undefined) out.clusterName = config.clusterName;
  if (config.planet !== undefined) out.planet = config.planet;
  if (config.profession !== undefined) out.profession = config.profession;
  if (config.holdZonedInMs !== undefined) out.holdZonedInMs = config.holdZonedInMs;
  if (config.skipGameStage !== undefined) out.skipGameStage = config.skipGameStage;
  if (config.script !== undefined) out.script = config.script;
  return out;
}

function summarize(outcomes: FleetOutcome[]): FleetSummary {
  let succeeded = 0;
  let failed = 0;
  let totalElapsedMs = 0;
  let cumulativeElapsedMs = 0;
  let totalUpdateTransformsSent = 0;
  let clientsWithErrorMessage = 0;
  const messageCounts: Record<string, FleetMessageCount> = {};
  const errorMessages: string[] = [];

  for (const outcome of outcomes) {
    if (outcome === undefined) continue;
    cumulativeElapsedMs += outcome.elapsedMs;
    if (outcome.elapsedMs > totalElapsedMs) totalElapsedMs = outcome.elapsedMs;
    if (outcome.error !== undefined) {
      failed++;
      errorMessages.push(outcome.error.message);
      continue;
    }
    succeeded++;
    const lr = outcome.lifecycleResult;
    if (lr === undefined) continue;
    if (lr.receivedErrorMessage) clientsWithErrorMessage++;
    for (const event of lr.transcript) {
      const name = event.messageName;
      const bucket = messageCounts[name] ?? { sent: 0, recv: 0 };
      if (event.direction === 'send') {
        bucket.sent++;
        if (name === 'UpdateTransformMessage') totalUpdateTransformsSent++;
      } else {
        bucket.recv++;
      }
      messageCounts[name] = bucket;
    }
  }

  return {
    totalClients: outcomes.length,
    succeeded,
    failed,
    totalElapsedMs,
    cumulativeElapsedMs,
    totalUpdateTransformsSent,
    messageCounts,
    clientsWithErrorMessage,
    errorMessages,
  };
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
