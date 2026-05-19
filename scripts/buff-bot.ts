/**
 * NGE medic buff-bot — long-running scripted bot that wanders no further than
 * the spot it warped to, finds players within 5m, and casts the master medic
 * stat-enhancement buffs on each one. Re-buffs the same target no more often
 * than every 25 minutes. Logs out cleanly on SIGINT or when any player in
 * spatial-chat vicinity says exactly the word `kill` (case-insensitive after
 * trim).
 *
 * Setup sequence (admin):
 *   1. `setGodMode 1`                    — admin privileges
 *   2. best-effort invulnerability       — warn-and-continue if unavailable
 *   3. `skill grantSkill <medic master>` — verified `class_medic_phase4_master`
 *      plus the 6 `expertise_me_enhance_*` unlocks
 *   4. `skill grantExperience <oid> combat_general <chunk>` × N
 *      until `ctx.character.level >= 90`
 *   5. `planetwarp <planet> <x> <y> <z>` — defaults to tatooine mos_eisley
 *
 * Verified ability verbs (from
 *   ~/code/swg-main/dsrc/sku.0/sys.shared/compiled/game/datatables/command/command_table.tab):
 *   - me_buff_health_3      → +Constitution (the "Nutrient Injection"-equivalent;
 *                              no `nutrientInjection` verb exists in this fork)
 *   - me_enhance_strength_3 → +Strength  (expertise master tier)
 *   - me_enhance_agility_3  → +Agility   (expertise master tier)
 *   - me_enhance_precision_3 → +Precision (expertise master tier)
 *   - me_enhance_block_1    → +Block     (only `_1` exists)
 *   - me_enhance_dodge_1    → +Dodge     (only `_1` exists)
 *
 * Skill grant (verified in skills.tab):
 *   `class_medic_phase4_master` is the master medic class skill; the
 *   `expertise_me_enhance_*_1` skills unlock the enhance commands and have
 *   prereq chains on `expertise_me_<stat>_4`. We grant all 11 in dependency
 *   order so the skill manager accepts each one. `grantSkill` does not
 *   auto-grant prerequisites server-side.
 *
 * setInvulnerable: no admin console command exposes it (only a Java
 * script-hook function used by AI templates). We attempt the direct
 * useAbility('setInvulnerable', ...) shot once; if it gets rejected by
 * the command table it's a no-op. The bot continues either way per the
 * user's explicit risk acceptance.
 *
 * Usage:
 *   pnpm tsx bin/buff-bot.ts --user=tslive03 --character=BuffBot [--planet=tatooine --x=3528 --z=-4804]
 *                            [--radius=5] [--rebuff-after-min=25] [--verbose]
 */

import {
  type LifecycleResult,
  type NetworkId,
  ObjectTypeTags,
  type ScenarioFn,
  type ScriptContext,
  SwgClient,
  type WorldObject,
} from '../src/index.js';
import { adminConsole, adminGodModeOn, adminPlanetWarp } from './build-city/admin.js';
import { AutoArrayCodec } from '../src/archive/containers.js';
import type { IByteStream, IReadIterator } from '../src/archive/interface.js';
import { StringCodec } from '../src/archive/string.js';
import { GameNetworkMessage, defineMessageMeta } from '../src/messages/base.js';

// Script-local wire message: SWG's ExpertiseRequestMessage. Server-side at
// CreatureObject.cpp:14532 has a god-mode bypass — "GOD MODE: Granting you
// expertise skill X without regard for points, requisites, or permissions"
// — so a godmode bot can request every expertise leaf in one shot and the
// server will both add the skill row AND fire the command-tier upgrade
// chain (which is what unlocks me_buff_health_3, me_enhance_strength_3,
// etc.). `grantSkill` alone adds the row but skips the upgrade chain.
//
// C++ ref: ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/
//          src/shared/clientGameServer/ExpertiseRequestMessage.{cpp,h}
// varCount = 1 (cmd) + addExpertisesList + clearAllExpertisesFirst = 3.
class ExpertiseRequestMessage extends GameNetworkMessage {
  static readonly META = defineMessageMeta('ExpertiseRequestMessage');
  static override readonly messageName = ExpertiseRequestMessage.META.messageName;
  static readonly typeCrc = ExpertiseRequestMessage.META.typeCrc;
  static override readonly varCount = 3;

  constructor(
    public addExpertisesList: readonly string[],
    public clearAllExpertisesFirst: boolean,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    AutoArrayCodec(StringCodec).encode(stream, [...this.addExpertisesList]);
    stream.writeU8(this.clearAllExpertisesFirst ? 1 : 0);
  }

  static decodePayload(iter: IReadIterator): ExpertiseRequestMessage {
    const list = AutoArrayCodec(StringCodec).decode(iter);
    const clear = iter.readU8() !== 0;
    return new ExpertiseRequestMessage(list, clear);
  }
}

// All 93 medic expertise leaves — same list as REQUIRED_SKILLS (the
// `expertise_me_*` subset). The bot SENDS this in addition to `grantSkill`
// to trigger the command-tier upgrade path; grantSkill alone leaves us
// stuck at tier 1 commands.
const MEDIC_EXPERTISE_LEAVES: readonly string[] = [
  'expertise_me_hot_duration_1', 'expertise_me_hot_duration_2',
  'expertise_me_hot_duration_3', 'expertise_me_hot_duration_4',
  'expertise_me_drag', 'expertise_me_revive_duration_1',
  'expertise_me_revive_duration_2', 'expertise_me_revive_duration_3',
  'expertise_me_blood_cleaners_1', 'expertise_me_bacta_bomb_1',
  'expertise_me_heal_damage_1', 'expertise_me_heal_damage_2',
  'expertise_me_heal_damage_3', 'expertise_me_heal_damage_4',
  'expertise_me_cure_affliction_1', 'expertise_me_heal_action_1',
  'expertise_me_heal_action_2', 'expertise_me_heal_action_3',
  'expertise_me_serotonin_boost_1', 'expertise_me_bacta_grenade_1',
  'expertise_me_enhance_duration_1', 'expertise_me_enhance_duration_2',
  'expertise_me_enhance_duration_3', 'expertise_me_enhancement_specialist_1',
  'expertise_me_reckless_stimulation_1', 'expertise_me_stasis_1',
  'expertise_me_vital_action_1', 'expertise_me_vital_action_2',
  'expertise_me_vital_action_3', 'expertise_me_vital_action_4',
  'expertise_me_bacta_resistance_1', 'expertise_me_dot_damage_1',
  'expertise_me_dot_damage_2', 'expertise_me_dot_damage_3',
  'expertise_me_serotonin_purge_1', 'expertise_me_induce_insanity_1',
  'expertise_me_vital_damage_1', 'expertise_me_vital_damage_2',
  'expertise_me_vital_damage_3', 'expertise_me_vital_damage_4',
  'expertise_me_electrolyte_drain_1', 'expertise_me_dot_duration_1',
  'expertise_me_dot_duration_2', 'expertise_me_dot_duration_3',
  'expertise_me_traumatize_1', 'expertise_me_thyroid_rupture_1',
  'expertise_me_strength_1', 'expertise_me_strength_2',
  'expertise_me_strength_3', 'expertise_me_strength_4',
  'expertise_me_enhance_strength_1', 'expertise_me_carbine_damage_1',
  'expertise_me_carbine_damage_2', 'expertise_me_carbine_damage_3',
  'expertise_me_carbine_damage_4', 'expertise_me_dueterium_rounds_1',
  'expertise_me_humanoid_crits_1', 'expertise_me_humanoid_crits_2',
  'expertise_me_humanoid_crits_3', 'expertise_me_burst_1',
  'expertise_me_agility_1', 'expertise_me_agility_2',
  'expertise_me_agility_3', 'expertise_me_agility_4',
  'expertise_me_enhance_agility_1', 'expertise_me_unarmed_damage_1',
  'expertise_me_unarmed_damage_2', 'expertise_me_unarmed_damage_3',
  'expertise_me_unarmed_damage_4', 'expertise_me_poison_knuckle_1',
  'expertise_me_unarmed_crit_1', 'expertise_me_unarmed_crit_2',
  'expertise_me_unarmed_crit_3', 'expertise_me_cranial_smash_1',
  'expertise_me_agro_healing_1', 'expertise_me_agro_healing_2',
  'expertise_me_agro_healing_3', 'expertise_me_evasion_1',
  'expertise_me_precision_1', 'expertise_me_precision_2',
  'expertise_me_precision_3', 'expertise_me_precision_4',
  'expertise_me_enhance_precision_1', 'expertise_me_kinetic_armor_1',
  'expertise_me_kinetic_armor_2', 'expertise_me_kinetic_armor_3',
  'expertise_me_kinetic_armor_4', 'expertise_me_enhance_block_1',
  'expertise_me_energy_armor_1', 'expertise_me_energy_armor_2',
  'expertise_me_energy_armor_3', 'expertise_me_energy_armor_4',
  'expertise_me_enhance_dodge_1',
];

interface Args {
  host: string;
  port: number;
  user: string;
  character: string;
  planet: string;
  x: number;
  z: number;
  radius: number;
  rebuffAfterMin: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    host: '10.254.0.253',
    port: 44453,
    user: '',
    character: '',
    planet: 'tatooine',
    x: 3528,
    z: -4804,
    radius: 5,
    rebuffAfterMin: 25,
    verbose: false,
  };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const val = eq < 0 ? 'true' : arg.slice(eq + 1);
    switch (key) {
      case 'host':
        a.host = val;
        break;
      case 'port':
        a.port = Number.parseInt(val, 10);
        break;
      case 'user':
        a.user = val;
        break;
      case 'character':
        a.character = val;
        break;
      case 'planet':
        a.planet = val;
        break;
      case 'x':
        a.x = Number.parseFloat(val);
        break;
      case 'z':
        a.z = Number.parseFloat(val);
        break;
      case 'radius':
        a.radius = Number.parseFloat(val);
        break;
      case 'rebuff-after-min':
        a.rebuffAfterMin = Number.parseFloat(val);
        break;
      case 'verbose':
        a.verbose = val === 'true' || val === '';
        break;
      default:
        process.stderr.write(`unknown flag --${key}\n`);
        process.exit(2);
    }
  }
  if (a.user === '' || a.character === '') {
    process.stderr.write(
      'usage: bin/buff-bot.ts --user=<account> --character=<name>\n' +
        '       [--host=10.254.0.253] [--port=44453]\n' +
        '       [--planet=tatooine --x=3528 --z=-4804]\n' +
        '       [--radius=5] [--rebuff-after-min=25] [--verbose]\n',
    );
    process.exit(2);
  }
  return a;
}

// Verified against ~/code/swg-main/dsrc/.../command/command_table.tab AND
// skills.tab: the `_3` variants exist as command rows but require a
// `characterAbility` (command_table col 9) that no skill grants — only
// the `_1` abilities are granted (by expertise leaves + class_medic_phase3_novice
// for me_buff_health_1). Tier-3 commands were silently rejected at queue
// validation. Use `_1` everywhere; expertise ranks 1-4 boost the applied
// buff potency server-side.
const MEDIC_BUFF_COMMANDS = [
  // Tier 3 is granted directly via `skill grantCommand` (the command_series.tab
  // level-based upgrades don't fire reliably even after triggerAll OnInitialize).
  // block/dodge only exist at tier 1; the rest at _3 give the wiki magnitudes
  // (e.g. me_buff_strength_3 = +80 strength_modified vs +15 at tier 1).
  // UI names: me_buff_health_* = Nutrient Injection, me_enhance_action_* =
  // Metabolic Accelerators, me_enhance_strength/agility/precision_* = Enhance X.
  // me_enhance_block_1 first — fires before the tier-3s so it lands cleanly
  // even if the rest of the round trips the shared `me_enhance` cooldown.
  'me_enhance_block_1',       // Enhance Block (only Mk 1 exists)
  'me_enhance_dodge_1',       // Enhance Dodge (only Mk 1 exists)
  'me_buff_health_3',         // Nutrient Injection Mk 3 (constitution/health)
  'me_enhance_action_3',      // Metabolic Accelerators Mk 3 (action)
  'me_enhance_strength_3',    // Enhance Strength Mk 3
  'me_enhance_agility_3',     // Enhance Agility Mk 3
  'me_enhance_precision_3',   // Enhance Precision Mk 3
] as const;

// Skill chain (verified in skills.tab). `grantSkill` does NOT auto-grant
// prereqs server-side, so we walk the dependency chain in order.
const REQUIRED_SKILLS: readonly string[] = [
  // Medic class chain — master tier unlocks me_buff_health_3 etc. via tier props.
  'class_medic_phase1_novice',
  'class_medic_phase1_01',
  'class_medic_phase1_02',
  'class_medic_phase1_03',
  'class_medic_phase1_04',
  'class_medic_phase1_05',
  'class_medic_phase1_master',
  'class_medic_phase2_novice',
  'class_medic_phase2_01',
  'class_medic_phase2_02',
  'class_medic_phase2_03',
  'class_medic_phase2_04',
  'class_medic_phase2_05',
  'class_medic_phase2_master',
  'class_medic_phase3_novice',
  'class_medic_phase3_01',
  'class_medic_phase3_02',
  'class_medic_phase3_03',
  'class_medic_phase3_04',
  'class_medic_phase3_05',
  'class_medic_phase3_master',
  'class_medic_phase4_novice',
  'class_medic_phase4_02',
  'class_medic_phase4_03',
  'class_medic_phase4_04',
  'class_medic_phase4_05',
  'class_medic_phase4_master',
  // Full medic expertise — all 93 `expertise_me_*` from
  // ~/code/swg-main/dsrc/.../expertise/expertise.tab in file order
  // (which is tier+rank order per chain, so prereqs grant before leaves).
  // Bot is GM via godmode so the grant bypasses normal expertise-point limits.
  'expertise',
  'expertise_me_hot_duration_1',
  'expertise_me_hot_duration_2',
  'expertise_me_hot_duration_3',
  'expertise_me_hot_duration_4',
  'expertise_me_drag',
  'expertise_me_revive_duration_1',
  'expertise_me_revive_duration_2',
  'expertise_me_revive_duration_3',
  'expertise_me_blood_cleaners_1',
  'expertise_me_bacta_bomb_1',
  'expertise_me_heal_damage_1',
  'expertise_me_heal_damage_2',
  'expertise_me_heal_damage_3',
  'expertise_me_heal_damage_4',
  'expertise_me_cure_affliction_1',
  'expertise_me_heal_action_1',
  'expertise_me_heal_action_2',
  'expertise_me_heal_action_3',
  'expertise_me_serotonin_boost_1',
  'expertise_me_bacta_grenade_1',
  'expertise_me_enhance_duration_1',
  'expertise_me_enhance_duration_2',
  'expertise_me_enhance_duration_3',
  'expertise_me_enhancement_specialist_1',
  'expertise_me_reckless_stimulation_1',
  'expertise_me_stasis_1',
  'expertise_me_vital_action_1',
  'expertise_me_vital_action_2',
  'expertise_me_vital_action_3',
  'expertise_me_vital_action_4',
  'expertise_me_bacta_resistance_1',
  'expertise_me_dot_damage_1',
  'expertise_me_dot_damage_2',
  'expertise_me_dot_damage_3',
  'expertise_me_serotonin_purge_1',
  'expertise_me_induce_insanity_1',
  'expertise_me_vital_damage_1',
  'expertise_me_vital_damage_2',
  'expertise_me_vital_damage_3',
  'expertise_me_vital_damage_4',
  'expertise_me_electrolyte_drain_1',
  'expertise_me_dot_duration_1',
  'expertise_me_dot_duration_2',
  'expertise_me_dot_duration_3',
  'expertise_me_traumatize_1',
  'expertise_me_thyroid_rupture_1',
  'expertise_me_strength_1',
  'expertise_me_strength_2',
  'expertise_me_strength_3',
  'expertise_me_strength_4',
  'expertise_me_enhance_strength_1',
  'expertise_me_carbine_damage_1',
  'expertise_me_carbine_damage_2',
  'expertise_me_carbine_damage_3',
  'expertise_me_carbine_damage_4',
  'expertise_me_dueterium_rounds_1',
  'expertise_me_humanoid_crits_1',
  'expertise_me_humanoid_crits_2',
  'expertise_me_humanoid_crits_3',
  'expertise_me_burst_1',
  'expertise_me_agility_1',
  'expertise_me_agility_2',
  'expertise_me_agility_3',
  'expertise_me_agility_4',
  'expertise_me_enhance_agility_1',
  'expertise_me_unarmed_damage_1',
  'expertise_me_unarmed_damage_2',
  'expertise_me_unarmed_damage_3',
  'expertise_me_unarmed_damage_4',
  'expertise_me_poison_knuckle_1',
  'expertise_me_unarmed_crit_1',
  'expertise_me_unarmed_crit_2',
  'expertise_me_unarmed_crit_3',
  'expertise_me_cranial_smash_1',
  'expertise_me_agro_healing_1',
  'expertise_me_agro_healing_2',
  'expertise_me_agro_healing_3',
  'expertise_me_evasion_1',
  'expertise_me_precision_1',
  'expertise_me_precision_2',
  'expertise_me_precision_3',
  'expertise_me_precision_4',
  'expertise_me_enhance_precision_1',
  'expertise_me_kinetic_armor_1',
  'expertise_me_kinetic_armor_2',
  'expertise_me_kinetic_armor_3',
  'expertise_me_kinetic_armor_4',
  'expertise_me_enhance_block_1',
  'expertise_me_energy_armor_1',
  'expertise_me_energy_armor_2',
  'expertise_me_energy_armor_3',
  'expertise_me_energy_armor_4',
  'expertise_me_enhance_dodge_1',
];

const log = (verbose: boolean) =>
  verbose ? (m: string) => process.stderr.write(`[buff-bot] ${m}\n`) : () => {};

const alwaysLog = (m: string): void => {
  process.stderr.write(`[buff-bot] ${m}\n`);
};

/** Pull a display name from the SHARED baseline (package id 3), if present. */
function deriveName(obj: WorldObject): string {
  const shared = obj.baselines.get(3) as
    | { objectName?: string; nameStringId?: { text?: string } }
    | undefined;
  if (shared === undefined) return '';
  if (typeof shared.objectName === 'string' && shared.objectName !== '') return shared.objectName;
  if (typeof shared.nameStringId?.text === 'string') return shared.nameStringId.text;
  return '';
}

/** Grant a single skill via the admin `skill grantSkill` console command. */
async function grantSkill(ctx: ScriptContext, skill: string): Promise<string> {
  return adminConsole(ctx, `skill grantSkill ${skill}`);
}

/** Grant `amount` XP of `xpType` to the player. */
async function grantExperience(
  ctx: ScriptContext,
  xpType: string,
  amount: number,
): Promise<string> {
  const oid = ctx.sceneStart.playerNetworkId.toString();
  return adminConsole(ctx, `skill grantExperience ${oid} ${xpType} ${amount}`);
}

/**
 * Push the character to at least `target` level via repeated XP grants. The
 * server-side level-up loop converts combat XP to character level; chunks
 * are large enough to make rapid progress without overshooting wildly.
 */
async function setLevelBest(
  ctx: ScriptContext,
  target: number,
  print: (m: string) => void,
): Promise<void> {
  const chunk = 500_000;
  const maxIterations = 40; // 20M XP cap — plenty for level 90
  for (let i = 0; i < maxIterations; i++) {
    if (ctx.character.level >= target) {
      print(`level=${ctx.character.level} (target ${target}) — done`);
      return;
    }
    print(`level=${ctx.character.level} — granting ${chunk} combat_general XP`);
    await grantExperience(ctx, 'combat_general', chunk);
    await ctx.wait(750);
  }
  print(`WARNING: level=${ctx.character.level} after ${maxIterations} grants; continuing anyway`);
}

function makeScenario(args: Args, killController: { stop: boolean; reason: string }): ScenarioFn {
  const print = log(args.verbose);
  return async (ctx) => {
    // Settle briefly so CREO baseline arrives and ctx.character is hot.
    await ctx.wait(2_500);

    alwaysLog(`myOid=${ctx.sceneStart.playerNetworkId.toString()}`);

    // 1. Admin god-mode (privileges required for every subsequent console cmd).
    alwaysLog('enabling godmode');
    await adminGodModeOn(ctx);
    alwaysLog('godmode on');

    // 2. Best-effort invulnerability. No admin console verb exists for this
    // in the current server fork, and CM_setInvulnerable is gated by
    // allowFromClient on most builds. Try a useAbility shot; if the command
    // table doesn't accept it, the server logs a HackAttempts entry and
    // ignores it. User has accepted the risk of dying to wandering aggro.
    try {
      ctx.useAbility('setInvulnerable', undefined, '1');
      print('attempted setInvulnerable via useAbility (no reply expected)');
    } catch (err) {
      alwaysLog(
        `WARNING: could not enable invulnerability (${err instanceof Error ? err.message : String(err)}) — bot may die to wandering aggro`,
      );
    }
    await ctx.wait(250);

    // 3. Grant medic master + every expertise unlock. We walk the prereq
    // chain in order — grantSkill server-side enforces prereqs; replies for
    // already-granted skills are no-ops.
    print(`granting ${REQUIRED_SKILLS.length} skills`);
    for (const skill of REQUIRED_SKILLS) {
      try {
        const reply = await grantSkill(ctx, skill);
        if (/error|fail|cannot|invalid|unknown/i.test(reply)) {
          print(`  grantSkill ${skill}: ${reply.trim().slice(0, 120)}`);
        } else {
          print(`  granted ${skill}`);
        }
      } catch (err) {
        print(`  grantSkill ${skill}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    alwaysLog('granted required skills (final tier: class_medic_phase4_master)');

    // 3b. Allocate all expertise via ExpertiseRequestMessage. grantSkill
    // adds the skill row but skips the expertise tier-upgrade chain — that
    // chain is what unlocks me_buff_health_2/_3, me_enhance_strength_2/_3,
    // etc. as character abilities. Godmode bypasses point limits per
    // CreatureObject.cpp:14532. Send once with clearAllExpertisesFirst=true
    // so we land in a known clean state.
    alwaysLog(`sending ExpertiseRequest (${MEDIC_EXPERTISE_LEAVES.length} leaves)`);
    ctx.send(new ExpertiseRequestMessage(MEDIC_EXPERTISE_LEAVES, true));
    await ctx.wait(1_000);

    // 4. Push to level 90.
    await setLevelBest(ctx, 90, print);
    alwaysLog(`level=${ctx.character.level}`);

    // 4b. Force the player init handler to re-run with the new level. This
    // calls base_player.java::OnInitialize which refreshes combat skill-mods
    // (block/dodge/critical/etc.) — empirically observed adding 10 expertise
    // skill mods like expertise_block_chance, display_only_dodge.
    const myOidStr = ctx.sceneStart.playerNetworkId.toString();
    try {
      const reply = await adminConsole(ctx, `script triggerAll OnInitialize ${myOidStr}`);
      print(`script triggerAll OnInitialize: ${reply.trim().slice(0, 120)}`);
    } catch (err) {
      alwaysLog(
        `WARNING: triggerAll OnInitialize failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    await ctx.wait(1_500);

    // 4c. Directly grant the tier-2/3 series commands that `recomputeCommandSeries`
    // refuses to grant for us (the upgrade trigger fires at level-up transitions
    // during real gameplay; admin grantExperience-driven leveling doesn't trigger
    // it reliably even with OnInitialize re-run above). Use the dedicated
    // `skill grantCommand` admin verb from ConsoleCommandParserSkill.cpp:35,
    // which bypasses skill prereqs and the series-upgrade machinery.
    // command_series.tab thresholds: _2 at level 46, _3 at level 76. Bot is 90.
    const UPGRADED_COMMANDS = [
      'me_buff_health_2', 'me_buff_health_3',
      'me_enhance_action_2', 'me_enhance_action_3',
      'me_enhance_strength_2', 'me_enhance_strength_3',
      'me_enhance_agility_2', 'me_enhance_agility_3',
      'me_enhance_precision_2', 'me_enhance_precision_3',
    ];
    print(`granting ${UPGRADED_COMMANDS.length} tier-2/3 series commands`);
    for (const cmd of UPGRADED_COMMANDS) {
      try {
        const reply = await adminConsole(ctx, `skill grantCommand ${cmd} ${myOidStr}`);
        if (/error|fail|invalid|unknown|not found/i.test(reply)) {
          print(`  grantCommand ${cmd}: ${reply.trim().slice(0, 120)}`);
        } else {
          print(`  granted command ${cmd}`);
        }
      } catch (err) {
        print(`  grantCommand ${cmd}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 4d. Grant the expertise-derived skill mods that grantSkill skips.
    // The expertise SKILL ROWS are added by grantSkill above, but the side
    // effect of applying the listed SKILL_MODS column (skills.tab col 23)
    // is gated by the same broken recompute that misses command tiers.
    // The buff system looks these up at cast time via
    // `combat.java:527 getEnhancedSkillStatisticModifierUncapped(...,
    // "expertise_buff_duration_line_" + specialLine)` so without the mod,
    // duration extension = 0. Grant directly via `skill grantSkillMod`.
    // Totals = sum of the per-leaf MODS values from skills.tab.
    const EXPERTISE_SKILL_MODS: Array<[string, number]> = [
      ['expertise_buff_duration_line_me_enhance', 1200], // 300+300+600 → enhance buffs +20min
      ['expertise_healing_line_me_heal', 25],            // 5+5+5+10  → heal magnitude
      ['expertise_healing_line_me_hot', 50],             // 10+10+15+15 → hot magnitude
      ['expertise_action_line_me_heal', 35],             // 10+10+15
      ['expertise_action_line_me_dm', 25],               // 5+5+5+10
      ['expertise_damage_line_me_dm', 20],               // 5+5+5+5
      ['expertise_dot_increase', 15],                    // 5+5+5
      ['expertise_dot_duration_line_me_dot', 10],        // 3+3+4
      ['expertise_cooldown_line_me_revive', 15],         // 5+5+5
      ['expertise_cooldown_line_me_aoe_revive', 15],     // same
    ];
    print(`granting ${EXPERTISE_SKILL_MODS.length} expertise skill mods`);
    for (const [mod, value] of EXPERTISE_SKILL_MODS) {
      try {
        const reply = await adminConsole(
          ctx,
          `skill grantSkillMod ${mod} ${value} ${myOidStr}`,
        );
        if (/error|fail|invalid|unknown/i.test(reply)) {
          print(`  grantSkillMod ${mod}: ${reply.trim().slice(0, 120)}`);
        } else {
          print(`  granted mod ${mod}=${value}`);
        }
      } catch (err) {
        print(`  grantSkillMod ${mod}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 5. Warp to the operating spot.
    alwaysLog(`warping to ${args.planet} (${args.x}, ${args.z})`);
    await adminPlanetWarp(ctx, args.planet, args.x, 0, args.z);
    alwaysLog(`warped to ${args.planet} (${args.x}, ${args.z})`);

    // 6. Wire the kill switch — any nearby player saying exactly "kill" stops
    // the loop. Self-filter on character name so we don't react to our own
    // "Buffing X" echoes (defense-in-depth; strict text match already excludes
    // them).
    const ownName = ctx.character.name ?? '';
    ctx.chat.onSay(
      (text, sender) => {
        if (sender.name === ownName) return false;
        return text.trim().toLowerCase() === 'kill';
      },
      (_text, sender) => {
        killController.stop = true;
        killController.reason = `kill command received from ${sender.name}`;
        alwaysLog(killController.reason);
      },
    );

    // 7. Buff loop.
    //
    // NB: `ctx.playersInRange(r)` filters on `ObjectTypeTags.PLAY`, but PLAY
    // is the *PlayerObject* baseline (the local-only metadata: quests,
    // badges, etc.) — other players' visible bodies in the world are CREO
    // (CreatureObject). We can't reliably distinguish players from NPCs by
    // template alone because `SceneCreateObjectByCrc` arrives without a
    // template name in this fork (we see e.g. `tpl=(no-name) crc=0xaf1dc1a1`
    // for the user). So within the bot's small radius (5m default), we just
    // treat every non-self CREO as a buff target — NPCs at point-blank
    // range to a stationary bot are vanishingly rare in starting zones,
    // and a misfired buff on an NPC is harmless.
    const selfId = ctx.sceneStart.playerNetworkId;
    const radius2 = args.radius * args.radius;
    const findPlayersInRange = (): WorldObject[] => {
      const here = ctx.position();
      const out: Array<[WorldObject, number]> = [];
      for (const o of ctx.world.byType(ObjectTypeTags.CREO)) {
        if (o.id === selfId) continue;
        const dx = o.position.x - here.x;
        const dz = o.position.z - here.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > radius2) continue;
        out.push([o, d2]);
      }
      out.sort((a, b) => a[1] - b[1]);
      return out.map(([o]) => o);
    };

    const rebuffMs = args.rebuffAfterMin * 60_000;
    const lastBuffed = new Map<string, number>();

    // Rebuff switch — any nearby player saying exactly "rebuff" clears their
    // own throttle entry so they get re-buffed on the next tick (skip the
    // 25-min cooldown). Self-filter on character name like the kill handler.
    ctx.chat.onSay(
      (text, sender) => {
        if (sender.name === ownName) return false;
        return text.trim().toLowerCase() === 'rebuff';
      },
      (_text, sender) => {
        if (!sender.id) return;
        const key = sender.id.toString();
        if (lastBuffed.delete(key)) {
          alwaysLog(`rebuff requested by ${sender.name} (${key}) — throttle cleared`);
        } else {
          alwaysLog(`rebuff requested by ${sender.name} (${key}) — not currently throttled`);
        }
      },
    );

    // Keepalive: server drops idle sessions after a few minutes of no traffic
    // (built-in 45s ClockSync alone isn't enough). Re-send our current posture
    // every 60s as a no-op ObjController message — invisible to other players
    // but enough activity to satisfy server-side liveness.
    let lastKeepaliveAt = Date.now();
    const KEEPALIVE_MS = 60_000;

    let tick = 0;
    while (!ctx.signal.aborted && !killController.stop) {
      tick++;
      if (Date.now() - lastKeepaliveAt >= KEEPALIVE_MS) {
        try {
          ctx.changePosture('standing');
          lastKeepaliveAt = Date.now();
        } catch {
          // ignored — keepalive failure means we're already dead
        }
      }
      const players = findPlayersInRange();
      if (players.length === 0) {
        // Diagnostic: how many CREOs total in radius? (helps see if it's a
        // template-filter miss vs an observation-range miss.) Also dump any
        // in-range CREOs that didn't match the player-template heuristic.
        const here = ctx.position();
        const inRange: WorldObject[] = [];
        for (const o of ctx.world.byType(ObjectTypeTags.CREO)) {
          if (o.id === selfId) continue;
          const dx = o.position.x - here.x;
          const dz = o.position.z - here.z;
          if (dx * dx + dz * dz <= radius2) inRange.push(o);
        }
        print(
          `tick #${tick}: no players in ${args.radius}m radius ` +
            `(${inRange.length} CREO in radius, ${ctx.world.byType(ObjectTypeTags.CREO).length} CREO total)`,
        );
        for (const o of inRange) {
          print(
            `  in-range CREO id=${o.id.toString()} tpl=${o.templateName ?? '(no-name)'} ` +
              `crc=${o.templateCrc != null ? `0x${o.templateCrc.toString(16)}` : '(no-crc)'} ` +
              `pos=(${o.position.x.toFixed(1)},${o.position.z.toFixed(1)})`,
          );
        }
      } else {
        print(`tick #${tick}: ${players.length} player(s) in range`);
      }
      for (const p of players) {
        if (ctx.signal.aborted || killController.stop) break;
        const oidKey = p.id.toString();
        const lastAt = lastBuffed.get(oidKey) ?? 0;
        if (lastAt + rebuffMs > Date.now()) {
          print(`  skip ${oidKey} (buffed ${Math.round((Date.now() - lastAt) / 1000)}s ago)`);
          continue;
        }
        const name = deriveName(p) || `player-${oidKey}`;
        alwaysLog(`buffing ${name} (${oidKey})`);
        ctx.say(`Buffing ${name}`);
        await ctx.wait(400);
        for (const ability of MEDIC_BUFF_COMMANDS) {
          if (ctx.signal.aborted || killController.stop) break;
          // params MUST be non-empty for the medic buff Java handler:
          // combat_actions.java:11850 — `performMedicGroupBuff` returns false
          // (silent no-op) on `params == null || params.length() <= 0`.
          // Windows client sends the target oid as string; mirror that.
          ctx.useAbility(ability, p.id, p.id.toString());
          // 2s spacing — all 7 enhance buffs share `cooldownGroup=me_enhance`
          // with a 1s server-side cooldown; 1.2s pacing was tripping it on
          // server-jitter and silently dropping random casts.
          await ctx.wait(2_000);
        }
        if (!killController.stop) {
          ctx.say(`Done buffing ${name}`);
          lastBuffed.set(oidKey, Date.now());
        }
      }
      if (killController.stop) break;
      await ctx.wait(2_000);
    }

    if (killController.stop) {
      alwaysLog(`stopping: ${killController.reason}`);
    } else if (ctx.signal.aborted) {
      alwaysLog('script aborted; logging out');
    }
    await ctx.logout();
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  alwaysLog(
    `starting host=${args.host} user=${args.user} character=${args.character} ` +
      `planet=${args.planet} (${args.x},${args.z}) radius=${args.radius}m rebuff=${args.rebuffAfterMin}min`,
  );

  // SIGINT bridges into the same kill switch the in-game `kill` command uses
  // — both paths drain through ctx.logout() and the game-stage's clean
  // teardown, so the LogoutMessage actually goes out.
  const killController = { stop: false, reason: '' };
  const onSigint = (): void => {
    if (killController.stop) {
      // Second Ctrl-C: hard exit.
      process.stderr.write('[buff-bot] second SIGINT; force exit\n');
      process.exit(130);
    }
    killController.stop = true;
    killController.reason = 'SIGINT';
    alwaysLog('SIGINT received; stopping at next tick');
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);

  // Crash-trace hooks so silent deaths leave evidence in the log.
  process.on('uncaughtException', (err) => {
    process.stderr.write(
      `[buff-bot] FATAL uncaughtException: ${err.stack ?? err.message ?? String(err)}\n`,
    );
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(
      `[buff-bot] FATAL unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
    );
    process.exit(1);
  });
  process.on('exit', (code) => {
    process.stderr.write(`[buff-bot] process exiting with code ${code}\n`);
  });

  const client = new SwgClient({ loginServer: { host: args.host, port: args.port } });
  let lifecycle: LifecycleResult;
  try {
    lifecycle = await client.fullLifecycle({
      account: args.user,
      characterName: args.character,
      planet: args.planet,
      // The script runs its own loop (until SIGINT or in-game `kill`) and
      // calls ctx.logout() before returning. Game-stage's post-script sleep
      // is computed as max(0, holdZonedInMs - scriptElapsed); after a
      // long-running script returns, the elapsed time exceeds this
      // budget and the sleep collapses to 0 — the logout is sent
      // immediately. (See src/client/game-stage.ts line 217-218.)
      holdZonedInMs: 10_000,
      script: makeScenario(args, killController),
    });
  } catch (err) {
    process.stderr.write(
      `[buff-bot] lifecycle failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigint);

  const scriptErr = lifecycle.scriptResult?.error;
  if (scriptErr) {
    process.stderr.write(`[buff-bot] script error: ${scriptErr}\n`);
    return 1;
  }
  alwaysLog(
    `clean exit (zonedIn=${!!lifecycle.zonedInAt} logout=${!!lifecycle.logoutAt} stop=${killController.reason || '(none)'})`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
