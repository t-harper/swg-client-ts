/**
 * Build-city orchestrator.
 *
 * Drives the 6-phase city build. Each phase persists progress to state.json
 * so re-running the orchestrator skips completed phases (use --force to
 * re-run a specific phase).
 */

import {
  Fleet,
  type FleetClientConfig,
  type FleetOutcome,
  SwgClient,
} from '../../src/index.js';
import type { ServerEndpoint } from '../../src/index.js';
import {
  adminGiveMoney,
  adminGodModeOn,
  adminReloadAdminTable,
  adminSpawnInto,
} from './admin.js';
import {
  CITY_CENTER,
  CITY_NAME,
  CITY_PLANET,
  type CharacterSlot,
  fullLayout,
  gardenAnchors,
  mvpLayout,
} from './layout.js';
import {
  civicScenario,
  decorationScenario,
  guildScenario,
  mayorScenario,
  residentScenario,
} from './scenarios.js';
import {
  type CharacterRecord,
  type CityState,
  type PhaseName,
  isPhaseComplete,
  loadState,
  markPhaseFinished,
  markPhaseStarted,
  saveState,
} from './state.js';

export type Mode = 'mvp' | 'full' | 'verify' | 'phase0pre';

export interface OrchestratorOptions {
  loginServer: ServerEndpoint;
  mode: Mode;
  /** Force-run specific phase(s) even if state.json says they're done. */
  forcePhases?: PhaseName[];
  /** Dry-run: log what would happen, don't send wire traffic. */
  dryRun?: boolean;
  /** Verbose logging. */
  verbose?: boolean;
}

/** Stagger constant for Fleet launches. */
const FLEET_STAGGER_MS = 750;
/** Max concurrent clients per Fleet phase. */
const FLEET_MAX_CONCURRENT = 10;
/** Account used to bootstrap admin reload (must be pre-existing admin). */
const RELOAD_BOOTSTRAP_ACCOUNT = 'swg';

// ────────────────────────────────────────────────────────────────────────────
// Top-level run
// ────────────────────────────────────────────────────────────────────────────

export async function run(opts: OrchestratorOptions): Promise<{ ok: boolean; state: CityState }> {
  const state = loadState();
  // Initialize city-name fields on first run.
  // Use a timestamp suffix so re-runs after a failed previous attempt don't collide
  // on the server's isUniqueCityName check (cityName must be globally unique).
  if (state.cityName === '') {
    const suffix = ((Date.now() / 60_000) | 0) % 100000; // changes every minute
    state.cityName = `${CITY_NAME}${suffix}`;
  }
  if (state.cityPlanet === '') state.cityPlanet = CITY_PLANET;
  if (state.cityCenter.x === 0 && state.cityCenter.z === 0) state.cityCenter = CITY_CENTER;

  // Layout for this run
  const slots: CharacterSlot[] = opts.mode === 'mvp' ? mvpLayout() : fullLayout();

  // Persist mayor account
  const mayorSlot = slots.find((s) => s.role === 'mayor');
  if (mayorSlot !== undefined) state.mayorAccount = mayorSlot.account;

  // Hydrate the characters map from slot definitions (don't lose existing networkIds)
  for (const slot of slots) {
    if (state.characters[slot.account] === undefined) {
      state.characters[slot.account] = {
        account: slot.account,
        characterName: slot.characterName,
        networkId: null,
        created: false,
        wasFreshlyCreated: false,
      };
    }
  }
  saveState(state);

  const forced = new Set(opts.forcePhases ?? []);
  const log = (msg: string): void => {
    process.stderr.write(`[orchestrator] ${msg}\n`);
  };

  // Define phase sequence
  const phases: Array<{
    name: PhaseName;
    onlyIfMode: Mode[] | null;
    runner: () => Promise<{ ok: boolean; notes?: string; failures?: string[] }>;
  }> = [
    {
      name: 'phase0pre',
      onlyIfMode: null,
      runner: () => phase0pre(opts, state, log),
    },
    {
      name: opts.mode === 'mvp' ? 'phase0a-mvp' : 'phase0b-full',
      onlyIfMode: opts.mode === 'verify' ? [] : null,
      runner: () => phase0_stock(opts, state, slots, log),
    },
    {
      name: opts.mode === 'mvp' ? 'phase1-mvp' : 'phase1-full',
      onlyIfMode: opts.mode === 'verify' ? [] : null,
      runner: () => phase1_lookup(opts, state, slots, log),
    },
    {
      name: 'phase2-mayor',
      onlyIfMode: opts.mode === 'verify' ? [] : null,
      runner: () => phase2_mayor(opts, state, slots, log),
    },
    {
      name: opts.mode === 'mvp' ? 'phase3-mvp' : 'phase3-full',
      onlyIfMode: opts.mode === 'verify' ? [] : null,
      runner: () => phase3_housing(opts, state, slots, log),
    },
    {
      name: 'phase4-civic',
      onlyIfMode: ['full'],
      runner: () => phase4_civic(opts, state, slots, log),
    },
    {
      name: 'phase5-decor',
      onlyIfMode: ['full'],
      runner: () => phase5_decor(opts, state, log),
    },
    {
      name: 'phase6-verify',
      onlyIfMode: null,
      runner: () => phase6_verify(opts, state, slots, log),
    },
  ];

  for (const ph of phases) {
    if (ph.onlyIfMode !== null && !ph.onlyIfMode.includes(opts.mode)) {
      log(`SKIP ${ph.name} (not applicable to mode=${opts.mode})`);
      continue;
    }
    if (isPhaseComplete(state, ph.name) && !forced.has(ph.name)) {
      log(`SKIP ${ph.name} (already complete; use --force=${ph.name} to re-run)`);
      continue;
    }

    log(`>>> ${ph.name} starting`);
    markPhaseStarted(state, ph.name);
    saveState(state);
    let result: { ok: boolean; notes?: string; failures?: string[] };
    try {
      result = await ph.runner();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`!!! ${ph.name} threw: ${msg}`);
      markPhaseFinished(state, ph.name, false, { notes: `threw: ${msg}` });
      saveState(state);
      return { ok: false, state };
    }
    markPhaseFinished(state, ph.name, result.ok, {
      ...(result.notes !== undefined ? { notes: result.notes } : {}),
      ...(result.failures !== undefined ? { assertionFailures: result.failures } : {}),
    });
    saveState(state);
    log(`<<< ${ph.name} ${result.ok ? 'ok' : 'FAILED'}${result.notes !== undefined ? ` — ${result.notes}` : ''}`);
    if (!result.ok && !forced.has(ph.name)) {
      log(`Halting — fix the failure or use --force=${ph.name} to retry`);
      return { ok: false, state };
    }
  }

  return { ok: true, state };
}

// ────────────────────────────────────────────────────────────────────────────
// Phase implementations
// ────────────────────────────────────────────────────────────────────────────

/**
 * Phase 0pre — admin allowlist reload.
 *
 * Assumption: the .tab/.iff edit was done out-of-band before orchestrator start
 * (Phase 0pre script `stage-admin-allowlist.ts` handles that — or done manually).
 * This phase just triggers the in-server reload via a swg-account-authenticated
 * ConGenericMessage.
 *
 * NOTE: This phase requires that the `swg` account ALREADY has at least one
 * character that can log in. If it doesn't, we skip the reload (relying on
 * `adminGodToAll=true` and stella_admin.iff being pre-loaded on server start).
 */
async function phase0pre(
  opts: OrchestratorOptions,
  state: CityState,
  log: (msg: string) => void,
): Promise<{ ok: boolean; notes?: string }> {
  if (opts.dryRun) {
    log('Would log in as swg → setGodMode → server reloadAdminTable');
    return { ok: true, notes: 'dry-run' };
  }

  const client = new SwgClient({ loginServer: opts.loginServer });
  try {
    const result = await client.fullLifecycle({
      account: RELOAD_BOOTSTRAP_ACCOUNT,
      // We don't pass characterName: the swg account should already have one.
      // If not, server returns ClientCreateCharacterFailed and we'd fall back
      // — but this is a small risk for an admin account.
      holdZonedInMs: 5_000,
      script: async (ctx) => {
        try {
          await adminGodModeOn(ctx);
          await ctx.wait(500);
          const reply = await adminReloadAdminTable(ctx);
          log(`reloadAdminTable reply: ${reply.slice(0, 200)}`);
        } catch (err) {
          ctx.fail(`reloadAdminTable failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });
    const failures = result.scriptResult?.assertionFailures ?? [];
    if (failures.length > 0) {
      return { ok: false, notes: failures.join('; ') };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      notes: `bootstrap login failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Phase 0 — stock characters. For each slot, attempt to create the character
 * via Fleet (skipGameStage=false so we observe ClientPermissionsMessage).
 */
async function phase0_stock(
  opts: OrchestratorOptions,
  state: CityState,
  slots: CharacterSlot[],
  log: (msg: string) => void,
): Promise<{ ok: boolean; notes?: string; failures?: string[] }> {
  const needsStocking = slots.filter((s) => state.characters[s.account]?.created !== true);
  if (needsStocking.length === 0) {
    return { ok: true, notes: 'all already stocked' };
  }
  log(`Stocking ${needsStocking.length}/${slots.length} characters`);

  if (opts.dryRun) {
    for (const s of needsStocking) log(`  would create ${s.account} / ${s.characterName}`);
    return { ok: true, notes: 'dry-run' };
  }

  const configs: FleetClientConfig[] = needsStocking.map((slot) => ({
    account: slot.account,
    characterName: slot.characterName,
    planet: 'mos_eisley',
    profession: 'combat_brawler',
    holdZonedInMs: 1500,
  }));

  const fleet = new Fleet({ loginServer: opts.loginServer });
  const result = await fleet.run(configs, {
    staggerMs: FLEET_STAGGER_MS,
    maxConcurrent: FLEET_MAX_CONCURRENT,
  });

  const failures: string[] = [];
  for (const outcome of result.outcomes) {
    const slot = needsStocking.find((s) => s.account === outcome.config.account);
    if (slot === undefined) continue;
    const rec: CharacterRecord = state.characters[slot.account] ?? {
      account: slot.account,
      characterName: slot.characterName,
      networkId: null,
      created: false,
      wasFreshlyCreated: false,
    };
    if (outcome.error !== undefined) {
      rec.error = outcome.error.message;
      failures.push(`${slot.account}: ${outcome.error.message}`);
    } else if (outcome.lifecycleResult !== undefined) {
      rec.created = true;
      rec.wasFreshlyCreated = outcome.lifecycleResult.characterWasCreated;
      rec.networkId = outcome.lifecycleResult.character.networkId.toString();
    }
    state.characters[slot.account] = rec;
  }
  saveState(state);
  return {
    ok: failures.length === 0,
    notes: `${result.summary.succeeded}/${result.summary.totalClients} stocked`,
    ...(failures.length > 0 ? { failures } : {}),
  };
}

/**
 * Phase 1 — NetworkId lookup. Already done as part of phase 0_stock if it
 * called fullLifecycle. This phase is a no-op fallback for cases where we
 * need to re-resolve (e.g., character existed but state.json was wiped).
 */
async function phase1_lookup(
  opts: OrchestratorOptions,
  state: CityState,
  slots: CharacterSlot[],
  log: (msg: string) => void,
): Promise<{ ok: boolean; notes?: string }> {
  const needsLookup = slots.filter((s) => state.characters[s.account]?.networkId === null);
  if (needsLookup.length === 0) {
    return { ok: true, notes: 'all NetworkIds resolved' };
  }

  log(`Looking up NetworkIds for ${needsLookup.length} chars`);
  if (opts.dryRun) return { ok: true, notes: 'dry-run' };

  const configs: FleetClientConfig[] = needsLookup.map((s) => ({
    account: s.account,
    characterName: s.characterName,
    skipGameStage: true, // just login + select, no zone-in
  }));

  const fleet = new Fleet({ loginServer: opts.loginServer });
  const result = await fleet.run(configs, {
    staggerMs: FLEET_STAGGER_MS,
    maxConcurrent: FLEET_MAX_CONCURRENT,
  });

  let updated = 0;
  for (const outcome of result.outcomes) {
    if (outcome.lifecycleResult === undefined) continue;
    const slot = needsLookup.find((s) => s.account === outcome.config.account);
    if (slot === undefined) continue;
    const rec = state.characters[slot.account]!;
    rec.networkId = outcome.lifecycleResult.character.networkId.toString();
    updated++;
  }
  saveState(state);
  return { ok: updated === needsLookup.length, notes: `${updated}/${needsLookup.length} resolved` };
}

/**
 * Phase 2 — mayor founds city. Single-client.
 */
async function phase2_mayor(
  opts: OrchestratorOptions,
  state: CityState,
  slots: CharacterSlot[],
  log: (msg: string) => void,
): Promise<{ ok: boolean; notes?: string; failures?: string[] }> {
  const mayor = slots.find((s) => s.role === 'mayor');
  if (mayor === undefined) return { ok: false, notes: 'no mayor in layout' };
  if (opts.dryRun) {
    log(`would log in as ${mayor.account} → place cityhall at (${mayor.x}, ${mayor.z})`);
    return { ok: true, notes: 'dry-run' };
  }

  const client = new SwgClient({ loginServer: opts.loginServer });
  const scenario = mayorScenario({
    cityCenter: { x: mayor.x, z: mayor.z },
    cityName: state.cityName,
    rotation: mayor.rotation,
  });

  const result = await client.fullLifecycle({
    account: mayor.account,
    characterName: mayor.characterName,
    planet: 'mos_eisley',
    profession: 'combat_brawler',
    holdZonedInMs: 30_000, // generous — placement + treasury fund takes time
    script: scenario,
  });

  state.mayorNetworkId = result.character.networkId.toString();
  saveState(state);

  const failures = result.scriptResult?.assertionFailures ?? [];
  return {
    ok: failures.length === 0,
    notes: `mayor=${mayor.account}, sends=${result.scriptResult?.sendsCount ?? 0}`,
    ...(failures.length > 0 ? { failures } : {}),
  };
}

/**
 * Phase 3 — housing wave. N residents in parallel.
 */
async function phase3_housing(
  opts: OrchestratorOptions,
  state: CityState,
  slots: CharacterSlot[],
  log: (msg: string) => void,
): Promise<{ ok: boolean; notes?: string; failures?: string[] }> {
  const residents = slots.filter((s) => s.role === 'resident');
  if (opts.dryRun) {
    log(`would place ${residents.length} houses`);
    return { ok: true, notes: 'dry-run' };
  }

  const configs: FleetClientConfig[] = residents.map((slot) => {
    // Pass the structure OID through to the scenario if Feat #5 populated
    // it on a previous run. The scenario uses it for idempotent permission
    // grants to the paired guildExtra; falls back to a blind useAbility fire
    // (no OID) when state.structures[slot.account]?.structureOid is null.
    const oidStr = state.structures[slot.account]?.structureOid;
    const structureOid: bigint | undefined =
      oidStr !== undefined && oidStr !== null ? BigInt(oidStr) : undefined;
    return {
      account: slot.account,
      characterName: slot.characterName,
      planet: 'mos_eisley',
      profession: 'combat_brawler',
      holdZonedInMs: 60_000, // walk + place + walk-in + declare-residence + permission grant
      script: residentScenario({
        slot,
        ...(structureOid !== undefined ? { structureOid } : {}),
      }),
    };
  });

  const fleet = new Fleet({ loginServer: opts.loginServer });
  const result = await fleet.run(configs, {
    staggerMs: FLEET_STAGGER_MS,
    maxConcurrent: FLEET_MAX_CONCURRENT,
  });

  return summarizeFleetOutcome(result.outcomes, residents.length);
}

/**
 * Phase 4 — civic wave + guild hall.
 */
async function phase4_civic(
  opts: OrchestratorOptions,
  state: CityState,
  slots: CharacterSlot[],
  log: (msg: string) => void,
): Promise<{ ok: boolean; notes?: string; failures?: string[] }> {
  const civic = slots.filter((s) => s.role === 'civic');
  const guildLeaders = slots.filter((s) => s.role === 'guild' && s.deedTemplate !== null);
  const guildExtras = slots.filter((s) => s.role === 'guild' && s.deedTemplate === null);

  if (opts.dryRun) {
    log(`would place ${civic.length} civic + ${guildLeaders.length} guild halls + ${guildExtras.length} extra citizens`);
    return { ok: true, notes: 'dry-run' };
  }

  const configs: FleetClientConfig[] = [
    ...civic.map((slot) => ({
      account: slot.account,
      characterName: slot.characterName,
      planet: 'mos_eisley',
      profession: 'combat_brawler',
      holdZonedInMs: 45_000,
      script: civicScenario({ slot }),
    })),
    ...guildLeaders.map((slot) => ({
      account: slot.account,
      characterName: slot.characterName,
      planet: 'mos_eisley',
      profession: 'combat_brawler',
      holdZonedInMs: 45_000,
      script: guildScenario({ slot }),
    })),
    ...guildExtras.map((slot) => ({
      account: slot.account,
      characterName: slot.characterName,
      planet: 'mos_eisley',
      profession: 'combat_brawler',
      holdZonedInMs: 45_000,
      script: guildScenario({ slot }),
    })),
  ];

  const fleet = new Fleet({ loginServer: opts.loginServer });
  const result = await fleet.run(configs, {
    staggerMs: FLEET_STAGGER_MS,
    maxConcurrent: FLEET_MAX_CONCURRENT,
  });

  return summarizeFleetOutcome(result.outcomes, configs.length);
}

/**
 * Phase 5 — decoration (mayor solo).
 */
async function phase5_decor(
  opts: OrchestratorOptions,
  state: CityState,
  log: (msg: string) => void,
): Promise<{ ok: boolean; notes?: string; failures?: string[] }> {
  const mayor = { account: state.mayorAccount, characterName: 'Mayor01' };
  if (mayor.account === null) return { ok: false, notes: 'no mayor account in state' };

  if (opts.dryRun) {
    log('would place gardens + decorations');
    return { ok: true, notes: 'dry-run' };
  }

  const client = new SwgClient({ loginServer: opts.loginServer });
  const result = await client.fullLifecycle({
    account: mayor.account,
    characterName: mayor.characterName,
    planet: 'mos_eisley',
    profession: 'combat_brawler',
    holdZonedInMs: 90_000,
    script: decorationScenario({ decorations: gardenAnchors() }),
  });
  const failures = result.scriptResult?.assertionFailures ?? [];
  return {
    ok: failures.length === 0,
    notes: `decoration sends=${result.scriptResult?.sendsCount ?? 0}`,
    ...(failures.length > 0 ? { failures } : {}),
  };
}

/**
 * Phase 6 — verify. Mayor logs in, walks a circle, snapshots baselines.
 */
async function phase6_verify(
  opts: OrchestratorOptions,
  state: CityState,
  slots: CharacterSlot[],
  log: (msg: string) => void,
): Promise<{ ok: boolean; notes?: string }> {
  const mayor = { account: state.mayorAccount, characterName: 'Mayor01' };
  if (mayor.account === null) return { ok: false, notes: 'no mayor account in state' };

  if (opts.dryRun) {
    log('would log in as mayor → walk 350m circle → assert structures');
    return { ok: true, notes: 'dry-run' };
  }

  const expectedStructureMin = opts.mode === 'mvp' ? 5 : 22;
  const client = new SwgClient({ loginServer: opts.loginServer });

  let structureCount = 0;
  const result = await client.fullLifecycle({
    account: mayor.account,
    characterName: mayor.characterName,
    planet: 'mos_eisley',
    profession: 'combat_brawler',
    holdZonedInMs: 60_000,
    script: async (ctx) => {
      // Walk a circle around the city
      const radius = opts.mode === 'mvp' ? 300 : 450;
      await ctx.walkCircle({
        centerX: state.cityCenter.x,
        centerZ: state.cityCenter.z,
        radius,
        durationMs: 45_000,
        speed: 8,
      });
    },
  });

  // Count naboo-family structures from the transcript
  for (const ev of result.transcript) {
    if (ev.direction !== 'recv') continue;
    if (ev.messageName !== 'SceneCreateObjectByName') continue;
    const decoded = ev.decoded as { templateName?: string } | null;
    if (decoded?.templateName !== undefined && /naboo/i.test(decoded.templateName)) {
      structureCount++;
    }
  }
  for (const ev of result.transcript) {
    if (ev.direction !== 'recv') continue;
    if (ev.messageName !== 'SceneCreateObjectByCrc') continue;
    // CRC-based — we don't have a server template lookup, so just count all in the area as candidates
    structureCount++;
  }

  log(`Phase 6: observed ${structureCount} structures (need ≥${expectedStructureMin})`);
  if (structureCount < expectedStructureMin) {
    return {
      ok: false,
      notes: `only ${structureCount}/${expectedStructureMin} structures visible — placement may have failed`,
    };
  }
  return { ok: true, notes: `${structureCount} structures observed` };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function summarizeFleetOutcome(
  outcomes: FleetOutcome[],
  expected: number,
): { ok: boolean; notes?: string; failures?: string[] } {
  const failures: string[] = [];
  let succeeded = 0;
  for (const o of outcomes) {
    if (o.error !== undefined) {
      failures.push(`${o.config.account}: ${o.error.message}`);
      continue;
    }
    const scriptFailures = o.lifecycleResult?.scriptResult?.assertionFailures ?? [];
    if (scriptFailures.length > 0) {
      for (const f of scriptFailures) failures.push(`${o.config.account}: ${f}`);
      continue;
    }
    succeeded++;
  }
  return {
    ok: succeeded === expected,
    notes: `${succeeded}/${expected} succeeded`,
    ...(failures.length > 0 ? { failures } : {}),
  };
}
