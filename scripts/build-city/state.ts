/**
 * Persistence layer for the build-city orchestrator.
 *
 * State.json schema is intentionally simple JSON — no SQLite, no lockfile.
 * The orchestrator is single-process and phase-sequential, so file-level
 * locking isn't needed. NetworkIds are stored as strings (decimal form) since
 * JSON can't represent bigint natively.
 *
 * File location: `scripts/build-city/state.json` (gitignored).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NetworkId } from '../../src/types.js';

// Resolve state.json path relative to this source file's directory.
// Works for both compiled (dist/) and direct tsx execution.
const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, 'state.json');

export type PhaseName =
  | 'phase0pre' // admin allowlist staged + reloaded
  | 'phase0a-mvp' // 5 chars stocked
  | 'phase0b-full' // 25 additional chars stocked
  | 'phase1-mvp' // 5 chars NetworkIds resolved
  | 'phase1-full' // 30 chars NetworkIds resolved
  | 'phase2-mayor' // city hall placed
  | 'phase3-mvp' // 4 residents placed houses
  | 'phase3-full' // 15 residents placed houses
  | 'phase4-civic' // 6 civic builders placed
  | 'phase5-decor' // gardens + decorations placed
  | 'phase6-verify'; // city verified, citizen count confirmed

export interface PhaseLogEntry {
  phase: PhaseName;
  startedAt: string; // ISO timestamp
  finishedAt: string | null;
  ok: boolean;
  notes?: string;
  /** Soft-failure messages from per-character ScriptResult.assertionFailures. */
  assertionFailures?: string[];
}

export interface CharacterRecord {
  account: string;
  characterName: string;
  /** NetworkId as decimal string (BigInt-safe). */
  networkId: string | null;
  /** True if Stage 1+2 lookup succeeded. */
  created: boolean;
  /** True if character was newly created (false if already existed). */
  wasFreshlyCreated: boolean;
  /** ClientPermissionsMessage.isAdmin observed during lookup — sanity check. */
  isAdmin?: boolean;
  /** Last error message if creation failed. */
  error?: string;
}

export interface StructureRecord {
  /** Owning character (mayor for cityhall, civic builder for civics, resident for houses). */
  ownerAccount: string;
  /** Structure type for state.json bookkeeping. */
  kind: 'cityhall' | 'civic' | 'house' | 'guildhall' | 'garden';
  /** Specific role/template (e.g. 'bank', 'naboo_house_small'). */
  subKind?: string;
  /** Server-side deed NetworkId — consumed once placed. */
  deedOid: string | null;
  /** Actual placed structure NetworkId, if scraped post-placement. */
  structureOid: string | null;
  /** Placement coords. */
  x: number;
  z: number;
  rotation: number;
  /** True if this is the player's declared residence. */
  isResidence?: boolean;
}

export interface CityState {
  /** Schema version — bump if breaking changes. */
  schemaVersion: 1;
  /** City constants snapshot (so state.json is self-contained). */
  cityName: string;
  cityCenter: { x: number; z: number };
  cityPlanet: string;
  /** Computed city OID once known (from `city getCityAtLocation` or similar). Decimal string. */
  cityOid: string | null;
  /** The mayor's account. */
  mayorAccount: string | null;
  /** The mayor's NetworkId. */
  mayorNetworkId: string | null;
  /** Pre-stocked characters indexed by account. */
  characters: Record<string, CharacterRecord>;
  /** Placed structures (any kind), keyed by owner account. */
  structures: Record<string, StructureRecord>;
  /** Phase progression log. */
  phaseLog: PhaseLogEntry[];
}

const EMPTY_STATE: CityState = {
  schemaVersion: 1,
  cityName: '',
  cityCenter: { x: 0, z: 0 },
  cityPlanet: '',
  cityOid: null,
  mayorAccount: null,
  mayorNetworkId: null,
  characters: {},
  structures: {},
  phaseLog: [],
};

/** Load state from disk; returns EMPTY_STATE if file doesn't exist. */
export function loadState(): CityState {
  if (!existsSync(STATE_PATH)) return structuredClone(EMPTY_STATE);
  const raw = readFileSync(STATE_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as CityState;
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `build-city state.json schemaVersion ${parsed.schemaVersion} unsupported; expected 1`,
    );
  }
  return parsed;
}

/** Save state atomically (write+rename). */
export function saveState(state: CityState): void {
  const tmpPath = `${STATE_PATH}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmpPath, STATE_PATH);
}

/** Mark a phase as started — appends an entry with finishedAt=null. */
export function markPhaseStarted(state: CityState, phase: PhaseName, notes?: string): void {
  state.phaseLog.push({
    phase,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: false,
    ...(notes !== undefined ? { notes } : {}),
  });
}

/** Mark the most-recent phase entry as finished, with success status. */
export function markPhaseFinished(
  state: CityState,
  phase: PhaseName,
  ok: boolean,
  opts: { notes?: string; assertionFailures?: string[] } = {},
): void {
  // Find the most-recent matching phase entry without finishedAt
  for (let i = state.phaseLog.length - 1; i >= 0; i--) {
    const entry = state.phaseLog[i]!;
    if (entry.phase === phase && entry.finishedAt === null) {
      entry.finishedAt = new Date().toISOString();
      entry.ok = ok;
      if (opts.notes !== undefined) entry.notes = opts.notes;
      if (opts.assertionFailures !== undefined && opts.assertionFailures.length > 0) {
        entry.assertionFailures = opts.assertionFailures;
      }
      return;
    }
  }
  // No matching unstarted entry — add a fresh one (defensive; shouldn't happen)
  const newEntry: PhaseLogEntry = {
    phase,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ok,
    ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
    ...(opts.assertionFailures !== undefined && opts.assertionFailures.length > 0
      ? { assertionFailures: opts.assertionFailures }
      : {}),
  };
  state.phaseLog.push(newEntry);
}

/** Returns true if the given phase has a successful entry in the log. */
export function isPhaseComplete(state: CityState, phase: PhaseName): boolean {
  return state.phaseLog.some((e) => e.phase === phase && e.ok && e.finishedAt !== null);
}

/** Convert a NetworkId (bigint) to its decimal string form for storage. */
export function networkIdToString(id: NetworkId): string {
  return id.toString();
}

/** Convert a stored decimal string back to NetworkId. Returns null if empty. */
export function networkIdFromString(s: string | null): NetworkId | null {
  if (s === null || s === '') return null;
  return BigInt(s);
}

/** Test helper — override STATE_PATH for tests (not exported in production). */
export function _setStatePathForTesting(path: string): { restore: () => void } {
  // We can't reassign const STATE_PATH, but tests can monkey-patch loadState/saveState
  // via DI. For now, tests use createScratchState() helper instead of overriding paths.
  return { restore: () => {} };
}

/** Create a fresh state in memory (for tests, without touching disk). */
export function createScratchState(opts: Partial<Pick<CityState, 'cityName' | 'cityCenter' | 'cityPlanet'>> = {}): CityState {
  return {
    ...structuredClone(EMPTY_STATE),
    cityName: opts.cityName ?? 'TsHarbor',
    cityCenter: opts.cityCenter ?? { x: 2800, z: -2800 },
    cityPlanet: opts.cityPlanet ?? 'naboo',
  };
}

export { STATE_PATH };
