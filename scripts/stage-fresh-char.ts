/**
 * stage-fresh-char.ts
 *
 * Create a brand-new character with an NGE profession already set, then
 * log out cleanly. Forces character creation even on accounts that already
 * have stocked characters by overriding the connection-stage's
 * `characters: []` (the high-level `fullLifecycle()` won't do this — it
 * only creates when LoginServer returns an empty avatar list).
 *
 * If `--profession=<class>` resolves to one of the NGE classes below, the
 * matching `skillTemplate` + `workingSkill` are baked into the
 * `ClientCreateCharacterMessage`, which sets the player's `m_skillTemplate`
 * baseline before zone-in and skips the in-client `ws_professiontemplateselect`
 * picker that fresh NGE characters get on first login.
 *
 * Usage:
 *   pnpm tsx scripts/stage-fresh-char.ts
 *     [--host=10.254.0.253] [--port=44453]
 *     [--user=tslive11] [--character=Officer1]
 *     [--planet=mos_eisley]
 *     [--profession=officer]            # NGE class shortcut (see NGE_CLASSES below)
 *     [--skill-template=officer_1a]     # OR raw skillTemplate (overrides --profession)
 *     [--working-skill=class_officer_phase1_novice]
 *     [--legacy-profession=combat_brawler]  # rarely needed — the legacy
 *                                            # profession stub baked into the
 *                                            # character template (must be one of
 *                                            # the 7 accepted strings)
 */
import { runLoginStage } from '../src/client/login-stage.js';
import { runConnectionStage } from '../src/client/connection-stage.js';
import { runGameStage } from '../src/client/game-stage.js';

/**
 * NGE class shortcuts → (skillTemplate, workingSkill). Maps the friendly
 * profession name the user types at the CLI to the wire-level
 * skill_template chain. All 9 NGE classes from
 * `dsrc/.../skill_template/skill_template.tab` are included.
 */
const NGE_CLASSES: Record<string, { skillTemplate: string; workingSkill: string }> = {
  officer:         { skillTemplate: 'officer_1a',         workingSkill: 'class_officer_phase1_novice' },
  commando:        { skillTemplate: 'commando_1a',        workingSkill: 'class_commando_phase1_novice' },
  medic:           { skillTemplate: 'medic_1a',           workingSkill: 'class_medic_phase1_novice' },
  spy:             { skillTemplate: 'spy_1a',             workingSkill: 'class_spy_phase1_novice' },
  smuggler:        { skillTemplate: 'smuggler_1a',        workingSkill: 'class_smuggler_phase1_novice' },
  bounty_hunter:   { skillTemplate: 'bounty_hunter_1a',   workingSkill: 'class_bounty_hunter_phase1_novice' },
  trader:          { skillTemplate: 'trader_0a',          workingSkill: 'class_domestics_phase1_novice' },
  entertainer:     { skillTemplate: 'entertainer_1a',     workingSkill: 'class_entertainer_phase1_novice' },
  force_sensitive: { skillTemplate: 'force_sensitive_1a', workingSkill: 'class_force_sensitive_phase1_novice' },
};

/**
 * Legacy profession strings — what the C++ `PlayerCreationManager` accepts
 * via the wire `profession` field. NGE class items come from the NPE
 * roadmap (driven by skillTemplate), not from this field, but it still
 * must be one of these 7 strings for character creation to succeed.
 */
const LEGACY_PROFESSION_DEFAULTS: Record<string, string> = {
  officer:         'combat_brawler',
  commando:        'combat_brawler',
  medic:           'science_medic',
  spy:             'combat_brawler',
  smuggler:        'combat_brawler',
  bounty_hunter:   'combat_marksman',
  trader:          'crafting_artisan',
  entertainer:     'social_entertainer',
  force_sensitive: 'jedi',
};

interface Args {
  host: string;
  port: number;
  user: string;
  character: string;
  planet: string;
  profession: string;
  skillTemplate: string;
  workingSkill: string;
  legacyProfession: string;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {
    host: '10.254.0.253',
    port: 44453,
    user: 'tslive11',
    character: 'PathPick',
    planet: 'mos_eisley',
    profession: '',
    skillTemplate: '',
    workingSkill: '',
    legacyProfession: '',
  };
  for (const a of argv) {
    const m = /^--([\w-]+)=(.*)$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    switch (k) {
      case 'host': out.host = v; break;
      case 'port': out.port = Number(v); break;
      case 'user': out.user = v; break;
      case 'character': out.character = v; break;
      case 'planet': out.planet = v; break;
      case 'profession': out.profession = v; break;
      case 'skill-template': out.skillTemplate = v; break;
      case 'working-skill': out.workingSkill = v; break;
      case 'legacy-profession': out.legacyProfession = v; break;
    }
  }
  return out;
}

function log(msg: string): void {
  process.stderr.write(`[stage] ${msg}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Resolve NGE class shortcut → skillTemplate + workingSkill
  let resolvedSkillTemplate = args.skillTemplate;
  let resolvedWorkingSkill = args.workingSkill;
  let resolvedLegacyProf = args.legacyProfession;
  if (args.profession && NGE_CLASSES[args.profession]) {
    const cls = NGE_CLASSES[args.profession];
    if (!resolvedSkillTemplate) resolvedSkillTemplate = cls.skillTemplate;
    if (!resolvedWorkingSkill) resolvedWorkingSkill = cls.workingSkill;
    if (!resolvedLegacyProf) {
      resolvedLegacyProf = LEGACY_PROFESSION_DEFAULTS[args.profession] ?? 'combat_brawler';
    }
  } else if (args.profession) {
    log(`WARNING: --profession=${args.profession} is not a recognized NGE class (${Object.keys(NGE_CLASSES).join(', ')}); treating as a raw legacy profession string`);
    if (!resolvedLegacyProf) resolvedLegacyProf = args.profession;
  }
  if (!resolvedLegacyProf) resolvedLegacyProf = 'combat_brawler';

  log(`host=${args.host}:${args.port} user=${args.user} character=${args.character}`);
  if (resolvedSkillTemplate) {
    log(`NGE path: skillTemplate=${resolvedSkillTemplate} workingSkill=${resolvedWorkingSkill}`);
  } else {
    log(`no skillTemplate set — NPE path picker will fire on first login`);
  }

  const login = await runLoginStage({
    endpoint: { host: args.host, port: args.port },
    username: args.user,
  });
  log(`logged in; ${login.characters.length} existing characters (will be ignored)`);

  const cluster = login.clusters[0];
  if (!cluster?.connectionServerAddress || !cluster.connectionServerPort) {
    throw new Error('cluster info incomplete');
  }

  log(`force-creating "${args.character}" (planet=${args.planet}, legacy=${resolvedLegacyProf})`);
  const conn = await runConnectionStage({
    endpoint: {
      host: cluster.connectionServerAddress,
      port: cluster.connectionServerPort,
    },
    tokenBytes: login.token.bytes,
    characters: [],
    characterToCreate: {
      name: args.character,
      startingLocation: args.planet,
      profession: resolvedLegacyProf,
      ...(resolvedSkillTemplate ? { skillTemplate: resolvedSkillTemplate } : {}),
      ...(resolvedWorkingSkill ? { workingSkill: resolvedWorkingSkill } : {}),
    },
  });
  log(`character created oid=${conn.selectedCharacter.networkId} — awaiting CmdStartScene`);

  const game = await runGameStage({
    dispatcher: conn.dispatcher,
    holdZonedInMs: 0,
    script: async (ctx) => {
      await ctx.wait(2_000);
      log(`zoned in as oid=${ctx.sceneStart.playerNetworkId} — logging out`);
      await ctx.logout();
    },
  });
  log(`outcome: zonedInAt=${game.zonedInAt.toISOString()} logoutAt=${game.logoutAt.toISOString()}`);
  process.exit(0);
}

await main();
