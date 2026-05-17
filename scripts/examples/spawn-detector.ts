#!/usr/bin/env node --import tsx
/**
 * spawn-detector.ts — stream every new object entering view (and optionally
 * every departure) as NDJSON to stdout.
 *
 * Useful for testing server spawn cycles, view-range / interest-management
 * behavior, NPE roadmap mob spawning, dynamic-spawn-table churn, and any
 * scenario where you want to know *exactly* what the server pushed into
 * your view and when. Subscribes to the WorldModel's `'create'` /
 * `'baseline'` / `'destroy'` events and emits one JSON record per line.
 *
 * Why `'baseline'` too: a fresh `'create'` lands with `typeId === 0` because
 * Scene* messages don't carry the type tag — the tag only shows up once the
 * first `BaselinesMessage` arrives. By emitting on the first baseline (when
 * the id was previously suppressed for not having a typeId yet), we make
 * sure type-filtered consumers actually see the spawn.
 *
 * Output modes:
 *   --summary-ms=0   (default) NDJSON record per event:
 *                    {kind:'spawn',  at, id, typeIdString, templateName, position, distanceFromPlayer}
 *                    {kind:'despawn', at, id, typeIdString, templateName, position, distanceFromPlayer, hyperspace}
 *   --summary-ms=N (>0) NDJSON record every N ms with counts by type:
 *                    {kind:'summary', at, windowMs, creates:{CREO:n,TANO:n,...}, destroys:{...}}
 *
 * The final line written to stdout is the `ScenarioSummary` JSON object
 * (compact, single-line — also valid NDJSON) so pipe consumers can both
 * stream events and capture the final outcome from the same stream.
 *
 * Examples:
 *   pnpm exec tsx scripts/examples/spawn-detector.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --minutes=10 --types=CREO,PLAY
 *
 *   pnpm exec tsx scripts/examples/spawn-detector.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --minutes=30 --summary-ms=5000 --types=CREO,TANO,PLAY
 */

import {
  ObjectTypeTags,
  type ScenarioFn,
  type WorldEvent,
  type WorldObject,
  tagToString,
} from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/spawn-detector.ts';

interface ScriptArgs {
  /** Set of accepted `typeId` (u32 Tag) values, or `null` to mean "all types". */
  typeFilter: Set<number> | null;
  /** Original comma-separated list, for the summary `extra` block. */
  typesRaw: string;
  includeDestroys: boolean;
  /** 0 = NDJSON per event; >0 = periodic summary aggregation in ms. */
  summaryMs: number;
}

function parseTypeFilter(raw: string): Set<number> | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '*' || trimmed.toLowerCase() === 'all') return null;
  const tags = new Set<number>();
  for (const tok of trimmed.split(',')) {
    const name = tok.trim().toUpperCase();
    if (name === '') continue;
    const tag = (ObjectTypeTags as Record<string, number>)[name];
    if (tag === undefined) {
      throw new Error(
        `Unknown type tag "${name}". Known: ${Object.keys(ObjectTypeTags).join(',')} (or "all"/"*").`,
      );
    }
    tags.add(tag);
  }
  return tags.size === 0 ? null : tags;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const typesRaw = extra.get('types') ?? 'CREO,TANO,PLAY';
  const includeDestroysRaw = extra.get('include-destroys') ?? 'true';
  const summaryMsRaw = extra.get('summary-ms') ?? '0';
  return {
    typeFilter: parseTypeFilter(typesRaw),
    typesRaw,
    includeDestroys: includeDestroysRaw === 'true' || includeDestroysRaw === '',
    summaryMs: Math.max(0, Number.parseInt(summaryMsRaw, 10) || 0),
  };
}

interface DetectorStats {
  spawnRecordsEmitted: number;
  despawnRecordsEmitted: number;
  summariesEmitted: number;
  creatorEventsObserved: number;
  baselineEventsObserved: number;
  destroyEventsObserved: number;
  /** Ids we've already emitted a spawn record for (avoid duplicate on first baseline). */
  emittedIds: Set<string>;
  /** Per-type spawn counts (cumulative). */
  spawnsByType: Map<string, number>;
  /** Per-type despawn counts (cumulative). */
  despawnsByType: Map<string, number>;
}

function makeStats(): DetectorStats {
  return {
    spawnRecordsEmitted: 0,
    despawnRecordsEmitted: 0,
    summariesEmitted: 0,
    creatorEventsObserved: 0,
    baselineEventsObserved: 0,
    destroyEventsObserved: 0,
    emittedIds: new Set<string>(),
    spawnsByType: new Map<string, number>(),
    despawnsByType: new Map<string, number>(),
  };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** 2D distance (x, z) — altitude is ignored because SWG's vertical window is small. */
function distance2D(a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Emit one NDJSON line to stdout. We use `console.log(JSON.stringify(...))`
 * so the output is line-delimited and consumable by `jq -c`, NDJSON
 * readers, etc. The final `ScenarioSummary` will be written as another
 * single-line JSON object below by `main()`.
 */
function emitLine(record: unknown): void {
  console.log(JSON.stringify(record, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

function buildScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  stats: DetectorStats,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('spawn', verbose);
    const selfId = ctx.sceneStart.playerNetworkId;
    log(
      `spawn-detector starting: types=${args.typesRaw}, includeDestroys=${args.includeDestroys}, summaryMs=${args.summaryMs}`,
    );

    const typeMatches = (typeId: number): boolean => {
      // typeId === 0 means "no baseline yet" — suppress the create event;
      // we'll re-emit when the first baseline lands and gives us a real tag.
      if (typeId === 0) return false;
      if (args.typeFilter === null) return true;
      return args.typeFilter.has(typeId);
    };

    /** Build the spawn/despawn record for a WorldObject. */
    const buildRecord = (
      kind: 'spawn' | 'despawn',
      obj: WorldObject,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => {
      const me = ctx.position();
      const dist =
        Number.isFinite(obj.position.x) && Number.isFinite(me.x)
          ? Number(distance2D(obj.position, me).toFixed(2))
          : null;
      return {
        kind,
        at: new Date().toISOString(),
        id: obj.id.toString(),
        typeIdString: obj.typeIdString,
        templateName: obj.templateName ?? null,
        position: {
          x: Number(obj.position.x.toFixed(2)),
          y: Number(obj.position.y.toFixed(2)),
          z: Number(obj.position.z.toFixed(2)),
        },
        distanceFromPlayer: dist,
        ...extra,
      };
    };

    const emitSpawn = (obj: WorldObject): void => {
      const key = obj.id.toString();
      if (stats.emittedIds.has(key)) return;
      if (obj.id === selfId) {
        // Don't bother emitting ourselves — we're the observer.
        stats.emittedIds.add(key);
        return;
      }
      if (!typeMatches(obj.typeId)) return;
      stats.emittedIds.add(key);
      bump(stats.spawnsByType, obj.typeIdString);
      if (args.summaryMs === 0) {
        emitLine(buildRecord('spawn', obj));
        stats.spawnRecordsEmitted++;
      }
    };

    const emitDespawn = (obj: WorldObject, hyperspace: boolean): void => {
      if (!args.includeDestroys) return;
      if (obj.id === selfId) return;
      // Only count departures for ids we actually emitted a spawn for —
      // otherwise the destroy is for an object we never reported on (e.g.
      // a non-matching type, or it never got a baseline).
      const key = obj.id.toString();
      if (!stats.emittedIds.has(key)) return;
      if (!typeMatches(obj.typeId)) return;
      bump(stats.despawnsByType, obj.typeIdString);
      if (args.summaryMs === 0) {
        emitLine(buildRecord('despawn', obj, { hyperspace }));
        stats.despawnRecordsEmitted++;
      }
    };

    const unsub = ctx.world.on((e: WorldEvent) => {
      if (e.kind === 'create') {
        stats.creatorEventsObserved++;
        // If the object already has a typeId (rare — Scene* doesn't carry
        // one, but a stateful message that landed before Scene* could
        // have synthesised one), emit immediately. Otherwise wait for
        // the first baseline.
        emitSpawn(e.object);
      } else if (e.kind === 'baseline') {
        stats.baselineEventsObserved++;
        // First baseline is when typeId becomes non-zero — that's when a
        // 'create' that we previously suppressed becomes eligible.
        emitSpawn(e.object);
      } else if (e.kind === 'destroy') {
        stats.destroyEventsObserved++;
        emitDespawn(e.lastKnown, e.hyperspace);
      }
    });

    // Pick up anything already in the world view at script start
    // (zone-in baseline flood lands before our handler attaches).
    for (const o of ctx.world.objects()) {
      emitSpawn(o);
    }

    // Periodic summary tick (only if summaryMs > 0).
    const flushSummary = (windowMs: number): void => {
      if (args.summaryMs === 0) return;
      const creates: Record<string, number> = {};
      for (const [k, v] of stats.spawnsByType) creates[k] = v;
      const destroys: Record<string, number> = {};
      for (const [k, v] of stats.despawnsByType) destroys[k] = v;
      emitLine({
        kind: 'summary',
        at: new Date().toISOString(),
        windowMs,
        cumulative: {
          spawns: stats.spawnsByType.size === 0 ? 0 : sumValues(stats.spawnsByType),
          despawns: stats.despawnsByType.size === 0 ? 0 : sumValues(stats.despawnsByType),
        },
        creates,
        destroys,
      });
      stats.summariesEmitted++;
    };

    try {
      if (args.summaryMs === 0) {
        await ctx.wait(totalMs);
      } else {
        const deadline = Date.now() + totalMs;
        while (Date.now() < deadline) {
          const slice = Math.min(args.summaryMs, deadline - Date.now());
          if (slice <= 0) break;
          await ctx.wait(slice);
          flushSummary(args.summaryMs);
        }
      }
    } finally {
      unsub();
    }

    log(
      `spawn-detector done: spawnRecords=${stats.spawnRecordsEmitted}, despawnRecords=${stats.despawnRecordsEmitted}, summaries=${stats.summariesEmitted}`,
    );
    await ctx.logout();
  };
}

function sumValues(m: Map<string, number>): number {
  let total = 0;
  for (const v of m.values()) total += v;
  return total;
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Stream every new (and optionally destroyed) object as NDJSON.', [
      '  --types=A,B,C            comma-separated type tags to include',
      '                             (default CREO,TANO,PLAY; "all"/"*" = no filter)',
      `                             known: ${Object.keys(ObjectTypeTags).join(',')}`,
      '  --include-destroys=BOOL  also emit despawn records (default true)',
      '  --summary-ms=N           0 = NDJSON per event (default); >0 = emit',
      '                             a summary record every N ms (counts by type)',
    ]);
    return 0;
  }
  let script: ScriptArgs;
  try {
    script = parseScriptArgs(args.extra);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const totalMs = durationMs(args.minutes);
  const stats = makeStats();
  const scenario = buildScenario(script, totalMs, args.verbose, stats);
  const { summary } = await runScenario(args, scenario);
  // Map → plain object for JSON emission.
  const spawnsByType: Record<string, number> = {};
  for (const [k, v] of stats.spawnsByType) spawnsByType[k] = v;
  const despawnsByType: Record<string, number> = {};
  for (const [k, v] of stats.despawnsByType) despawnsByType[k] = v;
  summary.extra = {
    typesRaw: script.typesRaw,
    typeFilter: script.typeFilter === null ? null : [...script.typeFilter].map(tagToString),
    includeDestroys: script.includeDestroys,
    summaryMs: script.summaryMs,
    spawnRecordsEmitted: stats.spawnRecordsEmitted,
    despawnRecordsEmitted: stats.despawnRecordsEmitted,
    summariesEmitted: stats.summariesEmitted,
    creatorEventsObserved: stats.creatorEventsObserved,
    baselineEventsObserved: stats.baselineEventsObserved,
    destroyEventsObserved: stats.destroyEventsObserved,
    uniqueSpawnsEmitted: stats.emittedIds.size,
    spawnsByType,
    despawnsByType,
  };
  // Force compact JSON so the summary is one line — keeps the stdout
  // stream valid NDJSON even with --pretty (which would otherwise break
  // line-delimited parsers).
  process.stdout.write(formatJson(summary, false));
  return summary.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
