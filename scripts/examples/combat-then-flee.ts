#!/usr/bin/env node --import tsx
/**
 * combat-then-flee.ts — attack the nearest hostile until it dies; when our
 * health drops, break combat and walk to safe coords.
 *
 * Driven entirely by `ctx.combat.attackingNearest()` + `ctx.combat.autoLoot`
 * + `ctx.safety.fleeWhenHealthBelow()`. The flee watcher fires once when
 * health drops, sends `peace`, optionally calls/mounts a vehicle, then
 * walks. The main loop just churns hostile after hostile.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/combat-then-flee.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --health-bail=0.3 --flee-x=0 --flee-z=0 --minutes=10
 */

import type { ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/combat-then-flee.ts';
const AUTO_PICK_RADIUS_M = 40;

interface ScriptArgs {
  tickMs: number;
  healthBailFraction: number;
  fleeX: number;
  fleeZ: number;
  fleeSpeed: number;
  restMs: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    tickMs: Number.parseInt(extra.get('tick-ms') ?? '1500', 10),
    healthBailFraction: Number.parseFloat(extra.get('health-bail') ?? '0.3'),
    fleeX: Number.parseFloat(extra.get('flee-x') ?? '0'),
    fleeZ: Number.parseFloat(extra.get('flee-z') ?? '0'),
    fleeSpeed: Number.parseFloat(extra.get('flee-speed') ?? '12'),
    restMs: Number.parseInt(extra.get('rest-ms') ?? '2000', 10),
  };
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('flee', verbose);
    log(
      `auto-engage nearest hostile within ${AUTO_PICK_RADIUS_M}m; flee at health<${args.healthBailFraction} → (${args.fleeX},${args.fleeZ})`,
    );

    ctx.combat.autoLoot = true;
    let fled = false;
    ctx.safety.fleeWhenHealthBelow(args.healthBailFraction, {
      goTo: { x: args.fleeX, z: args.fleeZ },
      usePeace: true,
      useVehicle: true,
      speed: args.fleeSpeed,
      onTrigger: (info) => {
        fled = true;
        log(
          `FLEE TRIGGERED: ratio=${info.healthRatio.toFixed(2)} hp=${info.health}/${info.healthMax} vehicle=${info.usingVehicle}`,
        );
      },
    });

    const deadline = Date.now() + totalMs;
    let cycles = 0;
    while (Date.now() < deadline && !fled) {
      cycles++;
      await ctx.combat.attackingNearest({
        maxRadiusM: AUTO_PICK_RADIUS_M,
        tickMs: args.tickMs,
        timeoutMs: Math.min(60_000, Math.max(1_000, deadline - Date.now())),
      });
      if (cycles % 3 === 0) {
        const h = ctx.character.health;
        log(`cycle=${cycles} ham=${h.current}/${h.max} engaged=${ctx.combat.engaged}`);
      }
      if (args.restMs > 0) {
        await ctx.wait(Math.min(args.restMs, Math.max(0, deadline - Date.now())));
      }
    }
    log(`done: cycles=${cycles} fled=${fled}`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Auto-attack the nearest hostile; flee with peace+vehicle when health drops.', [
      '  --tick-ms=N              ms between attacks during burst (default 1500)',
      '  --rest-ms=N              rest after each kill (default 2000)',
      '  --health-bail=F          flee when health.current/health.max drops below this',
      '                           fraction (default 0.3)',
      '  --flee-x=N               flee destination X (default 0)',
      '  --flee-z=N               flee destination Z (default 0)',
      '  --flee-speed=N           walk speed during flee (default 12, clamped by mounted cap)',
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
