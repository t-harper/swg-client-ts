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

import type { ScenarioFn } from '../client/script/context.js';

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

export const scenarios: Record<string, ScenarioFactory> = {
  'walk-line': walkLine,
  'walk-circle': walkCircle,
  'open-inventory': openInventory,
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
};
