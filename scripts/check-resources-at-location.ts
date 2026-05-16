#!/usr/bin/env node --import tsx
/**
 * check-resources-at-location.ts — survey every resource class at a single
 * spot and report which resources are available + their densities.
 *
 * Unlike `find-best-resource.ts` (which walks a planet looking for the best
 * single resource), this script picks ONE location, walks to it, surveys
 * every requested resource class in sequence, and prints a per-class
 * report. Useful for "what's worth gathering here?" decisions.
 *
 * Run with:
 *   pnpm exec tsx scripts/check-resources-at-location.ts \
 *     --host=10.254.0.253 --user=<account> --character=<name> \
 *     [--x=1234 --z=-567]                  # target location (default: current)
 *     [--classes=mineral,flora,gas]        # comma-separated (default: all)
 *     [--per-class-timeout-ms=5000]
 *     [--walk-speed=8]
 *     [--no-pretty] [--verbose]
 *
 * Output (pretty by default):
 *   {
 *     "location": { "x": 1234, "y": 5, "z": -567 },
 *     "spawn":    { "x":  -42, "y": 5, "z":  -88 },
 *     "walkedMeters": 1450.1,
 *     "perClass": {
 *       "mineral":          { "samples": 7, "maxPct": 73.4, "avgPct": 41.2, "topAt": {x,z} },
 *       "flora":            { "samples": 5, "maxPct": 18.0, "avgPct":  8.1, "topAt": {x,z} },
 *       "gas":              { "samples": 0, "maxPct":  0,   "avgPct":  0,   "topAt": null },
 *       ...
 *     },
 *     "best":     { "class": "mineral", "maxPct": 73.4, "at": {x,z} },
 *     "elapsedMs": 18421
 *   }
 *
 * If the character has no survey tool installed for a class, the server
 * never responds — those classes show up as `{ samples: 0, status: "timeout" }`.
 * That's diagnostic, not a script failure.
 */

import {
  buildContainerIndex,
  type ContainerItem,
  type LifecycleResult,
  type NetworkId,
  type ScenarioFn,
  type ScriptContext,
  SwgClient,
} from '../src/index.js';

/**
 * Server-side: the `requestSurvey` command takes a TOOL NetworkId as its
 * `target` (see commandFuncRequestSurvey in CommandCppFuncs.cpp). Each
 * tool template only handles certain resource classes. This map covers the
 * stock SWG tools shipped with the artisan starter kit + later survey-tool
 * crafts.
 */
const TOOL_TEMPLATE_TO_CLASSES: Array<{ pattern: RegExp; classes: string[] }> = [
  { pattern: /survey_tool_all(_s\d+)?\b/, classes: ['*'] }, // universal — handles ALL classes
  { pattern: /survey_tool_mineral(_noob)?\b/, classes: ['mineral'] },
  { pattern: /survey_tool_inorganic\b/, classes: ['inorganic_chemical'] },
  { pattern: /survey_tool_organic\b/, classes: ['organic_chemical'] },
  { pattern: /survey_tool_lumber\b/, classes: ['flora_resources'] },
  { pattern: /survey_tool_gas\b/, classes: ['gas'] },
  { pattern: /survey_tool_liquid\b/, classes: ['water'] },
  { pattern: /survey_tool_moisture\b/, classes: ['water'] },
  { pattern: /survey_tool_geo_thermal\b/, classes: ['geothermal_energy'] },
  { pattern: /survey_tool_solar\b/, classes: ['solar_energy'] },
  { pattern: /survey_tool_wind\b/, classes: ['wind_energy'] },
];

/** Find all survey tools in any container reachable from the player's networkId (recursive). */
function findSurveyTools(
  transcript: { transcript: import('../src/client/dispatcher.js').TranscriptEvent[] } | import('../src/client/dispatcher.js').TranscriptEvent[],
  playerNetworkId: NetworkId,
): Map<string, NetworkId> {
  const result = new Map<string, NetworkId>();
  const index = buildContainerIndex(transcript);
  const visited = new Set<string>();
  const queue: NetworkId[] = [playerNetworkId];
  while (queue.length > 0) {
    const parent = queue.shift();
    if (parent === undefined) continue;
    const key = parent.toString();
    if (visited.has(key)) continue;
    visited.add(key);
    const children = index.get(parent) ?? [];
    for (const child of children) {
      // Match by templateName (may be null if the server sent only Crc).
      const name = child.templateName ?? '';
      for (const { pattern, classes } of TOOL_TEMPLATE_TO_CLASSES) {
        if (pattern.test(name)) {
          for (const cls of classes) {
            if (!result.has(cls)) result.set(cls, child.networkId);
          }
          break;
        }
      }
      // Recurse into containers (e.g. inventory → bag → tool).
      queue.push(child.networkId);
    }
  }
  return result;
}

/** Get the survey-tool NetworkId for a given resource class. Returns undefined if no matching tool. */
function toolFor(map: Map<string, NetworkId>, resourceClass: string): NetworkId | undefined {
  const exact = map.get(resourceClass);
  if (exact !== undefined) return exact;
  // Universal tool ('*') handles every class.
  return map.get('*');
}

interface Args {
  host: string;
  port: number;
  user: string;
  character?: string;
  password?: string;
  cluster?: string;
  planet: string;
  profession: string;
  x?: number;
  z?: number;
  classes: string[];
  perClassTimeoutMs: number;
  walkSpeed: number;
  pretty: boolean;
  verbose: boolean;
}

/**
 * The common resource CLASSES the SWG survey tool can scan for. Each maps
 * to a tool category — the character must hold a tool of that category for
 * the server to respond. Source: `dsrc/sku.0/sys.server/compiled/game/datatables/resource/resource_classes.iff`.
 */
const DEFAULT_RESOURCE_CLASSES = [
  'mineral',
  'inorganic_chemical',
  'organic_chemical',
  'flora_resources',
  'gas',
  'water',
  'geothermal_energy',
  'wind_energy',
  'solar_energy',
];

function parseArgs(argv: string[]): Args {
  const a: Args = {
    host: '10.254.0.253',
    port: 44453,
    user: '',
    planet: 'mos_eisley',
    profession: 'combat_brawler',
    classes: DEFAULT_RESOURCE_CLASSES,
    perClassTimeoutMs: 5_000,
    walkSpeed: 8,
    pretty: true,
    verbose: false,
  };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    const eq = arg.indexOf('=');
    const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const val = eq < 0 ? 'true' : arg.slice(eq + 1);
    switch (key) {
      case 'host':                 a.host = val; break;
      case 'port':                 a.port = Number.parseInt(val, 10); break;
      case 'user':                 a.user = val; break;
      case 'character':            a.character = val; break;
      case 'password':             a.password = val; break;
      case 'cluster':              a.cluster = val; break;
      case 'planet':               a.planet = val; break;
      case 'profession':           a.profession = val; break;
      case 'x':                    a.x = Number.parseFloat(val); break;
      case 'z':                    a.z = Number.parseFloat(val); break;
      case 'classes':              a.classes = val.split(',').map((s) => s.trim()).filter(Boolean); break;
      case 'per-class-timeout-ms': a.perClassTimeoutMs = Number.parseInt(val, 10); break;
      case 'walk-speed':           a.walkSpeed = Number.parseFloat(val); break;
      case 'no-pretty':            a.pretty = false; break;
      case 'verbose':              a.verbose = val === 'true' || val === ''; break;
      default:
        process.stderr.write(`Unknown flag: --${key}\n`);
        process.exit(2);
    }
  }
  if (a.user === '') {
    usage();
    process.stderr.write('\n--user is required\n');
    process.exit(2);
  }
  return a;
}

function usage(): void {
  process.stderr.write(
    [
      'check-resources-at-location — survey all resource classes at one spot',
      '',
      'Usage:',
      '  tsx scripts/check-resources-at-location.ts --host=<host> --user=<account>',
      '       [--character=<name>] [--x=<n> --z=<n>] [--classes=<a,b,c>]',
      '       [--per-class-timeout-ms=5000] [--walk-speed=8]',
      '       [--planet=mos_eisley] [--no-pretty] [--verbose]',
      '',
      'Examples:',
      '  # Survey all default classes at character\'s spawn',
      '  tsx scripts/check-resources-at-location.ts --host=10.254.0.253 --user=ci --character=TsCli',
      '',
      '  # Survey just minerals + gas at (1500, -800)',
      '  tsx scripts/check-resources-at-location.ts --host=10.254.0.253 --user=ci --character=TsCli \\',
      '       --x=1500 --z=-800 --classes=mineral,gas',
      '',
      'Defaults to surveying: ' + DEFAULT_RESOURCE_CLASSES.join(', '),
      '',
    ].join('\n'),
  );
}

interface PerClassResult {
  samples: number;
  maxPct: number;
  avgPct: number;
  topAt: { x: number; y: number; z: number } | null;
  status: 'ok' | 'timeout' | 'no-tool';
}

function makeScenario(args: Args, results: Map<string, PerClassResult>, target: { x: number; z: number } | null): ScenarioFn {
  const log = args.verbose
    ? (m: string) => process.stderr.write(`[check] ${m}\n`)
    : () => {};

  return async (ctx: ScriptContext) => {
    // Settle for a moment so baselines + containment messages finish.
    await ctx.wait(2_500);

    // Scan the player's containers for survey tools. Server-side
    // commandFuncRequestSurvey requires the TOOL networkId as the
    // command's target — passing 0n is a silent no-op.
    const tools = findSurveyTools(ctx.dispatcher.transcript, ctx.sceneStart.playerNetworkId);
    log(
      `found ${tools.size} survey tool(s) in inventory: ${
        [...tools.entries()].map(([cls, id]) => `${cls}=${id}`).join(', ') || '(none)'
      }`,
    );

    // Walk to target if one was supplied.
    if (target !== null) {
      log(`walking to (${target.x.toFixed(1)}, ${target.z.toFixed(1)}) at speed ${args.walkSpeed}`);
      await ctx.walkTo(target, { speed: args.walkSpeed });
      await ctx.wait(500); // brief settle so the server registers the new position
    }

    const here = ctx.position();
    log(`surveying at (${here.x.toFixed(1)}, ${here.z.toFixed(1)}); ${args.classes.length} classes to check`);

    // Survey each class in sequence. Uses the resolved tool's NetworkId so
    // the server's commandFuncRequestSurvey actually fires (rather than
    // silently dropping when tool=0n).
    for (const cls of args.classes) {
      const toolId = toolFor(tools, cls);
      if (toolId === undefined) {
        log(`survey: ${cls} → no tool in inventory, skipping`);
        results.set(cls, { samples: 0, maxPct: 0, avgPct: 0, topAt: null, status: 'no-tool' });
        continue;
      }
      log(`survey: ${cls} (tool ${toolId})`);
      ctx.useAbility('requestsurvey', toolId, cls);
      try {
        const result = await ctx.waitForSurvey({ timeoutMs: args.perClassTimeoutMs });
        const points = result.points;
        if (points.length === 0) {
          results.set(cls, { samples: 0, maxPct: 0, avgPct: 0, topAt: null, status: 'ok' });
          log(`  → ok, 0 samples (server responded but radial is empty)`);
          continue;
        }
        let max = 0;
        let sum = 0;
        let top: { x: number; y: number; z: number } | null = null;
        for (const p of points) {
          const pct = p.efficiency * 100;
          sum += pct;
          if (pct > max) {
            max = pct;
            top = { x: p.location.x, y: p.location.y, z: p.location.z };
          }
        }
        results.set(cls, {
          samples: points.length,
          maxPct: Math.round(max * 10) / 10,
          avgPct: Math.round((sum / points.length) * 10) / 10,
          topAt: top,
          status: 'ok',
        });
        log(`  → ${points.length} samples, max ${max.toFixed(1)}%, avg ${(sum / points.length).toFixed(1)}%`);
      } catch (err) {
        // Timeout — server didn't respond (likely no tool for this class).
        const isTimeout = err instanceof Error && /Timed out/.test(err.message);
        results.set(cls, {
          samples: 0,
          maxPct: 0,
          avgPct: 0,
          topAt: null,
          status: isTimeout ? 'no-tool' : 'timeout',
        });
        log(`  → no response (${isTimeout ? 'no tool for this class' : 'error: ' + (err instanceof Error ? err.message : String(err))})`);
      }
    }
  };
}

function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dz * dz);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const target = args.x !== undefined && args.z !== undefined ? { x: args.x, z: args.z } : null;
  if (args.verbose) {
    process.stderr.write(
      `[check] host=${args.host} user=${args.user} char=${args.character ?? '(create)'} ` +
        `target=${target ? `(${target.x},${target.z})` : '(spawn)'} classes=${args.classes.join(',')}\n`,
    );
  }

  const client = new SwgClient({ loginServer: { host: args.host, port: args.port } });
  const results = new Map<string, PerClassResult>();
  const t0 = Date.now();

  let lifecycle: LifecycleResult;
  try {
    lifecycle = await client.fullLifecycle({
      account: args.user,
      ...(args.password !== undefined ? { password: args.password } : {}),
      ...(args.cluster !== undefined ? { clusterName: args.cluster } : {}),
      ...(args.character !== undefined ? { characterName: args.character } : {}),
      planet: args.planet,
      profession: args.profession,
      // 5s settle + walk-time + (timeout * classes) — give the lifecycle
      // enough hold time even when most classes time out.
      holdZonedInMs: 5_000 + args.classes.length * args.perClassTimeoutMs,
      script: makeScenario(args, results, target),
    });
  } catch (err) {
    process.stderr.write(`lifecycle failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // Pull final position from the script's view: the scenario walked to target
  // (if given), and our cursor is now there. Reconstruct from sceneStart.
  const spawn = lifecycle.sceneStart?.startPosition ?? { x: 0, y: 0, z: 0 };
  const surveyedAt = target ?? { x: spawn.x, z: spawn.z };
  const walkedMeters = target !== null ? distance({ x: spawn.x, z: spawn.z }, target) : 0;

  // Compute best across all classes.
  let bestClass: string | null = null;
  let bestPct = 0;
  let bestAt: { x: number; y: number; z: number } | null = null;
  for (const [cls, r] of results) {
    if (r.maxPct > bestPct) {
      bestPct = r.maxPct;
      bestClass = cls;
      bestAt = r.topAt;
    }
  }

  const perClassObj: Record<string, PerClassResult> = {};
  for (const cls of args.classes) {
    const r = results.get(cls);
    if (r !== undefined) perClassObj[cls] = r;
  }

  const report = {
    ok: true,
    host: args.host,
    character: lifecycle.character.name,
    spawn: { x: spawn.x, y: spawn.y, z: spawn.z },
    surveyedAt,
    walkedMeters: Math.round(walkedMeters * 10) / 10,
    perClass: perClassObj,
    best: bestClass !== null
      ? { class: bestClass, maxPct: bestPct, at: bestAt }
      : null,
    summary: {
      classesChecked: args.classes.length,
      classesWithData: [...results.values()].filter((r) => r.samples > 0).length,
      classesTimedOut: [...results.values()].filter((r) => r.status === 'no-tool').length,
      totalSamples: [...results.values()].reduce((s, r) => s + r.samples, 0),
    },
    receivedErrorMessage: lifecycle.receivedErrorMessage,
    elapsedMs: Date.now() - t0,
  };

  process.stdout.write(
    args.pretty ? `${JSON.stringify(report, null, 2)}\n` : `${JSON.stringify(report)}\n`,
  );

  if (report.summary.classesWithData === 0) {
    process.stderr.write(
      `[check] No survey responses came back. The character likely has no survey tools ` +
        `in inventory — equip one and re-run.\n`,
    );
  }

  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
