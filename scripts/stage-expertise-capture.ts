/**
 * stage-expertise-capture.ts
 *
 * One-shot character staging for capturing a real ExpertiseRequestMessage
 * wire packet from the Windows client. Run this once, then log into the
 * Windows client with the printed credentials and grant expertise via the
 * in-game Expertise window (K hotkey). A tcpdump on UDP 44453 will capture
 * the exact wire bytes the live client emits.
 *
 * What it does:
 *   - Logs in as an admin-pool account (default tslive09).
 *   - Creates a fresh medic character on Tatooine (Mos Eisley) if absent.
 *   - Enables god-mode, grants the 28-skill class_medic_phase1..4_master chain
 *     (so the medic expertise tree is unlocked), pushes the character to
 *     level 90 (so all expertise points are available).
 *   - Clears any existing expertise via ExpertiseRequestMessage([], true)
 *     so the user has a full unspent expertise pool to allocate when they
 *     log in via the Windows client.
 *   - Logs out cleanly so the user can grab the GameConnection slot.
 *
 * Usage:
 *   pnpm tsx scripts/stage-expertise-capture.ts
 *     [--host=10.254.0.253] [--port=44453]
 *     [--user=tslive09] [--character=ExpertCap]
 *     [--planet=tatooine --x=3528 --z=-4804]
 */
import { SwgClient } from '../src/index.js';
import type { ScenarioFn } from '../src/index.js';
import {
  adminConsole,
  adminGodModeOn,
  adminPlanetWarp,
} from './build-city/admin.js';
import { AutoArrayCodec } from '../src/archive/containers.js';
import type { IByteStream, IReadIterator } from '../src/archive/interface.js';
import { StringCodec } from '../src/archive/string.js';
import { GameNetworkMessage, defineMessageMeta } from '../src/messages/base.js';

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

const MEDIC_CHAIN: readonly string[] = [
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
];

interface Args {
  host: string;
  port: number;
  user: string;
  character: string;
  planet: string;
  x: number;
  z: number;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {
    host: '10.254.0.253',
    port: 44453,
    user: 'tslive09',
    character: 'ExpertCap',
    planet: 'tatooine',
    x: 3528,
    z: -4804,
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
      case 'x': out.x = Number(v); break;
      case 'z': out.z = Number(v); break;
    }
  }
  return out;
}

function log(msg: string): void {
  process.stderr.write(`[stage] ${msg}\n`);
}

const scenario = (args: Args): ScenarioFn => async (ctx) => {
  await ctx.wait(2_500);

  const oid = ctx.sceneStart.playerNetworkId.toString();
  log(`character=${args.character} oid=${oid}`);

  log('godmode on');
  await adminGodModeOn(ctx);
  await ctx.wait(250);

  log(`warping to ${args.planet} (${args.x}, ${args.z})`);
  try {
    await adminPlanetWarp(ctx, args.planet, args.x, 0, args.z);
  } catch (err) {
    log(`warp warning: ${err instanceof Error ? err.message : String(err)}`);
  }
  await ctx.wait(1_500);

  log(`granting ${MEDIC_CHAIN.length} medic class skills`);
  for (const skill of MEDIC_CHAIN) {
    try {
      await adminConsole(ctx, `skill grantSkill ${skill}`);
    } catch (err) {
      log(`  grantSkill ${skill}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log('class_medic_phase4_master granted');

  log('pushing to level 90');
  for (let i = 0; i < 40; i++) {
    if (ctx.character.level >= 90) break;
    await adminConsole(ctx, `skill grantExperience ${oid} combat_general 500000`);
    await ctx.wait(750);
  }
  log(`level=${ctx.character.level}`);

  log('clearing all expertise (ExpertiseRequestMessage([], true))');
  ctx.send(new ExpertiseRequestMessage([], true));
  await ctx.wait(1_500);

  log('staging done — logging out so user can claim the GameConnection');
  await ctx.logout();
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  log(`host=${args.host}:${args.port} user=${args.user} character=${args.character}`);

  const client = new SwgClient({
    loginServer: { host: args.host, port: args.port },
  });

  const result = await client.fullLifecycle({
    account: args.user,
    characterName: args.character,
    planet: 'mos_eisley',
    holdZonedInMs: 0,
    script: scenario(args),
  });

  log(`lifecycle outcome=${result.outcome} zonedInAt=${result.zonedInAt ?? 'null'}`);
  process.exit(result.outcome === 'success' ? 0 : 1);
}

await main();
