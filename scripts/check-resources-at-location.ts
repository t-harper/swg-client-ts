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

import { ByteStream } from '../src/archive/byte-stream.js';
import { TransformCodec, type Transform } from '../src/archive/transform.js';
import { ObjControllerMessage } from '../src/messages/game/obj-controller-message.js';
import {
  buildContainerIndex,
  type ContainerItem,
  type LifecycleResult,
  type NetworkId,
  type ScenarioFn,
  type ScriptContext,
  SwgClient,
} from '../src/index.js';

const CM_NET_UPDATE_TRANSFORM = 113;
const CLIENT_TO_AUTH_SERVER_FLAGS = 0x23;

/**
 * Encode the MessageQueueDataTransform trailer used inside an
 * ObjControllerMessage(message=CM_netUpdateTransform). Wire layout per
 * /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueDataTransform.cpp:45-55
 */
function packDataTransform(syncStamp: number, seq: number, x: number, y: number, z: number, speed: number): Uint8Array {
  const s = new ByteStream();
  s.writeU32(syncStamp >>> 0);
  s.writeI32(seq);
  const transform: Transform = { rotation: { w: 1, x: 0, y: 0, z: 0 }, position: { x, y, z } };
  TransformCodec.encode(s, transform);
  s.writeF32(speed);
  s.writeF32(0); // lookAtYaw
  s.writeU8(0); // useLookAtYaw
  return s.toBytes();
}

/**
 * Walk to (targetX, targetZ) at `speed` m/s by sending repeated
 * ObjControllerMessage(CM_netUpdateTransform) packets. The standard
 * ctx.walkTo() sends top-level UpdateTransformMessage which the SERVER
 * IGNORES — see CLAUDE.md / Client.cpp's dispatch table; client→server
 * movement only flows through the CM_netUpdateTransform controller
 * subtype.
 */
async function nativeWalkTo(
  ctx: ScriptContext,
  startX: number,
  startY: number,
  startZ: number,
  targetX: number,
  targetZ: number,
  speed: number,
  startTimeMs: number,
): Promise<{ x: number; y: number; z: number }> {
  const tickMs = 200;
  const tickSec = tickMs / 1000;
  const stepLen = speed * tickSec;
  const dx = targetX - startX;
  const dz = targetZ - startZ;
  const dist = Math.hypot(dx, dz);
  const ticks = Math.max(1, Math.ceil(dist / stepLen));
  const ux = dx / dist;
  const uz = dz / dist;
  let seq = 1;
  let x = startX;
  let z = startZ;
  for (let i = 1; i <= ticks; i++) {
    const isLast = i === ticks;
    if (isLast) {
      x = targetX;
      z = targetZ;
    } else {
      x = startX + ux * stepLen * i;
      z = startZ + uz * stepLen * i;
    }
    const syncStamp = Date.now() - startTimeMs;
    const trailer = packDataTransform(syncStamp, seq++, x, startY, z, speed);
    ctx.send(new ObjControllerMessage(CLIENT_TO_AUTH_SERVER_FLAGS, CM_NET_UPDATE_TRANSFORM, ctx.sceneStart.playerNetworkId, 0, trailer));
    if (!isLast) await ctx.wait(tickMs);
  }
  return { x, y: startY, z };
}

/**
 * Server-side: the `requestSurvey` command takes a TOOL NetworkId as its
 * `target` (see commandFuncRequestSurvey in CommandCppFuncs.cpp). Each
 * tool template only handles certain resource classes. This map covers the
 * stock SWG tools shipped with the artisan starter kit + later survey-tool
 * crafts.
 */
// Template short-names that come back over the wire are truncated (e.g.
// `survey_tool_geo_n` rather than `survey_tool_geo_thermal`). Patterns use
// the leading prefix that fits inside the truncated form.
const TOOL_TEMPLATE_TO_CLASSES: Array<{ pattern: RegExp; classes: string[] }> = [
  { pattern: /survey_tool_all\b/, classes: ['*'] }, // universal — handles every class
  { pattern: /survey_tool_mineral/, classes: ['mineral'] }, // also matches _noob
  { pattern: /survey_tool_inorganic/, classes: ['inorganic_chemical'] },
  { pattern: /survey_tool_organic/, classes: ['organic_chemical'] },
  { pattern: /survey_tool_lumber/, classes: ['flora_resources'] },
  { pattern: /survey_tool_gas/, classes: ['gas'] },
  { pattern: /survey_tool_liquid/, classes: ['water'] },
  { pattern: /survey_tool_moisture/, classes: ['water'] },
  { pattern: /survey_tool_geo/, classes: ['geothermal_energy'] }, // truncated form: survey_tool_geo_n
  { pattern: /survey_tool_solar/, classes: ['solar_energy'] },
  { pattern: /survey_tool_wind/, classes: ['wind_energy'] },
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
      // Match by templateName (full path; may be null if only CRC is known)
      // OR by the short display name from the SHARED baseline (this is
      // what the server actually sends for GM-spawned items — see the
      // truncation note above).
      const candidates = [child.templateName ?? '', child.name ?? ''];
      for (const text of candidates) {
        if (text === '') continue;
        let matched = false;
        for (const { pattern, classes } of TOOL_TEMPLATE_TO_CLASSES) {
          if (pattern.test(text)) {
            for (const cls of classes) {
              if (!result.has(cls)) result.set(cls, child.networkId);
            }
            matched = true;
            break;
          }
        }
        if (matched) break;
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

    // Walk to target via the SERVER-ACCEPTED wire path (CM_netUpdateTransform
    // wrapped in ObjControllerMessage). The default ctx.walkTo() sends
    // top-level UpdateTransformMessage which the server silently drops —
    // confirmed against engine/server/.../core/Client.cpp's dispatch table.
    let here: { x: number; y: number; z: number };
    if (target !== null) {
      log(`walking to (${target.x.toFixed(1)}, ${target.z.toFixed(1)}) at speed ${args.walkSpeed}`);
      const spawn = ctx.sceneStart.startPosition;
      const sessionStart = Date.now();
      here = await nativeWalkTo(ctx, spawn.x, spawn.y, spawn.z, target.x, target.z, args.walkSpeed, sessionStart);
      await ctx.wait(1_500); // server-side settle so position reads catch up
    } else {
      const cur = ctx.position();
      here = { x: cur.x, y: cur.y, z: cur.z };
    }
    log(`surveying at (${here.x.toFixed(1)}, ${here.z.toFixed(1)}); ${args.classes.length} classes to check`);

    // Survey each class in sequence via the native flow: useAbility(
    // 'requestsurvey', toolId, resourceClass) → commandFuncRequestSurvey
    // → toolObj.trigAllScripts(TRIG_REQUEST_SURVEY) → OnRequestSurvey
    // (survey_tool_script.java) → requestSurvey JNI → SurveySystem →
    // broadcast SurveyMessage. The server-side script will silently
    // bail (no SurveyMessage) if the player is inside a structure or
    // standing on a building surface — so walk to OPEN TERRAIN first.
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
