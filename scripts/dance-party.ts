#!/usr/bin/env node --import tsx
/**
 * dance-party.ts — 10 characters log in, form a circle around the spawn,
 * dance for ~10 seconds, then log out.
 *
 * Run with:
 *   pnpm exec tsx scripts/dance-party.ts [--host=10.254.0.253] [--count=10] [--seconds=10]
 *
 * Uses Fleet to drive N concurrent SwgClients. Each client runs a
 * scenario that:
 *   1. Waits a short stagger to let baselines settle.
 *   2. Stands up (in case spawn posture differs).
 *   3. Walks to its assigned spot on a circle around (0, 0) relative to
 *      the spawn so the group physically forms a dance circle.
 *   4. Issues the `startdance` ability via the command queue with a
 *      rotating performance name so the group dances different styles.
 *   5. Holds in the dancing pose for `seconds` seconds.
 *   6. Issues `stopdance` and logs out (Fleet's lifecycle handles the
 *      LogoutMessage + SOE Terminate).
 *
 * No --planet flag because the bundled CLI default (mos_eisley) is what
 * Fleet uses too. Characters are created on first use; subsequent runs
 * reuse the same set if you keep the same prefix + count.
 */

import { Fleet, type FleetClientConfig, type ScenarioFn } from '../src/index.js';

interface Args {
  host: string;
  port: number;
  count: number;
  seconds: number;
  prefix: string;
  radius: number;
  staggerMs: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    host: '10.254.0.253',
    port: 44453,
    count: 10,
    seconds: 10,
    prefix: 'dnc',
    radius: 8,
    staggerMs: 200,
    verbose: false,
  };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const val = eq < 0 ? 'true' : arg.slice(eq + 1);
    switch (key) {
      case 'host':       a.host = val; break;
      case 'port':       a.port = Number.parseInt(val, 10); break;
      case 'count':      a.count = Number.parseInt(val, 10); break;
      case 'seconds':    a.seconds = Number.parseInt(val, 10); break;
      case 'prefix':     a.prefix = val; break;
      case 'radius':     a.radius = Number.parseFloat(val); break;
      case 'stagger-ms': a.staggerMs = Number.parseInt(val, 10); break;
      case 'verbose':    a.verbose = val === 'true' || val === ''; break;
      default:
        process.stderr.write(`Unknown flag: --${key}\n`);
        process.exit(2);
    }
  }
  return a;
}

/**
 * Performance names from `performance.iff`. The `startdance` command takes
 * one of these as its argument; we cycle them across the 10 dancers so the
 * party isn't a uniform conga line.
 */
const DANCE_STYLES = [
  'basic',
  'rhythmic',
  'footloose',
  'formal',
  'lyrical',
  'exotic',
  'exotic2',
  'poplock',
  'tumble',
  'breakdance',
];

function makeDanceScenario(opts: {
  position: { x: number; z: number };
  performance: string;
  seconds: number;
  initialDelayMs: number;
  verbose: boolean;
  label: string;
}): ScenarioFn {
  return async (ctx) => {
    const log = opts.verbose ? (m: string) => process.stderr.write(`[${opts.label}] ${m}\n`) : () => {};

    // 1. Let the baselines flood settle.
    await ctx.wait(opts.initialDelayMs);

    // 2. Stand up (in case spawn pose is something else).
    ctx.changePosture('standing');

    // 3. Walk to assigned spot. `walkTo` is relative to absolute world
    //    coordinates, and we got our spawn position from sceneStart.
    const spawn = ctx.sceneStart.startPosition;
    const target = { x: spawn.x + opts.position.x, z: spawn.z + opts.position.z };
    log(`walking to (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`);
    await ctx.walkTo(target, { speed: 5 });

    // 4. Face the centre and START DANCING.
    log(`starting dance: ${opts.performance}`);
    ctx.useAbility('startdance', 0n, opts.performance);

    // 5. Hold the pose. Heartbeats keep the session alive.
    log(`dancing for ${opts.seconds}s...`);
    await ctx.wait(opts.seconds * 1_000);

    // 6. Stop and let Fleet send the LogoutMessage.
    log('stopping dance');
    ctx.useAbility('stopdance');
    await ctx.wait(500);
    // Don't call ctx.logout() — Fleet's lifecycle does that for us.
  };
}

function buildConfigs(args: Args, runTag: string): FleetClientConfig[] {
  const cfgs: FleetClientConfig[] = [];
  for (let i = 0; i < args.count; i++) {
    // Position on a circle around the spawn.
    const angle = (i / args.count) * 2 * Math.PI;
    const position = {
      x: args.radius * Math.sin(angle),
      z: args.radius * Math.cos(angle),
    };
    const performance = DANCE_STYLES[i % DANCE_STYLES.length] ?? 'basic';

    // Account name caps at 15 chars. ${prefix}${runTag}${i} should fit.
    const account = `${args.prefix}${runTag}${i}`.slice(0, 15);
    const characterName = `Dancer${runTag}${i}`;

    cfgs.push({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0, // scenario provides its own duration
      script: makeDanceScenario({
        position,
        performance,
        seconds: args.seconds,
        initialDelayMs: 1_500, // let zone-in baselines settle
        verbose: args.verbose,
        label: `${i}/${performance}`,
      }),
    });
  }
  return cfgs;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const runTag = (Date.now() % 100_000_000).toString(36);

  process.stderr.write(
    `[dance-party] ${args.count} dancers, ${args.seconds}s each, ` +
      `radius=${args.radius}m, host=${args.host}, runTag=${runTag}\n`,
  );

  const fleet = new Fleet({
    loginServer: { host: args.host, port: args.port },
  });

  const configs = buildConfigs(args, runTag);

  const result = await fleet.run(configs, {
    staggerMs: args.staggerMs,
    // No maxConcurrent — let them all run together for the full visual effect.
  });

  // Compact summary report.
  const summary = {
    runTag,
    totalDancers: result.summary.totalClients,
    succeeded: result.summary.succeeded,
    failed: result.summary.failed,
    totalElapsedMs: result.summary.totalElapsedMs,
    cumulativeElapsedMs: result.summary.cumulativeElapsedMs,
    danceCommandsSent: result.summary.messageCounts.ObjControllerMessage?.sent ?? 0,
    movementsSent: result.summary.messageCounts.UpdateTransformMessage?.sent ?? 0,
    logoutsSent: result.summary.messageCounts.LogoutMessage?.sent ?? 0,
    serverErrors: result.summary.clientsWithErrorMessage,
    outcomes: result.outcomes.map((o) => ({
      character: o.config.characterName,
      ok: o.error === undefined,
      error: o.error?.message,
      sendsCount: o.lifecycleResult?.scriptResult?.sendsCount,
      elapsedMs: o.elapsedMs,
    })),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  return result.summary.failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
