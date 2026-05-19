/**
 * delete-all-chars.ts — sweep a list of accounts and delete every
 * character on each. Intended for dev-server cleanup.
 *
 * Usage:
 *   pnpm tsx scripts/delete-all-chars.ts [--host=... --port=...]
 *     [--accounts=swg,swg1,swg2,tslive01,tslive02,...]
 *     [--dry-run]
 *
 * Defaults: --accounts=swg,swg1,swg2,swg3,swg4,swg5,tslive01..tslive20
 *           (plus a spot-check of testing01, trav01, automated001)
 *
 * Cluster id defaults to 1 (only cluster on the reference build).
 */
import { runLoginStage } from '../src/client/login-stage.js';
import { deleteCharacter } from '../src/client/delete-character.js';
import type { CharacterInfo } from '../src/types.js';

interface Args {
  host: string;
  port: number;
  accounts: string[];
  dryRun: boolean;
  clusterId: number;
}

function defaultAccounts(): string[] {
  const out: string[] = ['swg', 'swg1', 'swg2', 'swg3', 'swg4', 'swg5'];
  for (let i = 1; i <= 20; i++) out.push(`tslive${i.toString().padStart(2, '0')}`);
  // Spot-check the user-added pools — these should be empty since they
  // were added today, but the sweep doubles as a verification pass.
  out.push('testing01', 'trav01', 'automated001');
  return out;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {
    host: '10.254.0.253',
    port: 44453,
    accounts: defaultAccounts(),
    dryRun: false,
    clusterId: 1,
  };
  for (const a of argv) {
    if (a === '--dry-run') { out.dryRun = true; continue; }
    const m = /^--([\w-]+)=(.*)$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    switch (k) {
      case 'host': out.host = v; break;
      case 'port': out.port = Number(v); break;
      case 'cluster-id': out.clusterId = Number(v); break;
      case 'accounts': out.accounts = v.split(',').map((s) => s.trim()).filter(Boolean); break;
    }
  }
  return out;
}

function log(msg: string): void {
  process.stderr.write(`[sweep] ${msg}\n`);
}

async function survey(endpoint: { host: string; port: number }, account: string): Promise<readonly CharacterInfo[]> {
  try {
    const login = await runLoginStage({ endpoint, username: account });
    return login.characters;
  } catch (err) {
    log(`  WARN: login failed on ${account}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = { host: args.host, port: args.port };
  log(`host=${args.host}:${args.port} accounts=${args.accounts.length}${args.dryRun ? ' DRY-RUN' : ''}`);

  // Phase 1: survey
  log('--- phase 1: survey ---');
  const surveyed: Array<{ account: string; chars: readonly CharacterInfo[] }> = [];
  let totalChars = 0;
  for (const account of args.accounts) {
    const chars = await survey(endpoint, account);
    if (chars.length > 0) {
      log(`  ${account}: ${chars.length} character(s) — ${chars.map((c) => c.name).join(', ')}`);
      surveyed.push({ account, chars });
      totalChars += chars.length;
    }
  }
  log(`survey done: ${totalChars} character(s) across ${surveyed.length} account(s)`);

  if (totalChars === 0) {
    log('nothing to delete');
    process.exit(0);
  }
  if (args.dryRun) {
    log('dry-run — exiting without deleting');
    process.exit(0);
  }

  // Phase 2: delete
  log('--- phase 2: delete ---');
  let deleted = 0;
  let failed = 0;
  for (const { account, chars } of surveyed) {
    for (const c of chars) {
      try {
        const reply = await deleteCharacter({
          loginServer: endpoint,
          account,
          characterId: c.networkId,
          clusterId: args.clusterId,
        });
        if (reply.resultCode === 0) {
          log(`  deleted ${account}/${c.name} (oid=${c.networkId.toString()}) — ${reply.resultName}`);
          deleted++;
        } else {
          log(`  FAILED ${account}/${c.name} (oid=${c.networkId.toString()}) — ${reply.resultName}`);
          failed++;
        }
      } catch (err) {
        log(`  ERROR ${account}/${c.name}: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }
  }
  log(`delete done: ${deleted} queued, ${failed} failed`);
  log(`NOTE: DB purge is async — wait ~10s and re-survey to confirm`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
