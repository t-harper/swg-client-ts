/**
 * Survey → harvest → craft. End-to-end demo of the crafting-discovery flow:
 *
 *   1. Find a tuned crafting tool in inventory.
 *   2. Open a crafting session and dump the available draft schematics.
 *   3. Pick the first schematic whose shared-template name matches one of
 *      `--target=<keyword>` (default: any "survey_tool" or "generic_tool" —
 *      i.e. a craftable tool).
 *   4. Walk to a known high-density mineral spot (or honor --x / --z).
 *   5. Survey for the slot's matching resource class. For each slot, find
 *      an existing inventory container or sample until we have ≥ the
 *      required units.
 *   6. Assign each slot to the matching container.
 *   7. Skip experimentation (default — pass --experiment to enable a single
 *      pass) and finalize as a real prototype.
 *   8. Wait for the new item to land in inventory; dump its attributes.
 *
 * Defaults are tuned for the swg2/Artisan7374 character which already has
 * survey tools spawned via /object createIn and 152+ units of
 * Carboseuweroris (steel_arveshian = metal/mineral) in inventory — so the
 * default run skips both survey and sample and crafts immediately.
 *
 * Usage:
 *   pnpm tsx scripts/craft-a-tool.ts --host=10.254.0.253 --user=swg2 \
 *     --character=Artisan7374 [--target=gas|wind|mineral|generic_tool|...]
 *     [--x=3511 --z=-4790]
 */

import {
  SwgClient,
  buildContainerIndex,
  type LifecycleResult,
  type NetworkId,
  type ScenarioFn,
  type ScriptContext,
} from '../src/index.js';
import {
  CraftingIngredientType,
  type ManufactureSchematicSlot,
} from '../src/messages/game/crafting/index.js';

interface Args {
  host: string;
  port: number;
  user: string;
  character: string;
  planet: string;
  target: string;
  x?: number;
  z?: number;
  experiment: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    host: '10.254.0.253',
    port: 44453,
    user: '',
    character: '',
    planet: 'tatooine',
    target: 'survey_tool|generic_tool',
    experiment: false,
    verbose: false,
  };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const val = eq < 0 ? 'true' : arg.slice(eq + 1);
    switch (key) {
      case 'host':       a.host = val; break;
      case 'port':       a.port = Number.parseInt(val, 10); break;
      case 'user':       a.user = val; break;
      case 'character':  a.character = val; break;
      case 'planet':     a.planet = val; break;
      case 'target':     a.target = val; break;
      case 'x':          a.x = Number.parseFloat(val); break;
      case 'z':          a.z = Number.parseFloat(val); break;
      case 'experiment': a.experiment = val === 'true' || val === ''; break;
      case 'verbose':    a.verbose = val === 'true' || val === ''; break;
      default:           process.stderr.write(`unknown flag --${key}\n`); process.exit(2);
    }
  }
  if (a.user === '' || a.character === '') {
    process.stderr.write('usage: --host=<host> --user=<account> --character=<name> [--target=<keyword>] [--x=<n> --z=<n>] [--experiment] [--verbose]\n');
    process.exit(2);
  }
  return a;
}

const log = (verbose: boolean) =>
  verbose ? (m: string) => process.stderr.write(`[craft] ${m}\n`) : () => {};

// Hardcoded sharedCrc → human-readable name map for the common artisan
// schematic set (gleaned from object_template_crc_string_table.tab). We
// load matches lazily by re-reading the tab file isn't viable from a
// shipped script, so we keep the most-useful subset inline. Anything not
// in this map shows up as "(crc:0x...)" in the log; pass --target=<crc>
// for an exact match.
const KNOWN_TEMPLATES: Record<number, string> = {
  0x0f4a3063: 'survey_tool_gas',
  0xcbe62d55: 'survey_tool_moisture',
  0x3567ac79: 'survey_tool_geo_thermal',
  0xc9e6040a: 'ten_sided_dice',
  0x60ab05d8: 'dish_meat_jerky',
  0x51f63167: 'survey_tool_flora',
  0xfa29b152: 'fishing_pole',
  0xa0a5d640: 'survey_tool_wind',
  0x6c750908: 'container_small_glass',
  0x9932ce03: 'firework_two',
  0x2e81524b: 'survey_tool_liquid',
  0xb00f0456: 'six_sided_dice',
  0x838ff623: 'dessert_bofa_treat',
  0xa7979526: 'enhancement_module',
  0xadb81eb6: 'generic_tool',
  0x44c4c1d6: 'clothing_shoes_casual_02',
  0x6e808ae1: 'firework_three',
  0x757a3f17: 'drink_spiced_tea',
  0xa09242d9: 'clothing_shirt_casual_04',
  0xbeedf66b: 'chance_cube',
  0x7a5a9e89: 'firework_one',
  0x9ed2682e: 'reverse_engineering_tool',
  0x32f2aa70: 'dish_travel_biscuits',
  0x8015a9d4: 'survey_tool_solar',
  0xc49b3d71: 'clothing_pants_casual_25',
  0xe8877f51: 'clothing_wke_shirt_s01',
  0x566c4f43: 'survey_tool_mineral',
};

interface InvItem {
  id: NetworkId;
  templateName: string;
  name: string;
}

function walkAllInventory(ctx: ScriptContext): InvItem[] {
  const index = buildContainerIndex(ctx.dispatcher.transcript);
  const playerId = ctx.sceneStart.playerNetworkId;
  const visited = new Set<string>();
  const queue: bigint[] = [playerId];
  const items: InvItem[] = [];
  while (queue.length > 0) {
    const p = queue.shift()!;
    if (visited.has(p.toString())) continue;
    visited.add(p.toString());
    for (const c of index.get(p) ?? []) {
      items.push({
        id: c.networkId,
        templateName: (c as { templateName?: string }).templateName ?? '',
        name: (c as { name?: string }).name ?? '',
      });
      queue.push(c.networkId);
    }
  }
  return items;
}

function findCraftingTools(ctx: ScriptContext): NetworkId[] {
  const out: NetworkId[] = [];
  for (const item of walkAllInventory(ctx)) {
    if (/item_npe_gen_craft_tool_trader/.test(item.name)) out.push(item.id);
    else if (/crafting.station|generic.tool|crafting_tool/.test(item.templateName)) out.push(item.id);
  }
  return out;
}

interface ResourceContainerInfo {
  id: NetworkId;
  resourceName: string;
  resourceClass: string;
  units: number;
}

async function findContainersForClass(
  ctx: ScriptContext,
  resourceClass: string,
  print: (m: string) => void = () => {},
): Promise<ResourceContainerInfo[]> {
  // Resource containers don't have a templateName in the SHARED baseline
  // we cache, so we identify them via attributes: any item whose
  // AttributeListMessage carries `resource_name` + `resource_class` is a
  // resource container.
  const inv = walkAllInventory(ctx);
  // Be generous about candidates — resource containers may have a short
  // display name; the AttributeListMessage filter below catches non-resources.
  const candidates = inv.filter((it) => !/^survey_tool|item_npe|item_pgc|item_publish|item_respec|item_trader|appearance_inventory|^inventory$|^datapad$|^bank$|^mission_bag$|^shirt|^pants|^vest|^shoes|^necklace|^bracelet/.test(it.name) && !/wearables|crafting|survey_tool|publish_gift|comlink|pgc_starter/.test(it.templateName));
  print(`  ${inv.length} total inventory items, ${candidates.length} candidates for resource-container lookup`);
  if (candidates.length === 0) return [];
  const attrs = await ctx.fetchResourceAttributes(
    candidates.map((it) => it.id),
    { timeoutMs: 10_000 },
  );
  print(`  attribute responses for ${attrs.size}/${candidates.length} items`);
  const out: ResourceContainerInfo[] = [];
  for (const it of candidates) {
    const pairs = attrs.get(it.id);
    if (!pairs) continue;
    const m = new Map(pairs.map((p) => [p.key, p.value]));
    const rname = m.get('resource_name') ?? '';
    const rclass = (m.get('resource_class') ?? '').replace(/^@resource\/resource_names:/, '');
    const contents = m.get('resource_contents') ?? '0/0';
    const units = Number.parseInt(contents.split('/')[0] ?? '0', 10);
    if (rname === '' || units <= 0) continue;
    print(`    candidate ${it.id}: ${rname} class=${rclass} units=${units}`);
    // Match: the container's class is a child of the requested class. We
    // can't traverse the full resource hierarchy from here without the
    // resource_classes.iff data table, so use a name-substring heuristic.
    // The container's "resource_class" attribute is the parent-class STF
    // string after stripping the @prefix; for "metal" we need the chain
    // mineral/inorganic_mineral/metal/.../<class>. We approximate by
    // checking if `requested` is a substring of the container's class or
    // matches a known parent.
    const requested = resourceClass.toLowerCase();
    const klass = rclass.toLowerCase();
    // Heuristic class-chain match: the spawned-resource class names usually
    // start with the root-class token followed by `_<subclass>` (e.g.
    // "steel_arveshian" is a kind of "steel" → "ferrous_metal" → "metal" →
    // "mineral"). We use `^token(_|$)` rather than `\btoken\b` because `_`
    // is a word character in JS regex (\b doesn't match between letter and _).
    const startsWith = (tokens: string[]): boolean =>
      tokens.some((t) => klass === t || klass.startsWith(`${t}_`));
    const matches =
      klass === requested ||
      klass.startsWith(`${requested}_`) ||
      (requested === 'metal' &&
        startsWith(['steel', 'aluminum', 'iron', 'copper', 'tin', 'chromium', 'chromite', 'polysteel', 'duralloy', 'kelmarian', 'carbonate', 'ferrous_metal', 'non_ferrous_metal'])) ||
      (requested === 'mineral' &&
        startsWith(['steel', 'aluminum', 'iron', 'copper', 'tin', 'chromium', 'chromite', 'polysteel', 'duralloy', 'carbonate', 'granite', 'gemstone', 'crystal', 'silicate', 'sandstone', 'ferrous_metal', 'non_ferrous_metal', 'inorganic_mineral', 'metal'])) ||
      (requested === 'ferrous_metal' && startsWith(['steel', 'iron'])) ||
      (requested === 'non_ferrous_metal' && startsWith(['aluminum', 'copper', 'tin', 'chromium', 'polysteel', 'duralloy'])) ||
      (requested === 'inorganic_chemical' && startsWith(['aluminum', 'copper', 'tin', 'chromium', 'carbonate', 'silicate', 'sandstone', 'inorganic_chemical']));
    if (matches) {
      out.push({ id: it.id, resourceName: rname, resourceClass: rclass, units });
    }
  }
  return out;
}

function makeScenario(args: Args, result: { craftedItem?: { id: NetworkId; attrs: Record<string, string> }; error?: string }): ScenarioFn {
  const print = log(args.verbose);
  return async (ctx) => {
    await ctx.wait(2_500);
    const playerId = ctx.sceneStart.playerNetworkId;

    // 1. Find crafting tools — try each in turn (a stale session on one
    //    tool blocks future use of that tool until cluster restart, but
    //    fresh tools work)
    const craftTools = findCraftingTools(ctx);
    if (craftTools.length === 0) {
      result.error = 'no crafting tool found in inventory';
      print(result.error);
      return;
    }
    print(`crafting tools available: ${craftTools.join(', ')}`);

    // 2. Optional walk to target spot
    if (args.x !== undefined && args.z !== undefined) {
      print(`walking to (${args.x}, ${args.z})`);
      await ctx.walkTo({ x: args.x, z: args.z }, { speed: 6 });
      await ctx.wait(2_000);
    }

    // 3. Try each tool in turn until one yields draft slots after select.
    // (A stale session in CS_assembly stage on the previous tool blocks
    // subsequent selectDraftSchematic calls server-side until the tool's
    // ManufactureSchematic state is cleared, which doesn't reliably happen
    // on logout. Fresh tools work.)
    let craftToolId: NetworkId | undefined;
    let schematics: Awaited<ReturnType<typeof ctx.waitForDraftSchematics>> | undefined;
    for (const candidate of craftTools) {
      print(`trying tool ${candidate}: cancel any prior session`);
      ctx.useAbility('cancelCraftingSession', candidate, '');
      await ctx.wait(2_000);
      print(`trying tool ${candidate}: beginCrafting`);
      ctx.beginCrafting(candidate);
      try {
        schematics = await ctx.waitForDraftSchematics({ timeoutMs: 10_000 });
        craftToolId = candidate;
        break;
      } catch {
        print(`  tool ${candidate}: no schematics list — trying next`);
      }
    }
    if (!craftToolId || !schematics) {
      result.error = 'no usable crafting tool (all yielded no schematics list)';
      print(result.error);
      return;
    }
    print(`using tool ${craftToolId}; ${schematics.schematics.length} schematics available`);

    // 4. Pick the first schematic matching --target
    const re = new RegExp(args.target, 'i');
    let pickIdx = -1;
    let pickName = '';
    for (let i = 0; i < schematics.schematics.length; i++) {
      const s = schematics.schematics[i]!;
      const name = KNOWN_TEMPLATES[s.sharedCrc] ?? `crc:0x${s.sharedCrc.toString(16)}`;
      if (re.test(name)) {
        pickIdx = i;
        pickName = name;
        break;
      }
    }
    if (pickIdx < 0) {
      result.error = `no schematic matched /${args.target}/i; available: ${schematics.schematics.map((s) => KNOWN_TEMPLATES[s.sharedCrc] ?? `crc:0x${s.sharedCrc.toString(16)}`).join(', ')}`;
      print(result.error);
      return;
    }
    print(`picked schematic ${pickIdx}: ${pickName}`);

    // 5. Select schematic + get slot requirements. If first tool's
    //    selectDraftSchematic doesn't produce a DraftSlots reply (stale
    //    server-side state — see C++ requestDraftSlots prototype-creation
    //    early-return), cancel and try the next tool.
    let slots;
    for (let attempt = 0; attempt < craftTools.length; attempt++) {
      const toolForAttempt = attempt === 0 ? craftToolId : craftTools[attempt]!;
      if (attempt > 0) {
        print(`retrying with tool ${toolForAttempt}`);
        ctx.useAbility('cancelCraftingSession', toolForAttempt, '');
        await ctx.wait(2_000);
        ctx.beginCrafting(toolForAttempt);
        try {
          await ctx.waitForDraftSchematics({ timeoutMs: 10_000 });
        } catch {
          continue;
        }
        craftToolId = toolForAttempt;
      }
      print(`selectCraftingSchematic(${pickIdx}) on tool ${craftToolId}`);
      ctx.selectCraftingSchematic(pickIdx);
      try {
        slots = await ctx.waitForDraftSlots({ timeoutMs: 10_000 });
        break;
      } catch {
        print(`  tool ${craftToolId}: no DraftSlots — likely stale state, trying next`);
        ctx.useAbility('cancelCraftingSession', craftToolId, '');
        await ctx.wait(1_000);
      }
    }
    if (!slots) {
      result.error = `no DraftSlots returned from any tool — server-side state may be stuck (restart cluster)`;
      print(result.error);
      return;
    }
    print(`${slots.slots.length} slots; manfSchemId=${slots.manfSchemId}`);
    for (let i = 0; i < slots.slots.length; i++) {
      const s = slots.slots[i]!;
      const o = s.options[0];
      print(`  slot[${i}] needs ${o?.amountNeeded ?? '?'} units of "${o?.ingredient ?? '?'}" (type=${o?.type ?? '?'})`);
    }

    // 6. For each slot, find a matching container
    const assignments: Array<{ slot: ManufactureSchematicSlot; containerId: NetworkId; optionIndex: number }> = [];
    for (let i = 0; i < slots.slots.length; i++) {
      const slot = slots.slots[i]!;
      // For now only support resourceClass slots (type=4); component slots need a different flow
      const resOptIdx = slot.options.findIndex((o) => o.type === CraftingIngredientType.ResourceClass);
      if (resOptIdx < 0) {
        result.error = `slot ${i} requires a non-resource ingredient (type=${slot.options[0]?.type ?? '?'}); component-slot crafting not implemented`;
        print(result.error);
        return;
      }
      const opt = slot.options[resOptIdx]!;
      const containers = await findContainersForClass(ctx, opt.ingredient, print);
      const usable = containers.filter((c) => c.units >= opt.amountNeeded);
      if (usable.length === 0) {
        result.error = `slot ${i} needs ${opt.amountNeeded} of "${opt.ingredient}" but no container has enough; available: ${containers.map((c) => `${c.resourceName}(${c.resourceClass})=${c.units}`).join(', ') || '(none)'}`;
        print(result.error);
        return;
      }
      // Pick the container with the most units (likely highest-quality stack)
      usable.sort((a, b) => b.units - a.units);
      const pick = usable[0]!;
      print(`  slot[${i}] → ${pick.resourceName} (${pick.resourceClass}, ${pick.units} units)`);
      assignments.push({ slot, containerId: pick.id, optionIndex: resOptIdx });
    }

    // 7. Send assignments
    for (let i = 0; i < assignments.length; i++) {
      const { containerId, optionIndex } = assignments[i]!;
      ctx.assignCraftingSlot(i, containerId, { optionIndex });
    }
    print(`assigned ${assignments.length} slots; waiting 2s for server settle`);
    await ctx.wait(2_000);

    // 8. Optional experimentation pass
    if (args.experiment) {
      print('experimenting (1 pass on attribute 0 with 1 point)');
      ctx.craftExperiment([{ attribute: 0, points: 1 }]);
      await ctx.wait(2_000);
    }

    // 9. Finish (real prototype)
    print('finishCrafting');
    const beforeIds = new Set<string>(walkAllInventory(ctx).map((it) => it.id.toString()));
    ctx.finishCrafting(craftToolId, { realPrototype: true });

    // 10. Wait up to 15s for the new prototype to appear
    let craftedId: NetworkId | undefined;
    for (let i = 0; i < 30 && !craftedId; i++) {
      await ctx.wait(500);
      for (const it of walkAllInventory(ctx)) {
        if (!beforeIds.has(it.id.toString())) {
          // Skip the manfSchem itself (we know its id)
          if (it.id === slots.manfSchemId || it.id === slots.prototypeId) continue;
          craftedId = it.id;
          break;
        }
      }
    }
    if (craftedId === undefined) {
      // Fall back: use the prototypeId the server told us
      craftedId = slots.prototypeId;
      print(`no new inventory item observed; using server-reported prototypeId=${craftedId}`);
    } else {
      print(`crafted item: ${craftedId}`);
    }

    // 11. Fetch its attributes
    const attrs = await ctx.fetchResourceAttributes([craftedId], { timeoutMs: 10_000 });
    const pairs = attrs.get(craftedId);
    const attrMap: Record<string, string> = {};
    if (pairs) {
      for (const p of pairs) attrMap[p.key] = p.value;
      print('attributes:');
      for (const p of pairs) print(`  ${p.key} = ${p.value}`);
    } else {
      print('(no attributes returned for crafted item)');
    }
    result.craftedItem = { id: craftedId, attrs: attrMap };
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.verbose) {
    process.stderr.write(`[craft] host=${args.host} user=${args.user} char=${args.character} target=/${args.target}/i\n`);
  }
  const client = new SwgClient({ loginServer: { host: args.host, port: args.port } });
  const result: { craftedItem?: { id: NetworkId; attrs: Record<string, string> }; error?: string } = {};
  let lifecycle: LifecycleResult;
  try {
    lifecycle = await client.fullLifecycle({
      account: args.user,
      characterName: args.character,
      planet: args.planet,
      holdZonedInMs: 180_000,
      script: makeScenario(args, result),
    });
  } catch (err) {
    process.stderr.write(`lifecycle failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const scriptErr = lifecycle.scriptResult?.error;
  if (result.error || scriptErr) {
    const errMsg = result.error ?? scriptErr ?? 'unknown';
    process.stderr.write(`craft failed: ${errMsg}\n`);
    process.stdout.write(
      JSON.stringify(
        {
          ok: false,
          error: errMsg,
          lifecycle: { zonedIn: !!lifecycle.zonedInAt, logout: !!lifecycle.logoutAt },
          craftedItemSoFar: result.craftedItem,
        },
        replacer,
        2,
      ) + '\n',
    );
    return 1;
  }
  process.stdout.write(JSON.stringify({ ok: true, craftedItem: result.craftedItem }, replacer, 2) + '\n');
  return 0;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1); });
