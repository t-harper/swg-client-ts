/**
 * Runtime provisioning for LIVE combat tests.
 *
 * `provisionFullCombatCharacter(ctx, profession)` takes a fresh zoned-in
 * character and brings it up to a real combat-ready state:
 *
 *   1. `setGodMode 1` (admin privileges)
 *   2. Grant the profession's full skill chain (24 skills) via `skill grantSkill`
 *   3. Send ONE `ExpertiseRequestMessage` with every expertise leaf
 *   4. Level up to 90 via repeated `skill grantExperience combat_general`
 *   5. `script triggerAll OnInitialize` to refresh skill mods
 *   6. Grant tier-2/3 commands directly via `skill grantCommand`
 *   7. Spawn weapon into inventory + equip via `transferItemMisc`
 *   8. Spawn 9 composite armor pieces + equip each
 *   9. `setGodMode 0` (CRITICAL — makes "alive at end" meaningful)
 *
 * Each step swallows errors and continues; the returned `ProvisioningReport`
 * carries which steps succeeded for the LIVE test to log.
 */

import { adminConsole, adminGodModeOff, adminGodModeOn } from '../../scripts/build-city/admin.js';
import { ByteStream } from '../../src/archive/byte-stream.js';
import type { NetworkId, ProfessionId, ScriptContext } from '../../src/index.js';
import { CLIENT_TO_AUTH_SERVER_FLAGS } from '../../src/messages/game/command-queue/index.js';
import { ConGenericMessage } from '../../src/messages/game/con-generic-message.js';
import { ExpertiseRequestMessage } from '../../src/messages/game/expertise-request.js';
import { ObjControllerMessage } from '../../src/messages/game/obj-controller-message.js';
import { ObjControllerSubtypeIds } from '../../src/messages/game/obj-controller/index.js';
import { _encodeObjectMenu } from '../../src/messages/game/obj-controller/object-menu-request.js';
import {
  ObjectMenuSelectMessage,
  RadialMenuTypes,
} from '../../src/messages/game/object-menu-select-message.js';
import { SuiEventNotification } from '../../src/messages/game/sui/sui-event-notification.js';
import {
  PROVISIONING_SPECS,
  type ProfessionProvisioningSpec,
} from './live-combat-provisioning-specs.js';

const LEVEL_TARGET = 90;
const XP_CHUNK = 500_000;
const MAX_XP_ROUNDS = 40;

/**
 * The grantExperience + ExpertiseRequest chain triggers a flood of level-up
 * scripts server-side (grants, baseline updates, skill-mod recomputes). The
 * ConGenericMessage reply queue lags during this — bump per-call timeout
 * for the post-level-up commands to give the server room.
 */
const POST_LEVELUP_TIMEOUT_MS = 20_000;
const POST_LEVELUP_SETTLE_MS = 5_000;

/**
 * Per-context monotonic msgId for fire-and-forget ConGenericMessage sends.
 * Distinct from the buff-bot/admin.ts counter — fire-and-forget doesn't
 * collide with adminConsole's awaited replies since we never set up a
 * matching predicate. We just need a non-zero id for ordering.
 */
const fnfMsgIdCounter = new WeakMap<object, { next: number }>();
function nextFnfMsgId(ctx: ScriptContext): number {
  let entry = fnfMsgIdCounter.get(ctx.dispatcher);
  if (entry === undefined) {
    entry = { next: 10_000 };
    fnfMsgIdCounter.set(ctx.dispatcher, entry);
  }
  return entry.next++;
}

/**
 * Send an admin console command WITHOUT waiting for the reply. Used for
 * grantCommand / triggerOnInitialize / etc. where we don't need the reply
 * text and where awaiting it stalls on the post-level-up reply-pipeline
 * backlog. Returns immediately.
 */
function fireAdminCommand(ctx: ScriptContext, command: string): void {
  ctx.send(new ConGenericMessage(command, nextFnfMsgId(ctx)));
}

export interface ProvisioningReport {
  profession: ProfessionId;
  godModeOnOk: boolean;
  skillsGranted: number;
  skillsAttempted: number;
  expertiseSent: boolean;
  finalLevel: number;
  upgradeCommandsGranted: number;
  weaponSpawnedId: NetworkId | null;
  weaponEquipped: boolean;
  armorSpawnedCount: number;
  armorEquippedCount: number;
  /** Jedi-only: crystals tuned + inserted into the saber (target: 5 = 1 color + 4 pearls). */
  saberCrystalsInstalled: number;
  godModeOffOk: boolean;
  elapsedMs: number;
  /** Any non-fatal errors encountered along the way (one per failed step). */
  warnings: string[];
}

export interface ProvisionOptions {
  /**
   * When true (default), turn god mode OFF at the end so the bot is killable.
   * Set false only for debugging the provisioning path itself.
   */
  disableGodModeAtEnd?: boolean;
  /**
   * Logger override. Default: `console.warn` with `[provision:<prof>]` prefix.
   */
  logFn?: (msg: string) => void;
}

export async function provisionFullCombatCharacter(
  ctx: ScriptContext,
  profession: ProfessionId,
  opts: ProvisionOptions = {},
): Promise<ProvisioningReport> {
  const spec: ProfessionProvisioningSpec | undefined = PROVISIONING_SPECS[profession];
  if (spec === undefined) {
    throw new Error(`no provisioning spec for profession '${profession}'`);
  }
  const log =
    opts.logFn ?? ((msg: string): void => console.warn(`[provision:${profession}] ${msg}`));
  const disableGodModeAtEnd = opts.disableGodModeAtEnd ?? true;
  const startMs = Date.now();
  const warnings: string[] = [];
  const playerOid = ctx.sceneStart.playerNetworkId;
  const playerOidStr = playerOid.toString();

  const report: ProvisioningReport = {
    profession,
    godModeOnOk: false,
    skillsGranted: 0,
    skillsAttempted: spec.skillChain.length,
    expertiseSent: false,
    finalLevel: ctx.character.level,
    upgradeCommandsGranted: 0,
    weaponSpawnedId: null,
    weaponEquipped: false,
    armorSpawnedCount: 0,
    armorEquippedCount: 0,
    saberCrystalsInstalled: 0,
    godModeOffOk: false,
    elapsedMs: 0,
    warnings,
  };

  // ── 0. Dismiss the New Player Experience SUI window ─────────────────────
  // A freshly-created character zones in with an NPE intro SUI page open.
  // While that page is up the server gates several actions — notably
  // equipping items — so the saber/armor transfers silently no-op until
  // it's closed. Dismiss every open SUI page before doing anything else.
  const dismissed0 = await dismissOpenSuiPages(ctx, log);
  if (dismissed0.length > 0) log(`startup SUI dismiss: [${dismissed0.join('; ')}]`);
  await ctx.wait(800);

  // ── 1. God mode ─────────────────────────────────────────────────────────
  try {
    await adminGodModeOn(ctx);
    report.godModeOnOk = true;
    log('god mode ON');
  } catch (err) {
    warnings.push(`godModeOn: ${err instanceof Error ? err.message : String(err)}`);
    return finalize(report, startMs);
  }
  await ctx.wait(500);

  // ── 2. Skill chain ──────────────────────────────────────────────────────
  log(`granting ${spec.skillChain.length} skills`);
  for (const skill of spec.skillChain) {
    try {
      const reply = await adminConsole(ctx, `skill grantSkill ${skill}`);
      if (/error|fail|cannot|invalid|unknown|not found/i.test(reply)) {
        warnings.push(`grantSkill ${skill}: ${reply.trim().slice(0, 80)}`);
      } else {
        report.skillsGranted++;
      }
    } catch (err) {
      warnings.push(`grantSkill ${skill}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`granted ${report.skillsGranted}/${spec.skillChain.length} skills`);

  // ── 3. Expertise (one ExpertiseRequestMessage) ──────────────────────────
  try {
    ctx.send(new ExpertiseRequestMessage(spec.expertise, true));
    report.expertiseSent = true;
    log(`sent ExpertiseRequest (${spec.expertise.length} leaves)`);
  } catch (err) {
    warnings.push(`expertiseSend: ${err instanceof Error ? err.message : String(err)}`);
  }
  await ctx.wait(1_000);

  // ── 4. Level up to 90 ───────────────────────────────────────────────────
  for (let round = 0; round < MAX_XP_ROUNDS; round++) {
    if (ctx.character.level >= LEVEL_TARGET) break;
    try {
      await adminConsole(ctx, `skill grantExperience ${playerOidStr} combat_general ${XP_CHUNK}`);
    } catch (err) {
      warnings.push(
        `grantExperience round ${round}: ${err instanceof Error ? err.message : String(err)}`,
      );
      break;
    }
    await ctx.wait(750);
  }
  report.finalLevel = ctx.character.level;
  log(`level=${report.finalLevel} (target ${LEVEL_TARGET})`);

  // Let the post-level-up script flood drain before issuing more console
  // commands — the server's ConGenericMessage REPLY pipeline backs up
  // during the level-up trigger storm. Empirically, awaited adminConsole
  // calls after the XP grind time out indefinitely even at 20s windows.
  // The commands themselves still process server-side, so for grants /
  // triggers (where we don't need the reply text), we switch to
  // fire-and-forget after this point.
  log(`settling ${POST_LEVELUP_SETTLE_MS}ms for level-up triggers to drain`);
  await ctx.wait(POST_LEVELUP_SETTLE_MS);

  // Level-up + OnInitialize scripts can re-init the Client object and
  // silently drop the god-mode flag. Re-assert it before issuing any more
  // admin console commands or the server will reject them without reply.
  try {
    await adminGodModeOn(ctx);
    log('re-asserted god mode after XP grind');
  } catch (err) {
    warnings.push(`godModeReassert: ${err instanceof Error ? err.message : String(err)}`);
  }
  await ctx.wait(500);

  // ── 5. Refresh skill mods (fire-and-forget) ─────────────────────────────
  fireAdminCommand(ctx, `script triggerAll OnInitialize ${playerOidStr}`);
  log('fired triggerAll OnInitialize (no reply awaited)');
  await ctx.wait(2_000);

  // ── 6. Grant tier-2/3 commands directly (fire-and-forget) ──────────────
  log(`firing ${spec.upgradeCommands.length} upgrade-command grants`);
  for (const cmd of spec.upgradeCommands) {
    fireAdminCommand(ctx, `skill grantCommand ${cmd} ${playerOidStr}`);
    report.upgradeCommandsGranted++;
    // Brief spacing so commands process in order without queuing storm.
    await ctx.wait(100);
  }
  log(`fired ${report.upgradeCommandsGranted}/${spec.upgradeCommands.length} grant commands`);
  await ctx.wait(2_000);

  // ── 7. Weapon spawn + equip ─────────────────────────────────────────────
  // Re-dismiss any SUI page that reappeared during provisioning (the NPE
  // roadmap can re-push a window after skill grants / level-ups). An open
  // SUI page gates the equip transfers.
  const dismissedPreEquip = await dismissOpenSuiPages(ctx, log);
  if (dismissedPreEquip.length > 0) {
    log(`pre-equip SUI dismiss: [${dismissedPreEquip.join('; ')}]`);
  }
  const inventoryId = await waitForInventoryId(ctx);
  if (inventoryId === null) {
    warnings.push('inventory containerId never populated; skipping equip steps');
  } else {
    log(`inventory containerId=${inventoryId.toString()}`);
    const weaponId = await spawnInto(ctx, spec.weaponTemplate, inventoryId, warnings);
    if (weaponId !== null) {
      report.weaponSpawnedId = weaponId;
      log(`spawned weapon ${spec.weaponTemplate} as ${weaponId.toString()}`);

      // ── Jedi-only: build the saber BEFORE equipping ─────────────────────
      // saber_inventory.OnAboutToReceiveItem rejects crystal transfers when
      // the saber is contained by a player (= equipped), so crystals must go
      // in while the saber is still loose in inventory.
      if (profession === 'jedi') {
        report.saberCrystalsInstalled = await buildJediSaber(
          ctx,
          weaponId,
          inventoryId,
          playerOid,
          warnings,
          log,
        );
      }

      // Equip via transferItemWeapon — server has separate handlers for
      // weapon/armor/misc; `commandFuncTransferMisc` bails on weapon
      // slots. Try a series of arrangement values: `isGoingInWeaponSlot`
      // requires arrangement > 0 AND that the item's arrangement[N]
      // includes hold_r or hold_l. Different weapon templates use
      // different arrangement values, so iterate until the weapon
      // actually moves out of inventory.
      report.weaponEquipped = await equipWearable(
        ctx,
        weaponId,
        playerOid,
        inventoryId,
        'weapon',
        warnings,
      );
      if (report.weaponEquipped) log(`equipped weapon ${spec.weaponTemplate}`);
    }

    // ── 8. Armor: spawn + equip each piece (empty list for Jedi) ────────
    log(`spawning + equipping ${spec.armorPieces.length} armor pieces`);
    for (const armorTpl of spec.armorPieces) {
      const armorId = await spawnInto(ctx, armorTpl, inventoryId, warnings);
      if (armorId === null) continue;
      report.armorSpawnedCount++;
      const ok = await equipWearable(ctx, armorId, playerOid, inventoryId, 'armor', warnings);
      if (ok) report.armorEquippedCount++;
    }
    log(
      `armor: spawned ${report.armorSpawnedCount}/${spec.armorPieces.length}, equipped ${report.armorEquippedCount}`,
    );
  }

  // ── 9. Disable god mode ─────────────────────────────────────────────────
  if (disableGodModeAtEnd) {
    try {
      await adminGodModeOff(ctx);
      report.godModeOffOk = true;
      log('god mode OFF — character is now killable');
    } catch (err) {
      warnings.push(`godModeOff: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    log('SKIPPING god mode OFF (disableGodModeAtEnd=false); character is invulnerable');
  }

  return finalize(report, startMs);
}

function finalize(report: ProvisioningReport, startMs: number): ProvisioningReport {
  report.elapsedMs = Date.now() - startMs;
  return report;
}

/**
 * Dismiss every currently-open SUI page, retrying until `ctx.sui.active` is
 * empty or `maxRounds` is reached.
 *
 * A freshly-created NGE character zones in with the New Player Experience
 * intro SUI window open; while it's up the server gates weapon/armor equip
 * (which is why the transfers silently no-op'd through every arrangement
 * value). For each open page we fire event types 0..3 — we don't know the
 * NPE page's button layout, so we cover OK/Cancel/Next/etc.; extra ones
 * are harmless. Returns the page descriptors that were seen across all
 * rounds (for logging).
 */
async function dismissOpenSuiPages(
  ctx: ScriptContext,
  log: (msg: string) => void,
  maxRounds = 5,
): Promise<string[]> {
  const seen: string[] = [];
  for (let round = 0; round < maxRounds; round++) {
    const open = ctx.sui.active;
    if (open.length === 0) break;
    for (const page of open) {
      if (round === 0) {
        // Dump the page's title + a sample of its commands so we can
        // identify exactly what window is gating us.
        const cmdSample = page.commands
          .slice(0, 8)
          .map((c) => JSON.stringify(c))
          .join(' | ');
        seen.push(
          `pageId=${page.pageId} name=${page.pageName} title="${page.title}" cmds=${page.commands.length} sample=${cmdSample}`,
        );
      }
      for (let evt = 0; evt <= 3; evt++) {
        ctx.send(new SuiEventNotification(page.pageId, evt, []));
      }
    }
    await ctx.wait(500);
  }
  const remaining = ctx.sui.active.length;
  if (remaining > 0) {
    log(`WARNING: ${remaining} SUI page(s) STILL open after ${maxRounds} dismiss rounds`);
  }
  return seen;
}

/**
 * Wait briefly for the inventory view to populate `containerId`. The CREO p3
 * SLOTTED_CONTAINER baseline carries the inventory's NetworkId — it usually
 * lands within the zone-in baseline flood but can lag a few hundred ms on a
 * busy cluster.
 */
async function waitForInventoryId(
  ctx: ScriptContext,
  timeoutMs = 5_000,
): Promise<NetworkId | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const id = ctx.inventory.containerId;
    if (id !== null && id !== 0n) return id;
    await ctx.wait(250);
  }
  return null;
}

// ── Jedi saber assembly ────────────────────────────────────────────────────
// Templates verified at
// ~/code/swg-main/dsrc/sku.0/sys.server/compiled/game/object/tangible/component/weapon/lightsaber/
const JEDI_FORCE_CRYSTAL_TEMPLATE =
  'object/tangible/component/weapon/lightsaber/lightsaber_module_force_crystal.iff';
const JEDI_KRAYT_PEARL_TEMPLATE =
  'object/tangible/component/weapon/lightsaber/lightsaber_module_krayt_dragon_pearl.iff';

/**
 * Drive the in-game "Tune Crystal" SUI dialog to its OK button.
 *
 * Wire choreography (mirrors the live Windows client):
 *   1. We send `ObjectMenuSelectMessage(crystalOid, SERVER_PET_OPEN=283)`.
 *   2. Server-side `jedi_saber_component.OnObjectMenuSelect` fires and
 *      calls `verifyTune(player)` which opens a SUI MsgBox.
 *   3. Client receives `SuiCreatePageMessage`. We use `ctx.sui.autoRespond`
 *      to match the tune page (associated object = the crystal) and reply
 *      with `'ok'` (eventType 0 = `sui.BP_OK`).
 *   4. Server fires `handleVerifyTune` → `tuneCrystal(player)` which
 *      `setObjVar(crystal, jedi.crystal.owner.id, player_obj_id)` — the
 *      ONLY way to write an obj_id-typed objvar (the `objvar set` console
 *      command only handles INT/REAL/STRING per
 *      `ConsoleCommandParserObjvar.cpp:148`).
 *
 * Returns true if the autoRespond fired within the timeout window. Tuning
 * actually completing server-side is verified by the subsequent
 * saber-insert step (which checks `isCrystalOwner`).
 */
async function tuneCrystalViaSui(
  ctx: ScriptContext,
  crystalOid: NetworkId,
  warnings: string[],
  timeoutMs = 4_000,
): Promise<boolean> {
  let responded = false;
  const sawPages: string[] = [];
  const unsub = ctx.sui.autoRespond((page) => {
    sawPages.push(`pageId=${page.pageId} name=${page.pageName} cmds=${page.commands.length}`);
    if (page.pageName !== 'Script.messageBox') return false;
    responded = true;
    return true;
  }, 'ok');
  try {
    // Step 1: send ObjectMenuRequest so the server populates the radial
    // (and crucially, sets `setServerNotify(true)` on the SERVER_PET_OPEN
    // entry — without that flag, the server-side script doesn't fire
    // OnObjectMenuSelect when we pick the item). Mirrors the live client.
    // Pattern lifted from `ctx.fetchSurveyResources` in context.ts.
    const playerId = ctx.sceneStart.playerNetworkId;
    const reqStream = new ByteStream();
    _encodeObjectMenu(reqStream, {
      targetId: crystalOid,
      requestorId: playerId,
      items: [],
      sequence: 1,
    });
    ctx.send(
      new ObjControllerMessage(
        CLIENT_TO_AUTH_SERVER_FLAGS,
        ObjControllerSubtypeIds.CM_objectMenuRequest,
        playerId,
        0,
        reqStream.toBytes(),
      ),
    );
    await ctx.wait(300);

    // Step 2: select the Tune Crystal entry, fires OnObjectMenuSelect →
    // verifyTune → opens the SUI MsgBox.
    ctx.send(new ObjectMenuSelectMessage(crystalOid, RadialMenuTypes.SERVER_PET_OPEN));

    // Poll briefly for the autoRespond to fire (flipped via side effect in
    // the predicate above). The SUI page typically appears and is replied
    // to within a few hundred ms.
    const start = Date.now();
    while (!responded && Date.now() - start < timeoutMs) {
      await ctx.wait(100);
    }
    if (!responded) {
      const pagesSummary = sawPages.length === 0 ? '(predicate never called)' : sawPages.join('; ');
      warnings.push(
        `tuneCrystalViaSui ${crystalOid.toString()}: no Script.messageBox in ${timeoutMs}ms. Predicate saw: ${pagesSummary}`,
      );
    }
  } finally {
    unsub();
  }
  // Settle to let the server's handleVerifyTune complete.
  await ctx.wait(500);
  return responded;
}

/** Number of crystal sockets to fill: 1 color crystal + 4 power pearls. */
const SABER_SOCKET_COUNT = 5;

/**
 * Build a fully-assembled, equippable saber.
 *
 * A lightsaber requires ALL its sockets filled: exactly one COLOR crystal
 * plus power crystals/pearls for the rest. An incomplete saber can't be
 * wielded. We fill 5 sockets (1 color + 4 Krayt pearls).
 *
 * Per-crystal pipeline:
 *   1. Spawn the raw template via `object createIn`.
 *   2. For the COLOR crystal: pre-set `jedi.crystal.stats.level` (low) and
 *      `jedi.crystal.stats.color` via `objvar set` (both INT objvars, which
 *      the console CAN write). `jedi.initializeCrystal` (in
 *      `jedi.java`) only promotes a `module_force_crystal` to a color
 *      crystal when `rand(25,100) > level` — at the player's real level 90
 *      that's a ~10% roll, so a freshly-spawned force crystal almost always
 *      becomes a plain power crystal. Forcing `level` low makes the roll
 *      succeed deterministically; the pre-set `color` objvar picks the hue.
 *   3. `script attach systems.jedi.jedi_saber_component` — the script is
 *      normally bound via the `master_item.tab` static-item flow; raw
 *      `object create` spawns carry no script. Attaching it fires
 *      `OnAttach → initializeCrystal` which reads the objvars from step 2.
 *   4. Tune via the in-game SUI dialog (`tuneCrystalViaSui`) — the only
 *      way to write the obj_id-typed `jedi.crystal.owner.id` objvar.
 *   5. `transferItemMisc` the crystal into the saber's `saber_inv`
 *      sub-container; `saber_inventory.OnReceivedItem` fires
 *      `jedi.addCrystalStats` to roll the contribution into the weapon.
 *
 * Must run BEFORE the saber is equipped — `saber_inventory.OnAboutToReceiveItem`
 * rejects crystal transfers to a saber whose container is the player.
 *
 * Returns the count of crystals successfully inserted (0..5).
 */
async function buildJediSaber(
  ctx: ScriptContext,
  saberOid: NetworkId,
  inventoryId: NetworkId,
  _playerOid: NetworkId,
  warnings: string[],
  log: (msg: string) => void,
): Promise<number> {
  void _playerOid;
  let installed = 0;

  // Find the saber's saber_inv sub-container up front.
  const saberInvOid = await waitForSaberInvContainer(ctx, saberOid, warnings);
  if (saberInvOid === null) return 0;
  log(`found saber_inv container=${saberInvOid.toString()}`);

  // Socket 0: the COLOR crystal (forced via pre-set level/color objvars).
  // Sockets 1..4: Krayt dragon pearls (inherently power crystals).
  for (let socket = 0; socket < SABER_SOCKET_COUNT; socket++) {
    const isColor = socket === 0;
    const label = isColor ? 'color-crystal' : `pearl-${socket}`;
    const template = isColor ? JEDI_FORCE_CRYSTAL_TEMPLATE : JEDI_KRAYT_PEARL_TEMPLATE;

    const crystalOid = await spawnInto(ctx, template, inventoryId, warnings);
    if (crystalOid === null) {
      warnings.push(`buildJediSaber: failed to spawn ${label}`);
      continue;
    }
    const crystalStr = crystalOid.toString();

    if (isColor) {
      // Pre-set level + color BEFORE the script attaches so OnAttach's
      // initializeCrystal promotes this force crystal to a color crystal.
      fireAdminCommand(ctx, `objvar set ${crystalStr} jedi.crystal.stats.level 1`);
      fireAdminCommand(ctx, `objvar set ${crystalStr} jedi.crystal.stats.color 3`);
      await ctx.wait(400);
    }

    // Attach the saber-component script → fires OnAttach → initializeCrystal.
    fireAdminCommand(ctx, `script attach systems.jedi.jedi_saber_component ${crystalStr}`);
    await ctx.wait(1_200);

    // Tune via the real SUI confirm dialog.
    const tuned = await tuneCrystalViaSui(ctx, crystalOid, warnings);
    if (!tuned) {
      warnings.push(`tune ${label} (${crystalStr}): SUI flow did not complete`);
      continue;
    }
    log(`tuned ${label} via SUI`);

    // Transfer into the saber.
    try {
      ctx.useAbility('transferItemMisc', crystalOid, `${saberInvOid.toString()} -1`);
      await ctx.wait(700);
      installed++;
      log(`inserted ${label} into saber (${installed}/${SABER_SOCKET_COUNT})`);
    } catch (err) {
      warnings.push(
        `insert ${label} (${crystalStr}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  log(`saber assembled with ${installed}/${SABER_SOCKET_COUNT} crystal(s)`);
  return installed;
}

/**
 * Find the NetworkId of the saber's `saber_inv` sub-container.
 *
 * A crafted saber (one that uses `default_lightsaber.iff` slot descriptor)
 * has exactly two slots: `saber_inv` and `crafted_components`. On a fresh
 * spawn only the `saber_inv` slot has a sub-container object — the
 * `crafted_components` slot stays empty until someone drops a crafting
 * tool in. So the very-first-child-of-the-saber heuristic is reliable here:
 * there's only one to find.
 *
 * The wire field `UpdateContainmentMessage.slotArrangement` turns out to
 * NOT be the local slot index we initially assumed — observed values
 * (e.g. 4) suggest it's the global SlotId from `slot_definitions.mif`,
 * which is template-dependent. Rather than hard-code the right number,
 * we just take whichever child appears (which template inheritance + the
 * single-occupied-slot reality both back).
 *
 * Polls 200ms until found or `timeoutMs` elapses. On timeout, appends a
 * descriptive warning to `warnings`. The crafted_components slot only
 * fills up if a crafting tool is inserted (out of scope here), so this
 * stays unambiguous unless the saber template was wrong.
 */
async function waitForSaberInvContainer(
  ctx: ScriptContext,
  saberOid: NetworkId,
  warnings: string[],
  timeoutMs = 6_000,
): Promise<NetworkId | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const o of ctx.world.filter((obj) => obj.containerId === saberOid)) {
      return o.id;
    }
    await ctx.wait(200);
  }
  warnings.push(
    `saber_inv container not found after ${timeoutMs}ms: saber ${saberOid.toString()} has NO child objects in WorldModel. Wrong saber template? (must inherit from crafted_lightsaber_base.iff which uses default_lightsaber.iff slot descriptor)`,
  );
  return null;
}

/**
 * Spawn `template` into `containerOid`. Returns the new object's NetworkId
 * parsed from the "NetworkId: <decimal>" reply line, or null on failure.
 * Warnings are appended (NOT thrown) so the caller's provisioning report
 * surfaces them.
 */
/**
 * Equip a wearable on the player and verify via WorldModel that the
 * item left the inventory.
 *
 * Wire command selection:
 *
 * - `transferItemArmor`: unconditionally calls `commandFuncTransferItem`.
 *   Use for armor pieces — `transferItemMisc` rejects armor with
 *   `(destId != actor || !isArmor)` when the destination is the player.
 *
 * - `transferItemMisc` (for non-armor wearables): proceeds when
 *   `!isGoingInWeaponSlot(item, arrangement)`. `isGoingInWeaponSlot`
 *   short-circuits to false for `arrangement <= 0`, so arrangement=0
 *   passes through. The inner `transferItemToSlottedContainer(0)`
 *   reads the item's arrangement-0 slot list (e.g. `[hold_r, hold_l]`
 *   for a `hold_both`-arranged lightsaber) and routes correctly.
 *
 * - `transferItemWeapon`: has the inverse gate — requires
 *   `isGoingInWeaponSlot` to be TRUE, which is impossible at arrangement=0
 *   in this fork (every wearable's `arrangementDescriptorFilename` is a
 *   single `form "0000"` block; arrangement>0 is out-of-range and returns
 *   0 slots, so isGoingInWeaponSlot always returns false). transferItemWeapon
 *   is effectively unusable for the standard wearables. Avoid it.
 *
 * Arrangement is always 0 — every standard wearable descriptor I've
 * inspected has exactly one arrangement at index 0.
 */
async function equipWearable(
  ctx: ScriptContext,
  itemOid: NetworkId,
  playerOid: NetworkId,
  inventoryOid: NetworkId,
  kind: 'weapon' | 'armor',
  warnings: string[],
): Promise<boolean> {
  const cmd = kind === 'armor' ? 'transferItemArmor' : 'transferItemMisc';
  // Weapons: if anything is already in hold_r / hold_l (typically a
  // default unarmed weapon at character create), move it to inventory
  // first. `commandFuncTransferItem`'s built-in auto-swap on
  // CEC_SlotOccupied is supposed to handle this but doesn't always
  // fire cleanly via transferItemMisc for the hold slots.
  if (kind === 'weapon') {
    for (const occupant of ctx.world.filter(
      (o) => o.containerId === playerOid && o.id !== itemOid,
    )) {
      // Skip armor (chest_plate etc.); just clear the held weapon(s).
      const tpl = occupant.templateName ?? '';
      if (
        /weapon|unarmed|saber|sword|rifle|pistol|carbine|knife|polearm|spear/i.test(tpl) ||
        tpl === ''
      ) {
        ctx.useAbility('transferItemMisc', occupant.id, `${inventoryOid.toString()} 0`);
        await ctx.wait(400);
      }
    }
  }
  // Arrangement value semantics aren't a stable index in this server fork —
  // sweep common values and stop on first success.
  const arrangements = [4, 0, 1, 2, 3, 5, 6, 7, 8];
  const playerOidStr = playerOid.toString();
  for (const arrangement of arrangements) {
    ctx.useAbility(cmd, itemOid, `${playerOidStr} ${arrangement}`);
    await ctx.wait(450);
    const item = ctx.world.get(itemOid);
    if (item === undefined) {
      warnings.push(
        `equipWearable ${itemOid.toString()}: vanished after ${cmd} arr=${arrangement}`,
      );
      return false;
    }
    if (item.containerId !== inventoryOid) return true;
  }
  warnings.push(
    `equipWearable ${itemOid.toString()} (${kind}): no arrangement in ${arrangements.join(',')} worked via ${cmd}`,
  );
  return false;
}

/**
 * Spawn `template` into `containerOid` and return the new object's NetworkId.
 *
 * The classic admin-console reply path (`object createIn` → parse "NetworkId:"
 * line) is unreliable after the level-up trigger flood — replies time out or
 * arrive minutes later, well outside any reasonable window. Instead we fire
 * the command and watch the WorldModel for a NEW object appearing in the
 * target container. Same containment data the server broadcasts via
 * `UpdateContainmentMessage` for every newly-created object regardless of
 * how it was created.
 *
 * Snapshots the current children of `containerOid` before firing the spawn,
 * then polls every 200ms for any child OID not in the snapshot. Returns the
 * first novel OID or null on timeout. Appends a descriptive warning on
 * timeout including what children were already there.
 */
async function spawnInto(
  ctx: ScriptContext,
  template: string,
  containerOid: NetworkId,
  warnings: string[],
  timeoutMs = 10_000,
): Promise<NetworkId | null> {
  const before = new Set<bigint>();
  for (const o of ctx.world.filter((obj) => obj.containerId === containerOid)) {
    before.add(o.id);
  }
  fireAdminCommand(ctx, `object createIn ${template} ${containerOid.toString()}`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const o of ctx.world.filter((obj) => obj.containerId === containerOid)) {
      if (!before.has(o.id)) return o.id;
    }
    await ctx.wait(200);
  }
  warnings.push(
    `spawnInto ${template}: no new object in container ${containerOid.toString()} after ${timeoutMs}ms (had ${before.size} children before)`,
  );
  return null;
}
