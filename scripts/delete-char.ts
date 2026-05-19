/**
 * delete-char.ts — CLI helper to delete a character via the LoginServer
 * wire path (same flow as the Windows client's "Delete Character" button).
 *
 * Usage:
 *   pnpm tsx scripts/delete-char.ts --user=<acct> (--oid=<characterId> | --character=<name>)
 *     [--host=10.254.0.253] [--port=44453] [--cluster-id=1]
 *
 * Examples:
 *   # Delete by oid (no avatar-list lookup needed beyond the safety check):
 *   pnpm tsx scripts/delete-char.ts --user=tslive11 --oid=591551177
 *
 *   # Delete by display name (script resolves it against the avatar list first):
 *   pnpm tsx scripts/delete-char.ts --user=tslive11 --character=OfficerAuto
 *
 * Caveat: rc_OK from the server only means the delete was QUEUED. The DB
 * purge is async — `pnpm tsx scripts/list-chars.ts <user>` may still
 * report the character for a few seconds afterward.
 */
import { runLoginStage } from '../src/client/login-stage.js';
import { deleteCharacter } from '../src/client/delete-character.js';

interface Args {
  host: string;
  port: number;
  user: string;
  oid: bigint | null;
  character: string;
  clusterId: number;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {
    host: '10.254.0.253',
    port: 44453,
    user: '',
    oid: null,
    character: '',
    clusterId: 1,
  };
  for (const a of argv) {
    const m = /^--([\w-]+)=(.*)$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    switch (k) {
      case 'host': out.host = v; break;
      case 'port': out.port = Number(v); break;
      case 'user': out.user = v; break;
      case 'oid': out.oid = BigInt(v); break;
      case 'character': out.character = v; break;
      case 'cluster-id': out.clusterId = Number(v); break;
    }
  }
  return out;
}

function log(msg: string): void {
  process.stderr.write(`[delete-char] ${msg}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.user) {
    console.error('usage: pnpm tsx scripts/delete-char.ts --user=<acct> (--oid=<id> | --character=<name>)');
    process.exit(2);
  }
  if (args.oid === null && !args.character) {
    console.error('must supply --oid=<id> or --character=<name>');
    process.exit(2);
  }

  const endpoint = { host: args.host, port: args.port };

  // Resolve character name → oid if needed.
  let oid = args.oid;
  if (oid === null) {
    log(`resolving "${args.character}" on ${args.user}…`);
    const login = await runLoginStage({ endpoint, username: args.user });
    const found = login.characters.find((c) => c.name === args.character);
    if (!found) {
      console.error(
        `character "${args.character}" not found on account "${args.user}" (have: ${login.characters.map((c) => c.name).join(', ') || '<none>'})`,
      );
      process.exit(1);
    }
    oid = found.networkId;
    log(`resolved ${args.character} → oid=${oid.toString()}`);
  }

  log(`deleting oid=${oid.toString()} on cluster ${args.clusterId}…`);
  const reply = await deleteCharacter({
    loginServer: endpoint,
    account: args.user,
    characterId: oid,
    clusterId: args.clusterId,
  });
  log(`reply: ${reply.resultName} (code=${reply.resultCode})`);
  log(`NOTE: avatar list still contains the character — the DB purge is async`);
  log(`      re-run list-chars.ts in a few seconds to confirm it's gone`);
  process.exit(reply.resultCode === 0 ? 0 : 1);
}

await main();
