/**
 * Structure placement + residence declaration helpers.
 *
 * Uses the same wire path as the real Windows client:
 *   1. Radial-menu USE on the deed (ObjectMenuSelectMessage with ITEM_USE=21)
 *   2. Server-side deed script opens SUI dialog(s):
 *      - For NON-reclaim deeds (cityhall, civic): YES_NO confirm msgbox
 *      - For cityhall additionally: cityName inputbox after YES
 *      - For reclaim-able deeds (houses): no SUI, queueCommand fires directly
 *   3. Respond to each SUI via SuiEventNotification
 *   4. Server queues placeStructure command which fires OnPlaceStructure → structure created
 */

import { ChatSystemMessage } from '../../src/messages/game/chat/index.js';
import { ObjectTypeTags } from '../../src/messages/game/baselines/registry.js';
import { ObjectMenuSelectMessage, RadialMenuTypes } from '../../src/messages/game/object-menu-select-message.js';
import { SceneCreateObjectByName } from '../../src/messages/game/scene-create-object-by-name.js';
import type { SuiCreatePageMessage } from '../../src/messages/game/sui/index.js';
import type { ScriptContext } from '../../src/client/script/context.js';
import type { NetworkId } from '../../src/types.js';
import { adminGetInventoryId, adminSpawnInto } from './admin.js';
import type { StructureRecord } from './state.js';

/**
 * Resolve the player's inventory NetworkId for spawning deeds.
 * Tries admin lookup first (always works for admin chars), falls back to
 * the auto-synced `ctx.inventory.containerId`.
 */
export async function resolveInventoryOid(ctx: ScriptContext): Promise<NetworkId> {
  try {
    const looked = await adminGetInventoryId(ctx, ctx.sceneStart.playerNetworkId);
    if (looked !== null) return looked;
  } catch {
    // fall through
  }
  const fromInventory = ctx.inventory.containerId;
  if (fromInventory !== null) return fromInventory;
  // Last resort: use player NetworkId (won't work for createIn but at least returns something)
  return ctx.sceneStart.playerNetworkId;
}

/**
 * Read the pageId from a `SuiCreatePageMessage`. After Feat #3 (SuiPageData
 * decode), this is just the decoded struct field — no manual byte unpacking
 * needed.
 */
function suiPageId(msg: SuiCreatePageMessage): number {
  return msg.pageData.pageId;
}

export interface PlaceDeedOptions {
  /** For city hall: the cityName to enter when the SUI inputbox appears. Default 'NewCity'. */
  cityName?: string;
  /** Container to spawn the deed into (default: auto-resolve via getInventoryId). */
  inventoryOid?: NetworkId;
  /** SUI wait timeout. Default 8000ms. */
  suiTimeoutMs?: number;
  /** Post-placement settle delay. Default 10000ms. */
  settleMs?: number;
  /** Number of SUI dialogs to expect; auto-detected from template if unset. */
  expectedSuiCount?: number;
  /**
   * After locating the placed structure's BUIO, wait up to this many ms for
   * at least one SCLT (cell) child to appear in the WorldModel. Required
   * for downstream `navigate({ buildingId })` to find an interior cell.
   * Default 10000ms; set to 0 to skip the wait (tests typically pass 0).
   */
  cellWaitMs?: number;
  /**
   * World coordinate where the structure should be placed. For non-cityhall
   * deeds (the 0-SUI path), the orchestrator skips the client-side
   * placement-preview UI and sends `placeStructure <deedOid> <x> <z> <rot>`
   * directly via the command queue. Defaults to `ctx.position()`.
   *
   * Wire reference:
   * `~/code/swg-main/src/engine/server/library/serverGame/src/shared/command/CommandCppFuncs.cpp:5302`
   * (`commandFuncPlaceStructure` — parses `<deedOid> <x> <z> <rot>` and
   * triggers `TRIG_PLACE_STRUCTURE` → `OnPlaceStructure` in
   * `player_building.java:106`).
   */
  placementPosition?: { x: number; z: number };
  /** Rotation in degrees (server expects 0/90/180/270). Default 0. */
  placementRotation?: number;
}

export interface PlaceDeedResult {
  /** The spawned deed's NetworkId (consumed if placement succeeded). */
  deedOid: NetworkId;
  /**
   * NetworkId of the newly-placed structure (the building), or null if
   * placement failed or we didn't observe a matching SceneCreateObjectByName
   * within the settle window.
   */
  structureOid: NetworkId | null;
  /**
   * Template name of the placed structure (e.g. `object/building/naboo/cityhall_naboo.iff`),
   * or null if `structureOid` is null.
   */
  structureTemplate: string | null;
  /** True if we observed an "no_room"/"obscene"/"cannot_use" chat — placement rejected. */
  rejected: boolean;
  /** Number of SUI dialogs we actually saw. */
  suiSeen: number;
  /** Any chat error messages observed. */
  chatErrors: string[];
}

/**
 * Strip the `_deed` suffix from a deed template's basename, returning the
 * stripped basename without extension. For example:
 *
 *   `object/tangible/deed/city_deed/cityhall_naboo_deed.iff` → `cityhall_naboo`
 *   `object/tangible/deed/player_house_deed/naboo_house_small_deed.iff` → `naboo_house_small`
 *   `object/tangible/deed/guild_deed/naboo_guild_deed.iff` → `naboo_guild`
 *
 * Returns null if the template doesn't end with `_deed.iff`.
 *
 * This is a pure helper so it's testable without a wire context.
 */
export function inferStructureBasename(deedTemplate: string): string | null {
  // Pull the filename portion (everything after the last `/`).
  const slash = deedTemplate.lastIndexOf('/');
  const filename = slash < 0 ? deedTemplate : deedTemplate.slice(slash + 1);
  // Must end with `_deed.iff` (case-insensitive).
  const m = filename.match(/^(.+)_deed\.iff$/i);
  if (m === null || m[1] === undefined) return null;
  return m[1];
}

/**
 * Test whether an observed `SceneCreateObjectByName.templateName` corresponds
 * to the structure produced by a deed with the given basename.
 *
 * The mapping is heuristic — most deed→structure templates land under
 * `object/building/...`, `object/installation/...`, or `object/tangible/...`
 * with a path whose basename matches the deed's stripped basename. We accept
 * any of these prefixes and require an exact filename match (sans `.iff`).
 *
 * Pure helper, testable in isolation.
 */
export function matchesStructureTemplate(observedTemplate: string, deedBasename: string): boolean {
  if (deedBasename === '') return false;
  // The observed template must NOT itself be a deed — that's the placeholder
  // we're trying to skip.
  if (/_deed\.iff$/i.test(observedTemplate)) return false;
  // Must start with one of the structure-bearing path prefixes.
  if (!/^object\/(building|installation|tangible)\//i.test(observedTemplate)) return false;
  // Filename basename must match.
  const slash = observedTemplate.lastIndexOf('/');
  const filename = slash < 0 ? observedTemplate : observedTemplate.slice(slash + 1);
  const m = filename.match(/^(.+)\.iff$/i);
  if (m === null || m[1] === undefined) return false;
  return m[1].toLowerCase() === deedBasename.toLowerCase();
}

/**
 * Classify a deed template into one of the `StructureRecord.kind` buckets
 * based on its path/filename. Pure helper — used by scenarios to populate
 * `StructureRecord.kind` consistently.
 *
 * Heuristics (in priority order):
 *   - `garden_*`                       → 'garden'
 *   - `cityhall_*`                     → 'cityhall'
 *   - `*_guild`/`guildhall`/`guild_*`  → 'guildhall'
 *   - `bank|cantina|hospital|cloning|shuttleport|garage|theater` → 'civic'
 *   - everything else under `player_house_deed/` or matching `naboo_house_*`,
 *     `tatooine_house_*`, `corellia_house_*`, etc. → 'house'
 *
 * Defaults to 'house' when nothing matches — caller can override via
 * `subKind` if it's actually something else.
 */
export function classifyDeedKind(deedTemplate: string): StructureRecord['kind'] {
  const lower = deedTemplate.toLowerCase();
  const basename = inferStructureBasename(deedTemplate) ?? '';
  const lowerBase = basename.toLowerCase();

  // Gardens are technically "house-like" reclaim-able structures but tracked
  // separately for decoration accounting.
  if (lowerBase.startsWith('garden_') || /\/garden_/.test(lower)) return 'garden';
  if (lowerBase.startsWith('cityhall')) return 'cityhall';
  if (/\/guild_deed\//.test(lower) || lowerBase.includes('guild')) return 'guildhall';
  if (/^(bank|cantina|hospital|cloning|shuttleport|garage|theater)_/.test(lowerBase)) return 'civic';
  return 'house';
}

/**
 * Place a structure deed via the real-client wire flow (radial USE → SUI dialogs).
 *
 * `position` is unused at the wire layer — the server places the structure at
 * the player's current location. CALLER must walk the player to the placement
 * spot BEFORE calling this function.
 *
 * The cityhall path takes 2 SUI roundtrips (confirm + cityName). Non-reclaim
 * non-cityhall takes 1 (confirm). Reclaim-able deeds (most houses) take 0.
 * We auto-detect by listening for SUI messages within a short window.
 */
export async function placeDeed(
  ctx: ScriptContext,
  sharedTemplate: string,
  opts: PlaceDeedOptions = {},
): Promise<PlaceDeedResult> {
  const suiTimeoutMs = opts.suiTimeoutMs ?? 8000;
  // Bumped from 5s → 10s so the BUIO baseline for the just-placed building
  // reliably lands in the WorldModel under parallel-Fleet load. With the
  // template-name heuristic broken for player-house deeds (basename
  // mismatch between `naboo_house_small_deed` and
  // `shared_player_house_naboo_small`), the fallback proximity scan needs
  // the BUIO present to return a non-null structureOid.
  const settleMs = opts.settleMs ?? 10_000;
  const cityName = opts.cityName ?? 'NewCity';
  const isCityhall = sharedTemplate.includes('cityhall');
  const expectedSui = opts.expectedSuiCount ?? (isCityhall ? 2 : 0);

  // 1. Resolve inventory OID
  const inventoryOid = opts.inventoryOid ?? (await resolveInventoryOid(ctx));

  // 2. Spawn deed
  const deedOid = await adminSpawnInto(ctx, sharedTemplate, inventoryOid);

  // 3. Collect chat errors throughout placement.
  // Decode the `outOfBand` field's packed-bytes-in-UTF16 encoding so STF
  // tokens like `player_structure:must_be_in_building` surface as plain
  // ASCII rather than the Unicode::String mojibake the wire format
  // produces.
  const decodeOob = (oob: string): string => {
    let s = '';
    for (let i = 0; i < oob.length; i++) {
      const cu = oob.charCodeAt(i);
      const lo = cu & 0xff;
      const hi = (cu >> 8) & 0xff;
      for (const b of [lo, hi]) {
        if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
      }
    }
    return s;
  };
  const chatErrors: string[] = [];
  const unsubChat = ctx.dispatcher.onMessage(ChatSystemMessage, (m) => {
    const text = m.message + ' | OOB:' + decodeOob(m.outOfBand);
    if (
      /obscene|cannot_use|no_room|not_unique|already_mayor|max_cities|too_close|no_rights|not_permitted|player_structure|structure_failed|structure_too|invalid|cannot_place|cant_be_/i.test(
        text,
      )
    ) {
      chatErrors.push(text.slice(0, 200).trim());
    }
  });

  // 3b. Listen for SceneCreateObjectByName — the server emits this whenever a
  //     new object is constructed in the player's view. Once placement
  //     succeeds, the new structure arrives with `templateName` matching the
  //     deed's stripped basename (cityhall_naboo_deed → cityhall_naboo).
  //     We register this BEFORE sending ITEM_USE so we don't miss a fast reply,
  //     and we filter by matching template so the deed's own spawn-event (which
  //     also came through as a SceneCreateObjectByName) doesn't false-match.
  const deedBasename = inferStructureBasename(sharedTemplate);
  const structureCandidates: { oid: NetworkId; template: string }[] = [];
  const unsubScene = ctx.dispatcher.onMessage(SceneCreateObjectByName, (m) => {
    if (deedBasename === null) return;
    // Skip the deed's own scene-create event (its template ends in `_deed.iff`).
    if (!matchesStructureTemplate(m.templateName, deedBasename)) return;
    // Skip duplicates (same oid arrives multiple times if multiple players see it).
    if (structureCandidates.some((c) => c.oid === m.networkId)) return;
    structureCandidates.push({ oid: m.networkId, template: m.templateName });
  });

  let suiSeen = 0;
  try {
    // 4. Send the placement command.
    //    Modernized to use `ctx.waitForSui` + `ctx.respondToSui` instead of
    //    the raw `dispatcher.waitFor(SuiCreatePageMessage)` + `dispatcher.send(SuiEventNotification)`
    //    primitives — same wire bytes, less plumbing.
    if (expectedSui === 0) {
      // No SUI expected — bypass the client-side placement-preview UI and
      // send the placeStructure command directly. The server-side
      // commandFuncPlaceStructure (CommandCppFuncs.cpp:5302) parses
      // "<deedOid> <x> <z> <rot>" and fires the OnPlaceStructure trigger
      // (player_building.java:106) which validates and creates the BUIO.
      // ObjectMenuSelectMessage(deedOid, ITEM_USE) alone only opens placement
      // mode client-side — without the client clicking-to-place, no
      // placeStructure command ever reaches the server and the deed
      // silently never places. We saw this firsthand in the prior MVP runs
      // (0/4 residents placed, no chat error, totalBuios stayed constant).
      const here = opts.placementPosition ?? ctx.position();
      const rotDegrees = opts.placementRotation ?? 0;
      // Server expects RotationType enum 0/1/2/3 (0/90/180/270 degrees),
      // NOT raw degrees. ScriptMethodsTerrain.cpp:441 rejects anything > 3
      // with -9998 → "internal script error: OnPlaceStructure". Convert
      // any degree value (0, 90, 180, 270, also negative or > 360) into
      // 0..3.
      const rotQuad = ((((Math.round(rotDegrees / 90) % 4) + 4) % 4) | 0);
      ctx.useAbility(
        'placeStructure',
        undefined,
        `${deedOid.toString()} ${here.x.toFixed(2)} ${here.z.toFixed(2)} ${rotQuad}`,
      );
    } else {
      const sui1P = ctx.waitForSui({ timeoutMs: suiTimeoutMs }).catch(() => null);
      ctx.send(new ObjectMenuSelectMessage(deedOid, RadialMenuTypes.ITEM_USE));
      const sui1 = await sui1P;
      if (sui1 !== null) {
        suiSeen++;
        const pageId1 = suiPageId(sui1);

        // 5. Respond to SUI 1 (confirm YES) — empty returnList means default OK button
        if (expectedSui >= 2) {
          // Cityhall: respond YES, then expect SUI 2 (inputbox for name)
          const sui2P = ctx.waitForSui({ timeoutMs: suiTimeoutMs }).catch(() => null);
          ctx.respondToSui(pageId1, 0);
          const sui2 = await sui2P;
          if (sui2 !== null) {
            suiSeen++;
            const pageId2 = suiPageId(sui2);
            // Inputbox response: returnList is positional values mapped to
            // subscribed widget properties. SWG's `sui.inputbox` subscribes
            // to TWO properties (sui.java:790-791): txtInput.LocalText AND
            // cmbOptions.SelectedText. We must send 2 entries so the
            // server's positional mapping puts our cityName in slot 0
            // (txtInput.LocalText), where `getInputBoxText` reads it. Send
            // empty string for the unused combo slot.
            ctx.respondToSui(pageId2, 0, [cityName, '']);
          }
        } else {
          // Single confirm SUI — just YES
          ctx.respondToSui(pageId1, 0);
        }
      }
    }

    // 6. Settle while server processes placement
    await ctx.wait(settleMs);
  } finally {
    unsubChat();
    unsubScene();
  }

  // 7. Pick the first matching structure (server emits in placement order).
  // If the template-name heuristic missed (common for player-house deeds
  // where the deed basename `naboo_house_small` doesn't match the structure
  // basename `shared_player_house_naboo_small`), fall back to a WorldModel
  // proximity scan: after settle, the new BUIO is in `ctx.world` and lies
  // within a few metres of the player's current position. Pick the nearest
  // BUIO within 20m as the placed structure.
  let firstStructure: { oid: NetworkId; template: string } | undefined =
    structureCandidates[0];
  if (firstStructure === undefined) {
    const here = ctx.position();
    let bestDist = Number.POSITIVE_INFINITY;
    let bestObj:
      | { id: NetworkId; templateName?: string; position: { x: number; z: number } }
      | undefined;
    for (const o of ctx.world.nearby(20, here)) {
      if (o.typeId !== ObjectTypeTags.BUIO) continue;
      // Skip the deed itself (defensive — deeds are TANO not BUIO, but in
      // case the server tags one BUIO for some reason).
      if (o.id === deedOid) continue;
      const dx = o.position.x - here.x;
      const dz = o.position.z - here.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist) {
        bestDist = d2;
        bestObj = o;
      }
    }
    if (bestObj !== undefined) {
      firstStructure = { oid: bestObj.id, template: bestObj.templateName ?? '' };
    }
  }

  // 8. If we have a building, wait for at least one SCLT (cell) child to
  // appear in the WorldModel before returning. The cell baselines arrive
  // shortly after the BUIO; if the caller immediately calls navigate() to
  // step inside, navigate throws if no SCLT children are visible
  // ("building X has no cell matching '(first public)' — SCLT baselines
  // haven't arrived yet"). Pure observational — no extra sends. Default
  // 10s; tests pass `cellWaitMs: 0` to skip.
  const cellWaitMs = opts.cellWaitMs ?? 10_000;
  if (firstStructure !== undefined && cellWaitMs > 0) {
    const buildingId = firstStructure.oid;
    const cellDeadline = Date.now() + cellWaitMs;
    while (Date.now() < cellDeadline) {
      const hasCell = ctx.world
        .toArray()
        .some((o) => o.containerId === buildingId && o.typeId === ObjectTypeTags.SCLT);
      if (hasCell) break;
      await ctx.wait(200);
    }
  }
  return {
    deedOid,
    structureOid: firstStructure?.oid ?? null,
    structureTemplate: firstStructure?.template ?? null,
    rejected: chatErrors.length > 0,
    suiSeen,
    chatErrors,
  };
}

/**
 * Issue `declareresidence` for the building the player is currently inside.
 * Caller must have walked into the building's cell first.
 *
 * Returns true if the server registers the player as a citizen of a city
 * within `timeoutMs`, false otherwise. Detection is via the typed
 * `ctx.character.cityName` field (PLAY p6 `m_citizenshipCity`), which the
 * server populates from the same call path that `declareresidence` invokes:
 *
 *   useAbility('declareresidence')
 *     → player_building.java:2511 declareResidence
 *     → player_building.java:2583 city.setCityResidence(self, structure)
 *     → city.java:620 setCityResidence → addCitizen(citizen, newresidence)
 *     → server updates m_citizenshipCity on the player's PlayerObject
 *     → DeltasMessage on PLAY package SHARED_NP (decoded into ctx.character)
 *
 * Was previously a chat-regex match on `ChatSystemMessage`, which suffered
 * from both false positives (`already_residence` / `change_residence_time`
 * also matched `/resid/`) and false negatives (the STF token packed into
 * `outOfBand` doesn't always carry the literal substring). The typed
 * citizenship watch is server-authoritative and deterministic.
 */
export async function declareResidence(
  ctx: ScriptContext,
  opts: { timeoutMs?: number; pollMs?: number; debugLabel?: string } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 200;
  const before = ctx.character.cityName;
  const label = opts.debugLabel ?? 'declareResidence';

  // Temporary diagnostic: capture every ChatSystemMessage during the wait so
  // failed declareresidences surface the actual server-side reason
  // (`must_be_in_building`, `declare_must_be_owner`, `already_residence`,
  // etc.). Remove once MVP is reliably green.
  const captured: string[] = [];
  const unsubChat = ctx.dispatcher.onMessage(ChatSystemMessage, (m) => {
    const text = (m.message + ' ' + m.outOfBand).slice(0, 200).trim();
    if (text !== '') captured.push(text);
  });

  ctx.useAbility('declareresidence', undefined, '');

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const now = ctx.character.cityName;
      // Success: transitioned from "no citizenship" or "different city" to a
      // non-null city name. Filter out null-only transitions (e.g. city
      // destruction) so we only resolve on actual citizenship grants.
      if (now !== null && now !== before) {
        process.stderr.write(
          `[${label}] OK cityName ${before ?? 'null'} → ${now}\n`,
        );
        return true;
      }
      await ctx.wait(pollMs);
    }
    process.stderr.write(
      `[${label}] TIMEOUT after ${timeoutMs}ms; cityName stayed at ${before ?? 'null'}; ` +
        `chat=${JSON.stringify(captured.slice(0, 5))}\n`,
    );
    return false;
  } finally {
    unsubChat();
  }
}

/**
 * Convenience: walk to a slot's entry point and declare residence.
 *
 * When `buildingId` is supplied, uses `ctx.navigate({ buildingId, cellName: '' })`
 * to step inside the building's first public cell — this is the new, simpler
 * path that handles dismount + cell-entry automatically and lands the player
 * inside the cell so `declareresidence` resolves to the right building via
 * the server-side `getStructure(self)` script-trigger.
 *
 * When `buildingId` is `undefined`, falls back to the legacy outdoor-walk path
 * (`walkTo` to the slot's entry offset) — relies on the server's lenient
 * "near enough" resolution which works for small houses but has been known
 * to land the wrong building on dense slot layouts.
 */
export async function walkInAndDeclareResidence(
  ctx: ScriptContext,
  slot: { x: number; z: number; entryOffset?: { x: number; z: number } },
  opts: {
    settleMs?: number;
    declareTimeoutMs?: number;
    /** Building NetworkId from placeDeed's structureOid — enables the cell-aware navigate path. */
    buildingId?: NetworkId;
    /** Optional label for diagnostic stderr output. */
    debugLabel?: string;
  } = {},
): Promise<boolean> {
  const settleMs = opts.settleMs ?? 1500;
  const label = opts.debugLabel ?? 'walkInAndDeclareResidence';
  if (opts.buildingId !== undefined) {
    // navigate() handles: walk outdoors to building anchor → enter first
    // public cell. No need for an entry-offset heuristic — the cell-relative
    // walk lands us inside the cell, which is what declareresidence's
    // getStructure(self) expects.
    try {
      await ctx.navigate(
        { buildingId: opts.buildingId, cellName: '' },
        { useMount: 'never' },
      );
      process.stderr.write(`[${label}] navigated into cell of ${opts.buildingId.toString()}\n`);
    } catch (err) {
      // Fall through to the legacy walkTo on navigation failure — likely the
      // building's SCLT baselines didn't arrive in time. Same risk as the
      // legacy path but at least we tried the precise route.
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[${label}] navigate failed (${reason}); falling back to outdoor walkTo\n`,
      );
      const entry = slot.entryOffset ?? { x: 0, z: -5 };
      await ctx.walkTo({ x: slot.x + entry.x, z: slot.z + entry.z });
    }
  } else {
    const entry = slot.entryOffset ?? { x: 0, z: -5 };
    process.stderr.write(
      `[${label}] no buildingId — outdoor walkTo (${slot.x + entry.x}, ${slot.z + entry.z})\n`,
    );
    await ctx.walkTo({ x: slot.x + entry.x, z: slot.z + entry.z });
  }
  await ctx.wait(settleMs);
  return declareResidence(ctx, {
    timeoutMs: opts.declareTimeoutMs,
    debugLabel: label,
  });
}
