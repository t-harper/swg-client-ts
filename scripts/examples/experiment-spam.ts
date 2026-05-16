#!/usr/bin/env node --import tsx
/**
 * experiment-spam.ts — given a crafting tool with an already-selected
 * schematic, repeatedly run craftExperiment in a loop with a configurable
 * attribute/points distribution.
 *
 * The script opens a crafting session and immediately starts experimenting.
 * Realistically you'll have selected a schematic first (use the
 * `selectCraftingSchematic` primitive); this script keeps it simple by
 * doing both up front from the configurable `--schematic-index`.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/experiment-spam.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --tool-id=0x12345 --schematic-index=0 \
 *     --attributes=0:2,1:1 --interval-ms=2000 --minutes=3
 */

import type { NetworkId, ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/experiment-spam.ts';

interface ScriptArgs {
  toolId: NetworkId;
  schematicIndex: number;
  attributes: Array<{ attribute: number; points: number }>;
  intervalMs: number;
}

function parseAttributes(raw: string): Array<{ attribute: number; points: number }> {
  const out: Array<{ attribute: number; points: number }> = [];
  for (const pair of raw.split(',').map((s) => s.trim())) {
    if (pair.length === 0) continue;
    const [a, p] = pair.split(':');
    if (a === undefined || p === undefined) continue;
    const attribute = Number.parseInt(a, 10);
    const points = Number.parseInt(p, 10);
    if (Number.isFinite(attribute) && Number.isFinite(points)) {
      out.push({ attribute, points });
    }
  }
  return out;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('tool-id') ?? '0';
  return {
    toolId: BigInt(raw) as NetworkId,
    schematicIndex: Number.parseInt(extra.get('schematic-index') ?? '0', 10),
    attributes: parseAttributes(extra.get('attributes') ?? '0:1'),
    intervalMs: Number.parseInt(extra.get('interval-ms') ?? '2000', 10),
  };
}

function buildScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  state: { experiments: number },
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('exp', verbose);
    if (args.toolId === 0n) throw new Error('--tool-id is required');
    if (args.attributes.length === 0) throw new Error('--attributes is required (e.g. 0:2,1:1)');
    log(`crafting tool=0x${args.toolId.toString(16)} schematicIdx=${args.schematicIndex}`);

    ctx.beginCrafting(args.toolId);
    await ctx.wait(500);
    ctx.selectCraftingSchematic(args.schematicIndex);
    await ctx.wait(500);

    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline) {
      const seq = ctx.craftExperiment(args.attributes);
      state.experiments++;
      if (state.experiments % 10 === 0) log(`exp ${state.experiments} seq=${seq}`);
      await ctx.wait(args.intervalMs);
    }
    log(`done: ${state.experiments} experiments`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Open a crafting session, select schematic, spam craftExperiment.', [
      '  --tool-id=N              crafting tool NetworkId (required)',
      '  --schematic-index=N      draft schematic index (default 0)',
      '  --attributes=I:P,I:P     attr:points pairs (e.g. 0:2,1:1)',
      '  --interval-ms=N          ms between experiments (default 2000)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const state = { experiments: 0 };
  const scenario = buildScenario(script, totalMs, args.verbose, state);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    toolId: `0x${script.toolId.toString(16)}`,
    schematicIndex: script.schematicIndex,
    attributes: script.attributes,
    experiments: state.experiments,
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
