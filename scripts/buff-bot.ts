/**
 * buff-bot — runnable entry point for the NGE medic buff-bot.
 *
 * Thin wrapper: parses args, installs signal handlers, and runs the
 * supervised lifecycle loop. The scenario itself (and everything
 * reloadable) lives in `buff-bot-scenario.ts`, kept separate so
 * `ctl reload` can dynamically re-import it without re-running `main()`.
 *
 * Control socket: ~/.swg-ts-client/sessions/buffbot-<character>.sock
 *   swg-ts-cli ctl status --session=buffbot-<character>
 *   swg-ts-cli ctl get character|world|... --session=buffbot-<character>
 *   swg-ts-cli ctl pause | resume | reload | restart | stop --session=buffbot-<character>
 *   swg-ts-cli ctl trigger rebuff-all --session=buffbot-<character>
 *
 * Usage:
 *   pnpm tsx bin/buff-bot.ts --user=<account> --character=<name>
 *       [--host=10.254.0.253] [--port=44453]
 *       [--planet=tatooine --x=3528 --z=-4804]
 *       [--radius=5] [--rebuff-after-min=25] [--session=<name>] [--verbose]
 */

import { SwgClient, createSessionControl, runSupervised } from '../src/index.js';
import type { ScenarioFn, SessionControl } from '../src/index.js';
import { type Args, alwaysLog } from './buff-bot-scenario.js';

function parseArgs(argv: string[]): Args {
  const a: Args = {
    host: '10.254.0.253',
    port: 44453,
    user: '',
    character: '',
    planet: 'tatooine',
    x: 3528,
    z: -4804,
    radius: 5,
    rebuffAfterMin: 25,
    verbose: false,
  };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const val = eq < 0 ? 'true' : arg.slice(eq + 1);
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
      case 'radius':
        a.radius = Number.parseFloat(val);
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
        process.stderr.write(`unknown flag --${key}\n`);
        process.exit(2);
    }
  }
  if (a.user === '' || a.character === '') {
    process.stderr.write(
      'usage: bin/buff-bot.ts --user=<account> --character=<name>\n' +
        '       [--host=10.254.0.253] [--port=44453]\n' +
        '       [--planet=tatooine --x=3528 --z=-4804]\n' +
        '       [--radius=5] [--rebuff-after-min=25] [--session=<name>] [--verbose]\n',
    );
    process.exit(2);
  }
  return a;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  alwaysLog(
    `starting host=${args.host} user=${args.user} character=${args.character} ` +
      `planet=${args.planet} (${args.x},${args.z}) radius=${args.radius}m rebuff=${args.rebuffAfterMin}min`,
  );

  const session = createSessionControl();
  const onSigint = (): void => {
    if (session.isTerminal()) {
      process.stderr.write('[buff-bot] second SIGINT; force exit\n');
      process.exit(130);
    }
    session.request('stop', 'SIGINT');
    alwaysLog('SIGINT received; stopping at next tick');
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);
  process.on('uncaughtException', (err) => {
    process.stderr.write(
      `[buff-bot] FATAL uncaughtException: ${err.stack ?? err.message ?? String(err)}\n`,
    );
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(
      `[buff-bot] FATAL unhandledRejection: ${
        reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
      }\n`,
    );
    process.exit(1);
  });
  process.on('exit', (code) => {
    process.stderr.write(`[buff-bot] process exiting with code ${code}\n`);
  });

  const client = new SwgClient({ loginServer: { host: args.host, port: args.port } });

  // `ctl reload` re-imports the scenario module with a cache-bust so edited
  // behavior code takes effect against the live connection.
  const scenarioUrl = new URL('./buff-bot-scenario.ts', import.meta.url).href;
  const scriptProvider = async (): Promise<ScenarioFn> => {
    const mod = (await import(`${scenarioUrl}?v=${Date.now()}`)) as {
      makeScenario: (a: Args, s: SessionControl) => ScenarioFn;
    };
    return mod.makeScenario(args, session);
  };

  try {
    const result = await runSupervised({
      client,
      sessionName: args.session ?? `buffbot-${args.character}`,
      sessionControl: session,
      scriptProvider,
      lifecycle: {
        account: args.user,
        characterName: args.character,
        // ClientCreateCharacter wants a starting_locations.iff city key.
        planet: 'mos_eisley',
        skillTemplate: 'medic_1a',
        workingSkill: 'class_medic_phase1_novice',
        profession: 'science_medic',
        holdZonedInMs: 10_000,
      },
      log: (m) => alwaysLog(m),
    });
    alwaysLog(
      `clean exit (iterations=${result.iterations} finalDirective=${result.finalDirective})`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `[buff-bot] runSupervised failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
