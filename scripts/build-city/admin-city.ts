/**
 * Admin wire helpers for the server's `city` console command family
 * (ConsoleCommandParserCity.cpp). Thin wrappers over `adminConsole(ctx, ...)`
 * that send a `city <verb> [args]` and parse the reply text into typed records.
 *
 * Authorization: every command in this module requires the caller's account to
 * have `AdminAccountManager::getAdminLevel(account) > 0` (god mode) — the
 * `tscity##` accounts seeded by Phase 0pre are AdminLevel 1, which is
 * sufficient. The parser checks `playerObject->getClient()->isGod()` at the
 * top of every subcommand (ConsoleCommandParserCity.cpp:80-82), so
 * `adminGodModeOn(ctx)` must precede any call here.
 *
 * Server-side reply format:
 *   The C++ parser builds a Unicode multi-line string via FormattedString +
 *   appends `getErrorMessage("<verb>", ERR_SUCCESS|ERR_FAIL)` from
 *   CommandParser.cpp:603 → e.g. "showCityDetails: Command completed succesfully."
 *   (note the misspelling of "succesfully" — it's in the upstream source).
 *   We tolerate either spelling defensively.
 *
 * Supported subcommands (read-only):
 *   - city showCityDetails <cityId>  → full city info + citizen list + structure list
 *   - city listByPlanet              → all cities, one line each, sortable by planet
 *
 * Unsupported by the city parser (no console command exists for these in
 * ConsoleCommandParserCity.cpp's `cmds[]` table):
 *   - addCitizen / removeCitizen / promote — only callable via the
 *     `script.library.city` Java helpers, which require a `script triggerOne`
 *     into a script that calls them. The wrappers below throw a clear
 *     "not supported via city console" error and document the alternative.
 *
 * The 22-field comma-separated line format from the list* commands is:
 *   "id, name, leaderId (leaderName), cityHallId, planet (x, z), radius m,
 *    faction (factionName), citizenCount, structureCount, creationTime (timeStr)"
 *
 * `showCityDetails` output is multi-line with `key: value\n` pairs followed by
 * `\nCitizens:\n` and `\nStructures:\n` sections.
 */

import type { ScriptContext } from '../../src/client/script/context.js';
import type { NetworkId } from '../../src/types.js';
import { adminConsole } from './admin.js';

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export interface CityInfo {
  /** Integer city id (the primary key in CityInterface). */
  cityId: NetworkId;
  /** Display name (server's `cityName` field). */
  cityName: string;
  /** City hall object NetworkId, or null if none/invalid. */
  cityHallId: NetworkId | null;
  /** Mayor (leader) NetworkId, or null if unset. */
  mayorId: NetworkId | null;
  /** Radius in meters. */
  radius: number;
  /**
   * Approximate "rank" — there's no `rank` field in CityInfo per se; the
   * server uses radius to look up rank in `datatables/city/city_rank.iff`.
   * The console output only exposes radius, so callers wanting rank should
   * apply the same lookup. We expose `rank` as a derived value mapped from
   * the standard rank thresholds (radius 150/200/250/350/400 → 1/2/3/4/5).
   */
  rank: number;
  /** Number of citizens (lower-bound, from the citizen scan). */
  citizenCount: number;
  /** Number of structures (lower-bound, from the structure scan). */
  structureCount: number;
  /** Planet name (e.g. "naboo", "tatooine"). */
  planet: string;
  /** City center X (meters, server coordinate frame). */
  centerX: number;
  /** City center Z (meters). */
  centerZ: number;
  /** Treasury balance — NOT exposed by the city console parser. Always 0. */
  treasury: number;
}

export interface CityCitizen {
  /** Citizen NetworkId. */
  oid: NetworkId;
  /** Display name (m_citizenName). */
  name: string;
  /** Profession / skill template (m_citizenProfessionSkillTemplate). */
  profession?: string;
  /** Level. */
  level?: number;
  /** Permissions bitmask + text (Militia / Citizen / AbsentWeek* / etc). */
  permissions?: string;
  /** Rank info string (e.g. "Mayor", "Militia"). */
  rank?: string;
  /** Title. */
  title?: string;
  /** Allegiance NetworkId. */
  allegiance?: string;
}

export interface CityStructure {
  /** Structure NetworkId. */
  oid: NetworkId;
  /** "valid" / "no valid" — server's getStructureValid(). */
  valid: boolean;
  /** Structure-type bitmask integer. */
  typeFlags: number;
  /** Decoded flag names (e.g. "SF_COST_CITY_HALL SF_PM_REGISTER"). */
  typeText: string;
  /**
   * NOT exposed by the city console parser. Filled by extra console probes
   * (objvar list, object info) — left undefined here; callers that need a
   * template string should call `adminConsole(ctx, 'object info <oid>')`.
   */
  template?: string;
  /** Likewise not exposed by `city` — owner OID requires `objvar list <oid>`. */
  ownerOid?: NetworkId;
  /** Likewise not exposed — server coordinates require `object info <oid>`. */
  x?: number;
  z?: number;
  /** Derived from typeFlags & SF_DECORATION (128). */
  isDecoration: boolean;
  /** Derived from typeFlags & (SF_MISSION_TERMINAL | SF_SKILL_TRAINER). */
  isCivic: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Read helpers (backed by real city console commands)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a single city's details via `city showCityDetails <cityId>`.
 *
 * Reply layout (multi-line):
 *   id: <int>
 *   name: <string>
 *   mayor: <oid> (<name>)
 *   city hall id: <oid>
 *   location: <planet> (<x>, <z>)
 *   radius: <int>m
 *   faction: <factionId> (<factionName>)
 *   GCW defender region: ...
 *   creation time: <int> (<timeStr>)
 *   taxes: income <int>, property <int>, sales <int>
 *   travel: location (<f>, <f>, <f>), cost <int>, interplanetary <yes|no>
 *   clone: cloner id <oid>, cloner location ..., clone respawn ...
 *
 *   Citizens:
 *   <id>, <name>, <profession>, <level>, <permissions> (<permText>), <rank>, <title>, <allegiance>
 *   ...
 *   <n> citizens listed
 *   Output format is: "id, name, profession, ..."
 *
 *   Structures:
 *   <id>, <valid|no valid>, <typeInt> (<typeText>)
 *   ...
 *   <n> structures listed
 *   Output format is: "id, valid, type"
 *
 *   showCityDetails: Command completed succesfully.
 *
 * Throws if the city does not exist (server replies
 * "no city with city id <id>\nshowCityDetails: Command failed!").
 *
 * @param ctx     ScriptContext (must already be god-moded).
 * @param cityId  Integer city id (bigint). Will be passed to the server as decimal.
 * @param opts    Optional `timeoutMs` (default 5s).
 */
export async function adminCityInfo(
  ctx: ScriptContext,
  cityId: NetworkId,
  opts: { timeoutMs?: number } = {},
): Promise<CityInfo> {
  const reply = await adminConsole(ctx, `city showCityDetails ${cityId.toString()}`, opts);
  if (/no city with city id\s+-?\d+/i.test(reply)) {
    throw new Error(`adminCityInfo: no city with id ${cityId.toString()}`);
  }
  // Even if showCityDetails reports failure, surface the message.
  if (/showCityDetails:\s*Command failed/i.test(reply)) {
    throw new Error(`adminCityInfo: server returned failure (reply=${truncate(reply, 200)})`);
  }

  const info = parseCityDetails(reply);
  if (info === null) {
    throw new Error(
      `adminCityInfo: failed to parse "city showCityDetails ${cityId.toString()}" reply (reply=${truncate(reply, 400)})`,
    );
  }
  return info;
}

/**
 * Return the citizens of a city. Backed by the citizen section of
 * `city showCityDetails <cityId>` (same wire round-trip as adminCityInfo).
 * Throws if the city does not exist.
 */
export async function adminCityListCitizens(
  ctx: ScriptContext,
  cityId: NetworkId,
  opts: { timeoutMs?: number } = {},
): Promise<CityCitizen[]> {
  const reply = await adminConsole(ctx, `city showCityDetails ${cityId.toString()}`, opts);
  if (/no city with city id\s+-?\d+/i.test(reply)) {
    throw new Error(`adminCityListCitizens: no city with id ${cityId.toString()}`);
  }
  return parseCitizenSection(reply);
}

/**
 * Return the structures of a city. Backed by the structure section of
 * `city showCityDetails <cityId>`. Throws if the city does not exist.
 *
 * NOTE: the city console parser only exposes `id, valid, typeFlags` per
 * structure. `template`, `ownerOid`, `x`, `z` are NOT populated — they
 * require separate `object info <oid>` / `objvar list <oid>` probes.
 */
export async function adminCityListStructures(
  ctx: ScriptContext,
  cityId: NetworkId,
  opts: { timeoutMs?: number } = {},
): Promise<CityStructure[]> {
  const reply = await adminConsole(ctx, `city showCityDetails ${cityId.toString()}`, opts);
  if (/no city with city id\s+-?\d+/i.test(reply)) {
    throw new Error(`adminCityListStructures: no city with id ${cityId.toString()}`);
  }
  return parseStructureSection(reply);
}

/**
 * Look up the city id at a given world location by listing all cities on the
 * planet and picking the one whose center is within `radiusBufferM` meters of
 * the supplied (x, z). Returns null if no city covers that location.
 *
 * NOTE: there is no `city getCityAtLocation` console command (the C++ helper
 * `CityInterface::getCityAtLocation` exists but is not exposed in
 * ConsoleCommandParserCity.cpp's `cmds[]` table). We approximate it by
 * scanning the `city listByPlanet` output — each row is
 *   "<id>, <name>, <leaderId> (<leaderName>), <cityHallId>, <planet> (<x>, <z>), <radius>m, ..."
 * and picking the first city whose center is within `radius + radiusBufferM`
 * meters of the supplied (x, z).
 *
 * @param ctx              ScriptContext (must already be god-moded).
 * @param planet           Planet name (e.g. "naboo"). Matched case-insensitively.
 * @param x                World X to look up (meters).
 * @param z                World Z to look up (meters).
 * @param radiusBufferM    Slack added to the city radius when checking inclusion.
 *                         Default 0 — strict radius. Use ~50 to tolerate small
 *                         deed-placement offsets.
 * @param opts             Optional `timeoutMs` (default 8s — list call is heavier).
 */
export async function adminCityGetCityAtLocation(
  ctx: ScriptContext,
  planet: string,
  x: number,
  z: number,
  radiusBufferM = 0,
  opts: { timeoutMs?: number } = {},
): Promise<NetworkId | null> {
  const reply = await adminConsole(ctx, 'city listByPlanet', {
    timeoutMs: opts.timeoutMs ?? 8_000,
  });
  const rows = parseCityListRows(reply);
  let best: { id: bigint; distance: number } | null = null;
  for (const row of rows) {
    if (row.planet.toLowerCase() !== planet.toLowerCase()) continue;
    const dx = row.x - x;
    const dz = row.z - z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance > row.radius + radiusBufferM) continue;
    if (best === null || distance < best.distance) {
      best = { id: row.id, distance };
    }
  }
  return best === null ? null : best.id;
}

// ────────────────────────────────────────────────────────────────────────────
// Mutation helpers (NOT directly supported by ConsoleCommandParserCity)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Promote a city — bump its rank by recomputing structure/citizen counts and
 * re-applying the rank table from `datatables/city/city_rank.iff`.
 *
 * NOTE: there is NO `city promote` console subcommand. Real "promotion" on
 * SWG happens automatically once the citizen + structure counts cross a
 * rank threshold (server runs a daily script that calls
 * `script.library.city.handlePromotion`). The only way to force-promote
 * via wire would be a `script triggerOne <trigger> <city_hall_oid> ...`
 * into a custom trigger that calls `cityRecomputeRanks`. Until that
 * helper script is staged in dsrc, this wrapper throws so callers don't
 * silently no-op.
 *
 * Workaround: place enough citizens + structures to organically promote, OR
 * use the `setMayor` / `setRadius` Java helpers via a manually-attached
 * helper script invoked through `script triggerOne` — out of scope here.
 *
 * @throws Always — documents the missing capability.
 */
export async function adminCityPromote(
  _ctx: ScriptContext,
  cityId: NetworkId,
  _opts: { timeoutMs?: number } = {},
): Promise<void> {
  throw new Error(
    `adminCityPromote(${cityId.toString()}): not supported — no 'city promote' console command exists in ConsoleCommandParserCity.cpp. Promote via citizen+structure thresholds or a custom 'script triggerOne' helper.`,
  );
}

/**
 * Add a citizen to a city.
 *
 * NOTE: there is NO `city addCitizen` console subcommand. The Java helper
 * `script.library.city.addCitizen(citizen, residence)` exists but is only
 * invoked from in-game flows (declare-residence radial, mayor's citizen
 * management UI). Wrapper throws to keep call sites honest.
 *
 * To actually add a citizen via wire: have the player walk into a residence
 * they own and run `useAbility('declareResidence', residenceOid)` — that
 * triggers the same script path as the UI radial.
 *
 * @throws Always — documents the missing capability.
 */
export async function adminCityAddCitizen(
  _ctx: ScriptContext,
  cityId: NetworkId,
  playerOid: NetworkId,
  _opts: { timeoutMs?: number } = {},
): Promise<void> {
  throw new Error(
    `adminCityAddCitizen(city=${cityId.toString()}, player=${playerOid.toString()}): not supported — no 'city addCitizen' console command. Use useAbility('declareResidence', residenceOid) from the citizen's own client instead.`,
  );
}

/**
 * Remove a citizen from a city.
 *
 * NOTE: no `city removeCitizen` console subcommand. Wrapper throws.
 *
 * To actually remove a citizen via wire: from the citizen's client, run
 * `useAbility('declareResidence', otherResidenceOid)` to move them out, OR
 * have the mayor run a `cityKickFromCity` / `cityBanPlayer` UI flow.
 *
 * @throws Always — documents the missing capability.
 */
export async function adminCityRemoveCitizen(
  _ctx: ScriptContext,
  cityId: NetworkId,
  playerOid: NetworkId,
  _opts: { timeoutMs?: number } = {},
): Promise<void> {
  throw new Error(
    `adminCityRemoveCitizen(city=${cityId.toString()}, player=${playerOid.toString()}): not supported — no 'city removeCitizen' console command. Have the citizen re-declare residence elsewhere, or run the mayor's kick/ban flow.`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Reply parsers
// ────────────────────────────────────────────────────────────────────────────

/** Each row in `city listBy*` output, comma-separated. */
interface CityListRow {
  id: bigint;
  name: string;
  leaderId: bigint;
  leaderName: string;
  cityHallId: bigint;
  planet: string;
  x: number;
  z: number;
  radius: number;
  faction: number;
  factionName: string;
  citizenCount: number;
  structureCount: number;
}

/**
 * Parse a `city listBy*` reply into structured rows. Tolerates the trailing
 * "N cities listed\n" footer and the "Output format is: ..." line.
 *
 * Row format from ConsoleCommandParserCity.cpp:98 (and replicas):
 *   "%d, %s, %s (%s), %s, %s (%d, %d), %dm, %lu (%s), %d, %d, %d (%s)\n"
 *
 * The interior parenthesized groups make a naive comma-split unreliable, so
 * we use an anchored regex per row.
 */
export function parseCityListRows(reply: string): CityListRow[] {
  // Pattern matches one row; captures: id, name, leaderId, leaderName,
  // cityHallId, planet, x, z, radius, faction, factionName, citizenCount,
  // structureCount.
  //
  // Name can contain spaces but not commas. LeaderName too. Planet is a single
  // token. Faction name is a single token like "Neutral"/"Imperial"/"Rebel"/"Unknown".
  const rowRe =
    /^(-?\d+),\s+([^,]+?),\s+(-?\d+)\s+\(([^)]*)\),\s+(-?\d+),\s+([^\s(]+)\s+\((-?\d+),\s+(-?\d+)\),\s+(-?\d+)m,\s+(\d+)\s+\(([^)]*)\),\s+(-?\d+),\s+(-?\d+),\s+-?\d+\s+\([^)]*\)\s*$/gm;
  const rows: CityListRow[] = [];
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(reply)) !== null) {
    rows.push({
      id: BigInt(match[1] ?? '0'),
      name: (match[2] ?? '').trim(),
      leaderId: BigInt(match[3] ?? '0'),
      leaderName: (match[4] ?? '').trim(),
      cityHallId: BigInt(match[5] ?? '0'),
      planet: (match[6] ?? '').trim(),
      x: parseInt(match[7] ?? '0', 10),
      z: parseInt(match[8] ?? '0', 10),
      radius: parseInt(match[9] ?? '0', 10),
      faction: parseInt(match[10] ?? '0', 10),
      factionName: (match[11] ?? '').trim(),
      citizenCount: parseInt(match[12] ?? '0', 10),
      structureCount: parseInt(match[13] ?? '0', 10),
    });
  }
  return rows;
}

/**
 * Parse the head portion of `city showCityDetails <id>` (everything before
 * the `\nCitizens:` line) into a `CityInfo`.
 */
function parseCityDetails(reply: string): CityInfo | null {
  const head = reply.split(/\nCitizens:\n/)[0] ?? reply;

  const id = matchInt(head, /^id:\s*(-?\d+)/m);
  const name = matchStr(head, /^name:\s*(.+?)\s*$/m);
  const mayor = head.match(/^mayor:\s*(-?\d+)\s*\(([^)]*)\)/m);
  const cityHall = matchStr(head, /^city hall id:\s*(-?\d+)/m);
  const location = head.match(/^location:\s*(\S+)\s+\((-?\d+),\s*(-?\d+)\)/m);
  const radius = matchInt(head, /^radius:\s*(-?\d+)m/m);

  // Citizen / structure counts come from the footer lines in the corresponding sections.
  const citizenCount = matchInt(reply, /^(\d+)\s+citizens listed\b/m) ?? 0;
  const structureCount = matchInt(reply, /^(\d+)\s+structures listed\b/m) ?? 0;

  if (id === null || name === null || location === null || radius === null) {
    return null;
  }
  return {
    cityId: BigInt(id),
    cityName: name,
    cityHallId: cityHall === null ? null : zeroToNull(BigInt(cityHall)),
    mayorId: mayor?.[1] !== undefined ? zeroToNull(BigInt(mayor[1])) : null,
    radius,
    rank: rankFromRadius(radius),
    citizenCount,
    structureCount,
    planet: (location[1] ?? '').trim(),
    centerX: parseInt(location[2] ?? '0', 10),
    centerZ: parseInt(location[3] ?? '0', 10),
    treasury: 0, // not exposed by the city console parser
  };
}

/**
 * Parse the `\nCitizens:\n...\n<n> citizens listed\n` block. Lines look like:
 *   "<oid>, <name>, <profession>, <level>, <permsInt> (<permsText>), <rank>, <title>, <allegiance>"
 */
function parseCitizenSection(reply: string): CityCitizen[] {
  const section = sliceSection(reply, /\nCitizens:\n/, /\d+\s+citizens listed/m);
  if (section === null) return [];
  const citizens: CityCitizen[] = [];
  // citizen line: id, name, profession, level, perms (permsText), rank-stuff, title, allegiance
  const lineRe =
    /^(-?\d+),\s+([^,]+),\s+([^,]*),\s+(-?\d+),\s+(-?\d+)\s+\(([^)]*)\),\s+(.+?),\s+([^,]*),\s+(-?\d+)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(section)) !== null) {
    citizens.push({
      oid: BigInt(m[1] ?? '0'),
      name: (m[2] ?? '').trim(),
      profession: (m[3] ?? '').trim(),
      level: parseInt(m[4] ?? '0', 10),
      permissions: `${(m[5] ?? '').trim()} (${(m[6] ?? '').trim()})`,
      rank: (m[7] ?? '').trim(),
      title: (m[8] ?? '').trim(),
      allegiance: (m[9] ?? '').trim(),
    });
  }
  return citizens;
}

/**
 * Parse the `\nStructures:\n...\n<n> structures listed\n` block. Lines:
 *   "<oid>, <valid|no valid>, <typeInt> (<typeText>)"
 */
function parseStructureSection(reply: string): CityStructure[] {
  const section = sliceSection(reply, /\nStructures:\n/, /\d+\s+structures listed/m);
  if (section === null) return [];
  const structures: CityStructure[] = [];
  const lineRe = /^(-?\d+),\s+(valid|no valid),\s+(-?\d+)\s+\(([^)]*)\)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(section)) !== null) {
    const typeFlags = parseInt(m[3] ?? '0', 10);
    const typeText = (m[4] ?? '').trim();
    const SF_MISSION_TERMINAL = 32;
    const SF_SKILL_TRAINER = 64;
    const SF_DECORATION = 128;
    structures.push({
      oid: BigInt(m[1] ?? '0'),
      valid: m[2] === 'valid',
      typeFlags,
      typeText,
      isDecoration: (typeFlags & SF_DECORATION) !== 0,
      isCivic: (typeFlags & (SF_MISSION_TERMINAL | SF_SKILL_TRAINER)) !== 0,
    });
  }
  return structures;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function matchInt(text: string, re: RegExp): number | null {
  const m = text.match(re);
  if (m === null || m[1] === undefined) return null;
  const n = parseInt(m[1], 10);
  return Number.isNaN(n) ? null : n;
}

function matchStr(text: string, re: RegExp): string | null {
  const m = text.match(re);
  if (m === null || m[1] === undefined) return null;
  return m[1].trim();
}

function sliceSection(text: string, startRe: RegExp, endRe: RegExp): string | null {
  const startMatch = startRe.exec(text);
  if (startMatch === null) return null;
  const after = text.slice(startMatch.index + startMatch[0].length);
  const endMatch = endRe.exec(after);
  return endMatch === null ? after : after.slice(0, endMatch.index);
}

function zeroToNull(n: bigint): NetworkId | null {
  return n === 0n ? null : n;
}

/**
 * Map a city radius to its in-game rank (1-5). Mirrors the lookup in
 * `datatables/city/city_rank.iff` (RADIUS column). Returns 0 for sub-rank
 * cities (radius < 150).
 *
 * Thresholds (vanilla SWG):
 *   rank 1 (outpost):       150m
 *   rank 2 (village):       200m
 *   rank 3 (township):      250m
 *   rank 4 (city):          350m
 *   rank 5 (metropolis):    400m
 */
function rankFromRadius(radius: number): number {
  if (radius >= 400) return 5;
  if (radius >= 350) return 4;
  if (radius >= 250) return 3;
  if (radius >= 200) return 2;
  if (radius >= 150) return 1;
  return 0;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[${s.length - max} more chars]`;
}
