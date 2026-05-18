#!/usr/bin/env node --import tsx
/**
 * cantina-troupe.ts — a 4-character entertainment troupe staging a coordinated
 * performance in a cantina.
 *
 * Roles (shared closure state coordinates the rendezvous):
 *   - Dancer1 + Dancer2  → walk into the cantina interior, start a dance,
 *                          hold for the full duration, stop on shutdown.
 *   - Spotter1 + Spotter2 → loiter near the cantina entrance, broadcast a
 *                           rotating spatial-chat ad every `--ad-interval-ms`,
 *                           snapshot `ctx.playersInRange` after each ad and
 *                           accumulate unique attendees, log inbound tells.
 *
 * Spotters wait for `dancersReady === 2` before any ad goes out — no point
 * advertising a show that hasn't started.
 *
 * Default cantina coordinates target the Mos Eisley cantina exterior; both
 * the entrance walk-up and dancer interior pose are derived from
 * `--cantinaX`/`--cantinaZ` so re-pointing to a different cantina (Theed,
 * Coronet, etc.) is a single coord swap.
 *
 * Example:
 *   pnpm exec tsx scripts/examples/cantina-troupe.ts \
 *     --host=10.254.0.253 --minutes=5 \
 *     --accounts=tslive14,tslive15,tslive16,tslive17 \
 *     --characters=ExCantinaDancer1,ExCantinaDancer2,ExCantinaSpotter1,ExCantinaSpotter2
 */

import type { FleetClientConfig, ScenarioFn } from '../../src/index.js';
import { durationMs, formatJson, makeLogger, parseCommonArgs, runFleet, usage } from './_lib.js';

const SCRIPT = 'scripts/examples/cantina-troupe.ts';

const DEFAULT_ACCOUNTS = ['tslive14', 'tslive15', 'tslive16', 'tslive17'];
const DEFAULT_CHARACTERS = [
  'ExCantinaDancer1',
  'ExCantinaDancer2',
  'ExCantinaSpotter1',
  'ExCantinaSpotter2',
];

const AD_LINES = [
  'Free dance show inside! Cantina XP buff active!',
  'Live entertainment in the cantina — wander in, watch, get buffed!',
  'Two dancers performing right now — cantina XP for everyone watching!',
  'Hey traveller, free buffs and a show inside the cantina!',
  'Show time! Step inside the cantina for a free Entertainer buff.',
];

interface ScriptArgs {
  cantinaX: number;
  cantinaZ: number;
  dancerOffsetX: number;
  dancerOffsetZ: number;
  spotterSpreadM: number;
  danceStyle: string;
  adIntervalMs: number;
  scanRadiusM: number;
  staggerMs: number;
  accounts: string[];
  characters: string[];
}

interface TroupeState {
  dancersReady: number;
  attendees: Set<string>;
  attendeeNames: Map<string, string>;
  tellsReceived: Array<{ from: string; text: string; at: string }>;
  broadcastsSent: number;
  totalDanceDurationMs: number;
  dancersPerformed: number;
  scanSamples: number;
  scanAudienceSum: number;
}

function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return fallback;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : fallback;
}

function parseScriptArgs(extra: Map<string, string>): ScriptArgs {
  return {
    cantinaX: Number.parseFloat(extra.get('cantinaX') ?? '3528'),
    cantinaZ: Number.parseFloat(extra.get('cantinaZ') ?? '-4805'),
    dancerOffsetX: Number.parseFloat(extra.get('dancer-offset-x') ?? '4'),
    dancerOffsetZ: Number.parseFloat(extra.get('dancer-offset-z') ?? '0'),
    spotterSpreadM: Number.parseFloat(extra.get('spotter-spread') ?? '3'),
    danceStyle: extra.get('style') ?? 'basic',
    adIntervalMs: Number.parseInt(extra.get('ad-interval-ms') ?? '45000', 10),
    scanRadiusM: Number.parseFloat(extra.get('scan-radius') ?? '50'),
    staggerMs: Number.parseInt(extra.get('stagger-ms') ?? '500', 10),
    accounts: parseList(extra.get('accounts'), DEFAULT_ACCOUNTS),
    characters: parseList(extra.get('characters'), DEFAULT_CHARACTERS),
  };
}

function makeDancerScenario(
  args: ScriptArgs,
  state: TroupeState,
  totalMs: number,
  dancerIndex: number,
  verbose: boolean,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger(`dancer${dancerIndex + 1}`, verbose);
    ctx.changePosture('standing');
    const lateral = dancerIndex === 0 ? -1 : 1;
    const target = {
      x: args.cantinaX + args.dancerOffsetX + lateral * 1.5,
      z: args.cantinaZ + args.dancerOffsetZ,
    };
    log(`walking to dance spot (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`);
    try {
      await ctx.walkTo(target);
    } catch (err) {
      log(`walkTo failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    log(`starting dance: ${args.danceStyle}`);
    ctx.useAbility('startdance', 0n, args.danceStyle);
    state.dancersReady++;
    state.dancersPerformed++;
    const startedAt = Date.now();
    const deadline = startedAt + totalMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await ctx.wait(Math.min(5_000, remaining));
    }
    state.totalDanceDurationMs += Date.now() - startedAt;
    log('stopping dance');
    ctx.useAbility('stopdance');
    await ctx.wait(500);
    state.dancersReady = Math.max(0, state.dancersReady - 1);
  };
}

function makeSpotterScenario(
  args: ScriptArgs,
  state: TroupeState,
  totalMs: number,
  spotterIndex: number,
  verbose: boolean,
): ScenarioFn {
  return async (ctx) => {
    const log = makeLogger(`spotter${spotterIndex + 1}`, verbose);
    ctx.changePosture('standing');
    const lateral = spotterIndex === 0 ? -args.spotterSpreadM : args.spotterSpreadM;
    const entrance = {
      x: args.cantinaX + lateral,
      z: args.cantinaZ - 6,
    };
    log(`walking to entrance (${entrance.x.toFixed(1)}, ${entrance.z.toFixed(1)})`);
    try {
      await ctx.walkTo(entrance);
    } catch (err) {
      log(`walkTo failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const unsubTell = ctx.chat.onTell(/./, (text, sender) => {
      const entry = { from: sender.name, text, at: new Date().toISOString() };
      state.tellsReceived.push(entry);
      log(`tell from ${sender.name}: ${text}`);
    });

    try {
      const deadline = Date.now() + totalMs;
      let rotation = spotterIndex;
      let waitedForDancers = false;
      while (Date.now() < deadline) {
        if (state.dancersReady < 2) {
          if (!waitedForDancers) {
            log(`waiting for dancers (ready=${state.dancersReady}/2)`);
            waitedForDancers = true;
          }
          await ctx.wait(Math.min(2_000, deadline - Date.now()));
          continue;
        }
        const ad = AD_LINES[rotation % AD_LINES.length];
        if (ad === undefined) break;
        rotation++;
        log(`broadcast: ${ad}`);
        ctx.say(ad);
        state.broadcastsSent++;

        const nearby = ctx.playersInRange(args.scanRadiusM);
        state.scanSamples++;
        state.scanAudienceSum += nearby.length;
        for (const p of nearby) {
          const key = p.id.toString();
          if (!state.attendees.has(key)) {
            state.attendees.add(key);
            const name =
              p.templateName !== undefined ? (p.templateName.split('/').pop() ?? key) : key;
            state.attendeeNames.set(key, name);
            log(`new attendee id=${key} (${nearby.length} in range)`);
          }
        }
        const sleepMs = Math.min(args.adIntervalMs, Math.max(0, deadline - Date.now()));
        if (sleepMs > 0) await ctx.wait(sleepMs);
      }
    } finally {
      unsubTell();
    }
  };
}

function buildConfigs(
  args: ScriptArgs,
  state: TroupeState,
  totalMs: number,
  verbose: boolean,
): FleetClientConfig[] {
  const n = Math.min(args.accounts.length, args.characters.length, 4);
  if (n < 4) {
    throw new Error(
      `cantina-troupe requires 4 accounts and 4 characters; got accounts=${args.accounts.length} characters=${args.characters.length}`,
    );
  }
  const cfgs: FleetClientConfig[] = [];
  for (let i = 0; i < 4; i++) {
    const isDancer = i < 2;
    const account = args.accounts[i] ?? DEFAULT_ACCOUNTS[i];
    const characterName = args.characters[i] ?? DEFAULT_CHARACTERS[i];
    if (account === undefined || characterName === undefined) {
      throw new Error(`missing account or character at index ${i}`);
    }
    cfgs.push({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: isDancer
        ? makeDancerScenario(args, state, totalMs, i, verbose)
        : makeSpotterScenario(args, state, totalMs, i - 2, verbose),
    });
  }
  return cfgs;
}

async function main(): Promise<number> {
  const args = parseCommonArgs(process.argv.slice(2), { minutes: 5 });
  if (args.help) {
    usage(SCRIPT, 'Cantina entertainment troupe — 2 dancers + 2 spotters with chat broadcast.', [
      '  --cantinaX=N             cantina anchor X (default 3528, Mos Eisley)',
      '  --cantinaZ=N             cantina anchor Z (default -4805, Mos Eisley)',
      '  --dancer-offset-x=N      dancer X offset from anchor (default 4)',
      '  --dancer-offset-z=N      dancer Z offset from anchor (default 0)',
      '  --spotter-spread=N       lateral spread between spotters in m (default 3)',
      '  --style=NAME             dance style (default "basic")',
      '  --ad-interval-ms=N       ms between spatial-chat ads (default 45000)',
      '  --scan-radius=N          metres to scan for attendees after each ad (default 50)',
      '  --stagger-ms=N           launch stagger between clients (default 500)',
      '  --accounts=A,B,C,D       4 accounts (default tslive14..17)',
      '  --characters=A,B,C,D     4 character names (dancers first, then spotters)',
    ]);
    return 0;
  }
  const script = parseScriptArgs(args.extra);
  const totalMs = durationMs(args.minutes);
  const state: TroupeState = {
    dancersReady: 0,
    attendees: new Set<string>(),
    attendeeNames: new Map<string, string>(),
    tellsReceived: [],
    broadcastsSent: 0,
    totalDanceDurationMs: 0,
    dancersPerformed: 0,
    scanSamples: 0,
    scanAudienceSum: 0,
  };
  const configs = buildConfigs(script, state, totalMs, args.verbose);
  const { summary } = await runFleet(args, configs, { staggerMs: script.staggerMs });
  const avgAttendees = state.scanSamples > 0 ? state.scanAudienceSum / state.scanSamples : 0;
  summary.extra = {
    cantina: { x: script.cantinaX, z: script.cantinaZ },
    danceStyle: script.danceStyle,
    adIntervalMs: script.adIntervalMs,
    scanRadiusM: script.scanRadiusM,
    dancersPerformed: state.dancersPerformed,
    totalDanceDurationMs: state.totalDanceDurationMs,
    broadcastsSent: state.broadcastsSent,
    uniqueAttendees: state.attendees.size,
    attendeeIds: [...state.attendees],
    tellsReceived: state.tellsReceived,
    avgAttendees: Number(avgAttendees.toFixed(2)),
  };
  process.stdout.write(formatJson(summary, args.pretty));
  return summary.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
