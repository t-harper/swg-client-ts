#!/usr/bin/env node --import tsx
/**
 * hunter-crafter.ts — solo combat → loot → craft chain, end-to-end.
 *
 * The grand-tour demo: a single character zones in, hunts down the nearest
 * hostile creature, loots its corpse, walks back to a crafting tool already
 * in inventory, opens a session, assigns whatever ingredients fit the first
 * draft schematic's first slot, runs a single experimentation pass, and
 * finalizes a real prototype. Each step soft-fails (records into
 * `assertionFailures` / `extra.error`) when the prerequisites aren't
 * available — empty zones, NPE characters without crafting tools, etc. —
 * so the run still emits a meaningful JSON summary instead of blowing up.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/hunter-crafter.ts \
 *     --host=10.254.0.253 --user=tslive01 --character=ExHunter \
 *     --minutes=2 --verbose
 */

import {
  type NetworkId,
  ObjectTypeTags,
  type ScenarioFn,
  type ScriptContext,
  type WorldObject,
} from '../../src/index.js';
import {
  CraftingIngredientType,
  type ManufactureSchematicData,
} from '../../src/messages/game/crafting/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runScenario, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/hunter-crafter.ts';

const TOOL_PATTERN = /tool_survey_|tool_weapon|tool_food|tool_clothing|generic_tool|crafting_tool/i;
const NAME_TOOL_PATTERN = /craft|crafting_tool|survey_tool/i;
const SCAN_RADII_M = [80, 120, 160, 240] as const;
const ENGAGE_RANGE_M = 5;
const SCAN_BUDGET_MS = 30_000;

interface ScriptArgs {
  attackTickMs: number;
  combatTimeoutMs: number;
  experiment: boolean;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  const experimentRaw = extra.get('experiment');
  return {
    attackTickMs: Number.parseInt(extra.get('attack-tick-ms') ?? '1500', 10),
    combatTimeoutMs: Number.parseInt(extra.get('combat-timeout-ms') ?? '60000', 10),
    experiment: experimentRaw === undefined ? true : experimentRaw !== 'false',
  };
}

interface RunSummary {
  targetKilled: boolean;
  targetId: string | null;
  lootCount: number;
  lootIds: string[];
  schematicName: string | null;
  schematicIndex: number | null;
  slotsAssigned: number;
  prototypeCreated: boolean;
  prototypeId: string | null;
  totalElapsedMs: number;
  error: string | null;
}

function buildScenario(
  args: ScriptArgs,
  totalMs: number,
  verbose: boolean,
  out: RunSummary,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger('hunt', verbose);
    const startedAt = Date.now();
    const deadline = startedAt + totalMs;

    // 1. Wait for first CREO baselines so nearestHostile has SHARED_NP populated.
    log('waiting for character baseline');
    if (!(await waitFor(() => ctx.character.ready, ctx, 10_000))) {
      out.error = 'character baseline never arrived';
      ctx.fail(out.error);
      out.totalElapsedMs = Date.now() - startedAt;
      await ctx.logout();
      return;
    }
    log(`character ready: ${ctx.character.name} (${ctx.character.templateName ?? 'unknown'})`);

    // 2. Find a hostile — scan progressively outward; soft-fail after ~30s.
    const target = await findHostile(ctx, log);
    if (target === null) {
      out.error = 'no hostile creature found within scan budget';
      ctx.fail(out.error);
      out.totalElapsedMs = Date.now() - startedAt;
      await ctx.logout();
      return;
    }
    out.targetId = `0x${target.id.toString(16)}`;
    const targetId = target.id;
    log(
      `target acquired ${out.targetId} at (${target.position.x.toFixed(1)},${target.position.z.toFixed(1)})`,
    );

    // 3. Walk into combat range, engage. We let attackingNearest do the
    //    cadence + per-tick re-target — it terminates once our nearest
    //    hostile leaves the world (i.e. dies / despawns) or 60s elapses.
    // Stop short of the target so we don't shove into its hitbox; the
    // server's anti-cheat is happier with a few-meter buffer.
    const approach = approachPoint(ctx.position(), target.position, ENGAGE_RANGE_M);
    try {
      await ctx.walkTo({ x: approach.x, z: approach.z });
    } catch (err) {
      log(`walkTo failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const inventoryBefore = inventoryIdSet(ctx);
    log(`pre-combat inventory: ${inventoryBefore.size} items`);
    log(
      `engaging (timeout=${Math.min(args.combatTimeoutMs, Math.max(0, deadline - Date.now()))}ms)`,
    );
    await ctx.combat.attackingNearest({
      maxRadiusM: ENGAGE_RANGE_M * 4,
      tickMs: args.attackTickMs,
      timeoutMs: Math.min(args.combatTimeoutMs, Math.max(0, deadline - Date.now())),
    });

    // The target is "dead" from our perspective once the WorldModel drops it.
    // Some servers leave the corpse object behind for the loot interaction;
    // others vaporize it immediately. We track both.
    const targetGone = !ctx.world.has(targetId);
    out.targetKilled = targetGone;
    log(`combat finished: targetGone=${targetGone} engaged=${ctx.combat.engaged}`);

    // 4. Loot the corpse if it still exists. Servers that vaporize the
    //    creature on death give us nothing to target — we still wait a beat
    //    for any "auto-loot" inventory drops the server might push.
    if (ctx.world.has(targetId)) {
      log(`looting corpse ${out.targetId}`);
      ctx.useAbility('loot', targetId);
    } else {
      log('corpse already gone; skipping explicit loot');
    }
    await ctx.wait(2_500);

    // 5. Diff inventory against the pre-combat snapshot to count new items.
    const inventoryAfter = inventoryIdSet(ctx);
    const lootIds: NetworkId[] = [];
    for (const id of inventoryAfter) if (!inventoryBefore.has(id)) lootIds.push(id);
    out.lootCount = lootIds.length;
    out.lootIds = lootIds.map((id) => `0x${id.toString(16)}`);
    log(`loot: ${out.lootCount} new inventory item(s)`);

    // 6. Find a crafting tool already in inventory.
    const toolId = findCraftingTool(ctx);
    if (toolId === null) {
      out.error = 'no crafting tool in inventory (NPE chars do not start with one)';
      ctx.fail(out.error);
      out.totalElapsedMs = Date.now() - startedAt;
      await ctx.logout();
      return;
    }
    log(`crafting tool: 0x${toolId.toString(16)}`);

    // 7. Open a session, pick the first schematic, assign at least one
    //    resource slot from inventory, experiment once, finalize.
    const preCraftIds = inventoryIdSet(ctx);
    ctx.useAbility('cancelCraftingSession', toolId, '');
    await ctx.wait(1_500);
    ctx.beginCrafting(toolId);

    let schematics: Awaited<ReturnType<typeof ctx.waitForDraftSchematics>>;
    try {
      schematics = await ctx.waitForDraftSchematics({ timeoutMs: 10_000 });
    } catch (err) {
      out.error = `no draft schematics from tool: ${err instanceof Error ? err.message : String(err)}`;
      ctx.fail(out.error);
      out.totalElapsedMs = Date.now() - startedAt;
      await ctx.logout();
      return;
    }
    if (schematics.schematics.length === 0) {
      out.error = 'tool returned an empty schematics list';
      ctx.fail(out.error);
      out.totalElapsedMs = Date.now() - startedAt;
      await ctx.logout();
      return;
    }
    const first = schematics.schematics[0];
    if (first === undefined) {
      out.error = 'schematics list shape was empty after length check';
      ctx.fail(out.error);
      out.totalElapsedMs = Date.now() - startedAt;
      await ctx.logout();
      return;
    }
    out.schematicIndex = 0;
    out.schematicName = `crc:0x${first.sharedCrc.toString(16)}`;
    log(`picking schematic[0] = ${out.schematicName} (${schematics.schematics.length} available)`);

    ctx.selectCraftingSchematic(0);
    let slots: ManufactureSchematicData;
    try {
      slots = await ctx.waitForDraftSlots({ timeoutMs: 10_000 });
    } catch (err) {
      out.error = `no DraftSlots reply: ${err instanceof Error ? err.message : String(err)}`;
      ctx.fail(out.error);
      out.totalElapsedMs = Date.now() - startedAt;
      await ctx.logout();
      return;
    }
    log(
      `schematic has ${slots.slots.length} slots; manfSchemId=0x${slots.manfSchemId.toString(16)}`,
    );

    // Find at least one resource-class slot we can fill from inventory.
    let filled = 0;
    for (let i = 0; i < slots.slots.length; i++) {
      const slot = slots.slots[i];
      if (slot === undefined) continue;
      const optIdx = slot.options.findIndex((o) => o.type === CraftingIngredientType.ResourceClass);
      if (optIdx < 0) continue;
      const opt = slot.options[optIdx];
      if (opt === undefined) continue;
      const crate = pickResourceCrate(ctx, opt.ingredient, opt.amountNeeded);
      if (crate === null) {
        log(
          `  slot[${i}] needs ${opt.amountNeeded} "${opt.ingredient}" — no crate in inventory; skip`,
        );
        continue;
      }
      log(`  slot[${i}] ← crate 0x${crate.toString(16)} for "${opt.ingredient}"`);
      ctx.assignCraftingSlot(i, crate, { optionIndex: optIdx });
      filled++;
    }
    out.slotsAssigned = filled;
    if (filled === 0) {
      out.error = 'no inventory resources matched any schematic slot';
      ctx.fail(out.error);
      out.totalElapsedMs = Date.now() - startedAt;
      await ctx.logout();
      return;
    }
    await ctx.wait(2_000);

    if (args.experiment) {
      log('experimenting (1 point on attribute 0)');
      ctx.craftExperiment([{ attribute: 0, points: 1 }]);
      await ctx.wait(2_000);
    }

    log('finishCrafting (realPrototype)');
    ctx.finishCrafting(toolId, { realPrototype: true });

    // 8. Verify a new prototype landed. The server delivers it as a fresh
    //    item inside the inventory container — diff against the pre-craft
    //    snapshot and exclude the manufacture schematic + reported prototype
    //    so we don't double-count session bookkeeping.
    let newItem: NetworkId | null = null;
    const skipSet = new Set<string>([slots.manfSchemId.toString(), slots.prototypeId.toString()]);
    for (let i = 0; i < 30 && newItem === null; i++) {
      await ctx.wait(500);
      for (const id of inventoryIdSet(ctx)) {
        if (preCraftIds.has(id)) continue;
        if (skipSet.has(id.toString())) continue;
        newItem = id;
        break;
      }
    }
    if (newItem !== null) {
      out.prototypeCreated = true;
      out.prototypeId = `0x${newItem.toString(16)}`;
      log(`prototype landed: ${out.prototypeId}`);
    } else if (ctx.world.has(slots.prototypeId)) {
      out.prototypeCreated = true;
      out.prototypeId = `0x${slots.prototypeId.toString(16)}`;
      log(`no diff observed; using server-reported prototypeId ${out.prototypeId}`);
    } else {
      log('no prototype observed in inventory after finish');
    }

    out.totalElapsedMs = Date.now() - startedAt;
    await ctx.logout();
  };
}

async function waitFor(
  predicate: () => boolean,
  ctx: ScriptContext,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await ctx.wait(250);
  }
  return predicate();
}

async function findHostile(
  ctx: ScriptContext,
  log: (m: string) => void,
): Promise<WorldObject | null> {
  const deadline = Date.now() + SCAN_BUDGET_MS;
  for (const radius of SCAN_RADII_M) {
    const cand = ctx.nearestHostile({ maxRadiusM: radius });
    if (cand !== undefined) {
      log(`nearestHostile@${radius}m found 0x${cand.id.toString(16)}`);
      return cand;
    }
  }
  log(`no hostile in baseline; polling up to ${SCAN_BUDGET_MS}ms`);
  while (Date.now() < deadline) {
    for (const radius of SCAN_RADII_M) {
      const cand = ctx.nearestHostile({ maxRadiusM: radius });
      if (cand !== undefined) {
        log(`nearestHostile@${radius}m (poll) found 0x${cand.id.toString(16)}`);
        return cand;
      }
    }
    // Fallback: widen to any CREO that isn't us — some servers don't flip
    // `inCombat=true` until a real attack lands, so the strict hostile
    // filter misses sleeping mobs.
    const creo = ctx.findNearest(ObjectTypeTags.CREO, { maxRadiusM: 80, excludeSelf: true });
    if (creo !== undefined && creo.id !== ctx.sceneStart.playerNetworkId) {
      log(`fallback: nearest CREO 0x${creo.id.toString(16)} (no inCombat flag)`);
      return creo;
    }
    await ctx.wait(1_000);
  }
  return null;
}

function approachPoint(
  from: { x: number; z: number },
  to: { x: number; z: number },
  standoffM: number,
): { x: number; z: number } {
  const dx = from.x - to.x;
  const dz = from.z - to.z;
  const d = Math.hypot(dx, dz);
  if (d <= standoffM) return { x: from.x, z: from.z };
  const k = standoffM / d;
  return { x: to.x + dx * k, z: to.z + dz * k };
}

function inventoryIdSet(ctx: ScriptContext): Set<NetworkId> {
  const ids = new Set<NetworkId>();
  for (const it of ctx.inventory.items) ids.add(it.networkId);
  return ids;
}

function findCraftingTool(ctx: ScriptContext): NetworkId | null {
  for (const it of ctx.inventory.items) {
    if (it.templateName && TOOL_PATTERN.test(it.templateName)) return it.networkId;
    if (it.name && NAME_TOOL_PATTERN.test(it.name)) return it.networkId;
  }
  // Walk one level of nested containers (bags etc.) to catch tools stowed
  // in a starter satchel.
  for (const it of ctx.inventory.items) {
    for (const child of ctx.findInContainer(it.networkId)) {
      const tn = child.templateName ?? '';
      if (TOOL_PATTERN.test(tn)) return child.id;
    }
  }
  return null;
}

function pickResourceCrate(
  ctx: ScriptContext,
  _requestedClass: string,
  amountNeeded: number,
): NetworkId | null {
  // Naive match: any RCNO crate in inventory with quantity >= amountNeeded.
  // The crafting server validates the resource_class chain on its end so
  // this is a best-effort first pass — if it rejects, the prototype just
  // doesn't materialise and the run reports prototypeCreated=false. A more
  // rigorous match would call `fetchResourceAttributes([crate.resourceType])`
  // and inspect the `resource_class` chain; see `scripts/craft-a-tool.ts`.
  for (const crate of ctx.inventory.resources()) {
    if (crate.quantity >= amountNeeded) return crate.containerId;
  }
  return null;
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    usage(SCRIPT, 'Hunt nearest hostile, loot, walk to a crafting tool, craft a prototype.', [
      '  --attack-tick-ms=N       ms between attack ticks (default 1500)',
      '  --combat-timeout-ms=N    soft cap on attackingNearest budget (default 60000)',
      '  --experiment=BOOL        run one experimentation pass (default true)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const out: RunSummary = {
    targetKilled: false,
    targetId: null,
    lootCount: 0,
    lootIds: [],
    schematicName: null,
    schematicIndex: null,
    slotsAssigned: 0,
    prototypeCreated: false,
    prototypeId: null,
    totalElapsedMs: 0,
    error: null,
  };
  const scenario = buildScenario(script, totalMs, args.verbose, out);
  const { summary } = await runScenario(args, scenario);
  summary.extra = {
    targetKilled: out.targetKilled,
    targetId: out.targetId,
    lootCount: out.lootCount,
    lootIds: out.lootIds,
    schematicName: out.schematicName,
    schematicIndex: out.schematicIndex,
    slotsAssigned: out.slotsAssigned,
    prototypeCreated: out.prototypeCreated,
    prototypeId: out.prototypeId,
    totalElapsedMs: out.totalElapsedMs,
    error: out.error,
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
