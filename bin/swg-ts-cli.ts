#!/usr/bin/env node
/**
 * swg-ts-cli — single-command verification of the full SWG lifecycle.
 *
 * Usage:
 *   swg-ts-cli zone  --host=10.254.0.253 [--port=44453] --user=ci-test
 *                    [--character=TsTest] [--planet=tatooine]
 *                    [--hold-ms=5000] [--verbose]
 *   swg-ts-cli swarm --host=10.254.0.253 [--port=44453] --count=3
 *                    [--user-prefix=fleet] [--stagger-ms=500]
 *                    [--max-concurrent=10] [--hold-ms=5000] [--skip-game]
 *
 * Emits the full LifecycleResult (zone) or aggregated FleetSummary (swarm)
 * as JSON on stdout. Exits 0 on success, non-zero on failure.
 */
import {
  CharacterPool,
  Fleet,
  type FleetClientConfig,
  type PooledCharacter,
  SwgClient,
  captureLifecycle,
  lifecycleResultToJSON,
  readTranscript,
  replay,
  writeTranscript,
} from '../src/index.js';
import type { CapturedEvent, TranscriptEvent } from '../src/index.js';
import { scenarios } from '../src/scenarios/index.js';

interface CliArgs {
  command: 'zone' | 'swarm' | 'capture' | 'replay' | 'pool' | 'help';
  host: string;
  port: number;
  user: string;
  password?: string;
  character?: string;
  cluster?: string;
  planet: string;
  profession: string;
  holdMs: number;
  verbose: boolean;
  pretty: boolean;
  skipGame: boolean;
  script?: string;
  scriptArgs: Record<string, string>;
  // swarm-only
  count: number;
  userPrefix: string;
  staggerMs: number;
  maxConcurrent: number;
  // capture/replay
  output?: string;
  input?: string;
  pacing: 'asFast' | 'asCaptured';
  compare: 'names' | 'count';
  // pool subcommand
  poolAction: 'list' | 'add' | 'remove' | 'stock' | 'checkout' | 'sweep' | 'help';
  poolAccount?: string;
  poolCharacter?: string;
  poolPath?: string;
  poolLeasedBy?: string;
  poolLeaseMs?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: 'help',
    host: '127.0.0.1',
    port: 44453,
    user: '',
    // starting_locations.iff city key (NOT a planet name like "tatooine")
    planet: 'mos_eisley',
    profession: 'combat_brawler',
    holdMs: 5_000,
    verbose: false,
    pretty: true,
    skipGame: false,
    scriptArgs: {},
    count: 1,
    userPrefix: 'fleet',
    staggerMs: 0,
    maxConcurrent: 0,
    pacing: 'asFast',
    compare: 'names',
    poolAction: 'help',
  };
  const positional: string[] = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const val = eq < 0 ? 'true' : a.slice(eq + 1);
      switch (key) {
        case 'host':
          args.host = val;
          break;
        case 'port':
          args.port = Number.parseInt(val, 10);
          break;
        case 'user':
          args.user = val;
          break;
        case 'password':
          args.password = val;
          break;
        case 'character':
          args.character = val;
          break;
        case 'cluster':
          args.cluster = val;
          break;
        case 'planet':
          args.planet = val;
          break;
        case 'profession':
          args.profession = val;
          break;
        case 'hold-ms':
          args.holdMs = Number.parseInt(val, 10);
          break;
        case 'verbose':
          args.verbose = val === 'true' || val === '';
          break;
        case 'no-pretty':
          args.pretty = false;
          break;
        case 'skip-game':
          args.skipGame = val === 'true' || val === '';
          break;
        case 'script':
          args.script = val;
          break;
        case 'script-arg': {
          const sep = val.indexOf('=');
          if (sep < 0) {
            process.stderr.write(`--script-arg expects key=value, got: ${val}\n`);
            process.exit(2);
          }
          args.scriptArgs[val.slice(0, sep)] = val.slice(sep + 1);
          break;
        }
        case 'count':
          args.count = Number.parseInt(val, 10);
          break;
        case 'user-prefix':
          args.userPrefix = val;
          break;
        case 'stagger-ms':
          args.staggerMs = Number.parseInt(val, 10);
          break;
        case 'max-concurrent':
          args.maxConcurrent = Number.parseInt(val, 10);
          break;
        case 'output':
          args.output = val;
          break;
        case 'input':
          args.input = val;
          break;
        case 'pacing':
          if (val !== 'asFast' && val !== 'asCaptured') {
            process.stderr.write(`--pacing must be 'asFast' or 'asCaptured' (got '${val}')\n`);
            process.exit(2);
          }
          args.pacing = val;
          break;
        case 'compare':
          if (val !== 'names' && val !== 'count') {
            process.stderr.write(`--compare must be 'names' or 'count' (got '${val}')\n`);
            process.exit(2);
          }
          args.compare = val;
          break;
        case 'account':
          args.poolAccount = val;
          break;
        case 'pool-path':
          args.poolPath = val;
          break;
        case 'leased-by':
          args.poolLeasedBy = val;
          break;
        case 'lease-ms':
          args.poolLeaseMs = Number.parseInt(val, 10);
          break;
        case 'help':
          args.command = 'help';
          break;
        default:
          process.stderr.write(`Unknown flag: --${key}\n`);
          process.exit(2);
      }
    } else {
      positional.push(a);
    }
  }
  const cmd = positional[0];
  if (
    cmd === 'zone' ||
    cmd === 'swarm' ||
    cmd === 'capture' ||
    cmd === 'replay' ||
    cmd === 'help'
  ) {
    args.command = cmd;
  } else if (cmd === 'pool') {
    args.command = 'pool';
    const sub = positional[1];
    if (
      sub === 'list' ||
      sub === 'add' ||
      sub === 'remove' ||
      sub === 'stock' ||
      sub === 'checkout' ||
      sub === 'sweep' ||
      sub === 'help'
    ) {
      args.poolAction = sub;
    } else if (sub === undefined) {
      args.poolAction = 'help';
    } else {
      process.stderr.write(`Unknown pool action: ${sub}\n`);
      process.exit(2);
    }
    // `--character=X` is reused for the pool sub-action's character argument.
    args.poolCharacter = args.character;
  } else if (positional.length === 0) {
    args.command = 'help';
  } else {
    process.stderr.write(`Unknown subcommand: ${positional[0]}\n`);
    process.exit(2);
  }
  return args;
}

function printHelp(): void {
  process.stderr.write(
    [
      'swg-ts-cli — headless SWG zone-in client',
      '',
      'Usage:',
      '  swg-ts-cli zone  --host=<host> [--port=44453] --user=<account>',
      '                   [--character=<name>] [--cluster=swg] [--planet=mos_eisley]',
      '                   [--profession=combat_brawler] [--hold-ms=5000]',
      '                   [--script=<name>] [--script-arg=k=v ...]',
      '                   [--verbose] [--no-pretty] [--skip-game]',
      '  swg-ts-cli swarm --host=<host> [--port=44453] --count=<N>',
      '                   [--user-prefix=fleet] [--stagger-ms=500]',
      '                   [--max-concurrent=10] [--hold-ms=5000]',
      '                   [--planet=mos_eisley] [--skip-game] [--verbose] [--no-pretty]',
      '  swg-ts-cli capture --host=<host> --user=<account> --character=<name>',
      '                     --output=<path>.ndjson [--hold-ms=5000] [--verbose]',
      '      Run a full lifecycle and write the wire transcript to <path>.ndjson.',
      '  swg-ts-cli replay --host=<host> --user=<account> --character=<name>',
      '                    --input=<path>.ndjson [--pacing=asFast|asCaptured]',
      '                    [--compare=names|count]',
      '      Load a captured NDJSON file, run a fresh lifecycle that replays the',
      '      captured sends, and compare observed inbound messages.',
      '      Exits 1 if any expected recv name is missing from the observed stream.',
      '  swg-ts-cli pool <action>',
      '      Manage the persistent character pool at ~/.swg-ts-client/character-pool.json',
      '      (override with --pool-path=<path>). Actions:',
      '        list                                       — show all pooled chars + lease state',
      '        add --account=X --character=Y              — add an existing char to the pool',
      '        remove --account=X                         — remove from the pool',
      '        stock --count=N --host=... [--user-prefix=pool]',
      '                                                   — create N new chars on the server + pool them',
      '        checkout [--leased-by=X] [--lease-ms=N]    — claim one char + print {account,...,leaseExpiresAt}',
      '        sweep                                      — clear expired leases',
      '  swg-ts-cli help',
      '',
      `Available scripts: ${Object.keys(scenarios).sort().join(', ')}`,
      '',
      'Examples:',
      '  swg-ts-cli zone --host=10.254.0.253 --user=ci-test',
      '  swg-ts-cli zone --host=10.254.0.253 --user=ci-test --character=TsTest --hold-ms=10000',
      '  swg-ts-cli zone --host=10.254.0.253 --user=ci-test --character=TsTest \\',
      '                  --script=walk-circle --script-arg=radius=8 --script-arg=durationMs=3000',
      '  swg-ts-cli swarm --host=10.254.0.253 --count=3 --user-prefix=fleet --stagger-ms=500',
      '  swg-ts-cli pool stock --host=10.254.0.253 --count=5 --user-prefix=pool',
      '  swg-ts-cli pool list',
      '  swg-ts-cli pool checkout --leased-by=manual --lease-ms=60000',
      '  swg-ts-cli pool sweep',
      '',
      'Exits 0 on success, 1 on failure. Always emits JSON on stdout.',
      '',
    ].join('\n'),
  );
}

async function runSwarm(args: CliArgs): Promise<number> {
  if (args.count <= 0) {
    process.stderr.write('--count must be a positive integer\n');
    return 2;
  }
  const fleet = new Fleet({ loginServer: { host: args.host, port: args.port } });

  // Stamp the prefix so re-runs don't collide on existing accounts/characters.
  // Account name capped server-side at 15 chars (MAX_ACCOUNT_NAME_LENGTH).
  const runTag = (Date.now() / 1000) | 0;
  const configs: FleetClientConfig[] = [];
  for (let i = 0; i < args.count; i++) {
    const account = `${args.userPrefix}${runTag.toString(36)}${i}`.slice(0, 15);
    const characterName = `Fleet${args.userPrefix}${i}`;
    configs.push({
      account,
      characterName,
      planet: args.planet === 'tatooine' ? 'mos_eisley' : args.planet,
      profession: args.profession,
      holdZonedInMs: args.holdMs,
      skipGameStage: args.skipGame,
    });
  }

  if (args.verbose) {
    process.stderr.write(
      `[swarm] launching ${args.count} clients (stagger=${args.staggerMs}ms, ` +
        `maxConcurrent=${args.maxConcurrent || 'unlimited'})\n`,
    );
  }

  const runOpts: { staggerMs?: number; maxConcurrent?: number } = {};
  if (args.staggerMs > 0) runOpts.staggerMs = args.staggerMs;
  if (args.maxConcurrent > 0) runOpts.maxConcurrent = args.maxConcurrent;

  try {
    const result = await fleet.run(configs, runOpts);

    // Don't dump per-client transcripts — they balloon fast. Just keep the
    // summary plus per-outcome status + (when present) error.
    const compact = {
      summary: result.summary,
      outcomes: result.outcomes.map((o) => ({
        account: o.config.account,
        characterName: o.config.characterName,
        elapsedMs: o.elapsedMs,
        ok: o.error === undefined,
        error: o.error?.message,
        baselineObjectCount: o.lifecycleResult?.baselineObjectCount,
        zonedInAt: o.lifecycleResult?.zonedInAt?.toISOString(),
      })),
    };
    process.stdout.write(
      args.pretty ? `${JSON.stringify(compact, null, 2)}\n` : `${JSON.stringify(compact)}\n`,
    );
    return result.summary.failed === 0 ? 0 : 1;
  } catch (err) {
    const errorReport = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    process.stdout.write(`${JSON.stringify(errorReport, null, 2)}\n`);
    return 1;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    printHelp();
    return 0;
  }
  if (args.command === 'swarm') {
    return runSwarm(args);
  }
  if (args.command === 'capture') {
    return runCapture(args);
  }
  if (args.command === 'replay') {
    return runReplay(args);
  }
  if (args.command === 'pool') {
    return runPool(args);
  }
  if (args.command !== 'zone') {
    printHelp();
    return 2;
  }
  if (args.user === '') {
    process.stderr.write('--user is required\n');
    return 2;
  }

  let scenarioFn: ReturnType<(typeof scenarios)[string]> | undefined;
  if (args.script !== undefined) {
    const factory = scenarios[args.script];
    if (factory === undefined) {
      process.stderr.write(
        `Unknown --script=${args.script}. Available: ${Object.keys(scenarios).sort().join(', ')}\n`,
      );
      return 2;
    }
    try {
      scenarioFn = factory(args.scriptArgs);
    } catch (err) {
      process.stderr.write(
        `Invalid --script-arg(s) for ${args.script}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }
  }

  const client = new SwgClient({
    loginServer: { host: args.host, port: args.port },
  });

  const transcriptStream: TranscriptEvent[] = [];
  let lastError: Error | null = null;
  try {
    const result = await client.fullLifecycle({
      account: args.user,
      password: args.password,
      ...(args.cluster !== undefined ? { clusterName: args.cluster } : {}),
      ...(args.character !== undefined ? { characterName: args.character } : {}),
      planet: args.planet,
      profession: args.profession,
      holdZonedInMs: args.holdMs,
      skipGameStage: args.skipGame,
      ...(scenarioFn !== undefined ? { script: scenarioFn } : {}),
      onTranscript: (event) => {
        transcriptStream.push(event);
        if (args.verbose) {
          process.stderr.write(
            `[${args.user}] ${event.direction} ${event.messageName} ${event.bytes}b\n`,
          );
        }
      },
      onStateChange: (state) => {
        if (args.verbose) {
          process.stderr.write(`[${args.user}] state -> ${state}\n`);
        }
      },
    });

    const normalized = lifecycleResultToJSON(result);
    process.stdout.write(
      args.pretty ? `${JSON.stringify(normalized, null, 2)}\n` : `${JSON.stringify(normalized)}\n`,
    );
    return 0;
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err));
    const errorReport = {
      ok: false,
      error: lastError.message,
      transcript: transcriptStream.map((e) =>
        e.direction === 'recv'
          ? {
              ...e,
              decoded: e.decoded === null ? null : summarizeDecoded(e.decoded),
            }
          : e,
      ),
    };
    process.stdout.write(`${JSON.stringify(errorReport, null, 2)}\n`);
    return 1;
  }
}

async function runCapture(args: CliArgs): Promise<number> {
  if (args.user === '') {
    process.stderr.write('--user is required\n');
    return 2;
  }
  if (args.output === undefined || args.output === '') {
    process.stderr.write('--output=<path>.ndjson is required for capture\n');
    return 2;
  }
  const events: CapturedEvent[] = [];
  try {
    const result = await captureLifecycle({
      loginServer: { host: args.host, port: args.port },
      account: args.user,
      ...(args.password !== undefined ? { password: args.password } : {}),
      ...(args.cluster !== undefined ? { clusterName: args.cluster } : {}),
      ...(args.character !== undefined ? { characterName: args.character } : {}),
      startingLocation: args.planet,
      profession: args.profession,
      holdZonedInMs: args.holdMs,
      onEvent: (ev) => {
        events.push(ev);
        if (args.verbose) {
          process.stderr.write(
            `[capture] ${ev.direction} ${ev.messageName} ${ev.payload.length}b\n`,
          );
        }
      },
    });
    await writeTranscript(result.events, args.output);
    const summary = {
      ok: true,
      output: args.output,
      eventCount: result.events.length,
      sendCount: result.events.filter((e) => e.direction === 'send').length,
      recvCount: result.events.filter((e) => e.direction === 'recv').length,
      character: { name: result.character.name, networkId: result.character.networkId.toString() },
      characterWasCreated: result.characterWasCreated,
      receivedErrorMessage: result.receivedErrorMessage,
      elapsedMs: result.elapsedMs,
    };
    process.stdout.write(
      args.pretty ? `${JSON.stringify(summary, null, 2)}\n` : `${JSON.stringify(summary)}\n`,
    );
    return 0;
  } catch (err) {
    const errReport = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      partialEventCount: events.length,
    };
    process.stdout.write(`${JSON.stringify(errReport, null, 2)}\n`);
    return 1;
  }
}

async function runReplay(args: CliArgs): Promise<number> {
  if (args.user === '') {
    process.stderr.write('--user is required\n');
    return 2;
  }
  if (args.input === undefined || args.input === '') {
    process.stderr.write('--input=<path>.ndjson is required for replay\n');
    return 2;
  }
  let capture: CapturedEvent[];
  try {
    capture = await readTranscript(args.input);
  } catch (err) {
    process.stderr.write(
      `failed to load ${args.input}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  try {
    const result = await replay({
      loginServer: { host: args.host, port: args.port },
      capture,
      pacing: args.pacing,
      compare: args.compare,
      account: args.user,
      ...(args.password !== undefined ? { password: args.password } : {}),
      ...(args.cluster !== undefined ? { clusterName: args.cluster } : {}),
      ...(args.character !== undefined ? { characterName: args.character } : {}),
      startingLocation: args.planet,
      profession: args.profession,
    });
    const out = {
      succeeded: result.succeeded,
      expectedRecvCount: result.expectedRecvNames.length,
      observedRecvCount: result.observedRecvNames.length,
      missing: result.missing,
      unexpected: result.unexpected,
      errors: result.errors,
      replayedSendNames: result.replayedSendNames,
      expectedRecvNames: result.expectedRecvNames,
      observedRecvNames: result.observedRecvNames,
    };
    process.stdout.write(
      args.pretty ? `${JSON.stringify(out, null, 2)}\n` : `${JSON.stringify(out)}\n`,
    );
    return result.missing.length === 0 ? 0 : 1;
  } catch (err) {
    const errReport = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    process.stdout.write(`${JSON.stringify(errReport, null, 2)}\n`);
    return 1;
  }
}

async function runPool(args: CliArgs): Promise<number> {
  const poolOpts: { path?: string } = {};
  if (args.poolPath !== undefined) poolOpts.path = args.poolPath;
  const pool = new CharacterPool(poolOpts);

  switch (args.poolAction) {
    case 'list': {
      const characters = await pool.list();
      writeJson(args, {
        path: pool.filePath,
        count: characters.length,
        characters: characters.map(pooledToJson),
      });
      return 0;
    }
    case 'add': {
      if (args.poolAccount === undefined || args.poolCharacter === undefined) {
        process.stderr.write('pool add: --account and --character are required\n');
        return 2;
      }
      const metadata: Record<string, string> = {};
      if (args.planet) metadata.planet = args.planet;
      if (args.profession) metadata.profession = args.profession;
      const added = await pool.add(args.poolAccount, args.poolCharacter, metadata);
      writeJson(args, { ok: true, character: pooledToJson(added) });
      return 0;
    }
    case 'remove': {
      if (args.poolAccount === undefined) {
        process.stderr.write('pool remove: --account is required\n');
        return 2;
      }
      const removed = await pool.remove(args.poolAccount);
      writeJson(args, { ok: true, removed });
      return removed ? 0 : 1;
    }
    case 'stock': {
      return runPoolStock(args, pool);
    }
    case 'checkout': {
      const opts: { leasedBy?: string; leaseMs?: number } = {};
      if (args.poolLeasedBy !== undefined) opts.leasedBy = args.poolLeasedBy;
      if (args.poolLeaseMs !== undefined && !Number.isNaN(args.poolLeaseMs)) {
        opts.leaseMs = args.poolLeaseMs;
      }
      try {
        const { character } = await pool.checkout(opts);
        writeJson(args, {
          ok: true,
          account: character.account,
          characterName: character.characterName,
          leasedBy: character.leasedBy,
          leaseExpiresAt: character.leaseExpiresAt?.toISOString() ?? null,
          warning:
            'lease will expire automatically; CLI does not auto-release. ' +
            'Re-run `pool sweep` to reclaim if the caller never releases.',
        });
        return 0;
      } catch (err) {
        writeJson(args, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return 1;
      }
    }
    case 'sweep': {
      const reclaimed = await pool.sweepExpired();
      writeJson(args, { ok: true, reclaimed });
      return 0;
    }
    default: {
      printHelp();
      return 0;
    }
  }
}

async function runPoolStock(args: CliArgs, pool: CharacterPool): Promise<number> {
  if (args.count <= 0) {
    process.stderr.write('pool stock: --count must be a positive integer\n');
    return 2;
  }
  if (args.host === '127.0.0.1') {
    process.stderr.write(
      'pool stock: --host is required (e.g. --host=10.254.0.253 — the test cluster)\n',
    );
    return 2;
  }
  const prefix = args.userPrefix === 'fleet' ? 'pool' : args.userPrefix;
  const runTag = ((Date.now() / 1000) | 0).toString(36);
  const fleet = new Fleet({ loginServer: { host: args.host, port: args.port } });

  const configs: FleetClientConfig[] = [];
  for (let i = 0; i < args.count; i++) {
    const account = `${prefix}${runTag}${i}`.slice(0, 15);
    const characterName = `Pool${prefix}${i}`;
    configs.push({
      account,
      characterName,
      planet: args.planet === 'tatooine' ? 'mos_eisley' : args.planet,
      profession: args.profession,
      // Keep dwell short — we just need the character to zone-in once so we
      // can mark it proven, then log out cleanly.
      holdZonedInMs: 1_500,
    });
  }

  if (args.verbose) {
    process.stderr.write(`[pool stock] creating ${args.count} characters on ${args.host}\n`);
  }

  const runOpts: { staggerMs?: number; maxConcurrent?: number } = {};
  if (args.staggerMs > 0) runOpts.staggerMs = args.staggerMs;
  if (args.maxConcurrent > 0) runOpts.maxConcurrent = args.maxConcurrent;

  const fleetResult = await fleet.run(configs, runOpts);

  // Register every successful lifecycle into the pool. Even partial successes
  // are valuable — the failed ones are reported but don't block.
  const added: PooledCharacter[] = [];
  const failures: { account: string; error: string }[] = [];

  for (let i = 0; i < fleetResult.outcomes.length; i++) {
    const outcome = fleetResult.outcomes[i];
    const config = configs[i];
    if (outcome === undefined || config === undefined) continue;
    if (outcome.error !== undefined || outcome.lifecycleResult === undefined) {
      failures.push({
        account: config.account,
        error: outcome.error?.message ?? 'no lifecycleResult',
      });
      continue;
    }
    const metadata: Record<string, string> = {
      planet: config.planet ?? 'mos_eisley',
      profession: config.profession ?? 'combat_brawler',
      stockedAt: new Date().toISOString(),
    };
    const pooled = await pool.add(config.account, config.characterName ?? '', metadata);
    // Zone-in succeeded → mark proven immediately so checkout() prefers them.
    if (outcome.lifecycleResult.zonedInAt !== null) {
      await pool.markProven(config.account);
      pooled.proven = true;
    }
    added.push(pooled);
  }

  writeJson(args, {
    ok: failures.length === 0,
    requested: args.count,
    added: added.length,
    failed: failures.length,
    failures,
    characters: added.map(pooledToJson),
    poolPath: pool.filePath,
  });
  return failures.length === 0 ? 0 : 1;
}

function pooledToJson(c: PooledCharacter): Record<string, unknown> {
  return {
    account: c.account,
    characterName: c.characterName,
    proven: c.proven,
    lastSeenAt: c.lastSeenAt?.toISOString() ?? null,
    leasedBy: c.leasedBy,
    leaseExpiresAt: c.leaseExpiresAt?.toISOString() ?? null,
    ...(c.metadata !== undefined ? { metadata: c.metadata } : {}),
  };
}

function writeJson(args: CliArgs, payload: unknown): void {
  process.stdout.write(
    args.pretty ? `${JSON.stringify(payload, null, 2)}\n` : `${JSON.stringify(payload)}\n`,
  );
}

/** Shallow-stringify a decoded message for diagnostic output (handles BigInt, Uint8Array). */
function summarizeDecoded(decoded: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(decoded)) {
    if (typeof v === 'bigint') out[k] = v.toString();
    else if (v instanceof Uint8Array) out[k] = `<${v.byteLength} bytes>`;
    else if (typeof v === 'object' && v !== null) out[k] = JSON.stringify(v).slice(0, 200);
    else out[k] = v;
  }
  return out;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
