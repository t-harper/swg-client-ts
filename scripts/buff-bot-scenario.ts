/**
 * buff-bot-scenario — the import-safe half of the NGE medic buff-bot.
 *
 * Holds the `makeScenario` factory, the `Args` shape, and every constant /
 * helper. Has NO top-level execution — safe to dynamically re-import for
 * `ctl reload` (the runnable entry point is `scripts/buff-bot.ts`).
 *
 * The bot finds players within `radius` metres and casts the master medic
 * stat-enhancement buffs on each, re-buffing no more often than
 * `rebuffAfterMin` minutes. Stop with `/say kill`; force a re-buff sweep
 * with `/say rebuff` or `ctl trigger rebuff-all`.
 *
 * Reload model: the heavy one-time setup (grant skills, level to 90, warp)
 * is gated behind an "already set up" check (`ctx.character.level >= 90`),
 * so `reload` skips straight to the buff loop.
 */

import { ObjectTypeTags } from '../src/index.js';
import type { ScenarioFn, ScriptContext, SessionControl, WorldObject } from '../src/index.js';
import { ExpertiseRequestMessage } from '../src/messages/game/expertise-request.js';
import { adminConsole, adminGodModeOn, adminPlanetWarp } from './build-city/admin.js';

export interface Args {
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
  /** Control-socket session name. Defaults to `buffbot-<character>`. */
  session?: string;
}

// All 93 medic expertise leaves — SENT via ExpertiseRequestMessage to
// trigger the command-tier upgrade path (grantSkill alone leaves tier 1).
const MEDIC_EXPERTISE_LEAVES: readonly string[] = [
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

// Tier-3 buff commands (block/dodge only exist at tier 1).
const MEDIC_BUFF_COMMANDS = [
  'me_enhance_block_1',
  'me_enhance_dodge_1',
  'me_buff_health_3',
  'me_enhance_action_3',
  'me_enhance_strength_3',
  'me_enhance_agility_3',
  'me_enhance_precision_3',
] as const;

// Medic class chain + all 93 expertise leaves, in dependency order.
const REQUIRED_SKILLS: readonly string[] = [
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
  'expertise',
  ...MEDIC_EXPERTISE_LEAVES,
];

// Tier-2/3 series commands granted directly (the level-up upgrade trigger
// doesn't fire reliably under admin grantExperience leveling).
const UPGRADED_COMMANDS = [
  'me_buff_health_2',
  'me_buff_health_3',
  'me_enhance_action_2',
  'me_enhance_action_3',
  'me_enhance_strength_2',
  'me_enhance_strength_3',
  'me_enhance_agility_2',
  'me_enhance_agility_3',
  'me_enhance_precision_2',
  'me_enhance_precision_3',
];

// Expertise-derived skill mods that grantSkill skips.
const EXPERTISE_SKILL_MODS: Array<[string, number]> = [
  ['expertise_buff_duration_line_me_enhance', 1200],
  ['expertise_healing_line_me_heal', 25],
  ['expertise_healing_line_me_hot', 50],
  ['expertise_action_line_me_heal', 35],
  ['expertise_action_line_me_dm', 25],
  ['expertise_damage_line_me_dm', 20],
  ['expertise_dot_increase', 15],
  ['expertise_dot_duration_line_me_dot', 10],
  ['expertise_cooldown_line_me_revive', 15],
  ['expertise_cooldown_line_me_aoe_revive', 15],
];

const log = (verbose: boolean): ((m: string) => void) => {
  if (!verbose) return () => undefined;
  return (m: string): void => {
    process.stderr.write(`[buff-bot] ${m}\n`);
  };
};

/** Always-on stderr logger — shared with the runnable entry point. */
export const alwaysLog = (m: string): void => {
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

async function grantSkill(ctx: ScriptContext, skill: string): Promise<string> {
  return adminConsole(ctx, `skill grantSkill ${skill}`);
}

async function grantExperience(
  ctx: ScriptContext,
  xpType: string,
  amount: number,
): Promise<string> {
  const oid = ctx.sceneStart.playerNetworkId.toString();
  return adminConsole(ctx, `skill grantExperience ${oid} ${xpType} ${amount}`);
}

async function setLevelBest(
  ctx: ScriptContext,
  target: number,
  print: (m: string) => void,
): Promise<void> {
  const chunk = 500_000;
  const maxIterations = 40;
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

/**
 * Heavy one-time setup — godmode, skills, level 90, warp. Skipped on
 * `reload` / `restart` when the character is already leveled.
 */
async function runSetup(ctx: ScriptContext, args: Args, print: (m: string) => void): Promise<void> {
  // 1. Admin god-mode.
  alwaysLog('enabling godmode');
  await adminGodModeOn(ctx);
  alwaysLog('godmode on');

  // 2. Best-effort invulnerability.
  try {
    ctx.useAbility('setInvulnerable', undefined, '1');
    print('attempted setInvulnerable via useAbility (no reply expected)');
  } catch (err) {
    alwaysLog(
      `WARNING: could not enable invulnerability (${err instanceof Error ? err.message : String(err)}) — bot may die to wandering aggro`,
    );
  }
  await ctx.wait(250);

  // 3. Grant medic master + every expertise unlock.
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

  // 3b. Allocate all expertise via ExpertiseRequestMessage.
  alwaysLog(`sending ExpertiseRequest (${MEDIC_EXPERTISE_LEAVES.length} leaves)`);
  ctx.send(new ExpertiseRequestMessage(MEDIC_EXPERTISE_LEAVES, true));
  await ctx.wait(1_000);

  // 4. Push to level 90.
  await setLevelBest(ctx, 90, print);
  alwaysLog(`level=${ctx.character.level}`);

  // 4b. Force the player init handler to re-run with the new level.
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

  // 4c. Directly grant the tier-2/3 series commands.
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
  print(`granting ${EXPERTISE_SKILL_MODS.length} expertise skill mods`);
  for (const [mod, value] of EXPERTISE_SKILL_MODS) {
    try {
      const reply = await adminConsole(ctx, `skill grantSkillMod ${mod} ${value} ${myOidStr}`);
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
}

/**
 * Build the buff-bot scenario. `session` is the shared {@link SessionControl}
 * — the buff loop watches it; `/say kill` and the control socket drive it.
 */
export function makeScenario(args: Args, session: SessionControl): ScenarioFn {
  const print = log(args.verbose);
  return async (ctx) => {
    // Settle briefly so CREO baseline arrives and ctx.character is hot.
    await ctx.wait(2_500);
    alwaysLog(`myOid=${ctx.sceneStart.playerNetworkId.toString()}`);

    const alreadySetUp = ctx.character.level >= 90;
    if (alreadySetUp) {
      alwaysLog(`already set up (level ${ctx.character.level}) — skipping setup`);
    } else {
      await runSetup(ctx, args, print);
    }

    // 6. Kill switch — any nearby player saying exactly "kill".
    const ownName = ctx.character.name ?? '';
    ctx.chat.onSay(
      (text, sender) => {
        if (sender.name === ownName) return false;
        return text.trim().toLowerCase() === 'kill';
      },
      (_text, sender) => {
        session.request('stop', `kill command received from ${sender.name}`);
        alwaysLog(`kill command received from ${sender.name}`);
      },
    );

    // 7. Buff loop. Every non-self CREO within `radius` is a buff target.
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

    // Rebuff switch — `/say rebuff` clears the speaker's throttle entry.
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

    // `ctl trigger rebuff-all` — clear every throttle so the whole crowd
    // gets re-buffed on the next tick.
    session.registerAction('rebuff-all', () => {
      const n = lastBuffed.size;
      lastBuffed.clear();
      alwaysLog(`rebuff-all triggered — cleared ${n} throttle(s)`);
      return `cleared ${n} throttle(s)`;
    });

    // Keepalive — re-send posture every 60s so the server doesn't drop us.
    let lastKeepaliveAt = Date.now();
    const KEEPALIVE_MS = 60_000;

    let tick = 0;
    while (!ctx.signal.aborted && session.shouldKeepRunning()) {
      tick++;
      if (Date.now() - lastKeepaliveAt >= KEEPALIVE_MS) {
        try {
          ctx.changePosture('standing');
          lastKeepaliveAt = Date.now();
        } catch {
          // ignored — keepalive failure means we're already dead
        }
      }
      // Suspend buffing while paused; keep the connection alive.
      if (session.isPaused()) {
        if (tick % 30 === 0) print(`tick #${tick}: paused`);
        await ctx.wait(2_000);
        continue;
      }
      const players = findPlayersInRange();
      if (players.length === 0) {
        print(`tick #${tick}: no players in ${args.radius}m radius`);
      } else {
        print(`tick #${tick}: ${players.length} player(s) in range`);
      }
      for (const p of players) {
        if (ctx.signal.aborted || !session.shouldKeepRunning()) break;
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
          if (ctx.signal.aborted || !session.shouldKeepRunning()) break;
          ctx.useAbility(ability, p.id, p.id.toString());
          await ctx.wait(2_000);
        }
        if (session.shouldKeepRunning() && !ctx.signal.aborted) {
          ctx.say(`Done buffing ${name}`);
          lastBuffed.set(oidKey, Date.now());
        }
      }
      if (!session.shouldKeepRunning()) break;
      await ctx.wait(2_000);
    }

    // On `reload` the connection is kept — return immediately so the
    // freshly imported code resumes against this same session.
    if (session.directive === 'reload') {
      alwaysLog('reload requested — yielding to fresh scenario code (connection kept)');
      return;
    }
    // stop / logout / restart / natural end — the game-stage logs out.
    alwaysLog(
      `scenario ending: directive=${session.directive} reason=${session.reason || '(none)'}`,
    );
  };
}
