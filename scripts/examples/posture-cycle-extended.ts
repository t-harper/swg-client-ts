#!/usr/bin/env node --import tsx
/**
 * posture-cycle-extended.ts — long-running posture cycle.
 *
 * Cycles standing → crouched → prone → sitting → standing forever, with a
 * configurable dwell. Extends the bundled `posture-cycle` scenario which
 * caps out at one cycle.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/posture-cycle-extended.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --dwell-ms=2500 --minutes=10
 */

import type { ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/posture-cycle-extended.ts';

const POSTURES = ['standing', 'crouched', 'prone', 'sitting'] as const;

interface ScriptArgs {
  dwellMs: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    dwellMs: Number.parseInt(extra.get('dwell-ms') ?? '2000', 10),
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('post', verbose);
    log(`posture-cycle dwell=${args.dwellMs}ms`);

    const deadline = Date.now() + totalMs;
    let i = 0;
    let appliedCount = 0;
    let mismatchCount = 0;
    while (Date.now() < deadline) {
      const pose = POSTURES[i % POSTURES.length];
      if (pose === undefined) break;
      ctx.changePosture(pose);
      i++;
      await ctx.wait(args.dwellMs);
      // After the dwell, the server should have applied the posture change
      // and pushed a CREO p3 (SHARED) delta with the new m_posture value.
      // `ctx.character.posture` reflects that delta in real time.
      const observed = ctx.character.posture;
      if (observed === pose) {
        appliedCount++;
        log(`${i}: requested=${pose} observed=${observed} ✓`);
      } else {
        mismatchCount++;
        log(`${i}: requested=${pose} observed=${observed} (mismatch)`);
      }
    }
    log(
      `posture-cycle done: ${i} transitions (${appliedCount} confirmed, ${mismatchCount} mismatched)`,
    );
    // End in standing for clean logout pose
    ctx.changePosture('standing');
    await ctx.wait(500);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Cycle posture endlessly: stand → crouch → prone → sit.', [
      '  --dwell-ms=N             ms held in each pose (default 2000)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const scenario = buildScenario(script, totalMs, args.verbose);
  const { summary } = await runScenario(args, scenario);
  summary.extra = { ...script };
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
