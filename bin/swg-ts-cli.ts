#!/usr/bin/env node
/**
 * swg-ts-cli — single-command verification of the full SWG lifecycle.
 *
 * Usage:
 *   swg-ts-cli zone --host=10.254.0.253 [--port=44453] --user=ci-test
 *                  [--character=TsTest] [--planet=tatooine]
 *                  [--hold-ms=5000] [--verbose]
 *
 * Emits the full LifecycleResult as JSON on stdout. Exits 0 on success,
 * non-zero on failure.
 */
import { SwgClient, lifecycleResultToJSON } from '../src/index.js';
import type { TranscriptEvent } from '../src/index.js';

interface CliArgs {
  command: 'zone' | 'help';
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
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: 'help',
    host: '127.0.0.1',
    port: 44453,
    user: '',
    planet: 'tatooine',
    profession: 'combat_brawler',
    holdMs: 5_000,
    verbose: false,
    pretty: true,
    skipGame: false,
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
  if (positional[0] === 'zone' || positional[0] === 'help') {
    args.command = positional[0];
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
      '  swg-ts-cli zone --host=<host> [--port=44453] --user=<account>',
      '                 [--character=<name>] [--cluster=swg] [--planet=tatooine]',
      '                 [--profession=combat_brawler] [--hold-ms=5000]',
      '                 [--verbose] [--no-pretty] [--skip-game]',
      '  swg-ts-cli help',
      '',
      'Examples:',
      '  swg-ts-cli zone --host=10.254.0.253 --user=ci-test',
      '  swg-ts-cli zone --host=10.254.0.253 --user=ci-test --character=TsTest --hold-ms=10000',
      '',
      'Exits 0 on success, 1 on failure. Always emits JSON on stdout.',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    printHelp();
    return 0;
  }
  if (args.command !== 'zone') {
    printHelp();
    return 2;
  }
  if (args.user === '') {
    process.stderr.write('--user is required\n');
    return 2;
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
