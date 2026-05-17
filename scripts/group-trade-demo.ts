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
 * Modern (auto-discover) variant — skip the Stage 1+2 lookup phase and let
 * each scenario find its partner via the live WorldModel:
 *   pnpm exec tsx scripts/group-trade-demo.ts ... --auto-discover
 *
 * Tune how long each side polls for its partner to spawn into view (helps
 * when the two Fleet clients race during zone-in):
 *   pnpm exec tsx scripts/group-trade-demo.ts ... --max-wait-ms=20000
 *
 * Workflow:
 *   1. Discovery: by default, run a quick Fleet with `skipGameStage: true`
 *      against both accounts to resolve each character's NetworkId by name
 *      via the LoginServer avatar list. If `--auto-discover` is set, skip
 *      this phase entirely.
 *   2. Run phase: run a 2-client Fleet with `groupTradeScenario` for each.
 *      Each scenario is wrapped so it polls `ctx.playersInRange(50)` /
 *      `ctx.world.byType(ObjectTypeTags.PLAY)` for up to `--max-wait-ms`
 *      before delegating to the actual handshake. If lookup resolved an
 *      explicit `otherId`, it's passed through; otherwise the scenario's
 *      built-in fallback picks the nearest PLAY in range.
 *   3. Report: a JSON summary of the lifecycle outcomes — did the group
 *      form? Did the (best-effort) trade window open?
 *
 * Manual-override workflow (skip every discovery phase):
 *   pnpm exec tsx scripts/group-trade-demo.ts ... \
 *     --leader-id=0xabcd --invitee-id=0xbcde
 *   ↑ when both ids are passed, both phases are skipped.
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
  ObjectTypeTags,
  type ScenarioFn,
  type ScriptContext,
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
  autoDiscover: boolean;
  maxWaitMs: number;
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
    autoDiscover: false,
    maxWaitMs: 15_000,
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
      case 'auto-discover':
        a.autoDiscover = val === 'true' || val === '';
        break;
      case 'max-wait-ms':
        a.maxWaitMs = Number.parseInt(val, 10);
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
  if (!Number.isFinite(a.maxWaitMs) || a.maxWaitMs < 0) {
    process.stderr.write(`--max-wait-ms must be a non-negative integer (got ${a.maxWaitMs})\n`);
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
      '  --auto-discover             skip the Stage 1+2 lookup phase and rely on the',
      "                              scenario's WorldModel-based partner discovery",
      '  --max-wait-ms=15000         how long each scenario polls for its partner to',
      '                              spawn into view before giving up (race-handling)',
      '  --leader-id=0x<hex>         skip the lookup phase and use this NetworkId',
      '  --invitee-id=0x<hex>        skip the lookup phase and use this NetworkId',
      '                              (both --leader-id and --invitee-id required to skip)',
      '  --verbose                   stream per-scenario log lines to stderr',
      '',
    ].join('\n'),
  );
}

/**
 * Stage 1+2-only Fleet that resolves each character's NetworkId by listing
 * the account's avatars (LoginServer pushes `EnumerateCharacterId` during
 * Stage 1 so this never needs to zone in). Returns `{ leaderId, inviteeId }`
 * or `null` if either side fails — callers are expected to fall back to
 * in-world discovery.
 *
 * The character will be created on first run if it doesn't exist (Stage 2
 * runs `ClientCreateCharacter` when the avatar list is empty).
 */
async function lookupNetworkIds(args: Args): Promise<{
  leaderId: NetworkId;
  inviteeId: NetworkId;
} | null> {
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
    process.stderr.write(`[group-trade-demo] Lookup phase failed:\n${lines.join('\n')}\n`);
    return null;
  }
  const leaderId = result.outcomes[0]?.lifecycleResult?.character.networkId;
  const inviteeId = result.outcomes[1]?.lifecycleResult?.character.networkId;
  if (leaderId === undefined || inviteeId === undefined) {
    process.stderr.write('[group-trade-demo] Lookup phase produced no character NetworkIds\n');
    return null;
  }
  process.stderr.write(
    `[group-trade-demo] Lookup OK: leader=${args.leaderCharacter} id=0x${leaderId.toString(16)}, ` +
      `invitee=${args.inviteeCharacter} id=0x${inviteeId.toString(16)}\n`,
  );
  return { leaderId, inviteeId };
}

/**
 * Poll the live WorldModel until at least one other PLAY-typed object is in
 * range, or `maxWaitMs` elapses. Returns the NetworkId of the first match
 * (or `null` on timeout). Used both as a pre-flight in `--auto-discover`
 * mode and as a fallback when the Stage 1+2 lookup phase fails.
 *
 * Note: returns the PLAY id — the scenario uses the same wire-id when
 * invoking via `useAbility('invite', ...)` (the server resolves PLAY → CREO
 * internally for group ops).
 */
async function waitForPartner(
  ctx: ScriptContext,
  maxWaitMs: number,
  log: (m: string) => void,
): Promise<NetworkId | null> {
  // Fast path — partner already in range from the baseline flood.
  const immediate = ctx.playersInRange(50)[0];
  if (immediate !== undefined) {
    log(`partner already in range at zone-in: id=0x${immediate.id.toString(16)}`);
    return immediate.id;
  }
  // Slow path — poll until the WorldModel sees another PLAY-typed object.
  // We don't pin the search to `playersInRange(50)` here because the partner
  // might land just outside our 50m starting bubble depending on planet
  // bring-up jitter; `world.byType(PLAY)` catches anyone the server is
  // streaming us regardless of distance, and `playersInRange(50)` confirms
  // they're close enough to actually trade with.
  const deadline = Date.now() + maxWaitMs;
  const pollMs = 250;
  log(`waiting up to ${maxWaitMs}ms for a partner to spawn into view...`);
  while (Date.now() < deadline) {
    const inRange = ctx.playersInRange(50)[0];
    if (inRange !== undefined) {
      log(`partner spawned: id=0x${inRange.id.toString(16)}`);
      return inRange.id;
    }
    // Even if not in range, count any other PLAY as a hint we're not alone.
    let anyOther: NetworkId | null = null;
    for (const o of ctx.world.byType(ObjectTypeTags.PLAY)) {
      if (o.id === ctx.sceneStart.playerNetworkId) continue;
      anyOther = o.id;
      break;
    }
    if (anyOther !== null) {
      // Partner is in the world but out of `playersInRange` distance.
      // Trust the scenario's own resolver (it scans world.byType(PLAY)
      // directly too) and let the handshake proceed.
      log(
        `partner visible but out of 50m bubble (id=0x${anyOther.toString(16)}); proceeding — scenario will resolve via its own playersInRange()`,
      );
      return anyOther;
    }
    await ctx.wait(pollMs);
  }
  log(`timed out after ${maxWaitMs}ms — no partner appeared`);
  return null;
}

/** Phase 2 — run the actual group-trade scenario for both clients. */
async function runScenario(
  args: Args,
  ids: { leaderId: NetworkId; inviteeId: NetworkId } | null,
): Promise<FleetResult> {
  process.stderr.write('[group-trade-demo] Phase 2: running group-trade scenario...\n');
  const fleet = new Fleet({ loginServer: { host: args.host, port: args.port } });

  // Build the per-role scenarios. When `ids` is null we omit `otherId`
  // entirely so the scenario falls back to its own
  // `ctx.playersInRange(50)[0]` resolver. The wrap layer below pre-polls
  // the WorldModel so the scenario's instant lookup actually finds someone.
  const baseScenarioArgs = {
    tradeAmount: String(args.tradeAmount),
    waitForOtherMs: String(Math.max(10_000, args.maxWaitMs)),
    dwellMs: '500',
  };
  const leaderScript: ScenarioFn = groupTradeScenario({
    ...baseScenarioArgs,
    role: 'leader',
    ...(ids === null ? {} : { otherId: `0x${ids.inviteeId.toString(16)}` }),
  });
  const inviteeScript: ScenarioFn = groupTradeScenario({
    ...baseScenarioArgs,
    role: 'invitee',
    ...(ids === null ? {} : { otherId: `0x${ids.leaderId.toString(16)}` }),
  });

  // Wrap scripts: optionally pre-poll for the partner (when we don't have
  // an explicit otherId), then optionally stream verbose log lines.
  const wrap = (label: string, inner: ScenarioFn): ScenarioFn => {
    return async (ctx) => {
      const log = (m: string): void => {
        if (args.verbose) process.stderr.write(`[${label}] ${m}\n`);
      };
      log('scenario start');
      try {
        // Only pre-poll when we did NOT pass an explicit otherId. With an
        // explicit otherId the scenario doesn't need a visible partner to
        // emit the invite — the server resolves the id and delivers the
        // group-inviter delta as soon as the partner zones in.
        if (ids === null) {
          const partnerId = await waitForPartner(ctx, args.maxWaitMs, log);
          if (partnerId === null) {
            ctx.fail(
              `no partner appeared within --max-wait-ms=${args.maxWaitMs}; auto-discover failed (other Fleet client may have crashed before zone-in)`,
            );
            return;
          }
        }
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
      script: wrap('leader', leaderScript),
    },
    {
      account: args.inviteeAccount,
      characterName: args.inviteeCharacter,
      planet: args.planet,
      holdZonedInMs: 0,
      script: wrap('invitee', inviteeScript),
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
  ids: { leaderId: NetworkId; inviteeId: NetworkId } | null,
  discoveryMode: 'manual' | 'lookup' | 'auto-discover' | 'lookup-failed-fallback',
): Record<string, unknown> {
  // The Fleet outcomes line up with the configs we passed:
  //   index 0 = leader, index 1 = invitee.
  // When discovery resolved the ids via Stage 1+2 lookup we already have
  // them; otherwise pull them from the actual lifecycle result.
  const leaderLifecycleId = result.outcomes[0]?.lifecycleResult?.character.networkId ?? null;
  const inviteeLifecycleId = result.outcomes[1]?.lifecycleResult?.character.networkId ?? null;
  const effectiveLeaderId = ids?.leaderId ?? leaderLifecycleId;
  const effectiveInviteeId = ids?.inviteeId ?? inviteeLifecycleId;
  const summary = {
    host: args.host,
    discoveryMode,
    leader: {
      account: args.leaderAccount,
      character: args.leaderCharacter,
      networkId: effectiveLeaderId !== null ? `0x${effectiveLeaderId.toString(16)}` : null,
    },
    invitee: {
      account: args.inviteeAccount,
      character: args.inviteeCharacter,
      networkId: effectiveInviteeId !== null ? `0x${effectiveInviteeId.toString(16)}` : null,
    },
    tradeAmount: args.tradeAmount,
    maxWaitMs: args.maxWaitMs,
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
    `[group-trade-demo] host=${args.host}:${args.port}, tradeAmount=${args.tradeAmount}, ` +
      `autoDiscover=${args.autoDiscover}, maxWaitMs=${args.maxWaitMs}\n`,
  );

  // Resolve NetworkIds. Three resolution paths:
  //   1. Manual: both --leader-id and --invitee-id supplied → skip every
  //      discovery phase.
  //   2. Auto-discover: --auto-discover set → skip lookup, let each
  //      scenario's WorldModel resolver pick the partner at run-time.
  //   3. Default: run the Stage 1+2 lookup phase. If it fails, fall back
  //      to auto-discover instead of aborting.
  let ids: { leaderId: NetworkId; inviteeId: NetworkId } | null;
  let discoveryMode: 'manual' | 'lookup' | 'auto-discover' | 'lookup-failed-fallback';
  if (args.leaderId !== null && args.inviteeId !== null) {
    process.stderr.write(
      '[group-trade-demo] Skipping discovery (--leader-id + --invitee-id supplied)\n',
    );
    ids = { leaderId: args.leaderId, inviteeId: args.inviteeId };
    discoveryMode = 'manual';
  } else if (args.autoDiscover) {
    process.stderr.write(
      '[group-trade-demo] Skipping lookup phase (--auto-discover); will resolve via WorldModel\n',
    );
    ids = null;
    discoveryMode = 'auto-discover';
  } else {
    const resolved = await lookupNetworkIds(args);
    if (resolved === null) {
      process.stderr.write(
        '[group-trade-demo] Lookup phase failed; falling back to WorldModel auto-discover\n',
      );
      ids = null;
      discoveryMode = 'lookup-failed-fallback';
    } else {
      ids = resolved;
      discoveryMode = 'lookup';
    }
  }

  // Phase 2: run the scenario.
  const result = await runScenario(args, ids);

  // Phase 3: report.
  const summary = buildSummary(args, result, ids, discoveryMode);

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
