#!/usr/bin/env node --import tsx
/**
 * group-trade-demo.ts — drive a 2-client SWG session where one character
 * invites the other into a group, optionally attempts to open a trade
 * window, then disbands and logs out.
 *
 * Run with:
 *   pnpm exec tsx scripts/group-trade-demo.ts \
 *     --host=10.254.0.253 \
 *     --leader-account=gtleader1 --leader-char=GtLeader1 \
 *     --invitee-account=gtinvite1 --invitee-char=GtInvite1 \
 *     [--trade-amount=100] [--verbose]
 *
 * Workflow:
 *   1. Lookup phase: run a quick Fleet with `skipGameStage: true` against
 *      both accounts to resolve each character's NetworkId. This is
 *      necessary because the group-trade scenario needs the OTHER
 *      character's id, which it cannot easily learn at scenario-time.
 *   2. Run phase: run a 2-client Fleet with `groupTradeScenario` for each.
 *      The leader invites; the invitee waits, accepts, then both disband
 *      and Fleet handles logout.
 *   3. Report: a JSON summary of the lifecycle outcomes — did the group
 *      form? Did the (best-effort) trade window open?
 *
 * Manual-override workflow (skip lookup phase):
 *   pnpm exec tsx scripts/group-trade-demo.ts ... \
 *     --leader-id=0xabcd --invitee-id=0xbcde
 *   ↑ when both ids are passed, the lookup phase is skipped.
 *
 * NOTE: The trade window beyond the initial RequestTrade is unmodeled in
 * this client; see `groupTradeScenario` in `src/scenarios/index.ts` for
 * details. The script reports whether the initial trade ObjController
 * was sent, not whether the full transaction completed.
 */

import {
  Fleet,
  type FleetClientConfig,
  type FleetResult,
  type NetworkId,
  type ScenarioFn,
} from '../src/index.js';
import { groupTradeScenario } from '../src/scenarios/index.js';

interface Args {
  host: string;
  port: number;
  leaderAccount: string;
  leaderCharacter: string;
  inviteeAccount: string;
  inviteeCharacter: string;
  leaderId: NetworkId | null;
  inviteeId: NetworkId | null;
  tradeAmount: number;
  planet: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    host: '10.254.0.253',
    port: 44453,
    leaderAccount: '',
    leaderCharacter: '',
    inviteeAccount: '',
    inviteeCharacter: '',
    leaderId: null,
    inviteeId: null,
    tradeAmount: 0,
    planet: 'mos_eisley',
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
      case 'leader-account':
        a.leaderAccount = val;
        break;
      case 'leader-char':
        a.leaderCharacter = val;
        break;
      case 'invitee-account':
        a.inviteeAccount = val;
        break;
      case 'invitee-char':
        a.inviteeCharacter = val;
        break;
      case 'leader-id':
        a.leaderId = BigInt(val);
        break;
      case 'invitee-id':
        a.inviteeId = BigInt(val);
        break;
      case 'trade-amount':
        a.tradeAmount = Number.parseInt(val, 10);
        break;
      case 'planet':
        a.planet = val;
        break;
      case 'verbose':
        a.verbose = val === 'true' || val === '';
        break;
      case 'help':
        printUsage();
        process.exit(0);
        break;
      default:
        process.stderr.write(`Unknown flag: --${key}\n`);
        printUsage();
        process.exit(2);
    }
  }
  // Validate required flags.
  if (a.leaderAccount === '' || a.leaderCharacter === '') {
    process.stderr.write('--leader-account and --leader-char are required\n');
    printUsage();
    process.exit(2);
  }
  if (a.inviteeAccount === '' || a.inviteeCharacter === '') {
    process.stderr.write('--invitee-account and --invitee-char are required\n');
    printUsage();
    process.exit(2);
  }
  return a;
}

function printUsage(): void {
  process.stderr.write(
    [
      'Usage: pnpm exec tsx scripts/group-trade-demo.ts [flags]',
      '',
      'Required:',
      '  --leader-account=<acct>     account name for the inviter (must be unique)',
      '  --leader-char=<name>        character name (will be created if missing)',
      '  --invitee-account=<acct>    account name for the invitee (must be unique)',
      '  --invitee-char=<name>       character name (will be created if missing)',
      '',
      'Optional:',
      '  --host=10.254.0.253         LoginServer host',
      '  --port=44453                LoginServer port',
      '  --trade-amount=0            credits to ATTEMPT to transfer (best-effort; full',
      '                              trade window unmodeled). Default 0 → skip trade step.',
      '  --planet=mos_eisley         starting_locations.iff city key (NOT a planet name)',
      '  --leader-id=0x<hex>         skip the lookup phase and use this NetworkId',
      '  --invitee-id=0x<hex>        skip the lookup phase and use this NetworkId',
      '                              (both --leader-id and --invitee-id required to skip)',
      '  --verbose                   stream per-scenario log lines to stderr',
      '',
    ].join('\n'),
  );
}

/**
 * Phase 1 — resolve NetworkIds for each character via a Stage 1+2-only
 * Fleet run. Returns `{ leaderId, inviteeId }`.
 *
 * The character will be created on first run if it doesn't exist (Stage 2
 * runs `ClientCreateCharacter` when the avatar list is empty).
 */
async function lookupNetworkIds(args: Args): Promise<{
  leaderId: NetworkId;
  inviteeId: NetworkId;
}> {
  process.stderr.write('[group-trade-demo] Phase 1: looking up NetworkIds (Stage 1+2 only)...\n');
  const fleet = new Fleet({ loginServer: { host: args.host, port: args.port } });
  const result = await fleet.run(
    [
      {
        account: args.leaderAccount,
        characterName: args.leaderCharacter,
        planet: args.planet,
        skipGameStage: true,
      },
      {
        account: args.inviteeAccount,
        characterName: args.inviteeCharacter,
        planet: args.planet,
        skipGameStage: true,
      },
    ],
    { staggerMs: 100 },
  );
  const failures = result.outcomes
    .map((o, i) => ({ i, err: o?.error }))
    .filter((x) => x.err !== undefined);
  if (failures.length > 0) {
    const lines = failures.map((f) => `  [${f.i}] ${f.err?.message ?? '(no message)'}`);
    throw new Error(`Lookup phase failed:\n${lines.join('\n')}`);
  }
  const leaderId = result.outcomes[0]?.lifecycleResult?.character.networkId;
  const inviteeId = result.outcomes[1]?.lifecycleResult?.character.networkId;
  if (leaderId === undefined || inviteeId === undefined) {
    throw new Error('Lookup phase produced no character NetworkIds');
  }
  process.stderr.write(
    `[group-trade-demo] Lookup OK: leader=${args.leaderCharacter} id=0x${leaderId.toString(16)}, ` +
      `invitee=${args.inviteeCharacter} id=0x${inviteeId.toString(16)}\n`,
  );
  return { leaderId, inviteeId };
}

/** Phase 2 — run the actual group-trade scenario for both clients. */
async function runScenario(
  args: Args,
  ids: { leaderId: NetworkId; inviteeId: NetworkId },
): Promise<FleetResult> {
  process.stderr.write('[group-trade-demo] Phase 2: running group-trade scenario...\n');
  const fleet = new Fleet({ loginServer: { host: args.host, port: args.port } });

  // Build the per-role scenarios. The factory takes string args (matches
  // the CLI factory signature) and the scenario itself knows the other
  // character's NetworkId.
  const leaderScript: ScenarioFn = groupTradeScenario({
    role: 'leader',
    otherId: `0x${ids.inviteeId.toString(16)}`,
    tradeAmount: String(args.tradeAmount),
    waitForOtherMs: '10000',
    dwellMs: '500',
  });
  const inviteeScript: ScenarioFn = groupTradeScenario({
    role: 'invitee',
    otherId: `0x${ids.leaderId.toString(16)}`,
    tradeAmount: String(args.tradeAmount),
    waitForOtherMs: '10000',
    dwellMs: '500',
  });

  // Wrap scripts so we can stream verbose lines if asked.
  const wrapVerbose = (label: string, inner: ScenarioFn): ScenarioFn => {
    if (!args.verbose) return inner;
    return async (ctx) => {
      const log = (m: string): void => {
        process.stderr.write(`[${label}] ${m}\n`);
      };
      log('scenario start');
      try {
        await inner(ctx);
        log('scenario end OK');
      } catch (err) {
        log(`scenario threw: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    };
  };

  const configs: FleetClientConfig[] = [
    {
      account: args.leaderAccount,
      characterName: args.leaderCharacter,
      planet: args.planet,
      holdZonedInMs: 0,
      script: wrapVerbose('leader', leaderScript),
    },
    {
      account: args.inviteeAccount,
      characterName: args.inviteeCharacter,
      planet: args.planet,
      holdZonedInMs: 0,
      script: wrapVerbose('invitee', inviteeScript),
    },
  ];
  return fleet.run(configs, { staggerMs: 200 });
}

/**
 * Build a compact JSON outcome summary. Inspects each scenario's
 * `ScriptResult.assertionFailures` to decide whether the group formed
 * cleanly, and scans the transcript for the trade-start ObjController.
 */
function buildSummary(
  args: Args,
  result: FleetResult,
  ids: { leaderId: NetworkId; inviteeId: NetworkId },
): Record<string, unknown> {
  // The Fleet outcomes line up with the configs we passed:
  //   index 0 = leader, index 1 = invitee.
  const summary = {
    host: args.host,
    leader: {
      account: args.leaderAccount,
      character: args.leaderCharacter,
      networkId: `0x${ids.leaderId.toString(16)}`,
    },
    invitee: {
      account: args.inviteeAccount,
      character: args.inviteeCharacter,
      networkId: `0x${ids.inviteeId.toString(16)}`,
    },
    tradeAmount: args.tradeAmount,
    fleet: {
      totalClients: result.summary.totalClients,
      succeeded: result.summary.succeeded,
      failed: result.summary.failed,
      totalElapsedMs: result.summary.totalElapsedMs,
      cumulativeElapsedMs: result.summary.cumulativeElapsedMs,
      clientsWithErrorMessage: result.summary.clientsWithErrorMessage,
      errorMessages: result.summary.errorMessages,
      objControllerMessagesSent: result.summary.messageCounts.ObjControllerMessage?.sent ?? 0,
      objControllerMessagesReceived: result.summary.messageCounts.ObjControllerMessage?.recv ?? 0,
    },
    leaderResult: roleOutcome(result, 0, 'leader'),
    inviteeResult: roleOutcome(result, 1, 'invitee'),
  };
  // Derive high-level "did the group form?" + "did trade start?" booleans
  // by inspecting both transcripts for the expected wire events.
  const leaderRecv = recvSubtypeIds(result, 0);
  const inviteeRecv = recvSubtypeIds(result, 1);
  // CM_setGroup = 421
  const leaderSawSetGroup = leaderRecv.includes(421);
  const inviteeSawSetGroup = inviteeRecv.includes(421);
  // CM_setGroupInviter = 351
  const inviteeSawInvite = inviteeRecv.includes(351);
  // We requested a trade if tradeAmount > 0 — the scenario only attempts to
  // send the trade ObjController in that case. Detailed verification would
  // require re-parsing the sent ObjControllerMessage bytes from the
  // transcript, which we skip for simplicity.
  const tradeRequested = args.tradeAmount > 0;
  return {
    ...summary,
    derived: {
      inviteeReceivedInvite: inviteeSawInvite,
      groupFormed: leaderSawSetGroup && inviteeSawSetGroup,
      tradeRequested,
      tradeWindowOpened: false, // unmodeled — see scenario docs
    },
  };
}

function roleOutcome(result: FleetResult, index: number, label: string): Record<string, unknown> {
  const outcome = result.outcomes[index];
  if (outcome === undefined) {
    return { role: label, status: 'no-outcome' };
  }
  const lr = outcome.lifecycleResult;
  return {
    role: label,
    elapsedMs: outcome.elapsedMs,
    error: outcome.error?.message,
    sendsCount: lr?.scriptResult?.sendsCount,
    didLogout: lr?.scriptResult?.didLogout,
    assertionFailures: lr?.scriptResult?.assertionFailures ?? [],
    receivedErrorMessage: lr?.receivedErrorMessage,
    networkId:
      lr?.character.networkId !== undefined ? `0x${lr.character.networkId.toString(16)}` : null,
  };
}

/** Extract the ObjController subtype IDs from inbound traffic on the Nth outcome. */
function recvSubtypeIds(result: FleetResult, index: number): number[] {
  const out: number[] = [];
  const lr = result.outcomes[index]?.lifecycleResult;
  if (lr === undefined) return out;
  for (const ev of lr.transcript) {
    if (ev.direction !== 'recv') continue;
    if (ev.messageName !== 'ObjControllerMessage') continue;
    const decoded = ev.decoded as { message?: number } | null;
    if (decoded && typeof decoded.message === 'number') out.push(decoded.message);
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  process.stderr.write(
    `[group-trade-demo] host=${args.host}:${args.port}, tradeAmount=${args.tradeAmount}\n`,
  );

  // Resolve NetworkIds (skip lookup phase if both ids were supplied).
  let ids: { leaderId: NetworkId; inviteeId: NetworkId };
  if (args.leaderId !== null && args.inviteeId !== null) {
    process.stderr.write(
      '[group-trade-demo] Skipping lookup phase (--leader-id + --invitee-id supplied)\n',
    );
    ids = { leaderId: args.leaderId, inviteeId: args.inviteeId };
  } else {
    ids = await lookupNetworkIds(args);
  }

  // Phase 2: run the scenario.
  const result = await runScenario(args, ids);

  // Phase 3: report.
  const summary = buildSummary(args, result, ids);

  // Note: there's no JSON.stringify-friendly representation of bigints,
  // and we deliberately stringified them above. Emit pretty JSON.
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  // Exit non-zero if either client failed or if neither side observed
  // group formation.
  const fleetFailed = result.summary.failed > 0;
  const groupFailed = !(summary as { derived?: { groupFormed?: boolean } }).derived?.groupFormed;
  return fleetFailed || groupFailed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
