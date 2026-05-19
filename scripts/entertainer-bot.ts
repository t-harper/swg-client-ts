/**
 * entertainer-bot — NGE entertainer auto-buffer.
 *
 * Pattern mirrors scripts/buff-bot.ts (medic bot). Differences:
 *   - Profession: entertainer (class_entertainer_phase4_master + all
 *     expertise_en_* leaves).
 *   - Location: outside Mos Eisley cantina (tatooine, 3477, -4857).
 *   - Idle behavior: continuous music performance with a kloo_horn (spawned
 *     into the bot's inventory at setup).
 *   - Cast trigger: PLAYER-DRIVEN via `/say buff <word>` (not auto-rotate).
 *   - Bio: set at startup to list the shorthand language so players can
 *     /examine the bot to discover the commands.
 *
 * Shorthand language (case-insensitive, trimmed, must be <= 40 chars total):
 *   /say buff heal       → en_healer_buff_package
 *   /say buff harvest    → en_harvest_faire_buff_package
 *   /say buff second     → en_second_chance_buff_package
 *   /say buff flow       → en_go_with_the_flow_buff_package
 *   /say buff flush      → en_flush_with_success_buff_package
 *   /say buff inspire    → inspire (base)
 *   /say buff all        → cast all six
 * Aliases handled per SHORTHAND_MAP below.
 *
 * Stop command: `/say kill` (same as medic bot; will stop BOTH bots if
 * both are within earshot — accepted per user choice).
 *
 * Usage:
 *   pnpm tsx bin/entertainer-bot.ts
 *       [--host=10.254.0.253] [--port=44453]
 *       [--user=tslive06] [--character=Bard]
 *       [--planet=tatooine --x=3477 --z=-4857]
 *       [--rebuff-after-min=2] [--verbose]
 */

import {
  type LifecycleResult,
  type NetworkId,
  ObjectMenuSelectMessage,
  ObjectTypeTags,
  RadialMenuTypes,
  type ScenarioFn,
  type ScriptContext,
  SwgClient,
  type WorldObject,
} from '../src/index.js';
import { adminConsole, adminGodModeOn, adminPlanetWarp, adminSpawnInto } from './build-city/admin.js';
import { AutoArrayCodec } from '../src/archive/containers.js';
import type { IByteStream, IReadIterator } from '../src/archive/interface.js';
import { StringCodec } from '../src/archive/string.js';
import { GameNetworkMessage, defineMessageMeta } from '../src/messages/base.js';

// Mirrors buff-bot.ts ExpertiseRequestMessage — godmode bypass at
// CreatureObject.cpp:14532 grants every expertise without point checks.
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

interface Args {
  host: string;
  port: number;
  user: string;
  character: string;
  planet: string;
  x: number;
  z: number;
  rebuffAfterMin: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    host: '10.254.0.253',
    port: 44453,
    user: 'tslive06',
    character: 'Bard',
    planet: 'tatooine',
    x: 3477,
    z: -4857,
    rebuffAfterMin: 2,
    verbose: false,
  };
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const key = (eq >= 0 ? raw.slice(2, eq) : raw.slice(2)).toLowerCase();
    const val = eq >= 0 ? raw.slice(eq + 1) : 'true';
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
      case 'rebuff-after-min':
        a.rebuffAfterMin = Number.parseFloat(val);
        break;
      case 'verbose':
        a.verbose = val === 'true' || val === '';
        break;
      default:
        process.stderr.write(`[entertainer-bot] unknown arg --${key}\n`);
        process.stderr.write(
          'usage: pnpm tsx bin/entertainer-bot.ts [--host=...] [--user=...] [--character=...]\n' +
            '       [--planet=... --x=... --z=...] [--rebuff-after-min=N] [--verbose]\n',
        );
        process.exit(2);
    }
  }
  return a;
}

// Player-targeted buff abilities granted by entertainer skill/expertise.
const BUFF_HEALER = 'en_healer_buff_package';
const BUFF_HARVEST = 'en_harvest_faire_buff_package';
const BUFF_SECOND = 'en_second_chance_buff_package';
const BUFF_FLOW = 'en_go_with_the_flow_buff_package';
const BUFF_FLUSH = 'en_flush_with_success_buff_package';
const BUFF_INSPIRE = 'inspire';
const BUFF_ALL = [BUFF_HEALER, BUFF_HARVEST, BUFF_SECOND, BUFF_FLOW, BUFF_FLUSH, BUFF_INSPIRE];

// Shorthand language: trimmed lowercased word after "buff " → list of verbs.
// Many synonyms map to the same ability for flexibility.
const SHORTHAND_MAP: Record<string, readonly string[]> = {
  heal: [BUFF_HEALER],
  healer: [BUFF_HEALER],
  health: [BUFF_HEALER],
  harvest: [BUFF_HARVEST],
  harv: [BUFF_HARVEST],
  crafter: [BUFF_HARVEST],
  craft: [BUFF_HARVEST],
  second: [BUFF_SECOND],
  chance: [BUFF_SECOND],
  sc: [BUFF_SECOND],
  flow: [BUFF_FLOW],
  gwf: [BUFF_FLOW],
  agility: [BUFF_FLOW],
  flush: [BUFF_FLUSH],
  success: [BUFF_FLUSH],
  fws: [BUFF_FLUSH],
  loot: [BUFF_FLUSH],
  inspire: [BUFF_INSPIRE],
  insp: [BUFF_INSPIRE],
  all: BUFF_ALL,
  me: BUFF_ALL,
  everything: BUFF_ALL,
};

// Bio text — keep <500 chars per the playerObject limit; we use ~250.
const BIO_TEXT =
  "Auto-buff bard. /say one of: buff heal, buff harvest, buff second, " +
  "buff flow, buff flush, buff inspire, buff all. Aliases: harv crafter " +
  "chance sc gwf agility success fws loot insp me everything. " +
  "(/say kill to stop the bot.)";

// Skill chain (class_entertainer_phase1..4_master). grantSkill enforces
// prereqs server-side; we walk the chain in order.
const REQUIRED_SKILLS: readonly string[] = [
  'class_entertainer_phase1_novice',
  'class_entertainer_phase1_02',
  'class_entertainer_phase1_03',
  'class_entertainer_phase1_04',
  'class_entertainer_phase1_05',
  'class_entertainer_phase1_master',
  'class_entertainer_phase2_novice',
  'class_entertainer_phase2_02',
  'class_entertainer_phase2_03',
  'class_entertainer_phase2_04',
  'class_entertainer_phase2_05',
  'class_entertainer_phase2_master',
  'class_entertainer_phase3_novice',
  'class_entertainer_phase3_02',
  'class_entertainer_phase3_03',
  'class_entertainer_phase3_04',
  'class_entertainer_phase3_05',
  'class_entertainer_phase3_master',
  'class_entertainer_phase4_novice',
  'class_entertainer_phase4_02',
  'class_entertainer_phase4_03',
  'class_entertainer_phase4_04',
  'class_entertainer_phase4_05',
  'class_entertainer_phase4_master',
  // Expertise root then all en_* leaves — extracted from skills.tab via
  // `awk -F'\t' '/^expertise_en_/ {print $1}'`.
  'expertise',
  'expertise_en_inspired_fitness_1',
  'expertise_en_inspired_fitness_2',
  'expertise_en_inspired_fitness_3',
  'expertise_en_inspired_fitness_4',
  'expertise_en_inspired_resilience_1',
  'expertise_en_inspired_resilience_2',
  'expertise_en_inspired_resilience_3',
  'expertise_en_inspired_resilience_4',
  'expertise_en_inspired_industry_1',
  'expertise_en_inspired_industry_2',
  'expertise_en_inspired_industry_3',
  'expertise_en_inspired_industry_4',
  'expertise_en_creativity_1',
  'expertise_en_creativity_2',
  'expertise_en_creativity_3',
  'expertise_en_creativity_4',
  'expertise_en_holism_1',
  'expertise_en_harvest_faire_1',
  'expertise_en_second_chance_1',
  'expertise_en_go_with_the_flow_1',
  'expertise_en_intense_performer_1',
  'expertise_en_intense_performer_2',
  'expertise_en_intense_performer_3',
  'expertise_en_intense_performer_4',
  'expertise_en_affability_1',
  'expertise_en_affability_2',
  'expertise_en_affability_3',
  'expertise_en_affability_4',
  'expertise_en_flush_with_success_1',
  'expertise_en_inspired_reactions_1',
];

const ENTERTAINER_EXPERTISE_LEAVES: readonly string[] = REQUIRED_SKILLS.filter((s) =>
  s.startsWith('expertise_en_'),
);

// Expertise-derived skill mods — granted directly because grantSkill alone
// doesn't reliably propagate them (same gap we discovered with the medic
// bot's expertise_buff_duration_line_me_enhance mod). Totals = sum of the
// per-leaf MODS values from skills.tab.
const EXPERTISE_SKILL_MODS: Array<[string, number]> = [
  ['expertise_en_inspire_attrib_increase', 200], // 50*4 from inspired_fitness
  ['expertise_en_inspire_resist_increase', 200], // 50*4 from inspired_resilience
  ['expertise_en_inspire_trader_increase', 100], // 25*4 from inspired_industry
  ['expertise_en_inspire_base_point_increase', 12], // 3*4 from creativity
  ['expertise_en_inspire_pulse_duration_increase', 4], // 1*4 from intense_performer
  ['expertise_en_performance_increase', 20], // 5*4 from affability
  ['expertise_en_inspire_proc_chance_increase', 1], // 1*1 from inspired_reactions
];

const log = (verbose: boolean) =>
  verbose ? (m: string) => process.stderr.write(`[entertainer-bot] ${m}\n`) : () => {};

const alwaysLog = (m: string): void => {
  process.stderr.write(`[entertainer-bot] ${m}\n`);
};

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
    print(`level=${ctx.character.level} — granting ${chunk} entertainer XP`);
    // entertainer-specific XP type may be more efficient; try entertainer
    // first, fall back to combat_general which always works.
    try {
      await grantExperience(ctx, 'entertainer', chunk);
    } catch {
      await grantExperience(ctx, 'combat_general', chunk);
    }
    await ctx.wait(750);
  }
  print(`WARNING: level=${ctx.character.level} after ${maxIterations} grants; continuing anyway`);
}

function makeScenario(args: Args, killController: { stop: boolean; reason: string }): ScenarioFn {
  const print = log(args.verbose);
  return async (ctx) => {
    await ctx.wait(2_500);
    alwaysLog(`myOid=${ctx.sceneStart.playerNetworkId.toString()}`);

    // 1. Godmode (privileges).
    alwaysLog('enabling godmode');
    await adminGodModeOn(ctx);
    alwaysLog('godmode on');

    // 2. Best-effort invulnerability.
    try {
      ctx.useAbility('setInvulnerable', undefined, '1');
      print('attempted setInvulnerable via useAbility');
    } catch (err) {
      alwaysLog(
        `WARNING: could not enable invulnerability (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    await ctx.wait(250);

    // 3. Grant entertainer class chain + all expertise leaves.
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
    alwaysLog('granted required skills (final tier: class_entertainer_phase4_master)');

    // 3b. ExpertiseRequest with all entertainer expertise (godmode bypass
    // grants without point limits).
    alwaysLog(`sending ExpertiseRequest (${ENTERTAINER_EXPERTISE_LEAVES.length} leaves)`);
    ctx.send(new ExpertiseRequestMessage(ENTERTAINER_EXPERTISE_LEAVES, true));
    await ctx.wait(1_000);

    // 4. Level 90.
    await setLevelBest(ctx, 90, print);
    alwaysLog(`level=${ctx.character.level}`);

    // 4b. Re-run init handler — refreshes combat skill mods from expertise.
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

    // 4c. Grant the inspire-related skill mods that the expertise side-effect
    // pipeline doesn't reliably apply (mirror the medic-bot pattern).
    print(`granting ${EXPERTISE_SKILL_MODS.length} inspire/performance skill mods`);
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

    // 5. Warp to outside Mos Eisley cantina (waypoint per collection.tab:5544).
    alwaysLog(`warping to ${args.planet} (${args.x}, ${args.z})`);
    await adminPlanetWarp(ctx, args.planet, args.x, 0, args.z);
    alwaysLog(`warped to ${args.planet} (${args.x}, ${args.z})`);

    // 6. Spawn instruments into the bot's inventory so it can play music.
    // shared_kloo_horn.iff isn't built in this server fork (the .tpf
    // references it but the shared variant is missing from data/), so we
    // pick instruments that DO have shared variants — fanfar + bandfill +
    // fizz + drums are all verified present under
    // data/sku.0/sys.shared/.../tangible/instrument/.
    // Spawn multiple so the bot can also switch between instrument types via
    // changeMusic — each music genre is tied to a specific instrument.
    // Server template paths (NOT shared_*) — server's
    // `getObjectTemplateForCreation` resolves these from
    // data/sku.0/sys.server/compiled/game/object/tangible/instrument/.
    const INSTRUMENTS = [
      'object/tangible/instrument/fanfar.iff',
      'object/tangible/instrument/bandfill.iff',
      'object/tangible/instrument/fizz.iff',
      'object/tangible/instrument/flute_droopy.iff',
      'object/tangible/instrument/mandoviol.iff',
      'object/tangible/instrument/kloo_horn.iff',
    ];
    const inventoryId = ctx.inventory?.containerId ?? null;
    let fanfarOid: NetworkId | null = null;
    if (inventoryId) {
      for (const tpl of INSTRUMENTS) {
        try {
          const oid = await adminSpawnInto(ctx, tpl, inventoryId, { timeoutMs: 5_000 });
          print(`spawn ${tpl.split('/').pop()}: oid=${oid.toString()}`);
          if (tpl.endsWith('/fanfar.iff')) fanfarOid = oid;
        } catch (err) {
          print(
            `spawn ${tpl.split('/').pop()}: FAILED (${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
    } else {
      alwaysLog('WARNING: could not resolve inventory id; skipping instrument spawn');
    }
    await ctx.wait(750);

    // 6b. Show-off jog to the cantina. The bot warps to (--x, --z) which is
    // typically a hold-point outside the building; run to the cantina anchor
    // (~3528, -4807 — the Mos Eisley cantina's buildout pos) with a flourish
    // mid-route so anyone watching sees movement + animation, then settle
    // there to play. Falls back to the warp position on any error.
    const CANTINA_X = 3528;
    const CANTINA_Z = -4807;
    try {
      const stops = [
        { x: (args.x + CANTINA_X) / 2, z: (args.z + CANTINA_Z) / 2, flourish: 3 },
        { x: CANTINA_X, z: CANTINA_Z, flourish: 7 },
      ];
      for (const stop of stops) {
        alwaysLog(`jogging to (${stop.x.toFixed(0)}, ${stop.z.toFixed(0)})`);
        await ctx.walkTo({ x: stop.x, z: stop.z });
        ctx.useAbility('flourish', undefined, String(stop.flourish));
        print(`flourish ${stop.flourish}`);
        await ctx.wait(500);
      }
      alwaysLog(`arrived at cantina (${CANTINA_X}, ${CANTINA_Z})`);
    } catch (err) {
      alwaysLog(
        `WARNING: jog-to-cantina failed (${err instanceof Error ? err.message : String(err)}) — playing from warp spot instead`,
      );
    }
    await ctx.wait(500);

    // 6c. Equip the fanfar so startMusic actually emits instrument sound +
    // animation. Without an equipped instrument the server accepts the
    // startMusic command but the visual/audio rendering on watching clients
    // is "standing still, silent". RadialMenuTypes.ITEM_EQUIP=12 mirrors
    // the right-click → Equip path the Windows client uses.
    if (fanfarOid !== null) {
      try {
        ctx.send(new ObjectMenuSelectMessage(fanfarOid, RadialMenuTypes.ITEM_EQUIP));
        alwaysLog(`equipped fanfar (oid=${fanfarOid.toString()})`);
        await ctx.wait(750);
      } catch (err) {
        alwaysLog(
          `WARNING: equip fanfar failed (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    } else {
      alwaysLog('WARNING: fanfar oid not captured — startMusic will fire without an instrument');
    }

    // 7. Set the in-game biography so players can /examine the bot to see
    // the shorthand language. Player-command path (per command_table.tab).
    try {
      ctx.useAbility('setBiography', undefined, BIO_TEXT);
      print(`set biography (${BIO_TEXT.length} chars)`);
    } catch (err) {
      alwaysLog(
        `WARNING: setBiography failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    await ctx.wait(500);

    // 8. Start performing music — the entertainer presence helps establish
    // an audience for inspire pulses to land. Genre choice is arbitrary;
    // 'rock' is granted by class_entertainer_phase1_novice.
    try {
      ctx.useAbility('startMusic', undefined, 'rock');
      print('startMusic+rock');
    } catch (err) {
      alwaysLog(
        `WARNING: startMusic failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    // 9. Wire chat handlers.
    const ownName = ctx.character.name ?? '';

    // Kill switch — exact 'kill' (case-insensitive, trimmed). Same word as
    // the medic bot per user choice; will stop both bots if both hear it.
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

    // Per-(player, buff) throttle so a single player can't spam the same buff
    // every second. Different buffs are independent; rebuffAfterMin minutes
    // between same-buff casts on the same player.
    const lastBuffed = new Map<string, number>();
    const throttleMs = args.rebuffAfterMin * 60_000;
    const throttleKey = (oid: string, verb: string): string => `${oid}:${verb}`;

    // Buff handler — parse `buff <word>` and dispatch via SHORTHAND_MAP.
    ctx.chat.onSay(
      (text, sender) => {
        if (sender.name === ownName) return false;
        const trimmed = text.trim().toLowerCase();
        if (trimmed.length > 40) return false; // hard cap per user spec
        return trimmed.startsWith('buff ');
      },
      (text, sender) => {
        const trimmed = text.trim().toLowerCase();
        const after = trimmed.slice('buff '.length).trim();
        const verbs = SHORTHAND_MAP[after];
        const senderId = sender.id;
        const senderName = sender.name || 'unknown';
        if (!senderId) {
          alwaysLog(`buff request from ${senderName}: no networkId on chat event; skipping`);
          return;
        }
        if (!verbs) {
          // Unknown shorthand — be quiet (don't echo, don't spam).
          print(`buff request from ${senderName}: unknown shorthand '${after}'`);
          return;
        }
        const oidStr = senderId.toString();
        // Fire-and-forget casts so the handler returns fast (chat handlers
        // should not block the dispatcher). Launch as a detached async IIFE.
        void (async () => {
          alwaysLog(`buff request from ${senderName}: ${after} (${verbs.length} cast(s))`);
          ctx.say(`Buffing ${senderName} (${after})`);
          await ctx.wait(400);
          let cast = 0;
          let skipped = 0;
          for (const verb of verbs) {
            if (ctx.signal.aborted || killController.stop) break;
            const key = throttleKey(oidStr, verb);
            const lastAt = lastBuffed.get(key) ?? 0;
            if (lastAt + throttleMs > Date.now()) {
              skipped++;
              continue;
            }
            ctx.useAbility(verb, senderId, oidStr);
            lastBuffed.set(key, Date.now());
            cast++;
            // 2s pacing — buff packages share cooldown groups; mirror medic
            // bot's empirically-safe spacing.
            await ctx.wait(2_000);
          }
          if (!killController.stop) {
            ctx.say(`Done buffing ${senderName} (cast=${cast} skip=${skipped})`);
          }
        })();
      },
    );

    // 10. Idle performance loop:
    //   - flourish 1..8 every ~30s (visual show)
    //   - change to a random music genre every ~3 min (variety)
    //   - keepalive posture-refresh every 60s (server drops idle sessions
    //     otherwise; verified empirically on the medic bot).
    // All music genres listed are granted by the class_entertainer_phase*
    // skills we just bought; verified against skills.tab COMMANDS columns.
    const MUSIC_GENRES = [
      'rock', 'starwars2', 'pop', 'folk', 'starwars3', 'ceremonial',
      'boogie', 'starwars4', 'ballad', 'swing', 'zydeco', 'funk', 'waltz',
    ] as const;
    const pickGenre = (current: string): string => {
      // Pick a different genre than the current one so changeMusic actually
      // changes something.
      if (MUSIC_GENRES.length <= 1) return MUSIC_GENRES[0]!;
      let next = current;
      while (next === current) {
        next = MUSIC_GENRES[Math.floor(Math.random() * MUSIC_GENRES.length)]!;
      }
      return next;
    };

    const FLOURISH_MS = 30_000;
    const KEEPALIVE_MS = 60_000;
    const GENRE_CHANGE_MS = 3 * 60_000;
    let lastFlourishAt = Date.now();
    let lastKeepaliveAt = Date.now();
    let lastGenreChangeAt = Date.now();
    let tick = 0;
    let flourishIdx = 1;
    let currentGenre = 'rock'; // matches the startMusic we issued above

    while (!ctx.signal.aborted && !killController.stop) {
      tick++;
      const now = Date.now();
      if (now - lastFlourishAt >= FLOURISH_MS) {
        try {
          // Pick a random flourish 1..8 (more variety than strict 1→8 cycle).
          flourishIdx = 1 + Math.floor(Math.random() * 8);
          ctx.useAbility('flourish', undefined, String(flourishIdx));
        } catch {
          // ignored
        }
        lastFlourishAt = now;
      }
      if (now - lastGenreChangeAt >= GENRE_CHANGE_MS) {
        const next = pickGenre(currentGenre);
        try {
          ctx.useAbility('changeMusic', undefined, next);
          print(`changeMusic ${currentGenre} → ${next}`);
          currentGenre = next;
        } catch {
          // ignored
        }
        lastGenreChangeAt = now;
      }
      if (now - lastKeepaliveAt >= KEEPALIVE_MS) {
        try {
          ctx.changePosture('standing');
        } catch {
          // ignored
        }
        lastKeepaliveAt = now;
      }
      if (tick % 30 === 0) {
        print(`tick #${tick}: idle (genre=${currentGenre} lastBuffed=${lastBuffed.size})`);
      }
      await ctx.wait(2_000);
    }

    if (killController.stop) {
      alwaysLog(`stopping: ${killController.reason}`);
    } else if (ctx.signal.aborted) {
      alwaysLog('script aborted; logging out');
    }
    // Politely stop performing before logout.
    try {
      ctx.useAbility('stopMusic', undefined, '');
    } catch {
      // ignored
    }
    await ctx.logout();
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const killController = { stop: false, reason: '' };
  const onSigint = (): void => {
    if (killController.stop) {
      process.stderr.write('[entertainer-bot] second SIGINT; force exit\n');
      process.exit(130);
    }
    killController.stop = true;
    killController.reason = 'SIGINT';
    alwaysLog('SIGINT received; stopping at next tick');
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);

  process.on('uncaughtException', (err) => {
    process.stderr.write(
      `[entertainer-bot] FATAL uncaughtException: ${err.stack ?? err.message ?? String(err)}\n`,
    );
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(
      `[entertainer-bot] FATAL unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
    );
    process.exit(1);
  });
  process.on('exit', (code) => {
    process.stderr.write(`[entertainer-bot] process exiting with code ${code}\n`);
  });

  const client = new SwgClient({ loginServer: { host: args.host, port: args.port } });
  let lifecycle: LifecycleResult;
  try {
    lifecycle = await client.fullLifecycle({
      account: args.user,
      characterName: args.character,
      planet: 'mos_eisley',
      // NGE entertainer class baked in at create-time — bypasses the
      // in-game `ws_professiontemplateselect` picker that fresh
      // characters otherwise get on first zone-in. Carried on
      // ClientCreateCharacterMessage so the PlayerObject's m_skillTemplate
      // baseline is set before zone-in. No-op when the named character
      // already exists.
      skillTemplate: 'entertainer_1a',
      workingSkill: 'class_entertainer_phase1_novice',
      profession: 'social_entertainer',
      holdZonedInMs: 10_000,
      script: makeScenario(args, killController),
    });
  } catch (err) {
    alwaysLog(`fullLifecycle threw: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  alwaysLog(
    `clean exit (zonedIn=${!!lifecycle.zonedInAt} logout=${!!lifecycle.logoutAt} stop=${killController.reason || '(none)'})`,
  );
}

main().catch((err) => {
  alwaysLog(`top-level error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
