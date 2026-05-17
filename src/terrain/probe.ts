/**
 * Empirical buildability probe.
 *
 * "Is this (x, z) coordinate flat / dry / un-claimed enough for a player
 * structure?" The most reliable way to answer that question, short of
 * porting the entire C++ TerrainGenerator + LotManager + collision system,
 * is to ask the live server: spawn a small-house deed, teleport to the
 * candidate coord, send the radial USE on the deed, and watch the inbound
 * chat stream for the rejection tokens the server emits when placement
 * fails.
 *
 * Why this works:
 *   - `ServerWorld::getGoodLocation` (ServerWorld.cpp:3024) checks
 *     `terrainObject->getWater()`, `terrainObject->getSlope()`, and
 *     `lotManager->canPlace()` — exactly the constraints we care about for
 *     a residence.
 *   - The deed script calls `placeStructure` which on failure emits a chat
 *     `ProsePackage` system message containing one of a known set of
 *     tokens: `no_room`, `not_permitted`, `too_close`, `obscene`,
 *     `cannot_use`, etc.
 *   - The probe consumes a deed per attempt — that's by design; cleanup is
 *     handled by destroying any deed still in inventory at the end.
 *
 * Throughput envelope:
 *   - ~1 probe / 5 s (RTT + server settle). To search ~30 candidates in a
 *     150m radius, expect ~2.5 minutes; parallelizing across N admin
 *     accounts cuts roughly linearly (the server allows one session per
 *     account so the parallelization happens at the orchestrator layer
 *     above this function — see `find-flat-patch.ts`).
 *
 * NOT a substitute for tuning by hand on a real test bed — this is a
 * pre-filter that gets you 90% of the way; the user still walks the final
 * site and visually checks before committing the city hall.
 *
 * Implementation note: this module deliberately re-implements the
 * minimum admin-console wire helpers (spawn / teleport / destroy) inline
 * rather than depending on the build-city `scripts/` siblings, because
 * `src/` is the published surface and `scripts/` are application code
 * that ride on top of it.
 */

import type { ScriptContext } from '../client/script/context.js';
import { decodeSampleOob } from '../client/script/context.js';
import { ChatSystemMessage } from '../messages/game/chat/index.js';
import { ConGenericMessage } from '../messages/game/con-generic-message.js';
import {
  ObjectMenuSelectMessage,
  RadialMenuTypes,
} from '../messages/game/object-menu-select-message.js';
import type { NetworkId } from '../types.js';

/**
 * Default "small footprint" deed used by the probe. `generic_house_small`
 * has a footprint comparable to most residential houses (~15 m × 15 m
 * including clearance) — placement that passes here will pass for most
 * other small houses too. Override via `options.houseTemplate` if you need
 * to probe for a larger / smaller footprint.
 *
 * The path is the SHARED template (sys.shared); the server's `object
 * createIn` console command expects that variant.
 */
export const DEFAULT_PROBE_DEED =
  'object/tangible/deed/player_house_deed/shared_generic_house_small_deed.iff';

/** Result of a single buildability probe. */
export interface BuildableProbeResult {
  /** True if the deed reached "structure placed" without a rejection chat. */
  buildable: boolean;
  /**
   * Concatenated decoded chat OOB tokens seen during the probe window. Empty
   * when buildable=true. Contains substrings like `no_room` / `not_permitted`
   * / `too_close` when buildable=false — useful for diagnosing WHY a spot
   * was rejected.
   */
  chatOob: string;
}

/** Tunable knobs for `probeBuildable`. */
export interface ProbeOptions {
  /** Shared deed template to spawn for the probe. Default = small house. */
  houseTemplate?: string;
  /**
   * How long to wait after sending ITEM_USE for the rejection chat (or
   * silence-meaning-success) to settle. Default 4500 ms — empirically the
   * server emits the rejection within ~2 s but cluster jitter occasionally
   * stretches it. Lower this for impatient sweeps; raise it for laggy servers.
   */
  settleMs?: number;
  /**
   * If true, leave the spawned deed in inventory on success (lets the
   * caller actually keep the structure if the probe succeeded). Default
   * `false` — the probe is destructive: we destroy the deed after the
   * settle window regardless of outcome so successive probes don't pile up.
   */
  keepDeedOnSuccess?: boolean;
  /**
   * If true, teleport the player to (x, z) via `planetwarp` before USE.
   * Default `true`. Set to false when the caller manages teleports
   * externally (e.g. batching probes inside an already-warped session).
   */
  teleportToCoord?: boolean;
  /**
   * Per-admin-console-command timeout. Default 5000 ms. Bump this if your
   * cluster is sluggish; lower for tight sweeps.
   */
  consoleTimeoutMs?: number;
}

/**
 * Regex matching the structure-placement error tokens emitted by the server.
 *
 * Sourced from `dsrc/.../script/.../structure/place_structure.script` and
 * `dsrc/.../structure_management/buildings.tab`. Kept deliberately broad
 * — false-positives just mean a spot is *reported* as unbuildable when it
 * isn't, which biases toward conservative city planning (preferred).
 */
const PLACEMENT_REJECTION_RE =
  /no_room|not_permitted|too_close|obscene|cannot_use|not_unique|no_rights|max_lots|invalid_location|not_inside|not_in_city|terrain|water|underwater|slope/i;

/**
 * Probe whether `(x, z)` is buildable for a small player structure.
 *
 * Side effects:
 *   - Spawns a deed in the player's inventory via `object createIn`.
 *   - Optionally teleports the player to `(x, z)` via `planetwarp`
 *     (planet inferred from `ctx.sceneStart.sceneName`).
 *   - Sends a radial-menu USE on the deed.
 *   - Destroys the spawned deed at the end (unless `keepDeedOnSuccess` is
 *     set and the probe succeeded).
 *
 * Returns synchronously after `settleMs` regardless of outcome — does NOT
 * block on a positive acknowledgement (there isn't one; the server just
 * doesn't emit a rejection chat).
 *
 * @param ctx ScriptContext from a zoned-in lifecycle (must be admin-level).
 * @param inventoryOid Caller's inventory NetworkId — resolve once (e.g. via
 *   `resolveInventoryOid` from `scripts/build-city/place.ts`) and reuse
 *   across many probes.
 * @param x World X in meters.
 * @param z World Z in meters.
 */
export async function probeBuildable(
  ctx: ScriptContext,
  inventoryOid: NetworkId,
  x: number,
  z: number,
  options: ProbeOptions = {},
): Promise<BuildableProbeResult> {
  const houseTemplate = options.houseTemplate ?? DEFAULT_PROBE_DEED;
  const settleMs = options.settleMs ?? 4500;
  const keepDeedOnSuccess = options.keepDeedOnSuccess ?? false;
  const teleportToCoord = options.teleportToCoord ?? true;
  const consoleTimeoutMs = options.consoleTimeoutMs ?? 5000;

  // Collect all chat OOB during the probe window.
  const chatTokens: string[] = [];
  const unsub = ctx.dispatcher.onMessage(ChatSystemMessage, (m) => {
    if (m.message.length > 0) chatTokens.push(m.message);
    if (m.outOfBand.length > 0) chatTokens.push(decodeSampleOob(m.outOfBand));
  });

  let deedOid: NetworkId | null = null;
  let buildable = false;
  let chatOob = '';

  try {
    // Step 1: spawn deed into inventory.
    deedOid = await spawnIntoInventory(ctx, houseTemplate, inventoryOid, consoleTimeoutMs);

    // Step 2: teleport to candidate coord on the player's current planet.
    if (teleportToCoord) {
      const planet = ctx.sceneStart.sceneName;
      if (planet.length > 0) {
        await planetWarp(ctx, planet, x, ctx.position().y, z);
        // Allow the warp to settle before USE — the structure-placement
        // path reads the player's *current* server-side position, so a
        // racing USE would aim at the pre-warp coord.
        await ctx.wait(750);
      }
    }

    // Step 3: USE the deed → server places structure or emits rejection.
    ctx.send(new ObjectMenuSelectMessage(deedOid, RadialMenuTypes.ITEM_USE));

    // Step 4: settle, then classify result by scanning collected chat.
    await ctx.wait(settleMs);

    chatOob = chatTokens.join(' | ');
    buildable = !PLACEMENT_REJECTION_RE.test(chatOob);
  } finally {
    unsub();

    // Cleanup: destroy the deed unless the caller asked us to keep it on
    // success. The server's `object destroy` is forgiving — no-op on an
    // already-consumed deed, so this is safe regardless of outcome.
    if (deedOid !== null && (!buildable || !keepDeedOnSuccess)) {
      try {
        await runAdminConsole(
          ctx,
          `object destroy ${deedOid.toString()}`,
          Math.min(consoleTimeoutMs, 3000),
        );
      } catch {
        // Ignore — leaked deeds are recoverable via the admin GM tools.
      }
    }
  }

  return { buildable, chatOob };
}

// ─────────────────────────────────────────────────────────────────────────
// Inline admin-console helpers
//
// Deliberately self-contained — see file header for the rationale. These
// mirror (and intentionally do NOT import) `scripts/build-city/admin.ts`;
// keep the two in sync if the wire shape changes.
// ─────────────────────────────────────────────────────────────────────────

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
 * Send a raw ConGenericMessage and await the matching reply. Mirrors
 * `adminConsole` in scripts/build-city/admin.ts but is local here so the
 * probe module has no upstream sibling deps.
 */
async function runAdminConsole(
  ctx: ScriptContext,
  command: string,
  timeoutMs: number,
): Promise<string> {
  const msgId = nextMsgId(ctx);
  const replyP = ctx.dispatcher.waitFor(ConGenericMessage, {
    timeoutMs,
    predicate: (m) => m.msgId === msgId,
  });
  ctx.send(new ConGenericMessage(command, msgId));
  const reply = await replyP;
  return reply.msg;
}

/** Spawn an object via `object createIn` and parse the returned NetworkId. */
async function spawnIntoInventory(
  ctx: ScriptContext,
  sharedTemplate: string,
  containerOid: NetworkId,
  timeoutMs: number,
): Promise<NetworkId> {
  const reply = await runAdminConsole(
    ctx,
    `object createIn ${sharedTemplate} ${containerOid.toString()}`,
    timeoutMs,
  );
  const match = reply.match(/NetworkId:\s*(-?\d+)/);
  if (match === null || match[1] === undefined) {
    throw new Error(
      `spawnIntoInventory: reply did not contain "NetworkId: <n>" (template=${sharedTemplate}, reply=${reply.slice(0, 200)})`,
    );
  }
  return BigInt(match[1]);
}

/**
 * Fire `useAbility('planetwarp', ...)`. Same wire path the build-city scripts
 * use, inlined here. Returns when the wait timer fires — we don't get a
 * server ack for planetwarp; the cursor update is the only feedback.
 */
async function planetWarp(
  ctx: ScriptContext,
  planet: string,
  x: number,
  y: number,
  z: number,
): Promise<void> {
  ctx.useAbility('planetwarp', undefined, `${planet} ${x} ${y} ${z}`);
  // Keep the in-context cursor in sync — movement primitives use this as
  // their starting point and would otherwise try to walk back from the old
  // location.
  ctx.setPose({ x, y, z }, ctx.yaw());
}
