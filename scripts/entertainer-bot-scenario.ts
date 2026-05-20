/**
 * entertainer-bot-scenario — the import-safe half of the entertainer bot.
 *
 * Holds the `makeScenario` factory, the `Args` shape, and every constant /
 * helper. Has NO top-level execution — it is safe to dynamically re-import
 * for `ctl reload` (the runnable entry point is `scripts/entertainer-bot.ts`).
 *
 * Reload model: the heavy one-time setup (grant skills, level to 90, spawn
 * instruments, walk into the cantina) is gated behind an "already set up"
 * check (`ctx.character.level >= 90`), so a `reload` skips straight to the
 * chat handlers + idle loop — exactly the code you iterate on.
 *
 * Shorthand language (case-insensitive, trimmed, <= 40 chars total):
 *   /say buff heal       → en_healer_buff_package
 *   /say buff harvest    → en_harvest_faire_buff_package
 *   /say buff second     → en_second_chance_buff_package
 *   /say buff flow       → en_go_with_the_flow_buff_package
 *   /say buff flush      → en_flush_with_success_buff_package
 *   /say buff inspire    → inspire (base)
 *   /say buff all        → cast all six
 *
 * Stop command: `/say kill`.
 */

import { AutoArrayCodec } from '../src/archive/containers.js';
import type { IByteStream, IReadIterator } from '../src/archive/interface.js';
import { StringCodec } from '../src/archive/string.js';
import type { ScenarioFn, ScriptContext, SessionControl } from '../src/index.js';
import { GameNetworkMessage, defineMessageMeta } from '../src/messages/base.js';
import { HeartBeat } from '../src/messages/game/heart-beat.js';
import { adminConsole, adminGodModeOn, adminSpawnInto } from './build-city/admin.js';

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

export interface Args {
  host: string;
  port: number;
  user: string;
  character: string;
  planet: string;
  x: number;
  z: number;
  rebuffAfterMin: number;
  verbose: boolean;
  /** Control-socket session name. Defaults to `entbot-<character>`. */
  session?: string;
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
  'Auto-buff bard. /say one of: buff heal, buff harvest, buff second, ' +
  'buff flow, buff flush, buff inspire, buff all. Aliases: harv crafter ' +
  'chance sc gwf agility success fws loot insp me everything. ' +
  '(/say kill to stop the bot.)';

// Skill chain (class_entertainer_phase1..4_master).
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
  // Expertise root then all en_* leaves.
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
// doesn't reliably propagate them.
const EXPERTISE_SKILL_MODS: Array<[string, number]> = [
  ['expertise_en_inspire_attrib_increase', 200],
  ['expertise_en_inspire_resist_increase', 200],
  ['expertise_en_inspire_trader_increase', 100],
  ['expertise_en_inspire_base_point_increase', 12],
  ['expertise_en_inspire_pulse_duration_increase', 4],
  ['expertise_en_performance_increase', 20],
  ['expertise_en_inspire_proc_chance_increase', 1],
];

const log = (verbose: boolean): ((m: string) => void) => {
  if (!verbose) return () => undefined;
  return (m: string): void => {
    process.stderr.write(`[entertainer-bot] ${m}\n`);
  };
};

/** Always-on stderr logger — shared with the runnable entry point. */
export const alwaysLog = (m: string): void => {
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
    try {
      await grantExperience(ctx, 'entertainer', chunk);
    } catch {
      await grantExperience(ctx, 'combat_general', chunk);
    }
    await ctx.wait(750);
  }
  print(`WARNING: level=${ctx.character.level} after ${maxIterations} grants; continuing anyway`);
}

// Music genres — all granted by the class_entertainer_phase* skills.
const MUSIC_GENRES = [
  'rock',
  'starwars2',
  'pop',
  'folk',
  'starwars3',
  'ceremonial',
  'boogie',
  'starwars4',
  'ballad',
  'swing',
  'zydeco',
  'funk',
  'waltz',
] as const;

function pickGenre(current: string): string {
  if (MUSIC_GENRES.length <= 1) return MUSIC_GENRES[0];
  let next = current;
  while (next === current) {
    next = MUSIC_GENRES[Math.floor(Math.random() * MUSIC_GENRES.length)] ?? MUSIC_GENRES[0];
  }
  return next;
}

/**
 * Run the heavy one-time setup — godmode, skills, level 90, instruments,
 * walk into the cantina. Skipped on `reload` / `restart` when the
 * character is already leveled (the `alreadySetUp` gate in `makeScenario`).
 */
async function runSetup(ctx: ScriptContext, print: (m: string) => void): Promise<void> {
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

  // 3b. ExpertiseRequest with all entertainer expertise.
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

  // 4c. Grant the inspire-related skill mods.
  print(`granting ${EXPERTISE_SKILL_MODS.length} inspire/performance skill mods`);
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

  // 6. Spawn instruments into the bot's inventory so it can play music.
  const INSTRUMENTS = [
    'object/tangible/instrument/fanfar.iff',
    'object/tangible/instrument/bandfill.iff',
    'object/tangible/instrument/fizz.iff',
    'object/tangible/instrument/flute_droopy.iff',
    'object/tangible/instrument/mandoviol.iff',
    'object/tangible/instrument/kloo_horn.iff',
  ];
  const inventoryId = ctx.inventory?.containerId ?? null;
  if (inventoryId) {
    for (const tpl of INSTRUMENTS) {
      try {
        const oid = await adminSpawnInto(ctx, tpl, inventoryId, { timeoutMs: 5_000 });
        print(`spawn ${tpl.split('/').pop()}: oid=${oid.toString()}`);
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

  // 6c. Enter the Mos Eisley cantina, cell3 (deep performance room).
  const CANTINA_BUILDING_OID = 1082874n;
  const CANTINA_PERFORMANCE_CELL = 'cell3';
  const PERF_SPOT = { x: 20.44, y: -0.89, z: 1.27 };
  try {
    alwaysLog(
      `entering cantina (building oid=${CANTINA_BUILDING_OID.toString()}, ${CANTINA_PERFORMANCE_CELL})`,
    );
    await ctx.navigate(
      { buildingId: CANTINA_BUILDING_OID, cellName: CANTINA_PERFORMANCE_CELL },
      { useMount: 'never' },
    );
    const cell = ctx.location.cell;
    if (cell !== null && cell.buildingId === CANTINA_BUILDING_OID) {
      alwaysLog(
        `inside cantina cell ✓ (cellName=${cell.cellName ?? 'public'}, cellNumber=${cell.cellNumber})`,
      );
      try {
        const player = ctx.world.get(ctx.sceneStart.playerNetworkId);
        const cellId = player?.containerId ?? 0n;
        if (cellId !== 0n) {
          await ctx.walkToCell(cellId, PERF_SPOT);
          print(`walked to performance spot (${PERF_SPOT.x}, ${PERF_SPOT.z})`);
        }
      } catch (err) {
        print(`perf-spot walk warn: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      alwaysLog(
        `WARNING: navigate returned but ctx.location.cell is ${cell === null ? 'null (outdoors)' : 'wrong building'}; continuing outside`,
      );
    }
  } catch (err) {
    alwaysLog(
      `WARNING: cantina entry failed (${err instanceof Error ? err.message : String(err)}); continuing outside`,
    );
  }
  await ctx.wait(500);

  // 7. Set the in-game biography so players can /examine the shorthand.
  try {
    ctx.useAbility('setBiography', undefined, BIO_TEXT);
    print(`set biography (${BIO_TEXT.length} chars)`);
  } catch (err) {
    alwaysLog(`WARNING: setBiography failed (${err instanceof Error ? err.message : String(err)})`);
  }
  await ctx.wait(500);
}

/**
 * Build the entertainer-bot scenario. `session` is the shared
 * {@link SessionControl} — the idle loop watches it, the `/say kill`
 * handler and the control socket drive it.
 */
export function makeScenario(args: Args, session: SessionControl): ScenarioFn {
  const print = log(args.verbose);
  return async (ctx) => {
    await ctx.wait(2_500);
    alwaysLog(`myOid=${ctx.sceneStart.playerNetworkId.toString()}`);

    // Heavy setup (skills, level 90, instruments, cantina walk) runs once.
    // On reload / restart the character is already leveled, so we skip
    // straight to performing + the handlers + idle loop.
    const alreadySetUp = ctx.character.level >= 90;
    if (alreadySetUp) {
      alwaysLog(`already set up (level ${ctx.character.level}) — skipping heavy setup`);
    } else {
      await runSetup(ctx, print);
    }

    // Ensure a performance instrument is equipped — music needs one, and an
    // equipped instrument is not reliably restored across a logout, so this
    // runs every connection. The live server sends inventory items CRC-only,
    // so match on the SHARED-baseline name, not the template path. Prefer a
    // fanfar (it covers the genres the idle loop cycles); any instrument is
    // an acceptable fallback.
    const botOid = ctx.sceneStart.playerNetworkId;
    const instrument =
      ctx.inventory.items.find((it) => it.name !== null && /fanfar/i.test(it.name)) ??
      ctx.inventory.items.find(
        (it) => it.name !== null && /kloo_horn|bandfill|fizz|mandoviol|chidinkalu/i.test(it.name),
      );
    if (instrument !== undefined) {
      try {
        ctx.useAbility('transferItemWeapon', instrument.networkId, `${botOid.toString()} 4`);
        await ctx.wait(1_500);
        const equipped = ctx.world.get(instrument.networkId)?.containerId === botOid;
        alwaysLog(
          equipped
            ? `equipped instrument ${instrument.name} ✓`
            : `WARNING: instrument equip didn't take (${instrument.name})`,
        );
      } catch (err) {
        alwaysLog(
          `WARNING: equip instrument failed (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    } else {
      alwaysLog('no instrument in inventory — assuming one is already equipped');
    }

    // Start performing — always. Music does NOT persist across a
    // logout/reconnect, so a fresh process run or `restart` must re-issue
    // it; on a `reload` (same connection, already performing) the server
    // rejects the duplicate and the try/catch swallows it.
    try {
      ctx.useAbility('startMusic', undefined, 'rock');
      print('startMusic+rock');
    } catch (err) {
      alwaysLog(`WARNING: startMusic failed (${err instanceof Error ? err.message : String(err)})`);
    }

    // 9. Wire chat handlers (always — the context is fresh each run).
    const ownName = ctx.character.name ?? '';

    // Kill switch — exact 'kill' (case-insensitive, trimmed).
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

    // Per-(player, buff) throttle.
    const lastBuffed = new Map<string, number>();
    const throttleMs = args.rebuffAfterMin * 60_000;
    const throttleKey = (oid: string, verb: string): string => `${oid}:${verb}`;

    // Buff handler — parse `buff <word>` and dispatch via SHORTHAND_MAP.
    ctx.chat.onSay(
      (text, sender) => {
        if (sender.name === ownName) return false;
        const trimmed = text.trim().toLowerCase();
        if (trimmed.length > 40) return false;
        return trimmed.startsWith('buff ');
      },
      (text, sender) => {
        if (session.isPaused()) {
          print('buff request ignored — bot paused');
          return;
        }
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
          print(`buff request from ${senderName}: unknown shorthand '${after}'`);
          return;
        }
        const oidStr = senderId.toString();
        void (async () => {
          alwaysLog(`buff request from ${senderName}: ${after} (${verbs.length} cast(s))`);
          ctx.say(`Buffing ${senderName} (${after})`);
          await ctx.wait(400);
          let cast = 0;
          let skipped = 0;
          for (const verb of verbs) {
            if (ctx.signal.aborted || !session.shouldKeepRunning()) break;
            const key = throttleKey(oidStr, verb);
            const lastAt = lastBuffed.get(key) ?? 0;
            if (lastAt + throttleMs > Date.now()) {
              skipped++;
              continue;
            }
            ctx.useAbility(verb, senderId, oidStr);
            lastBuffed.set(key, Date.now());
            cast++;
            await ctx.wait(2_000);
          }
          if (session.shouldKeepRunning() && !ctx.signal.aborted) {
            ctx.say(`Done buffing ${senderName} (cast=${cast} skip=${skipped})`);
          }
        })();
      },
    );

    // 10. Idle performance loop. Flourish, genre change, and a music
    // self-heal run while not paused; a HeartBeat keepalive runs always so
    // the server doesn't drop the session. We deliberately do NOT use
    // changePosture as the keepalive — it knocks the character out of the
    // `skillAnimating` performance posture and silences the music.
    const FLOURISH_MS = 30_000;
    const KEEPALIVE_MS = 30_000;
    const GENRE_CHANGE_MS = 3 * 60_000;
    const MUSIC_CHECK_MS = 20_000;
    let lastFlourishAt = Date.now();
    let lastKeepaliveAt = Date.now();
    let lastGenreChangeAt = Date.now();
    let lastMusicCheckAt = Date.now();
    let tick = 0;
    let currentGenre = 'rock';

    // Named actions for the `trigger` control command.
    session.registerAction('flourish', () => {
      const idx = 1 + Math.floor(Math.random() * 8);
      ctx.useAbility('flourish', undefined, String(idx));
      return `flourish ${idx}`;
    });
    session.registerAction('genre', (a) => {
      const requested =
        typeof a?.genre === 'string' && a.genre !== '' ? a.genre : pickGenre(currentGenre);
      ctx.useAbility('changeMusic', undefined, requested);
      currentGenre = requested;
      return `genre → ${requested}`;
    });

    while (!ctx.signal.aborted && session.shouldKeepRunning()) {
      tick++;
      const now = Date.now();
      if (!session.isPaused()) {
        // Self-heal: an entertainer that isn't performing is broken. If the
        // performance stopped (a player /peace, a server hiccup, etc.),
        // restart it.
        if (now - lastMusicCheckAt >= MUSIC_CHECK_MS) {
          if (!ctx.character.performance.performing) {
            try {
              ctx.useAbility('startMusic', undefined, currentGenre);
              print(`performance had stopped — restarted (${currentGenre})`);
            } catch {
              // ignored
            }
          }
          lastMusicCheckAt = now;
        }
        if (now - lastFlourishAt >= FLOURISH_MS) {
          try {
            ctx.useAbility('flourish', undefined, String(1 + Math.floor(Math.random() * 8)));
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
      }
      if (now - lastKeepaliveAt >= KEEPALIVE_MS) {
        // A HeartBeat is pure anti-idle traffic — unlike changePosture it
        // never disturbs the music performance.
        try {
          ctx.send(new HeartBeat());
        } catch {
          // ignored
        }
        lastKeepaliveAt = now;
      }
      if (tick % 30 === 0) {
        const state = session.isPaused() ? 'paused' : 'idle';
        const perf = ctx.character.performance.performing ? 'performing' : 'silent';
        print(
          `tick #${tick}: ${state}/${perf} (genre=${currentGenre} lastBuffed=${lastBuffed.size})`,
        );
      }
      await ctx.wait(2_000);
    }

    // On `reload` the connection is kept — return immediately without
    // stopping the music so the freshly imported code resumes seamlessly.
    if (session.directive === 'reload') {
      alwaysLog('reload requested — yielding to fresh scenario code (connection kept)');
      return;
    }
    // stop / logout / restart / natural end — stop performing politely.
    // The game-stage sends the LogoutMessage; the scenario does not.
    try {
      ctx.useAbility('stopMusic', undefined, '');
    } catch {
      // ignored
    }
    alwaysLog(
      `scenario ending: directive=${session.directive} reason=${session.reason || '(none)'}`,
    );
  };
}
