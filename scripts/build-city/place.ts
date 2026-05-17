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

import { extractInventoryContainerId } from '../../src/client/baseline-helpers.js';
import { ChatSystemMessage } from '../../src/messages/game/chat/index.js';
import { ObjectMenuSelectMessage, RadialMenuTypes } from '../../src/messages/game/object-menu-select-message.js';
import { SceneCreateObjectByName } from '../../src/messages/game/scene-create-object-by-name.js';
import { SuiCreatePageMessage, SuiEventNotification } from '../../src/messages/game/sui/index.js';
import type { ScriptContext } from '../../src/client/script/context.js';
import type { NetworkId } from '../../src/types.js';
import { adminGetInventoryId, adminSpawnInto } from './admin.js';
import type { StructureRecord } from './state.js';

/**
 * Resolve the player's inventory NetworkId for spawning deeds.
 * Tries admin lookup first (always works for admin chars), falls back to baselines.
 */
export async function resolveInventoryOid(ctx: ScriptContext): Promise<NetworkId> {
  try {
    const looked = await adminGetInventoryId(ctx, ctx.sceneStart.playerNetworkId);
    if (looked !== null) return looked;
  } catch {
    // fall through
  }
  const fromBaselines = extractInventoryContainerId(ctx.dispatcher.transcript);
  if (fromBaselines !== null) return fromBaselines;
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
  /** Post-placement settle delay. Default 5000ms. */
  settleMs?: number;
  /** Number of SUI dialogs to expect; auto-detected from template if unset. */
  expectedSuiCount?: number;
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
  const settleMs = opts.settleMs ?? 5000;
  const cityName = opts.cityName ?? 'NewCity';
  const isCityhall = sharedTemplate.includes('cityhall');
  const expectedSui = opts.expectedSuiCount ?? (isCityhall ? 2 : 0);

  // 1. Resolve inventory OID
  const inventoryOid = opts.inventoryOid ?? (await resolveInventoryOid(ctx));

  // 2. Spawn deed
  const deedOid = await adminSpawnInto(ctx, sharedTemplate, inventoryOid);

  // 3. Collect chat errors throughout placement
  const chatErrors: string[] = [];
  const unsubChat = ctx.dispatcher.onMessage(ChatSystemMessage, (m) => {
    const text = m.message + ' ' + m.outOfBand;
    if (/obscene|cannot_use|no_room|not_unique|already_mayor|max_cities|too_close|no_rights|not_permitted/i.test(text)) {
      chatErrors.push(text.slice(0, 120).trim());
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
    // 4. Send radial USE — server opens the first SUI (if any)
    if (expectedSui === 0) {
      // No SUI expected — deed will be placed via direct queueCommand path
      ctx.send(new ObjectMenuSelectMessage(deedOid, RadialMenuTypes.ITEM_USE));
    } else {
      const sui1P = ctx.dispatcher
        .waitFor(SuiCreatePageMessage, { timeoutMs: suiTimeoutMs })
        .catch(() => null);
      ctx.send(new ObjectMenuSelectMessage(deedOid, RadialMenuTypes.ITEM_USE));
      const sui1 = await sui1P;
      if (sui1 !== null) {
        suiSeen++;
        const pageId1 = suiPageId(sui1);

        // 5. Respond to SUI 1 (confirm YES) — empty returnList means default OK button
        if (expectedSui >= 2) {
          // Cityhall: respond YES, then expect SUI 2 (inputbox for name)
          const sui2P = ctx.dispatcher
            .waitFor(SuiCreatePageMessage, { timeoutMs: suiTimeoutMs })
            .catch(() => null);
          ctx.send(new SuiEventNotification(pageId1, 0, []));
          const sui2 = await sui2P;
          if (sui2 !== null) {
            suiSeen++;
            const pageId2 = suiPageId(sui2);
            // Inputbox response: returnList is positional values only — the server
            // maps them to subscribed widget properties (e.g. txtInput.LocalText) by
            // index. So just [`cityName`], NOT [`txtInput.LocalText=${cityName}`].
            ctx.send(new SuiEventNotification(pageId2, 0, [cityName]));
          }
        } else {
          // Single confirm SUI — just YES
          ctx.send(new SuiEventNotification(pageId1, 0, []));
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
  const firstStructure = structureCandidates[0];
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
 * Returns true if a confirming ChatSystemMessage arrives within `timeoutMs`
 * containing a residence-related token, false otherwise.
 */
export async function declareResidence(
  ctx: ScriptContext,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const confirmedP = ctx.dispatcher
    .waitFor(ChatSystemMessage, {
      timeoutMs,
      predicate: (m) => /resid|change_residence|new_home|primary/i.test(m.outOfBand + m.message),
    })
    .catch(() => null);

  ctx.useAbility('declareresidence', undefined, '');
  const result = await confirmedP;
  return result !== null;
}

/**
 * Convenience: walk to a slot's entry point and declare residence.
 */
export async function walkInAndDeclareResidence(
  ctx: ScriptContext,
  slot: { x: number; z: number; entryOffset?: { x: number; z: number } },
  opts: { settleMs?: number; declareTimeoutMs?: number } = {},
): Promise<boolean> {
  const entry = slot.entryOffset ?? { x: 0, z: -5 };
  const settleMs = opts.settleMs ?? 1500;
  await ctx.walkTo({ x: slot.x + entry.x, z: slot.z + entry.z }, { speed: 4 });
  await ctx.wait(settleMs);
  return declareResidence(ctx, { timeoutMs: opts.declareTimeoutMs });
}
