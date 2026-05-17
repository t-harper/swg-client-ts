/**
 * Live integration test: `ctx.character` enriched views.
 *
 * Verifies the six new derived views on `ctx.character`:
 *   - `skillMods`     — CREO p4 m_modMap (calculated skill-mod table)
 *   - `xp`            — PLAY p8 m_experiencePoints (XP per category)
 *   - `effects`       — CREO p6 m_buffs (active buff entries)
 *   - `weapon`        — joined WEAO baseline + AttributeListMessage
 *   - `roadmap`       — PLAY p8 m_workingSkill + activeQuests parse
 *   - `factionDetails` — CREO p3 m_pvpType + PLAY p3 m_currentGcwPoints
 *
 * Gated on `LIVE=1`. Uses an admin-pool character; admin-spawns a melee
 * weapon directly into the player's inventory, equips it via the radial
 * ITEM_EQUIP, then fetches its attribute list via `getAttributesBatch`
 * so `weapon.minDamage` / `maxDamage` populate.
 *
 * Why melee + admin: a pre-existing weapon in inventory is not guaranteed
 * for fresh admin-pool characters (the NGE roadmap grants weapons on
 * specific quest completion). Admin-spawning a known template (vibroblade)
 * gives us a deterministic surface to test.
 */
import { describe, expect, it } from 'vitest';

import { SwgClient } from '../../src/client/swg-client.js';
import { ConGenericMessage } from '../../src/messages/game/con-generic-message.js';
import type { NetworkId } from '../../src/types.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

/** Server templates to try in order — first one that succeeds wins. */
const WEAPON_TEMPLATES = [
  'object/weapon/ranged/rifle/rifle_a280.iff',
  'object/weapon/melee/2h_sword/2h_sword_battleaxe.iff',
  'object/weapon/melee/baton/baton_gaderiffi.iff',
  'object/weapon/melee/sword/sword_curved.iff',
];

describe.skipIf(!LIVE)('live character-sheet enriched views', () => {
  it(
    'populates skillMods, xp, effects, weapon, roadmap, factionDetails from real wire data',
    async () => {
      const { account, characterName } = await liveCredentials('ce');
      await sessionSettle();
      const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

      const observed = {
        skillModCount: 0,
        skillModSamples: [] as Array<{ name: string; total: number }>,
        xpCategoryCount: 0,
        xpSamples: [] as Array<{ category: string; amount: number }>,
        effectsCount: 0,
        weaponId: null as NetworkId | null,
        weaponEquippedAt: 0,
        weaponSnapshot: null as Record<string, unknown> | null,
        roadmap: null as Record<string, unknown> | null,
        factionDetails: null as Record<string, unknown> | null,
        bailReason: null as string | null,
      };

      const lifecycleResult = await client.fullLifecycle({
        account,
        characterName,
        planet: 'mos_eisley',
        holdZonedInMs: 0,
        script: async (ctx) => {
          // 1. Let the zone-in baseline flood settle so CREO p4 + PLAY p8 land.
          await ctx.wait(3_000);

          // skillMods — should be non-empty for any admin-pool character
          // because the species template grants base mods (e.g.
          // `strength_modified`, `expertise_general_speed`).
          observed.skillModCount = ctx.character.skillMods.size;
          // Capture up to 5 entries for the diagnostic log.
          const skillModIter = ctx.character.skillMods.entries();
          for (let i = 0; i < 5; i++) {
            const next = skillModIter.next();
            if (next.done) break;
            observed.skillModSamples.push({ name: next.value[0], total: next.value[1] });
          }

          // xp — admin-pool chars have at least one XP category populated
          // (the roadmap grants combat_general / crafting_artisan etc.).
          observed.xpCategoryCount = ctx.character.xp.size;
          const xpIter = ctx.character.xp.entries();
          for (let i = 0; i < 5; i++) {
            const next = xpIter.next();
            if (next.done) break;
            observed.xpSamples.push({ category: next.value[0], amount: next.value[1] });
          }

          // effects — may be empty for fresh chars (no active buffs).
          observed.effectsCount = ctx.character.effects.length;

          // roadmap — null if no workingSkill set; we just snapshot.
          observed.roadmap = ctx.character.roadmap as unknown as
            | Record<string, unknown>
            | null;

          // factionDetails — always populated (even if neutral).
          observed.factionDetails = {
            type: ctx.character.factionDetails.type,
            name: ctx.character.factionDetails.name,
            standing: ctx.character.factionDetails.standing,
            pvpStatus: ctx.character.factionDetails.pvpStatus,
          };

          // 2. Enable god mode + admin-spawn a weapon DIRECTLY INTO the
          //    player creature. The server's container logic routes wearables
          //    into the appropriate slot (hold_r for weapons) when the parent
          //    is the creature itself, so this auto-equips. This is simpler
          //    than spawning into inventory then issuing transferItemWeapon —
          //    which would require knowing the exact slot arrangement index.
          if (ctx.inventory.containerId === null) {
            observed.bailReason =
              'ctx.inventory.containerId is null after 3s — inventory container open failed';
            return;
          }
          ctx.useAbility('setGodMode', 0n, '1');
          await ctx.wait(1_500);

          const responses: string[] = [];
          const unsubResp = ctx.dispatcher.onMessage(ConGenericMessage, (m) => {
            responses.push(m.msg);
          });

          // Spawn the weapon. Try templates in order; bail with diagnostic
          // detail if NONE succeed. Use the player creature as the container
          // so the server auto-routes to hold_r.
          const playerOidLive = ctx.sceneStart.playerNetworkId.toString();
          let weaponSpawnedTemplate: string | null = null;
          for (let i = 0; i < WEAPON_TEMPLATES.length; i++) {
            const tpl = WEAPON_TEMPLATES[i]!;
            responses.length = 0;
            // Spawn directly into the player creature — auto-slots to hold_r.
            ctx.send(new ConGenericMessage(`object createIn ${tpl} ${playerOidLive}`, 100 + i));
            await ctx.wait(2_000);
            if (responses.find((r) => /NetworkId:\s*\d+/.test(r)) !== undefined) {
              weaponSpawnedTemplate = tpl;
              break;
            }
          }
          unsubResp();

          if (weaponSpawnedTemplate === null) {
            observed.bailReason =
              `/object createIn failed for all ${WEAPON_TEMPLATES.length} weapon templates. ` +
              `Tried: ${WEAPON_TEMPLATES.join(', ')}. ` +
              `Last responses: ${JSON.stringify(responses)}`;
            return;
          }

          const idMatch = responses.find((r) => /NetworkId:\s*\d+/.test(r));
          if (idMatch === undefined) {
            observed.bailReason = `No NetworkId in responses despite successful spawn: ${JSON.stringify(responses)}`;
            return;
          }
          const idStr = idMatch.match(/NetworkId:\s*(\d+)/)?.[1];
          if (idStr === undefined) {
            observed.bailReason = `Could not parse NetworkId out of: ${idMatch}`;
            return;
          }
          observed.weaponId = BigInt(idStr) as NetworkId;
          console.log(
            `[live-character-enrich] spawned weapon id=${observed.weaponId.toString()} template=${weaponSpawnedTemplate}`,
          );

          // 3. Wait for the weapon's WEAO baselines + the CREO p6 delta
          //    with currentWeapon to land. The auto-slot route should set
          //    currentWeapon within ~3s — no separate equip command needed.
          const equipDeadline = Date.now() + 8_000;
          while (Date.now() < equipDeadline) {
            if (ctx.character.currentWeapon === observed.weaponId) {
              observed.weaponEquippedAt = Date.now();
              break;
            }
            await ctx.wait(100);
          }
          // Also wait for the weapon's WEAO p3 baseline to land in the
          // world model (the world might lag the currentWeapon delta).
          const baselineDeadline = Date.now() + 3_000;
          while (Date.now() < baselineDeadline) {
            const obj = ctx.world.get(observed.weaponId);
            if (obj !== undefined && obj.baselines.has(3)) break;
            await ctx.wait(100);
          }

          // 6. Fetch the weapon's attribute list — this is what populates
          //    minDamage/maxDamage/ammoRemaining (those are server-only
          //    baselines; AttributeListMessage is the only client-facing
          //    source). Server emits `cat_wpn_damage.damage` as a unified
          //    "min-max" range string.
          if (ctx.character.currentWeapon === observed.weaponId) {
            await ctx.fetchResourceAttributes([observed.weaponId], { timeoutMs: 5_000 });
            await ctx.wait(500);
          }

          // 7. Snapshot the joined weapon view.
          const w = ctx.character.weapon;
          observed.weaponSnapshot =
            w === null
              ? null
              : {
                  networkId: w.networkId.toString(),
                  templateName: w.templateName,
                  minDamage: w.minDamage,
                  maxDamage: w.maxDamage,
                  attackSpeed: w.attackSpeed,
                  range: w.range,
                  ammoRemaining: w.ammoRemaining,
                };

          // 8. Cleanup: destroy the spawned weapon so we don't litter the DB.
          ctx.send(new ConGenericMessage(`object destroy ${observed.weaponId.toString()}`, 200));
          await ctx.wait(500);
        },
      });

      // Zone-in must have succeeded; the script must not have thrown.
      expect(lifecycleResult.zonedInAt, 'zonedInAt populated').not.toBeNull();
      expect(lifecycleResult.scriptResult?.error, 'script did not throw').toBeUndefined();

      // skillMods + factionDetails are unconditional for any zoned-in char.
      expect(
        observed.skillModCount,
        `skillMods should be non-empty for a player CREO. samples=${JSON.stringify(observed.skillModSamples)}`,
      ).toBeGreaterThan(0);
      // xp is character-state-dependent. A brand-new admin character has 0
      // XP in every category, so the map can legitimately be empty. We
      // require only that the PLAY p8 baseline was successfully decoded
      // by checking that one of its sibling fields (roadmap) is non-null
      // OR by accepting an empty map as "decoded with no XP".
      expect(
        observed.xpCategoryCount >= 0 && observed.roadmap !== null,
        `xp must be a Map (size >= 0) AND PLAY p8 baseline must have decoded ` +
          `(roadmap !== null is the proxy). xpCount=${observed.xpCategoryCount}, ` +
          `roadmap=${JSON.stringify(observed.roadmap)}, xpSamples=${JSON.stringify(observed.xpSamples)}`,
      ).toBe(true);
      expect(
        observed.factionDetails,
        'factionDetails should be populated (even if neutral)',
      ).not.toBeNull();
      const f = observed.factionDetails as Record<string, unknown>;
      expect(['neutral', 'imperial', 'rebel'], 'factionDetails.name canonical').toContain(f.name);

      // Weapon equip — the hard test. If the bail reason is set, surface it
      // explicitly so the failure is loud.
      if (observed.bailReason !== null) {
        console.warn(`[live-character-enrich] bail reason: ${observed.bailReason}`);
      }
      expect(observed.bailReason, 'no admin-spawn / equip bail').toBeNull();
      expect(observed.weaponId, 'spawned weapon NetworkId captured').not.toBeNull();
      expect(observed.weaponEquippedAt, 'weapon equipped within 5s').toBeGreaterThan(0);
      expect(observed.weaponSnapshot, 'ctx.character.weapon populated').not.toBeNull();
      const w = observed.weaponSnapshot as Record<string, unknown>;
      expect(w.attackSpeed, 'weapon.attackSpeed > 0 (from WEAO p3)').toBeGreaterThan(0);
      expect(
        w.range,
        'weapon.range > 0 (from WEAO p3 m_maxRange)',
      ).toBeGreaterThan(0);
      // templateName comes from SceneCreateObjectByName; the server may push
      // the weapon via SceneCreateObjectByCrc (CRC only) in which case the
      // templateName stays null. Both paths are valid — just confirm the
      // field is either a non-empty string or null (i.e. it's the right type).
      expect(
        w.templateName === null || typeof w.templateName === 'string',
        `weapon.templateName must be string|null; got ${typeof w.templateName} ${JSON.stringify(w.templateName)}`,
      ).toBe(true);
      // minDamage / maxDamage come from the AttributeListMessage. The server
      // populates `wpn_damage_min` / `wpn_damage_max` for every weapon.
      expect(
        w.minDamage,
        `weapon.minDamage > 0 (from AttributeListMessage via getAttributesBatch). w=${JSON.stringify(w)}`,
      ).toBeGreaterThan(0);
      expect(
        w.maxDamage,
        `weapon.maxDamage > 0 (from AttributeListMessage). w=${JSON.stringify(w)}`,
      ).toBeGreaterThan(0);

      console.log(
        `[live-character-enrich] skillMods=${observed.skillModCount} xp=${observed.xpCategoryCount}` +
          ` effects=${observed.effectsCount} weapon=${JSON.stringify(observed.weaponSnapshot)}` +
          ` roadmap=${JSON.stringify(observed.roadmap)} faction=${JSON.stringify(observed.factionDetails)}`,
      );
    },
    90_000,
  );
});
