/**
 * Admin wire helpers — thin functions that drive the server's god-mode console
 * (`ConGenericMessage`) and the `setGodMode` command-queue command. Used by
 * the build-city scenarios to spawn deeds, set objvars, grant credits, etc.
 *
 * Authorization: every operation here requires the caller's account to be in
 * `dsrc/.../admin/stella_admin.tab` (AdminLevel > 0). The `tscity##` accounts
 * are added by Phase 0pre.
 *
 * Server-side wire path:
 *   - `useAbility('setGodMode', null, '1')` → fires `admin_setGodMode` cpp hook
 *     → `Client::setGodMode(true)` → flips `m_godMode` on the in-memory Client
 *   - `ConGenericMessage('object createIn ...', msgId)` → server gates on
 *     `Client::isGod()` (Client.cpp:917) → `ConsoleMgr::processString` →
 *     server replies with `ConGenericMessage(result, msgId)` echoing the same
 *     `msgId` we sent.
 *   - Empty results auto-pad to "Command [...] succeeded." (ConsoleManager.cpp:112)
 *
 * `adminSpawnInto` parses "NetworkId: <decimal>" from the reply (the literal
 * text produced by `commandFuncObject createIn` at ConsoleCommandParserObject.cpp:992).
 */

import { ConGenericMessage } from '../../src/messages/game/con-generic-message.js';
import type { ScriptContext } from '../../src/client/script/context.js';
import type { NetworkId } from '../../src/types.js';

/**
 * Per-context monotonic msgId counter. We can't store it on the ScriptContext
 * (it's read-only and we don't want to monkeypatch), so we key by the
 * dispatcher reference. Each dispatcher is created per-stage, so this naturally
 * scopes to a single client run.
 */
const msgIdCounter = new WeakMap<object, { next: number }>();
function nextMsgId(ctx: ScriptContext): number {
  let entry = msgIdCounter.get(ctx.dispatcher);
  if (entry === undefined) {
    entry = { next: 1 };
    msgIdCounter.set(ctx.dispatcher, entry);
  }
  return entry.next++;
}

/**
 * Toggle the player's god-mode flag server-side. Required before any
 * ConGenericMessage console command will be honored. Fire-and-forget: the
 * server doesn't send a confirmation; we settle briefly and trust the flag is set.
 *
 * NOTE: requires AdminAccountManager::getAdminLevel(account) > 0
 * (or ConfigServerGame::getAdminGodToAll() === true).
 */
export async function adminGodModeOn(ctx: ScriptContext): Promise<void> {
  ctx.useAbility('setGodMode', undefined, '1');
  await ctx.wait(250);
}

/** Inverse of adminGodModeOn — also fire-and-forget. */
export async function adminGodModeOff(ctx: ScriptContext): Promise<void> {
  ctx.useAbility('setGodMode', undefined, '0');
  await ctx.wait(250);
}

/**
 * Teleport the player to (planet, x, y, z). Wraps `useAbility('planetwarp', ...)`
 * which fires `admin_planetwarp` server-side (CommandCppFuncs.cpp:1018).
 *
 * Param order on the wire: `<planet> <x> <y> <z>`. The server also accepts
 * a container OID + cell-relative position but we don't use those.
 *
 * After teleport, walks the player to settle the cell context. The transform
 * cursor is reset to the new position so `ctx.position()` returns the right thing.
 */
export async function adminPlanetWarp(
  ctx: ScriptContext,
  planet: string,
  x: number,
  y: number,
  z: number,
  settleMs = 2500,
): Promise<void> {
  ctx.useAbility('planetwarp', undefined, `${planet} ${x} ${y} ${z}`);
  // Update the in-context cursor so subsequent walkTo doesn't try to walk
  // from the old location.
  ctx.setPose({ x, y, z }, ctx.yaw());
  await ctx.wait(settleMs);
}

/**
 * Send a raw admin console command and return the server's reply text. Use
 * for any one-off command (e.g. `'server reloadAdminTable'`,
 * `'city getCityInfo <id>'`, `'objvar list <oid>'`).
 *
 * Throws on timeout (default 5s) — the server always replies even on parse
 * failure, so a timeout means the connection dropped or the reply didn't
 * match the msgId.
 */
export async function adminConsole(
  ctx: ScriptContext,
  command: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const msgId = nextMsgId(ctx);
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const replyP = ctx.dispatcher.waitFor(ConGenericMessage, {
    timeoutMs,
    predicate: (m) => m.msgId === msgId,
  });
  ctx.send(new ConGenericMessage(command, msgId));
  const reply = await replyP;
  return reply.msg;
}

/**
 * Spawn an object via `object createIn` into the named container. Returns
 * the new object's NetworkId (parsed from the reply's "NetworkId: <decimal>\n"
 * line — see ConsoleCommandParserObject.cpp:992).
 *
 * `sharedTemplate` is the SERVER template path (e.g. `object/tangible/deed/.../shared_*_deed.iff`).
 * `containerOid` is the destination — typically the player's inventory NetworkId
 * (use `extractInventoryContainerId(transcript)` from baseline-helpers to find it).
 */
export async function adminSpawnInto(
  ctx: ScriptContext,
  sharedTemplate: string,
  containerOid: NetworkId,
  opts: { timeoutMs?: number } = {},
): Promise<NetworkId> {
  const reply = await adminConsole(
    ctx,
    `object createIn ${sharedTemplate} ${containerOid.toString()}`,
    opts,
  );
  return parseNetworkIdFromReply(reply, sharedTemplate);
}

/**
 * Spawn an object at the player's standing location via `object createAt`.
 * Returns the new object's NetworkId.
 */
export async function adminSpawnAt(
  ctx: ScriptContext,
  sharedTemplate: string,
  opts: { timeoutMs?: number } = {},
): Promise<NetworkId> {
  const reply = await adminConsole(ctx, `object createAt ${sharedTemplate}`, opts);
  return parseNetworkIdFromReply(reply, sharedTemplate);
}

/**
 * Spawn an object at absolute world coordinates via `object create`.
 */
export async function adminSpawnAtXYZ(
  ctx: ScriptContext,
  sharedTemplate: string,
  x: number,
  y: number,
  z: number,
  opts: { timeoutMs?: number } = {},
): Promise<NetworkId> {
  const reply = await adminConsole(
    ctx,
    `object create ${sharedTemplate} ${x} ${y} ${z}`,
    opts,
  );
  return parseNetworkIdFromReply(reply, sharedTemplate);
}

/**
 * Set an objvar on the given object. Fire-and-forget (we still await reply
 * for ordering, but ignore content). The server's objvar parser auto-detects
 * the value type from the string (`1` → int, `1.5` → float, `"foo"` → string).
 */
export async function adminSetObjVar(
  ctx: ScriptContext,
  oid: NetworkId,
  key: string,
  value: string | number,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  await adminConsole(ctx, `objvar set ${oid.toString()} ${key} ${value}`, opts);
}

/**
 * Grant `amount` credits to the given object (player or structure). Uses the
 * `money deposit` console command. Fire-and-forget.
 */
export async function adminGiveMoney(
  ctx: ScriptContext,
  oid: NetworkId,
  amount: number,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  await adminConsole(ctx, `money deposit ${oid.toString()} ${amount}`, opts);
}

/**
 * Read an objvar from the given object. Returns the raw reply text — caller
 * parses based on expected type. Used as a placement-completion signal
 * (deeds are consumed when their structure is placed; getObjvar starts
 * returning an error string, which the caller distinguishes from success).
 */
export async function adminGetObjVar(
  ctx: ScriptContext,
  oid: NetworkId,
  key: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  return adminConsole(ctx, `objvar get ${oid.toString()} ${key}`, opts);
}

/**
 * Resolve the inventory container OID for a player via `object getInventoryId <oid>`.
 * Returns the inventory NetworkId, or null if the object has no inventory slot.
 *
 * Reply format from ConsoleCommandParserObject.cpp:1197:
 *   "<inventory_oid>\nSUCCESS: ..."
 */
export async function adminGetInventoryId(
  ctx: ScriptContext,
  playerOid: NetworkId,
  opts: { timeoutMs?: number } = {},
): Promise<NetworkId | null> {
  const reply = await adminConsole(ctx, `object getInventoryId ${playerOid.toString()}`, opts);
  // First line is the decimal NetworkId; second line is "SUCCESS: ..."
  const firstLine = reply.split('\n')[0]?.trim() ?? '';
  if (firstLine === '' || /no inventory|invalid/i.test(firstLine)) return null;
  try {
    return BigInt(firstLine);
  } catch {
    return null;
  }
}

/**
 * Trigger a server-wide admin table reload. Used by Phase 0pre after editing
 * stella_admin.tab + rebuilding the .iff. Must be called from a client whose
 * account is ALREADY admin (e.g. `swg`) — won't work on the newly-added
 * tscity## accounts before reload.
 *
 * Wire: ConGenericMessage('server reloadAdminTable') → game server's
 * ConsoleCommandParserServer at line 606 → AdminAccountManager::reload() +
 * broadcast ReloadAdminTableMessage to every other server via
 * ServerMessageForwarding.
 */
export async function adminReloadAdminTable(ctx: ScriptContext): Promise<string> {
  return adminConsole(ctx, 'server reloadAdminTable');
}

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

function parseNetworkIdFromReply(reply: string, contextForError: string): NetworkId {
  // Reply format from commandFuncObject createIn (ConsoleCommandParserObject.cpp:992):
  //   "NetworkId: 1234567890\nSUCCESS: ..."
  const match = reply.match(/NetworkId:\s*(-?\d+)/);
  if (match === null || match[1] === undefined) {
    throw new Error(
      `adminSpawn: server reply did not contain "NetworkId: <n>" (template=${contextForError}, reply=${truncate(reply, 200)})`,
    );
  }
  return BigInt(match[1]);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[${s.length - max} more chars]`;
}
