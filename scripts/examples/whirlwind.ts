#!/usr/bin/env node --import tsx
/**
 * whirlwind.ts — walk a tight circle while attacking + posture-changing on
 * each tick. Hammers all three command-queue subtypes simultaneously, useful
 * for triggering server-side queue overflows.
 *
 * Each tick:
 *   - Step around a tight circle
 *   - Queue an attack against the target
 *   - Cycle posture (stand → crouch → stand → prone …)
 *
 * Example:
 *   pnpm exec tsx scripts/examples/whirlwind.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --target-id=0x9999999 --radius=4 --tick-ms=400 --minutes=2
 */

import type { NetworkId, ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/whirlwind.ts';

const POSTURES = ['standing', 'crouched', 'standing', 'prone'] as const;

interface ScriptArgs {
  targetId: NetworkId;
  radius: number;
  tickMs: number;
  cycleSeconds: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const raw = extra.get('target-id') ?? '0';
  return {
    targetId: BigInt(raw) as NetworkId,
    radius: Number.parseFloat(extra.get('radius') ?? '4'),
    tickMs: Number.parseInt(extra.get('tick-ms') ?? '400', 10),
    cycleSeconds: Number.parseFloat(extra.get('cycle-seconds') ?? '4'),
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('whrl', verbose);
    if (args.targetId === 0n) throw new Error('--target-id is required');
    const spawn = ctx.sceneStart.startPosition;
    log(`whirlwind r=${args.radius} tick=${args.tickMs}ms cycleSecs=${args.cycleSeconds}`);

    const deadline = Date.now() + totalMs;
    let tick = 0;
    const omegaPerMs = (2 * Math.PI) / (args.cycleSeconds * 1_000);
    const t0 = Date.now();
    while (Date.now() < deadline) {
      const t = Date.now() - t0;
      const angle = t * omegaPerMs;
      const x = spawn.x + Math.cos(angle) * args.radius;
      const z = spawn.z + Math.sin(angle) * args.radius;
      await ctx.walkTo({ x, z }, { speed: 8, tickMs: args.tickMs });
      ctx.attackTarget(args.targetId);
      const pose = POSTURES[tick % POSTURES.length];
      if (pose !== undefined) ctx.changePosture(pose);
      tick++;
      if (tick % 10 === 0) log(`tick ${tick}`);
      await ctx.wait(args.tickMs);
    }
    log(`whirlwind done: ${tick} ticks`);
    ctx.changePosture('standing');
    await ctx.wait(500);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Walk a tight circle while attacking + posture-changing.', [
      '  --target-id=N            target NetworkId (decimal or 0x... hex) (required)',
      '  --radius=N               circle radius in m (default 4)',
      '  --tick-ms=N              ms per tick (default 400)',
      '  --cycle-seconds=N        seconds for one full revolution (default 4)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const scenario = buildScenario(script, totalMs, args.verbose);
  const { summary } = await runScenario(args, scenario);
  summary.extra = { ...script, targetId: `0x${script.targetId.toString(16)}` };
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
