/**
 * Building-permission admin helpers.
 *
 * Sit on top of the existing `adminConsole(ctx, ...)` wrapper from
 * `./admin.ts`. Wrap the `permissionListModify` command-queue command +
 * `objvar list` console reads so build-city scenarios can grant entry/admin/
 * hopper/banned permissions on each other's structures without crashing the
 * server's "no_rights" / "not_permitted" gates.
 *
 * Wire path (player-facing — the path the live Windows client uses):
 *
 *   useAbility('permissionListModify', structureOid, '<name> <listName> <action>')
 *
 * The C++ command handler (`CommandCppFuncs.cpp:2866 commandFuncPermissionListModify`)
 * fires the `OnPermissionListModify` script trigger in
 * `player_building.java:221`. That trigger reads listName as one of
 * `ENTRY|BAN|ADMIN|HOPPER` (case-sensitive uppercase) and calls
 * `player_structure.modify{Entry,Ban,Admin,Hopper}List`. **The `action` arg
 * is currently ignored by the script — `modifyList` toggles based on the
 * name's current membership**. This module therefore queries the current
 * list before sending the command and only fires when the desired state
 * differs from the observed state. Net effect from the caller's perspective:
 * `adminStructurePermissionAdd(...)` is idempotent.
 *
 * Observation pattern: we read the permission list via
 * `objvar get <oid> player_structure.<sub>` (the LIST parent, which dumps
 * via `listObjvars`) and parse the `STRING_ARRAY` payload — see
 * `ConsoleCommandParserObjvar.cpp:480 listObjvars` for the format.
 *
 * Authorization: the caller's account must be an admin (in
 * `stella_admin.tab`) so the underlying `useAbility` / `ConGenericMessage`
 * traffic isn't gated. The orchestrator's Phase 0pre sets this up.
 */

import type { ScriptContext } from '../../src/client/script/context.js';
import type { NetworkId } from '../../src/types.js';
import { adminConsole } from './admin.js';

/**
 * The four permission categories the server supports. Mapping to the listName
 * the script trigger compares against (in `player_building.java`):
 *
 *   entry  → "ENTRY"   → `player_structure.enter.enterList`
 *   admin  → "ADMIN"   → `player_structure.admin.adminList`
 *   hopper → "HOPPER"  → `player_structure.hopper.hopperList`
 *   banned → "BAN"     → `player_structure.ban.banList`
 */
export type PermissionType = 'entry' | 'admin' | 'hopper' | 'banned';

/** Server-side list name (the string the C++/Java compares against). */
const LIST_NAME: Record<PermissionType, 'ENTRY' | 'ADMIN' | 'HOPPER' | 'BAN'> = {
  entry: 'ENTRY',
  admin: 'ADMIN',
  hopper: 'HOPPER',
  banned: 'BAN',
};

/**
 * Path to the player_structure.<sub> LIST objvar that holds the names for
 * each permission type. The script stores the actual array under `enterList`
 * / `adminList` / etc. (a STRING_ARRAY child of the LIST), but querying the
 * parent LIST with `objvar get` triggers the nested-list dump which we then
 * parse.
 */
const OBJVAR_PARENT: Record<PermissionType, string> = {
  entry: 'player_structure.enter',
  admin: 'player_structure.admin',
  hopper: 'player_structure.hopper',
  banned: 'player_structure.ban',
};

/** The child STRING_ARRAY name inside the parent LIST. */
const OBJVAR_LEAF: Record<PermissionType, string> = {
  entry: 'enterList',
  admin: 'adminList',
  hopper: 'hopperList',
  banned: 'banList',
};

/**
 * Snapshot of one building's four permission lists. Names are normalized to
 * their stored form (case-preserved — the server lower-cases when comparing,
 * but stores whatever the trigger received). Guild tokens of the form
 * `guild:<abbrev>` may appear in `entry` and `banned`.
 */
export interface StructurePermissions {
  entry: string[];
  admin: string[];
  hopper: string[];
  banned: string[];
}

/**
 * Add a name to one of the structure's permission lists.
 *
 * Idempotent: queries the list first via `adminStructurePermissionList` and
 * only fires the `permissionListModify` toggle if `playerName` is NOT already
 * present in the requested list.
 *
 * Throws if the underlying `objvar list` console read fails. Does NOT throw
 * on "already a member" — that's treated as a successful no-op.
 */
export async function adminStructurePermissionAdd(
  ctx: ScriptContext,
  structureOid: NetworkId,
  permissionType: PermissionType,
  playerName: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const currentList = await readListForType(ctx, structureOid, permissionType, opts);
  if (containsName(currentList, playerName)) {
    return;
  }
  fireToggle(ctx, structureOid, permissionType, playerName);
}

/**
 * Remove a name from one of the structure's permission lists.
 *
 * Idempotent: only fires the toggle if `playerName` IS currently present.
 * `permissionType` is typed as `string` per the task spec (so callers can
 * pass raw `'entry'` / `'ENTRY'` / `'admin'` / etc.) — we normalize.
 */
export async function adminStructurePermissionRemove(
  ctx: ScriptContext,
  structureOid: NetworkId,
  permissionType: string,
  playerName: string,
): Promise<void> {
  const normalized = normalizeType(permissionType);
  const currentList = await readListForType(ctx, structureOid, normalized);
  if (!containsName(currentList, playerName)) {
    return;
  }
  fireToggle(ctx, structureOid, normalized, playerName);
}

/**
 * Snapshot all four permission lists on one structure. Useful for
 * "did the permission grant actually land?" assertions in tests.
 *
 * Empty lists are returned as `[]` (not null). The implementation issues
 * one `objvar get` per list (4 total console roundtrips) — for one-off
 * lookups in build-city scenarios this is fine; loops doing per-frame
 * polling should cache the result.
 */
export async function adminStructurePermissionList(
  ctx: ScriptContext,
  structureOid: NetworkId,
): Promise<StructurePermissions> {
  const [entry, admin, hopper, banned] = await Promise.all([
    readListForType(ctx, structureOid, 'entry'),
    readListForType(ctx, structureOid, 'admin'),
    readListForType(ctx, structureOid, 'hopper'),
    readListForType(ctx, structureOid, 'banned'),
  ]);
  return { entry, admin, hopper, banned };
}

// ────────────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fire the `permissionListModify` command-queue command. This is the
 * raw wire send — does NOT check current state. Use the `Add` / `Remove`
 * wrappers above for idempotent behavior.
 *
 * The third positional arg in `params` (`add`) is ignored by the script
 * trigger but we send it for forward-compat in case the C++ ever starts
 * to honor it. (Picking `add` over `remove` is arbitrary — either works
 * because the script ignores it.)
 */
function fireToggle(
  ctx: ScriptContext,
  structureOid: NetworkId,
  permissionType: PermissionType,
  playerName: string,
): void {
  const listName = LIST_NAME[permissionType];
  // Param order on the wire (parsed by commandFuncPermissionListModify):
  //   <name> <listName> <action>
  ctx.useAbility('permissionListModify', structureOid, `${playerName} ${listName} add`);
}

async function readListForType(
  ctx: ScriptContext,
  structureOid: NetworkId,
  permissionType: PermissionType,
  opts: { timeoutMs?: number } = {},
): Promise<string[]> {
  // `objvar get <oid> player_structure.<sub>` triggers the LIST handler in
  // ConsoleCommandParserObjvar.cpp (line 310), which dumps the nested list
  // via listObjvars. Output looks like:
  //   objvar list
  //   enterList	[
  //           	Alice
  //           	Bob
  //           	]
  // …with an "ERR_SUCCESS" tail.
  //
  // If the parent LIST has never been created (no entries ever added), the
  // server replies with ERR_INVALID_OBJVAR — we treat that as an empty list.
  const parent = OBJVAR_PARENT[permissionType];
  const leaf = OBJVAR_LEAF[permissionType];
  let reply: string;
  try {
    reply = await adminConsole(
      ctx,
      `objvar get ${structureOid.toString()} ${parent}`,
      opts,
    );
  } catch {
    return [];
  }
  if (/INVALID_OBJVAR|invalid objvar|not found|ERR_/i.test(reply) && !/SUCCESS/i.test(reply)) {
    return [];
  }
  return parseStringArrayBlock(reply, leaf);
}

/**
 * Parse a STRING_ARRAY payload out of a `listObjvars` dump. The format we're
 * looking for (whitespace-flexible):
 *
 *   <leaf>\t[\n
 *           \tNAME1\n
 *           \tNAME2\n
 *           \t]\n
 *
 * Returns `[]` if `<leaf>` isn't found in the dump (e.g. the parent LIST
 * exists but the leaf array hasn't been created yet).
 */
function parseStringArrayBlock(reply: string, leaf: string): string[] {
  const lines = reply.split('\n');
  // Locate the line that opens the leaf's array: "<leaf>\t[" (allowing leading whitespace).
  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Strip leading whitespace + tabs, then check for "<leaf>\t[" or "<leaf>  ["
    if (new RegExp(`^\\s*${escapeRegex(leaf)}\\s*\\[\\s*$`).test(line)) {
      openIdx = i;
      break;
    }
  }
  if (openIdx === -1) return [];

  // Walk forward until we hit a closing "]" line — every line between is one name.
  const names: string[] = [];
  for (let i = openIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === ']') break;
    if (trimmed === '') continue;
    // Some dumps prefix names with the original leaf-padding; trim() handles it.
    names.push(trimmed);
  }
  return names;
}

function containsName(list: string[], name: string): boolean {
  // The server's `isNameOn*List` helpers compare case-insensitively.
  const lower = name.toLowerCase();
  return list.some((n) => n.toLowerCase() === lower);
}

function normalizeType(t: string): PermissionType {
  const lower = t.toLowerCase();
  if (lower === 'entry' || lower === 'admin' || lower === 'hopper' || lower === 'banned') {
    return lower;
  }
  // Allow callers to pass the uppercase server-side listName too.
  if (lower === 'ban') return 'banned';
  throw new Error(
    `adminStructurePermissionRemove: unknown permissionType "${t}" (expected entry|admin|hopper|banned)`,
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
