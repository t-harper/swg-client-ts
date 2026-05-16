/**
 * Bundled scenarios for the CLI's `--script=<name>` flag. Each factory
 * accepts a `Record<string,string>` of CLI-supplied args and returns a
 * `ScenarioFn` ready to hand to `SwgClient.fullLifecycle({ script })`.
 *
 * Add a new scenario:
 *   1. Define a factory below.
 *   2. Add it to the `scenarios` map at the bottom.
 *   3. Document its args.
 */

import type { Posture, ScenarioFn } from '../client/script/context.js';
import type { NetworkId } from '../types.js';

export type ScenarioFactory = (args: Record<string, string>) => ScenarioFn;

/** Walk in a straight line from spawn to (x, z) then idle for `holdMs`. */
export const walkLine: ScenarioFactory = (args) => {
  const x = numArg(args, 'x', 0);
  const z = numArg(args, 'z', 0);
  const speed = numArg(args, 'speed', 5);
  const holdMs = numArg(args, 'holdMs', 1000);
  return async (ctx) => {
    await ctx.walkTo({ x, z }, { speed });
    if (holdMs > 0) await ctx.wait(holdMs);
  };
};

/** Walk a circle centred on (centerX, centerZ) (defaults to current pos) for `durationMs`. */
export const walkCircle: ScenarioFactory = (args) => {
  const radius = numArg(args, 'radius', 8);
  const durationMs = numArg(args, 'durationMs', 5000);
  const speed = args.speed !== undefined ? Number(args.speed) : undefined;
  const direction = args.direction === '-1' ? -1 : 1;
  return async (ctx) => {
    const cur = ctx.position();
    const centerX = args.centerX !== undefined ? Number(args.centerX) : cur.x;
    const centerZ = args.centerZ !== undefined ? Number(args.centerZ) : cur.z;
    await ctx.walkCircle({
      centerX,
      centerZ,
      radius,
      durationMs,
      direction,
      ...(speed !== undefined ? { speed } : {}),
    });
  };
};

/** Open the player's inventory, hold for `holdMs`, then close (no-op on wire). */
export const openInventory: ScenarioFactory = (args) => {
  const holdMs = numArg(args, 'holdMs', 2000);
  return async (ctx) => {
    ctx.openPlayerInventory();
    if (holdMs > 0) await ctx.wait(holdMs);
    ctx.closeContainer(ctx.sceneStart.playerNetworkId);
  };
};

/** Just idle for `durationMs` — useful as a sanity baseline. */
export const dwell: ScenarioFactory = (args) => {
  const durationMs = numArg(args, 'durationMs', 5000);
  return async (ctx) => {
    if (durationMs > 0) await ctx.wait(durationMs);
  };
};

/**
 * Queue `attack` against a fixed target every ~tickMs for durationMs.
 *
 * Args:
 *   targetId   (required) hex (0x...) or decimal NetworkId of the victim
 *   durationMs (default 5000) total attack window
 *   tickMs     (default 1000) cadence between enqueues
 */
export const combatAttack: ScenarioFactory = (args) => {
  const targetId = networkIdArg(args, 'targetId');
  const durationMs = numArg(args, 'durationMs', 5000);
  const tickMs = numArg(args, 'tickMs', 1000);
  if (tickMs <= 0) {
    throw new Error(`combat-attack: tickMs must be > 0 (got ${tickMs})`);
  }
  return async (ctx) => {
    const deadline = Date.now() + durationMs;
    // Emit one immediately, then re-queue every tickMs until durationMs elapses.
    ctx.attackTarget(targetId);
    while (Date.now() + tickMs <= deadline) {
      await ctx.wait(tickMs);
      ctx.attackTarget(targetId);
    }
  };
};

/**
 * Cycle through postures (standing → crouched → prone → standing) every
 * `tickMs` for `durationMs`. Useful as a visual smoke test that the
 * combat-engine wiring round-trips end to end.
 *
 * Args:
 *   durationMs (default 5000)
 *   tickMs     (default 1000) ms between posture changes
 */
export const postureCycle: ScenarioFactory = (args) => {
  const durationMs = numArg(args, 'durationMs', 5000);
  const tickMs = numArg(args, 'tickMs', 1000);
  if (tickMs <= 0) {
    throw new Error(`posture-cycle: tickMs must be > 0 (got ${tickMs})`);
  }
  const sequence: Posture[] = ['standing', 'crouched', 'prone', 'standing'];
  return async (ctx) => {
    const deadline = Date.now() + durationMs;
    let i = 0;
    ctx.changePosture(sequence[i++ % sequence.length] as Posture);
    while (Date.now() + tickMs <= deadline) {
      await ctx.wait(tickMs);
      ctx.changePosture(sequence[i++ % sequence.length] as Posture);
    }
  };
};

export const scenarios: Record<string, ScenarioFactory> = {
  'walk-line': walkLine,
  'walk-circle': walkCircle,
  'open-inventory': openInventory,
  'combat-attack': combatAttack,
  'posture-cycle': postureCycle,
  dwell,
};

function numArg(args: Record<string, string>, key: string, defaultValue: number): number {
  const raw = args[key];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`scenario arg --script-arg=${key}=${raw} is not a number`);
  }
  return n;
}

/**
 * Parse a required NetworkId from `args[key]`. Accepts:
 *   - hex literal:  "0xdeadbeef"  / "0xDEADBEEF"
 *   - decimal:      "16039260784"
 *
 * Throws with a clear error if the arg is missing or unparseable.
 */
function networkIdArg(args: Record<string, string>, key: string): NetworkId {
  const raw = args[key];
  if (raw === undefined || raw === '') {
    throw new Error(`missing required scenario arg --script-arg=${key}=<NetworkId>`);
  }
  try {
    return BigInt(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`scenario arg --script-arg=${key}=${raw} is not a valid NetworkId (${reason})`);
  }
}
