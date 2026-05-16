/**
 * _lib.ts — shared argument-parsing + run helpers for the example scripts.
 *
 * Every script in this directory wires up:
 *   - common CLI flags (--host, --port, --user, --character, --minutes, ...)
 *   - either a single-client SwgClient.fullLifecycle() call, or
 *   - a Fleet.run() over N configs.
 *
 * This module is intentionally dependency-free aside from the public API
 * exported by `../../src/index.js`. Scripts import `parseCommonArgs`,
 * `runScenario`, `runFleet`, `formatJson`, `usage`, plus a few small helpers
 * (`durationMs`, `repeatUntil`, `nowSeconds`, `unique15`) that come up over
 * and over.
 */

import {
  Fleet,
  type FleetClientConfig,
  type FleetResult,
  type FleetRunOptions,
  type FullLifecycleOptions,
  type LifecycleResult,
  type ScenarioFn,
  SwgClient,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Common args
// ---------------------------------------------------------------------------

export interface CommonArgs {
  host: string;
  port: number;
  user: string;
  character: string;
  minutes: number;
  pretty: boolean;
  verbose: boolean;
  help: boolean;
  /** Trailing unparsed argv entries (anything not in --flag=value form). */
  rest: string[];
  /** Script-specific flag map for downstream parsing. */
  extra: Map<string, string>;
}

export interface CommonArgDefaults {
  host?: string;
  port?: number;
  user?: string;
  character?: string;
  /**
   * Default duration in minutes. Single-client scripts default to 5; Fleet
   * scripts typically use 1 to keep smoke runs short.
   */
  minutes?: number;
  pretty?: boolean;
  verbose?: boolean;
}

/**
 * Parse the shared subset of CLI flags. Anything not recognised here is
 * dropped into `extra` so the caller can pull script-specific values
 * (`args.extra.get('radius')`). `--help`/`-h` flips `args.help = true`;
 * caller is expected to print usage and exit 0.
 */
export function parseCommonArgs(argv: string[], defaults: CommonArgDefaults = {}): CommonArgs {
  const args: CommonArgs = {
    host: defaults.host ?? '10.254.0.253',
    port: defaults.port ?? 44453,
    user: defaults.user ?? '',
    character: defaults.character ?? '',
    minutes: defaults.minutes ?? 5,
    pretty: defaults.pretty ?? true,
    verbose: defaults.verbose ?? false,
    help: false,
    rest: [],
    extra: new Map<string, string>(),
  };
  for (const tok of argv) {
    if (tok === '--help' || tok === '-h') {
      args.help = true;
      continue;
    }
    if (!tok.startsWith('--')) {
      args.rest.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const key = eq < 0 ? tok.slice(2) : tok.slice(2, eq);
    const val = eq < 0 ? 'true' : tok.slice(eq + 1);
    switch (key) {
      case 'host':
        args.host = val;
        break;
      case 'port':
        args.port = Number.parseInt(val, 10);
        break;
      case 'user':
      case 'account':
        args.user = val;
        break;
      case 'character':
      case 'char':
        args.character = val;
        break;
      case 'minutes':
        args.minutes = Number.parseFloat(val);
        break;
      case 'verbose':
        args.verbose = val === 'true' || val === '';
        break;
      case 'no-pretty':
        args.pretty = false;
        break;
      case 'pretty':
        args.pretty = val !== 'false';
        break;
      default:
        args.extra.set(key, val);
        break;
    }
  }
  return args;
}

/** Common flag block for usage strings. */
export const COMMON_USAGE_LINES = [
  '  --host=HOST              login server host (default 10.254.0.253)',
  '  --port=PORT              login server port (default 44453)',
  '  --user=ACCOUNT           account name (15 char max)',
  '  --character=NAME         character name (created on first run)',
  '  --minutes=N              total scenario duration in minutes',
  '  --verbose                print per-tick progress to stderr',
  '  --no-pretty              compact JSON summary on stdout',
  '  --help, -h               show this help',
];

/**
 * Print a usage block to stderr and exit with the given code. Scripts call
 * this from their main() when args.help is true OR when required args are
 * missing.
 */
export function usage(scriptPath: string, headline: string, extraLines: string[] = []): void {
  const lines = [
    headline,
    '',
    `Usage: pnpm exec tsx ${scriptPath} [options]`,
    '',
    'Options:',
    ...COMMON_USAGE_LINES,
    ...extraLines,
    '',
  ];
  process.stderr.write(`${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Single-client runner
// ---------------------------------------------------------------------------

export interface ScenarioRunOptions {
  /** Override account if you've built it yourself (e.g. with a per-run suffix). */
  account?: string;
  /** Override character name. */
  characterName?: string;
  /** Cluster name. Optional; default = first cluster. */
  clusterName?: string;
  /** Starting city for character creation. Default 'mos_eisley'. */
  planet?: string;
  /** Profession on creation. Default 'combat_brawler'. */
  profession?: string;
  /**
   * If your scenario controls its own duration via `ctx.wait`, leave this
   * at the default of 0 — Stage 3 will return as soon as your script does.
   * Otherwise set this to whatever your fallback hold should be.
   */
  holdZonedInMs?: number;
}

export interface ScenarioSummary {
  ok: boolean;
  host: string;
  account: string;
  character: string;
  durationMs: number;
  zonedInAt: string | null;
  baselineObjectCount: number;
  sendsCount: number;
  scriptElapsedMs: number;
  didLogout: boolean;
  scriptError?: string;
  assertionFailures: string[];
  serverErrorMessage: boolean;
  stages: LifecycleResult['stages'];
  messageCounts: Record<string, { send: number; recv: number }>;
  /** Free-form per-script payload. */
  extra?: Record<string, unknown>;
}

/**
 * Wrap `new SwgClient(...).fullLifecycle(...)` and produce a stable JSON
 * summary. Returns the summary plus the raw LifecycleResult so callers can
 * pull extra data into `summary.extra` before printing.
 */
export async function runScenario(
  args: CommonArgs,
  scenario: ScenarioFn,
  runOpts: ScenarioRunOptions = {},
): Promise<{ summary: ScenarioSummary; lifecycle: LifecycleResult }> {
  const account = runOpts.account ?? args.user;
  const character = runOpts.characterName ?? args.character;
  if (account === '') throw new Error('--user is required (e.g. --user=ci-test)');
  if (character === '') throw new Error('--character is required (e.g. --character=TsTest)');

  const client = new SwgClient({
    loginServer: { host: args.host, port: args.port },
  });

  const lifecycleOpts: FullLifecycleOptions = {
    account,
    characterName: character,
    script: scenario,
    holdZonedInMs: runOpts.holdZonedInMs ?? 0,
  };
  if (runOpts.clusterName !== undefined) lifecycleOpts.clusterName = runOpts.clusterName;
  if (runOpts.planet !== undefined) lifecycleOpts.planet = runOpts.planet;
  if (runOpts.profession !== undefined) lifecycleOpts.profession = runOpts.profession;

  const startedAt = Date.now();
  let lifecycle: LifecycleResult;
  try {
    lifecycle = await client.fullLifecycle(lifecycleOpts);
  } catch (err) {
    const summary: ScenarioSummary = {
      ok: false,
      host: args.host,
      account,
      character,
      durationMs: Date.now() - startedAt,
      zonedInAt: null,
      baselineObjectCount: 0,
      sendsCount: 0,
      scriptElapsedMs: 0,
      didLogout: false,
      scriptError: err instanceof Error ? err.message : String(err),
      assertionFailures: [],
      serverErrorMessage: false,
      stages: { login: 0, connection: 0, game: null, logout: null },
      messageCounts: {},
    };
    return { summary, lifecycle: stubLifecycle() };
  }
  const elapsedMs = Date.now() - startedAt;

  const script = lifecycle.scriptResult;
  const summary: ScenarioSummary = {
    ok: script?.error === undefined && !lifecycle.receivedErrorMessage,
    host: args.host,
    account,
    character,
    durationMs: elapsedMs,
    zonedInAt: lifecycle.zonedInAt ? lifecycle.zonedInAt.toISOString() : null,
    baselineObjectCount: lifecycle.baselineObjectCount,
    sendsCount: script?.sendsCount ?? 0,
    scriptElapsedMs: script?.elapsedMs ?? 0,
    didLogout: script?.didLogout ?? false,
    assertionFailures: script?.assertionFailures ? [...script.assertionFailures] : [],
    serverErrorMessage: lifecycle.receivedErrorMessage,
    stages: lifecycle.stages,
    messageCounts: aggregateTranscript(lifecycle),
  };
  if (script?.error !== undefined) summary.scriptError = script.error;
  return { summary, lifecycle };
}

// ---------------------------------------------------------------------------
// Fleet runner
// ---------------------------------------------------------------------------

export interface FleetSummaryJson {
  ok: boolean;
  host: string;
  totalClients: number;
  succeeded: number;
  failed: number;
  totalElapsedMs: number;
  cumulativeElapsedMs: number;
  clientsWithErrorMessage: number;
  totalUpdateTransformsSent: number;
  messageCounts: Record<string, { sent: number; recv: number }>;
  errorMessages: string[];
  outcomes: Array<{
    account: string;
    character: string | undefined;
    ok: boolean;
    elapsedMs: number;
    sendsCount: number | null;
    error?: string;
  }>;
  extra?: Record<string, unknown>;
}

/**
 * Wrap `new Fleet({...}).run(...)` and produce a stable JSON summary.
 */
export async function runFleet(
  args: CommonArgs,
  configs: FleetClientConfig[],
  runOpts: FleetRunOptions = {},
): Promise<{ summary: FleetSummaryJson; result: FleetResult }> {
  const fleet = new Fleet({ loginServer: { host: args.host, port: args.port } });
  const result = await fleet.run(configs, runOpts);
  const summary: FleetSummaryJson = {
    ok: result.summary.failed === 0 && result.summary.clientsWithErrorMessage === 0,
    host: args.host,
    totalClients: result.summary.totalClients,
    succeeded: result.summary.succeeded,
    failed: result.summary.failed,
    totalElapsedMs: result.summary.totalElapsedMs,
    cumulativeElapsedMs: result.summary.cumulativeElapsedMs,
    clientsWithErrorMessage: result.summary.clientsWithErrorMessage,
    totalUpdateTransformsSent: result.summary.totalUpdateTransformsSent,
    messageCounts: Object.fromEntries(
      Object.entries(result.summary.messageCounts).map(([k, v]) => [
        k,
        { sent: v.sent, recv: v.recv },
      ]),
    ),
    errorMessages: result.summary.errorMessages,
    outcomes: result.outcomes.map((o) => {
      const out: FleetSummaryJson['outcomes'][number] = {
        account: o.config.account,
        character: o.config.characterName,
        ok: o.error === undefined,
        elapsedMs: o.elapsedMs,
        sendsCount: o.lifecycleResult?.scriptResult?.sendsCount ?? null,
      };
      if (o.error !== undefined) out.error = o.error.message;
      return out;
    }),
  };
  return { summary, result };
}

// ---------------------------------------------------------------------------
// JSON / helpers
// ---------------------------------------------------------------------------

/**
 * Pretty- or compact-format a JSON object, then trail with a newline so it
 * round-trips through `tee` / pipe consumers cleanly.
 */
export function formatJson(obj: unknown, pretty: boolean): string {
  const replacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);
  return `${pretty ? JSON.stringify(obj, replacer, 2) : JSON.stringify(obj, replacer)}\n`;
}

/** Convert a `--minutes` argument to milliseconds. */
export function durationMs(minutes: number): number {
  return Math.max(0, Math.round(minutes * 60_000));
}

/** Wall-clock seconds (integer). */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

/** Clamp a string to <= 15 chars (account-name max). */
export function unique15(prefix: string, suffix: string | number = ''): string {
  return `${prefix}${suffix}`.slice(0, 15);
}

/**
 * Repeat `body()` until either the abort signal fires or `untilMs` of
 * wall-clock time has elapsed. Body should run quickly OR call `ctx.wait()`
 * itself for its own pacing. Returns the iteration count actually run.
 */
export async function repeatUntil(
  signal: AbortSignal,
  untilMs: number,
  body: (iter: number) => Promise<void> | void,
  opts: { tickMs?: number } = {},
): Promise<number> {
  const deadline = Date.now() + untilMs;
  let iter = 0;
  const tickMs = Math.max(0, opts.tickMs ?? 0);
  while (Date.now() < deadline && !signal.aborted) {
    await Promise.resolve(body(iter));
    iter++;
    if (signal.aborted) break;
    if (Date.now() >= deadline) break;
    if (tickMs > 0) {
      await delay(Math.min(tickMs, deadline - Date.now()), signal);
    }
  }
  return iter;
}

/** Sleep `ms` with optional abort. Resolves on abort (does not reject). */
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    t.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Print a per-tick log line to stderr when verbose. */
export function makeLogger(label: string, verbose: boolean): (msg: string) => void {
  if (!verbose) return () => {};
  return (msg: string) => process.stderr.write(`[${label}] ${msg}\n`);
}

/** Aggregate a LifecycleResult's transcript into a name → {send, recv} map. */
export function aggregateTranscript(
  lr: LifecycleResult,
): Record<string, { send: number; recv: number }> {
  const out: Record<string, { send: number; recv: number }> = {};
  for (const ev of lr.transcript) {
    const bucket = out[ev.messageName] ?? { send: 0, recv: 0 };
    if (ev.direction === 'send') bucket.send++;
    else bucket.recv++;
    out[ev.messageName] = bucket;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function stubLifecycle(): LifecycleResult {
  return {
    stages: { login: 0, connection: 0, game: null, logout: null },
    clusters: [],
    chosenCluster: {
      id: 0,
      name: '?',
      timeZone: 0,
    },
    character: {
      networkId: 0n,
      name: '',
      objectTemplateId: 0,
      clusterId: 0,
      characterType: 1,
    } as LifecycleResult['character'],
    characterWasCreated: false,
    baselineObjectCount: 0,
    zonedInAt: null,
    logoutAt: null,
    transcript: [],
    stationId: 0,
    receivedErrorMessage: false,
  };
}
