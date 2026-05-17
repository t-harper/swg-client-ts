/**
 * Per-role ScenarioFn factories. The orchestrator wires these into
 * FleetClientConfig.script for each character.
 *
 * Every scenario:
 *   1. Enables god-mode (server allows because account is in stella_admin.tab)
 *   2. Grants self credits (100M) for any incidental costs
 *   3. Walks to assigned slot
 *   4. Performs role-specific placement / residency action
 *   5. Reports success/failure via ctx.fail() (which feeds ScriptResult.assertionFailures)
 */

import type { ScenarioFn, ScriptContext } from '../../src/client/script/context.js';
import type { NetworkId } from '../../src/types.js';
import { adminGiveMoney, adminGodModeOn, adminPlanetWarp } from './admin.js';
import { adminStructurePermissionAdd } from './admin-permissions.js';
import type { CharacterSlot, DecorationSlot } from './layout.js';
import { CITY_CENTER, CITY_NAME, CITY_PLANET, distance } from './layout.js';
import { declareResidence, placeDeed, walkInAndDeclareResidence } from './place.js';

const POCKET_MONEY = 100_000_000;
const CITY_TREASURY = 50_000_000;

// ────────────────────────────────────────────────────────────────────────────
// Common helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Bootstrap step every admin scenario runs first:
 *   1. god-mode on (admin auth — the account is in stella_admin.tab Phase 0pre)
 *   2. teleport to a position NEAR the work site on the right planet (Naboo).
 *      Without this, the player starts on Tatooine (mos_eisley) and can't place
 *      naboo-scene-restricted deeds.
 *   3. grant 100M credits (incidental costs)
 *
 * `nearTarget` should be the slot the scenario will actually work at; we
 * warp to ~25m away so there's a tiny walk to settle the cell context.
 */
async function bootstrap(
  ctx: ScriptContext,
  nearTarget: { x: number; z: number } = CITY_CENTER,
): Promise<void> {
  await adminGodModeOn(ctx);
  // Warp to Naboo near the work site (offset by ~20m so we're not exactly on the deed spot)
  await adminPlanetWarp(ctx, CITY_PLANET, nearTarget.x + 20, 0, nearTarget.z + 20);
  try {
    await adminGiveMoney(ctx, ctx.sceneStart.playerNetworkId, POCKET_MONEY, { timeoutMs: 5000 });
  } catch (err) {
    ctx.fail(`bootstrap: adminGiveMoney failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Walk toward target if currently more than `nearMeters` away. */
async function walkIfFar(
  ctx: ScriptContext,
  target: { x: number; z: number },
  nearMeters: number,
): Promise<void> {
  const pos = ctx.position();
  if (distance({ x: pos.x, z: pos.z }, target) <= nearMeters) return;
  await ctx.walkTo({ x: target.x, z: target.z }, { speed: 6 });
}

// ────────────────────────────────────────────────────────────────────────────
// Mayor scenario
// ────────────────────────────────────────────────────────────────────────────

export interface MayorScenarioInputs {
  /** The city center coords (where city hall goes). */
  cityCenter: { x: number; z: number };
  /** The city name to set as the cityhall's `cityName` objvar. */
  cityName?: string;
  /** Mayor's placement rotation. */
  rotation?: number;
}

/**
 * Mayor scenario — Phase 2.
 * 1. bootstrap (god + money)
 * 2. walk to city center
 * 3. spawn cityhall_naboo_deed
 * 4. set cityName objvar
 * 5. placeStructure
 * 6. fund city treasury (50M to the new cityhall structure)
 */
export function mayorScenario(inputs: MayorScenarioInputs): ScenarioFn {
  const cityName = inputs.cityName ?? CITY_NAME;
  const rotation = inputs.rotation ?? 0;

  return async (ctx) => {
    await bootstrap(ctx, inputs.cityCenter);

    // Walk to center (small distance after warp)
    await walkIfFar(ctx, inputs.cityCenter, 5);
    await ctx.wait(500);

    // Place city hall via the real-client wire flow (radial USE → SUI confirm + cityName)
    let placeResult;
    try {
      placeResult = await placeDeed(
        ctx,
        'object/tangible/deed/city_deed/cityhall_naboo_deed.iff',
        { cityName, expectedSuiCount: 2 },
      );
    } catch (err) {
      ctx.fail(`mayor: cityhall placeDeed failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (placeResult.rejected) {
      ctx.fail(`mayor: cityhall placement rejected: ${placeResult.chatErrors.join('; ')}`);
      return;
    }
    if (placeResult.suiSeen < 2) {
      ctx.fail(`mayor: cityhall expected 2 SUI dialogs, saw ${placeResult.suiSeen}`);
      return;
    }

    // Fund treasury — we don't have the structure OID handy, but we can pay
    // the mayor's bank account (anti-cheat ignores this for admins). The
    // city treasury is fed automatically once the city is created and the
    // mayor pays via city UI — for now, just ensure mayor has plenty of cash.
    // (A future iteration can use admin command `city addCityTreasury <cityId> <amt>` if it exists.)
    try {
      await adminGiveMoney(ctx, ctx.sceneStart.playerNetworkId, CITY_TREASURY);
    } catch {
      // non-fatal
    }

    // Settle and let server finish city creation
    await ctx.wait(2000);
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Resident scenario
// ────────────────────────────────────────────────────────────────────────────

export interface ResidentScenarioInputs {
  slot: CharacterSlot;
  /**
   * NetworkId of the resident's structure, if Feat #5 has populated it on
   * a previous run. When set, the post-declareresidence permission-grant
   * uses `adminStructurePermissionAdd` for idempotent add (queries the
   * current list, only fires the toggle if absent). When unset, the
   * grant falls back to a blind `permissionListModify` fire that relies
   * on the player being physically inside the building (the server's
   * `OnPermissionListModify` script uses `getStructure(self)` to resolve
   * the target building, not the command's `target` arg).
   */
  structureOid?: NetworkId;
}

/**
 * Resident scenario — Phase 3.
 *
 * 1. bootstrap
 * 2. walk to assigned slot
 * 3. spawn house deed
 * 4. placeStructure
 * 5. walk through door (entry offset)
 * 6. declareresidence
 * 7. (NEW, fullLayout only) if `slot.pairedGuildCharacter` is set, grant the
 *    paired guildExtra ENTRY+ADMIN permission on this resident's house —
 *    otherwise Phase 4 guild's declareresidence in this house bounces off
 *    the server's no-permission gate.
 */
export function residentScenario(inputs: ResidentScenarioInputs): ScenarioFn {
  const slot = inputs.slot;
  if (slot.deedTemplate === null) {
    throw new Error(`residentScenario: slot for ${slot.characterName} has no deedTemplate`);
  }
  const deedTemplate = slot.deedTemplate;
  const pairedGuild = slot.pairedGuildCharacter;
  const structureOid = inputs.structureOid;

  return async (ctx) => {
    await bootstrap(ctx);

    // Walk to placement spot
    await walkIfFar(ctx, slot, 8);
    await ctx.wait(500);

    // Place house (reclaim-able deeds → 0 SUI roundtrips, fires queueCommand directly)
    let placeResult;
    try {
      placeResult = await placeDeed(ctx, deedTemplate, { expectedSuiCount: 0 });
    } catch (err) {
      ctx.fail(
        `resident ${slot.characterName}: placeDeed failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (placeResult.rejected) {
      ctx.fail(`resident ${slot.characterName}: house placement rejected: ${placeResult.chatErrors.join('; ')}`);
      return;
    }

    // Walk inside + declare residence
    const declared = await walkInAndDeclareResidence(ctx, slot, {
      settleMs: 2000,
      declareTimeoutMs: 8000,
    });
    if (!declared) {
      // Soft-fail; city.java may still count us as a citizen if the building exists.
      ctx.fail(
        `resident ${slot.characterName}: declareresidence didn't confirm via chat (citizen count may still increase)`,
      );
      // Don't bail — try the permission grant anyway since the building exists.
    }

    // Phase 4 guildExtra prep — grant the paired guildExtra ENTRY+ADMIN on
    // our just-placed house. Player is still inside the cell from the walk
    // above, so the server's OnPermissionListModify script resolves the
    // structure via `getStructure(self)` and the permission grant lands
    // on this house even when we don't have its NetworkId yet.
    if (pairedGuild !== undefined) {
      await grantPairedGuildPermissions(ctx, slot, pairedGuild, structureOid);
    }
  };
}

/**
 * Grant the resident's paired guildExtra ENTRY+ADMIN permission on the
 * resident's just-placed house.
 *
 * Two paths depending on whether the structure OID is known:
 *   - OID known (Feat #5 populated it on a prior run): use
 *     `adminStructurePermissionAdd` — queries the list first, only fires
 *     the toggle if the paired guild isn't already on the list. Idempotent
 *     across re-runs.
 *   - OID unknown: fall back to firing the `permissionListModify`
 *     command-queue command blindly. The server's command handler ignores
 *     the `target` arg; the script trigger uses `getStructure(self)` to
 *     resolve the building from the actor's current cell. As long as the
 *     resident is inside their just-placed house (they are — declareresidence
 *     walked them in), the grant lands on the right structure.
 *
 * Failures here are non-fatal — log via `ctx.fail()` (soft) so Phase 3 can
 * still complete and Phase 4 sees the attempt was made.
 */
async function grantPairedGuildPermissions(
  ctx: ScriptContext,
  slot: CharacterSlot,
  pairedGuild: string,
  structureOid: NetworkId | undefined,
): Promise<void> {
  if (structureOid === undefined) {
    // Punt path — Feat #5 hasn't populated structureOid yet. Log and fall back
    // to a blind useAbility fire that relies on the player being inside the
    // building (the script resolves the structure via getStructure(self)).
    process.stderr.write(
      `[residentScenario] ${slot.characterName}: structureOid not populated — ` +
        'falling back to blind permissionListModify (script resolves structure ' +
        "via player's current cell)\n",
    );
    ctx.useAbility(
      'permissionListModify',
      ctx.sceneStart.playerNetworkId,
      `${pairedGuild} ENTRY add`,
    );
    await ctx.wait(250);
    ctx.useAbility(
      'permissionListModify',
      ctx.sceneStart.playerNetworkId,
      `${pairedGuild} ADMIN add`,
    );
    await ctx.wait(250);
    return;
  }

  // Happy path — Feat #5 populated structureOid. Use the idempotent helper.
  try {
    await adminStructurePermissionAdd(ctx, structureOid, 'entry', pairedGuild);
    await adminStructurePermissionAdd(ctx, structureOid, 'admin', pairedGuild);
  } catch (err) {
    ctx.fail(
      `resident ${slot.characterName}: failed to grant ${pairedGuild} permission: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Civic scenario
// ────────────────────────────────────────────────────────────────────────────

export interface CivicScenarioInputs {
  slot: CharacterSlot;
}

/**
 * Civic builder scenario — Phase 4.
 * 1. bootstrap
 * 2. walk to assigned slot
 * 3. spawn civic deed
 * 4. placeStructure
 * (no declareresidence — civic structures don't need it)
 */
export function civicScenario(inputs: CivicScenarioInputs): ScenarioFn {
  const slot = inputs.slot;
  if (slot.deedTemplate === null) {
    throw new Error(`civicScenario: slot for ${slot.characterName} has no deedTemplate`);
  }
  const deedTemplate = slot.deedTemplate;

  return async (ctx) => {
    await bootstrap(ctx, slot);
    await walkIfFar(ctx, slot, 8);
    await ctx.wait(500);

    try {
      // Civic deeds are NOT reclaim-able → 1 SUI confirm roundtrip
      const result = await placeDeed(ctx, deedTemplate, { expectedSuiCount: 1 });
      if (result.rejected) {
        ctx.fail(
          `civic ${slot.characterName} (${slot.civicKind}): placement rejected: ${result.chatErrors.join('; ')}`,
        );
      }
    } catch (err) {
      ctx.fail(
        `civic ${slot.characterName} (${slot.civicKind}): placeDeed failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Guild scenario
// ────────────────────────────────────────────────────────────────────────────

export interface GuildScenarioInputs {
  slot: CharacterSlot;
  /** For "extra" guild chars (no deed): host resident's house OID, if known. */
  hostResidenceOid?: NetworkId;
}

/**
 * Guild scenario — Phase 4.
 * Two modes depending on `slot.deedTemplate`:
 *
 * - deedTemplate set: this is Guild01, places the guild hall.
 * - deedTemplate null: this is Guild02..08, walks to a host resident's house
 *   and declares residence there (just to push citizen count past 30).
 */
export function guildScenario(inputs: GuildScenarioInputs): ScenarioFn {
  const slot = inputs.slot;

  return async (ctx) => {
    await bootstrap(ctx, slot);
    await walkIfFar(ctx, slot, 8);
    await ctx.wait(500);

    if (slot.deedTemplate !== null) {
      // Guild01: place guild hall (non-reclaim → 1 SUI confirm)
      try {
        const result = await placeDeed(ctx, slot.deedTemplate, { expectedSuiCount: 1 });
        if (result.rejected) {
          ctx.fail(
            `guild ${slot.characterName}: guildhall placement rejected: ${result.chatErrors.join('; ')}`,
          );
        }
      } catch (err) {
        ctx.fail(
          `guild ${slot.characterName}: guildhall placeDeed failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    // Guild02..08: declare residence in someone else's house
    if (slot.residenceOf === undefined) {
      ctx.fail(`guild ${slot.characterName}: no deedTemplate AND no residenceOf — skipping`);
      return;
    }

    // The slot's (x, z) is already set to the host residence's coords in layout.ts.
    const declared = await walkInAndDeclareResidence(ctx, slot, {
      settleMs: 2000,
      declareTimeoutMs: 8000,
    });
    if (!declared) {
      ctx.fail(
        `guild ${slot.characterName}: declareresidence in ${slot.residenceOf}'s house didn't confirm (need to be inside cell + house owner permission may be required)`,
      );
    }
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Decoration scenario (mayor solo, Phase 5)
// ────────────────────────────────────────────────────────────────────────────

export interface DecorationScenarioInputs {
  decorations: readonly DecorationSlot[];
}

/**
 * Decoration scenario — Phase 5, mayor solo.
 * For each decoration anchor:
 *   - if mode='placeStructure': spawn deed + placeStructure (gardens)
 *   - if mode='spawnAtXYZ': direct admin createIn world spawn (lamps, fountains)
 */
export function decorationScenario(inputs: DecorationScenarioInputs): ScenarioFn {
  return async (ctx) => {
    await bootstrap(ctx, CITY_CENTER);

    for (const dec of inputs.decorations) {
      try {
        if (dec.mode === 'placeStructure') {
          // Walk to the decoration spot, then place via SUI flow
          await walkIfFar(ctx, { x: dec.x, z: dec.z }, 5);
          await ctx.wait(500);
          // Gardens are reclaim-able structures — 0 SUI
          const result = await placeDeed(ctx, dec.template, { expectedSuiCount: 0 });
          if (result.rejected) {
            ctx.fail(`decoration ${dec.label}: rejected: ${result.chatErrors.join('; ')}`);
          }
        }
        // For 'spawnAtXYZ', we'd use adminSpawnAtXYZ — but that requires direct
        // world cell access which is not modeled here yet. Skip for MVP.
      } catch (err) {
        ctx.fail(
          `decoration ${dec.label}: failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
}

/** Re-export `declareResidence` for use in scenarios that just need the action. */
export { declareResidence };
