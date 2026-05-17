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
import { SuiCreatePageMessage, SuiEventNotification } from '../../src/messages/game/sui/index.js';
import type { ScriptContext } from '../../src/client/script/context.js';
import type { NetworkId } from '../../src/types.js';
import { adminGetInventoryId, adminSpawnInto } from './admin.js';

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
 * Read the LE i32 pageId from a `SuiCreatePageMessage.pageData` (first 4 bytes).
 */
function suiPageId(msg: SuiCreatePageMessage): number {
  const d = msg.pageData;
  if (d.length < 4) throw new Error(`SuiCreatePageMessage.pageData too short (${d.length} bytes)`);
  return (d[0]! | (d[1]! << 8) | (d[2]! << 16) | (d[3]! << 24)) | 0;
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
  /** True if we observed an "no_room"/"obscene"/"cannot_use" chat — placement rejected. */
  rejected: boolean;
  /** Number of SUI dialogs we actually saw. */
  suiSeen: number;
  /** Any chat error messages observed. */
  chatErrors: string[];
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
  const unsub = ctx.dispatcher.onMessage(ChatSystemMessage, (m) => {
    const text = m.message + ' ' + m.outOfBand;
    if (/obscene|cannot_use|no_room|not_unique|already_mayor|max_cities|too_close|no_rights|not_permitted/i.test(text)) {
      chatErrors.push(text.slice(0, 120).trim());
    }
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
    unsub();
  }

  return {
    deedOid,
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
