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
  type ScenarioFn,
  type ScriptContext,
  SwgClient,
  type WorldObject,
} from '../src/index.js';
import { adminConsole, adminGodModeOn, adminPlanetWarp } from './build-city/admin.js';

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

// Verified against ~/code/swg-main/dsrc/.../command/command_table.tab — these
// are the highest-tier `_3` master variants where they exist; block/dodge only
// have a `_1` form. Order doesn't matter; we cast all six per target.
const MEDIC_BUFF_COMMANDS = [
  'me_buff_health_3',
  'me_enhance_strength_3',
  'me_enhance_agility_3',
  'me_enhance_precision_3',
  'me_enhance_block_1',
  'me_enhance_dodge_1',
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
  // Expertise chains — each leaf grants one me_enhance_* command.
  'expertise',
  'expertise_me_strength_1',
  'expertise_me_strength_2',
  'expertise_me_strength_3',
  'expertise_me_strength_4',
  'expertise_me_enhance_strength_1',
  'expertise_me_agility_1',
  'expertise_me_agility_2',
  'expertise_me_agility_3',
  'expertise_me_agility_4',
  'expertise_me_enhance_agility_1',
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

    // 4. Push to level 90.
    await setLevelBest(ctx, 90, print);
    alwaysLog(`level=${ctx.character.level}`);

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
    const rebuffMs = args.rebuffAfterMin * 60_000;
    const lastBuffed = new Map<string, number>();
    let tick = 0;
    while (!ctx.signal.aborted && !killController.stop) {
      tick++;
      const players = ctx.playersInRange(args.radius);
      if (players.length === 0) {
        print(`tick #${tick}: no players in ${args.radius}m radius`);
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
          ctx.useAbility(ability, p.id);
          await ctx.wait(1_200);
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
