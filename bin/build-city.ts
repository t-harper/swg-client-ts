#!/usr/bin/env node
/**
 * build-city CLI shim.
 *
 * Usage:
 *   pnpm tsx bin/build-city.ts --host=10.254.0.253 --mode=mvp [--phase=X --force] [--dry-run] [--verbose]
 */

import { type Mode, type OrchestratorOptions, run } from '../scripts/build-city/orchestrator.js';
import type { PhaseName } from '../scripts/build-city/state.js';

interface Args {
  host: string;
  port: number;
  mode: Mode;
  forcePhases: PhaseName[];
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    host: '10.254.0.253',
    port: 44453,
    mode: 'mvp',
    forcePhases: [],
    dryRun: false,
    verbose: false,
  };
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
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
      case 'mode':
        if (val !== 'mvp' && val !== 'full' && val !== 'verify' && val !== 'phase0pre') {
          process.stderr.write(`--mode must be mvp|full|verify|phase0pre (got '${val}')\n`);
          process.exit(2);
        }
        args.mode = val;
        break;
      case 'force':
        args.forcePhases.push(val as PhaseName);
        break;
      case 'phase':
        // --phase=X is sugar for --mode=verify --force=X (run just one phase)
        args.forcePhases.push(val as PhaseName);
        break;
      case 'dry-run':
        args.dryRun = val === 'true' || val === '';
        break;
      case 'verbose':
        args.verbose = val === 'true' || val === '';
        break;
      case 'help':
        printHelp();
        process.exit(0);
        return args;
      default:
        process.stderr.write(`Unknown flag: --${key}\n`);
        process.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  process.stderr.write(
    [
      'build-city — autonomously construct a Theed-style city on Naboo',
      '',
      'Usage:',
      '  pnpm tsx bin/build-city.ts --host=<host> [--port=44453]',
      '                              --mode=mvp|full|verify|phase0pre',
      '                              [--force=<phaseName>]... [--dry-run] [--verbose]',
      '',
      'Modes:',
      '  mvp        5-character minimum-viable city (mayor + 4 residents). ~10 min.',
      '  full       30-character full city: civic ring + housing + guild + gardens. ~25 min.',
      '  verify     Re-login mayor, walk circle, count structures',
      '  phase0pre  Reload admin allowlist (after editing stella_admin.tab)',
      '',
      'Phase names (for --force):',
      '  phase0pre, phase0a-mvp, phase0b-full, phase1-mvp, phase1-full,',
      '  phase2-mayor, phase3-mvp, phase3-full, phase4-civic, phase5-decor, phase6-verify',
      '',
      'State persists in scripts/build-city/state.json — completed phases are skipped',
      'on re-run. Use --force=<phase> to re-run a specific phase.',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const opts: OrchestratorOptions = {
    loginServer: { host: args.host, port: args.port },
    mode: args.mode,
    forcePhases: args.forcePhases,
    dryRun: args.dryRun,
    verbose: args.verbose,
  };

  const startedAt = Date.now();
  const result = await run(opts);
  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  // Print final summary
  const summary = {
    ok: result.ok,
    mode: args.mode,
    elapsedSeconds: elapsed,
    cityName: result.state.cityName,
    cityCenter: result.state.cityCenter,
    mayorAccount: result.state.mayorAccount,
    charactersStocked: Object.values(result.state.characters).filter((c) => c.created).length,
    phases: result.state.phaseLog.map((p) => ({
      phase: p.phase,
      ok: p.ok,
      ...(p.notes !== undefined ? { notes: p.notes } : {}),
      ...(p.assertionFailures !== undefined && p.assertionFailures.length > 0
        ? { failures: p.assertionFailures.length }
        : {}),
    })),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
