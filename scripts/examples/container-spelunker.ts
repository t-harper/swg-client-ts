#!/usr/bin/env node --import tsx
/**
 * container-spelunker.ts — open the player inventory (or any container by id),
 * then walk the live WorldModel to enumerate every item inside it down to
 * `--max-depth` levels of nested containers.
 *
 * Unlike the original (which scanned the post-mortem transcript), this version
 * queries `ctx.findInContainer(id)` against the live WorldModel — the same
 * source of truth `ctx.world` exposes during the dwell. The model already
 * absorbs every baseline + containment update from the server, so we just need
 * to wait briefly for the baseline flood to settle after `openContainer` and
 * then read the tree.
 *
 * We deliberately do NOT call `openContainer` recursively on every child:
 * issuing an Open per-container floods the server with redundant baseline
 * requests. The WorldModel already has the baselines for everything in view
 * (including nested-in-container items the server pushed during zone-in or
 * during the first open).
 *
 * Example:
 *   pnpm exec tsx scripts/examples/container-spelunker.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --scan-ms=3000 --max-depth=4
 *
 *   # start from a specific container (bank, backpack, datapad, etc.) instead
 *   # of the player's inventory:
 *   pnpm exec tsx scripts/examples/container-spelunker.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --container=0x123456 --scan-ms=3000 --max-depth=4
 */

import {
  type NetworkId,
  ObjectTypeTags,
  type ScenarioFn,
  type WorldObject,
  extractInventoryContainerId,
} from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/container-spelunker.ts';

interface SpelunkEntry {
  id: string;
  templateName: string;
  typeIdString: string;
  depth: number;
}

interface ScriptArgs {
  scanMs: number;
  maxDepth: number;
  /** Optional root container id (hex/decimal). When unset, uses the player inventory. */
  rootContainer: NetworkId | null;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = (extra.get('container') ?? '').trim();
  let rootContainer: NetworkId | null = null;
  if (raw !== '') rootContainer = BigInt(raw) as NetworkId;
  return {
    scanMs: Number.parseInt(extra.get('scan-ms') ?? '3000', 10),
    maxDepth: Number.parseInt(extra.get('max-depth') ?? '4', 10),
    rootContainer,
  };
}

/** Types that can themselves hold children. Anything else is a leaf. */
const CONTAINER_CAPABLE_TYPES = new Set<number>([
  ObjectTypeTags.TANO,
  ObjectTypeTags.BUIO,
  ObjectTypeTags.WEAO,
  ObjectTypeTags.RCNO,
  ObjectTypeTags.SCLT,
]);

function buildScenario(
  args: ScriptArgs,
  verbose: boolean,
  results: { entries: SpelunkEntry[]; rootId: NetworkId | null; rootSource: string },
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('spelnk', verbose);

    // 1) Resolve the root container.
    let rootId: NetworkId | null = args.rootContainer;
    let rootSource: string;
    if (rootId !== null) {
      rootSource = 'cli';
      log(`opening user-supplied container 0x${rootId.toString(16)}`);
      ctx.openContainer(rootId);
    } else {
      rootSource = 'inventory';
      log('opening player inventory');
      ctx.openPlayerInventory();
      // The inventory id appears in the baseline flood; let it land before
      // asking for it.
      await ctx.wait(args.scanMs);
      rootId = extractInventoryContainerId(ctx.dispatcher.transcript);
      if (rootId === null) {
        log('failed to resolve inventory container id from baselines');
        await ctx.logout();
        return;
      }
      log(`resolved inventory container 0x${rootId.toString(16)}`);
    }
    results.rootId = rootId;
    results.rootSource = rootSource;

    // If we were given a --container=... explicitly, still let the baselines
    // for its first level settle before we snapshot the world model.
    if (rootSource === 'cli') await ctx.wait(args.scanMs);

    // 2) Recursive walk via the live world model. Depth-limited; cycle-safe
    // (a Set of already-visited ids prevents pathological self-loops in
    // weird server responses).
    const visited = new Set<bigint>();
    const stack: Array<{ id: NetworkId; depth: number }> = [{ id: rootId, depth: 0 }];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame === undefined) break;
      const { id, depth } = frame;
      if (visited.has(id)) continue;
      visited.add(id);

      const children: WorldObject[] = ctx.findInContainer(id);
      for (const child of children) {
        results.entries.push({
          id: `0x${child.id.toString(16)}`,
          templateName: child.templateName ?? '',
          typeIdString: child.typeIdString,
          depth: depth + 1,
        });
        if (depth + 1 >= args.maxDepth) continue;
        if (!CONTAINER_CAPABLE_TYPES.has(child.typeId)) continue;
        stack.push({ id: child.id, depth: depth + 1 });
      }
    }
    log(
      `walked ${visited.size} containers, found ${results.entries.length} items (max depth ${args.maxDepth})`,
    );
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(
      SCRIPT,
      'Open a container and recursively enumerate its contents via the live WorldModel.',
      [
        '  --scan-ms=N              wait this many ms after open for baselines (default 3000)',
        '  --max-depth=N            recursion depth limit (default 4)',
        '  --container=0x...        start from this container id instead of the player inventory',
      ],
    );
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  void totalMs; // duration is governed by ctx.wait() + recursion, not a wall-clock cap
  const results = {
    entries: [] as SpelunkEntry[],
    rootId: null as NetworkId | null,
    rootSource: '',
  };
  const scenario = buildScenario(script, args.verbose, results);
  const { summary } = await runScenario(args, scenario);

  // Group by depth for quick eyeballing in CI logs.
  const depthCounts: Record<string, number> = {};
  for (const e of results.entries) {
    const k = String(e.depth);
    depthCounts[k] = (depthCounts[k] ?? 0) + 1;
  }

  summary.extra = {
    rootSource: results.rootSource,
    rootContainerId: results.rootId === null ? null : `0x${results.rootId.toString(16)}`,
    maxDepth: script.maxDepth,
    scanMs: script.scanMs,
    totalEntries: results.entries.length,
    depthCounts,
    entries: results.entries,
  };
  process.stdout.write(formatJson(summary, args.pretty));
  return summary.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
