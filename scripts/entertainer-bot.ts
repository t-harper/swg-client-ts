/**
 * entertainer-bot — runnable entry point.
 *
 * Thin wrapper: parses args, installs signal handlers, and runs the
 * supervised lifecycle loop. The scenario itself (and everything
 * reloadable) lives in `entertainer-bot-scenario.ts`, kept separate so
 * `ctl reload` can dynamically re-import it without re-running `main()`.
 *
 * Control socket: ~/.swg-ts-client/sessions/entbot-<character>.sock
 *   swg-ts-cli ctl status --session=entbot-<character>
 *   swg-ts-cli ctl get character|world|inventory|... --session=entbot-<character>
 *   swg-ts-cli ctl pause | resume | reload | restart | stop --session=entbot-<character>
 *   swg-ts-cli ctl trigger flourish --session=entbot-<character>
 *
 * Usage:
 *   pnpm tsx bin/entertainer-bot.ts
 *       [--host=10.254.0.253] [--port=44453]
 *       [--user=tslive06] [--character=Bard]
 *       [--planet=tatooine --x=3477 --z=-4857]
 *       [--rebuff-after-min=2] [--session=<name>] [--verbose]
 */

import { SwgClient, createSessionControl, runSupervised } from '../src/index.js';
import type { ScenarioFn, SessionControl } from '../src/index.js';
import { type Args, alwaysLog } from './entertainer-bot-scenario.js';

function parseArgs(argv: string[]): Args {
  const a: Args = {
    host: '10.254.0.253',
    port: 44453,
    user: 'tslive06',
    character: 'Bard',
    planet: 'tatooine',
    x: 3477,
    z: -4857,
    rebuffAfterMin: 2,
    verbose: false,
  };
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const key = (eq >= 0 ? raw.slice(2, eq) : raw.slice(2)).toLowerCase();
    const val = eq >= 0 ? raw.slice(eq + 1) : 'true';
    switch (key) {
      case 'host':
        a.host = val;
        break;
      case 'port':
        a.port = Number.parseInt(val, 10);
        break;
      case 'user':
        a.user = val;
        break;
      case 'character':
        a.character = val;
        break;
      case 'planet':
        a.planet = val;
        break;
      case 'x':
        a.x = Number.parseFloat(val);
        break;
      case 'z':
        a.z = Number.parseFloat(val);
        break;
      case 'rebuff-after-min':
        a.rebuffAfterMin = Number.parseFloat(val);
        break;
      case 'session':
        a.session = val;
        break;
      case 'verbose':
        a.verbose = val === 'true' || val === '';
        break;
      default:
        process.stderr.write(`[entertainer-bot] unknown arg --${key}\n`);
        process.stderr.write(
          'usage: pnpm tsx bin/entertainer-bot.ts [--host=...] [--user=...] [--character=...]\n' +
            '       [--planet=... --x=... --z=...] [--rebuff-after-min=N] [--session=<name>] [--verbose]\n',
        );
        process.exit(2);
    }
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const session = createSessionControl();

  const onSigint = (): void => {
    if (session.isTerminal()) {
      process.stderr.write('[entertainer-bot] second SIGINT; force exit\n');
      process.exit(130);
    }
    session.request('stop', 'SIGINT');
    alwaysLog('SIGINT received; stopping at next tick');
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);
  process.on('uncaughtException', (err) => {
    process.stderr.write(
      `[entertainer-bot] FATAL uncaughtException: ${err.stack ?? err.message ?? String(err)}\n`,
    );
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(
      `[entertainer-bot] FATAL unhandledRejection: ${
        reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
      }\n`,
    );
    process.exit(1);
  });
  process.on('exit', (code) => {
    process.stderr.write(`[entertainer-bot] process exiting with code ${code}\n`);
  });

  const client = new SwgClient({ loginServer: { host: args.host, port: args.port } });

  // `ctl reload` re-imports the scenario module with a cache-bust so edited
  // behavior code takes effect against the live connection.
  const scenarioUrl = new URL('./entertainer-bot-scenario.ts', import.meta.url).href;
  const scriptProvider = async (): Promise<ScenarioFn> => {
    const mod = (await import(`${scenarioUrl}?v=${Date.now()}`)) as {
      makeScenario: (a: Args, s: SessionControl) => ScenarioFn;
    };
    return mod.makeScenario(args, session);
  };

  try {
    const result = await runSupervised({
      client,
      sessionName: args.session ?? `entbot-${args.character}`,
      sessionControl: session,
      scriptProvider,
      lifecycle: {
        account: args.user,
        characterName: args.character,
        planet: 'mos_eisley',
        skillTemplate: 'entertainer_1a',
        workingSkill: 'class_entertainer_phase1_novice',
        profession: 'social_entertainer',
        holdZonedInMs: 10_000,
      },
      log: (m) => alwaysLog(m),
    });
    alwaysLog(
      `clean exit (iterations=${result.iterations} finalDirective=${result.finalDirective})`,
    );
  } catch (err) {
    alwaysLog(`runSupervised threw: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  alwaysLog(`top-level error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
