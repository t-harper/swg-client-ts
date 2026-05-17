#!/usr/bin/env node --import tsx
/**
 * bank-tourist.ts — auto-find the nearest bank in the scene, walk to it,
 * "open" its container, dwell, then walk away. Loop.
 *
 * Auto-resolution: scans `ctx.world` for objects whose `templateName` matches
 * `/bank/i` (catches `object/tangible/terminal/terminal_bank.iff`, the planet
 * bank buildings `bank_general` / `bank_tatooine` / `bank_naboo` / `bank_corellia`
 * / `bank_restuss`, and player-city banks), then picks the nearest by 2D
 * distance from the player. Read-only sightseeing — no transfers, no
 * destructive operations.
 *
 * Designed to exercise the open-container + walk-away-equals-close pattern
 * over long durations without requiring a hardcoded NetworkId.
 *
 * Fallback: if no bank baseline has arrived after `--scan-ms`, the script
 * logs "no bank in scene" and exits cleanly (no walk, no dwell).
 *
 * Example:
 *   pnpm exec tsx scripts/examples/bank-tourist.ts \
 *     --host=10.254.0.253 --user=ci-test --character=TsTest \
 *     --dwell-ms=4000 --walk-away=15 --minutes=5
 *
 * Overrides (back-compat):
 *   --bank-id=N              skip auto-resolve; use this NetworkId
 *   --bank-x=N --bank-z=N    skip auto-resolve; walk to (spawn+x, spawn+z)
 *                            (and open inventory as a container stand-in)
 */

import type { NetworkId, ScenarioFn, WorldObject } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/bank-tourist.ts';

interface ScriptArgs {
  /** Override: walk to (spawn + bankX, spawn + bankZ) instead of auto-resolving. */
  bankX: number | null;
  /** Override: walk to (spawn + bankX, spawn + bankZ) instead of auto-resolving. */
  bankZ: number | null;
  /** Override: open this NetworkId instead of auto-resolving. */
  bankId: NetworkId | null;
  /** Max ms to wait for a bank baseline to arrive before giving up. */
  scanMs: number;
  /** Ignore banks farther than this from the spawn (m). */
  maxRadiusM: number;
  dwellMs: number;
  walkAwayDistance: number;
  speed: number;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const idRaw = extra.get('bank-id');
  const xRaw = extra.get('bank-x');
  const zRaw = extra.get('bank-z');
  return {
    bankX: xRaw !== undefined && xRaw !== '' ? Number.parseFloat(xRaw) : null,
    bankZ: zRaw !== undefined && zRaw !== '' ? Number.parseFloat(zRaw) : null,
    bankId: idRaw !== undefined && idRaw !== '' ? (BigInt(idRaw) as NetworkId) : null,
    scanMs: Number.parseInt(extra.get('scan-ms') ?? '5000', 10),
    maxRadiusM: Number.parseFloat(extra.get('max-radius') ?? '500'),
    dwellMs: Number.parseInt(extra.get('dwell-ms') ?? '4000', 10),
    walkAwayDistance: Number.parseFloat(extra.get('walk-away') ?? '15'),
    speed: Number.parseFloat(extra.get('speed') ?? '5'),
  };
}

const BANK_PATTERN = /bank/i;

/**
 * Returns true if a WorldObject's template path looks like a bank — covers
 * `terminal_bank.iff`, the planet bank buildings (`bank_general` /
 * `bank_tatooine` / `bank_naboo` / `bank_corellia` / `bank_restuss`),
 * player-city banks, and the `floor_terminal_bank` / `wall_terminal_bank`
 * worldbuilding variants. Filters out anything without a template name
 * (objects we've only seen the baseline for, not a Scene*ByName create) and
 * the `character_bank` slot template (which is the per-player bank container
 * sub-object, not a terminal/building you'd walk up to).
 */
function isBankObject(o: WorldObject): boolean {
  const t = o.templateName;
  if (t === undefined) return false;
  if (!BANK_PATTERN.test(t)) return false;
  // Skip the player's own bank slot sub-object — it lives inside the player
  // and isn't a terminal you walk up to.
  if (t.includes('character_bank')) return false;
  return true;
}

/**
 * Find the nearest bank in the WorldModel, or `undefined` if none. Polls
 * up to `scanMs` because the planet's baseline flood can take a few hundred
 * ms after zone-in to drop the terminal's `SceneCreateObjectByName`.
 */
async function findNearestBank(
  ctx: Parameters<ScenarioFn>[0],
  scanMs: number,
  maxRadiusM: number,
  log: (msg: string) => void,
): Promise<WorldObject | undefined> {
  const here = ctx.position();
  const maxR2 = maxRadiusM * maxRadiusM;
  const deadline = Date.now() + scanMs;
  let pollMs = 200;
  while (Date.now() < deadline) {
    const candidates = ctx.world.filter(isBankObject);
    let best: WorldObject | undefined;
    let bestD2 = Number.POSITIVE_INFINITY;
    for (const o of candidates) {
      const dx = o.position.x - here.x;
      const dz = o.position.z - here.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > maxR2) continue;
      if (d2 < bestD2) {
        best = o;
        bestD2 = d2;
      }
    }
    if (best !== undefined) {
      log(
        `found bank: id=0x${best.id.toString(16)} template=${best.templateName} dist=${Math.sqrt(bestD2).toFixed(1)}m`,
      );
      return best;
    }
    await ctx.wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    pollMs = Math.min(1000, pollMs * 2);
  }
  return undefined;
}

function buildScenario(args: ScriptArgs, totalMs: number, verbose: boolean): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('bank', verbose);
    const spawn = ctx.sceneStart.startPosition;

    // ── Resolve target ─────────────────────────────────────────────────
    let bankWorld: { x: number; z: number };
    let bankId: NetworkId | null;
    let usingOverride = false;

    if (args.bankX !== null && args.bankZ !== null) {
      // Override: legacy spawn-relative coords.
      bankWorld = { x: spawn.x + args.bankX, z: spawn.z + args.bankZ };
      bankId = args.bankId;
      usingOverride = true;
      log(
        `override coords @ (${bankWorld.x.toFixed(1)}, ${bankWorld.z.toFixed(1)}) bankId=${bankId === null ? '<inventory>' : `0x${bankId.toString(16)}`}`,
      );
    } else if (args.bankId !== null) {
      // Override: explicit NetworkId — pull its position from the WorldModel.
      const o = ctx.world.get(args.bankId);
      if (o === undefined) {
        log(`bank-id override 0x${args.bankId.toString(16)} not in world; exiting`);
        await ctx.logout();
        return;
      }
      bankWorld = { x: o.position.x, z: o.position.z };
      bankId = args.bankId;
      usingOverride = true;
      log(
        `override id 0x${bankId.toString(16)} @ (${bankWorld.x.toFixed(1)}, ${bankWorld.z.toFixed(1)})`,
      );
    } else {
      // Auto-resolve via WorldModel.
      const bank = await findNearestBank(ctx, args.scanMs, args.maxRadiusM, log);
      if (bank === undefined) {
        log(`no bank in scene (scanned ${args.scanMs}ms, radius ${args.maxRadiusM}m)`);
        await ctx.logout();
        return;
      }
      bankWorld = { x: bank.position.x, z: bank.position.z };
      bankId = bank.id;
    }

    // The "away" point is `walkAwayDistance` metres back toward spawn along
    // the bank→spawn vector (so we end up at a known-safe location), with a
    // fallback to a fixed offset if we're sitting on top of the spawn.
    const dx = spawn.x - bankWorld.x;
    const dz = spawn.z - bankWorld.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    const awayWorld =
      len > 0.5
        ? {
            x: bankWorld.x + (dx / len) * args.walkAwayDistance,
            z: bankWorld.z + (dz / len) * args.walkAwayDistance,
          }
        : { x: bankWorld.x - args.walkAwayDistance, z: bankWorld.z - args.walkAwayDistance };

    // ── Tour loop ──────────────────────────────────────────────────────
    const deadline = Date.now() + totalMs;
    let trips = 0;
    while (Date.now() < deadline) {
      // 1. Walk to the bank
      log(`trip ${trips}: walking to bank (${bankWorld.x.toFixed(1)}, ${bankWorld.z.toFixed(1)})`);
      await ctx.walkTo(bankWorld, { speed: args.speed });

      // 2. Open the container (read-only — no transactions performed)
      if (bankId !== null) {
        ctx.openContainer(bankId);
      } else {
        // Override path with only --bank-x/--bank-z: open inventory as a
        // container stand-in (preserves the original walk+open soak shape).
        ctx.openPlayerInventory();
      }

      // 3. Dwell
      await ctx.wait(args.dwellMs);

      // 4. Walk away
      if (Date.now() < deadline) {
        await ctx.walkTo(awayWorld, { speed: args.speed });
      }
      trips++;
    }
    log(`done: ${trips} bank visits${usingOverride ? ' (override)' : ''}`);
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Auto-find the nearest bank, walk to it, open it, dwell, walk away. Loop.', [
      '  --scan-ms=N              ms to wait for a bank baseline to arrive (default 5000)',
      '  --max-radius=N           ignore banks farther than this from spawn (m, default 500)',
      '  --dwell-ms=N             ms held with bank open (default 4000)',
      '  --walk-away=N            distance to walk back toward spawn after closing (default 15)',
      '  --speed=N                walk speed (default 5)',
      '',
      'Overrides (skip auto-resolve):',
      '  --bank-id=N              open this NetworkId; walk to its world position',
      '  --bank-x=N --bank-z=N    walk to (spawn+x, spawn+z); open inventory as stand-in',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const scenario = buildScenario(script, totalMs, args.verbose);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    ...script,
    bankId: script.bankId === null ? null : `0x${script.bankId.toString(16)}`,
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
