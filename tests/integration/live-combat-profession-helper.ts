/**
 * Shared driver for the six per-profession LIVE combat smoke tests.
 *
 * NOT a test file (no `*.test.ts` suffix) — Vitest skips it.
 *
 * What each per-profession test does:
 *   1. Create a fresh character at the bundled `skillTemplate` for the profession.
 *   2. Provision: grant full skill chain + expertise + level 90 + tier-2/3
 *      commands + spawn-and-equip weapon + 9-piece composite armor.
 *      Disables god mode at the end so the test is REAL.
 *   3. Re-enable god mode briefly to spawn hostile NPCs (`object create`
 *      requires admin), then disable again immediately.
 *   4. Install combat behavior, aggro the first NPC.
 *   5. Wait up to `RUN_MS` (default 60s) for the bot to clear targets.
 *   6. Destroy any survivors and dispose.
 *   7. Assert: install succeeded, engaged at least once, at least one
 *      ability call went out, character alive at end (HP > 0), and
 *      `LIVE_COMBAT_REQUIRE_KILLS=1` enforces targets cleared.
 *
 * The character is fully provisioned via `provisionFullCombatCharacter` —
 * this is no longer a framework-only smoke test. The bot has real skills,
 * real expertise, real weapon, real armor, real level — and god mode is
 * OFF during combat, so survival is genuinely the bot's job.
 */
import { expect } from 'vitest';

import {
  adminGodModeOff,
  adminGodModeOn,
  adminPlanetWarp,
} from '../../scripts/build-city/admin.js';
import { installCombatBehavior } from '../../src/client/script/combat/index.js';
import type { ProfessionId } from '../../src/client/script/combat/types.js';
import { SwgClient } from '../../src/index.js';
import { ConGenericMessage } from '../../src/messages/game/con-generic-message.js';
import type { NetworkId } from '../../src/types.js';
import { liveCredentials, sessionSettle } from './helpers.js';
import { PROVISIONING_SPECS } from './live-combat-provisioning-specs.js';
import {
  type ProvisioningReport,
  provisionFullCombatCharacter,
} from './live-combat-provisioning.js';

const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);
const N_SPAWN = Number(process.env.LIVE_COMBAT_N ?? 3);
const RUN_MS = Number(process.env.LIVE_COMBAT_RUN_MS ?? 60_000);
const REQUIRE_KILLS = process.env.LIVE_COMBAT_REQUIRE_KILLS === '1';
const SKIP_PROVISIONING = process.env.LIVE_COMBAT_SKIP_PROVISIONING === '1';
const SPAWN_TEMPLATE_OVERRIDE = process.env.LIVE_COMBAT_SPAWN_TEMPLATE;

/**
 * Where the combat test happens. Deep Tatooine Dune Sea — flat sand, far
 * from every city and POI spawner that would litter the area with
 * unrelated hostiles. Buff-bot's coords (3528, -4804) are NEAR Mos Eisley
 * which has high spawn density; these are ~9km southwest in empty desert.
 *
 * Override via LIVE_COMBAT_WARP_X / LIVE_COMBAT_WARP_Z env vars.
 */
const WARP_PLANET = process.env.LIVE_COMBAT_WARP_PLANET ?? 'tatooine';
const WARP_X = Number(process.env.LIVE_COMBAT_WARP_X ?? -5300);
const WARP_Z = Number(process.env.LIVE_COMBAT_WARP_Z ?? 2550);

/** Per-profession test config. */
export interface ProfessionLiveTestOpts {
  profession: ProfessionId;
  /** 2-3 letter test prefix passed to `liveCredentials`. */
  prefix: string;
  /** Override the bundled NPC spawn template for this profession. */
  spawnTemplate?: string;
}

export interface ProfessionLiveTestObservations {
  profession: ProfessionId;
  provisioning: ProvisioningReport | null;
  spawnedIds: NetworkId[];
  spawnFailureReason?: string;
  installOk: boolean;
  engagedAtLeastOnce: boolean;
  disengagedAtLeastOnce: boolean;
  abilityCallCount: number;
  postHp: number;
  postHpMax: number;
  targetsAtEnd: number;
  combatErrors: string[];
}

export async function runProfessionCombatTest(
  opts: ProfessionLiveTestOpts,
): Promise<ProfessionLiveTestObservations> {
  const spec = PROVISIONING_SPECS[opts.profession];
  const spawnTemplate = opts.spawnTemplate ?? SPAWN_TEMPLATE_OVERRIDE ?? spec.npcSpawnTemplate;
  const { account, characterName } = await liveCredentials(opts.prefix);
  console.warn(
    `[live-combat:${opts.profession}] credentials: account=${account} character=${characterName}`,
  );
  await sessionSettle();
  const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

  const observed: ProfessionLiveTestObservations = {
    profession: opts.profession,
    provisioning: null,
    spawnedIds: [],
    installOk: false,
    engagedAtLeastOnce: false,
    disengagedAtLeastOnce: false,
    abilityCallCount: 0,
    postHp: 0,
    postHpMax: 0,
    targetsAtEnd: 0,
    combatErrors: [],
  };

  const lifecycleResult = await client.fullLifecycle({
    account,
    characterName,
    planet: 'mos_eisley',
    skillTemplate: spec.skillTemplate,
    workingSkill: spec.workingSkill,
    profession: spec.legacyProfession,
    holdZonedInMs: 0,
    script: async (ctx) => {
      await ctx.wait(2_500);

      // ── PROVISION ──────────────────────────────────────────────────────
      if (!SKIP_PROVISIONING) {
        observed.provisioning = await provisionFullCombatCharacter(ctx, opts.profession, {
          disableGodModeAtEnd: true,
        });
        const p = observed.provisioning;
        const saberLine =
          opts.profession === 'jedi' ? ` saber-crystals=${p.saberCrystalsInstalled}/5` : '';
        const armorTarget = PROVISIONING_SPECS[opts.profession].armorPieces.length;
        const armorLine = armorTarget > 0 ? ` armor=${p.armorEquippedCount}/${armorTarget}` : '';
        console.warn(
          `[live-combat:${opts.profession}] provisioned in ${p.elapsedMs}ms: level=${p.finalLevel} skills=${p.skillsGranted}/${p.skillsAttempted} upgrades=${p.upgradeCommandsGranted} weapon=${p.weaponEquipped}${armorLine}${saberLine} godModeOff=${p.godModeOffOk}${p.warnings.length > 0 ? ` warnings=${p.warnings.length}` : ''}`,
        );
        // Surface the first few warnings so failures are visible without
        // having to dump the full array (it can be 100+ entries).
        if (p.warnings.length > 0) {
          for (const w of p.warnings.slice(0, 6)) {
            console.warn(`[provision:${opts.profession}] WARN: ${w}`);
          }
          if (p.warnings.length > 6) {
            console.warn(
              `[provision:${opts.profession}] ... ${p.warnings.length - 6} more warnings`,
            );
          }
        }
      } else {
        console.warn(`[live-combat:${opts.profession}] SKIP_PROVISIONING=1; using bare character`);
      }

      // ── WARP TO REMOTE FLAT TERRAIN ───────────────────────────────────
      // Get away from Mos Eisley's spawn density before dropping hostiles.
      await adminGodModeOn(ctx);
      await ctx.wait(500);
      console.warn(
        `[live-combat:${opts.profession}] warping to ${WARP_PLANET} (${WARP_X}, ${WARP_Z})`,
      );
      await adminPlanetWarp(ctx, WARP_PLANET, WARP_X, 0, WARP_Z);
      await ctx.wait(2_500);

      // ── SPAWN NPCs ─────────────────────────────────────────────────────
      const responses: string[] = [];
      const unsubResponses = ctx.dispatcher.onMessage(ConGenericMessage, (m) => {
        responses.push(m.msg);
      });

      const pos = ctx.position();
      for (let i = 0; i < N_SPAWN; i++) {
        const x = pos.x + 5 + i * 3;
        const z = pos.z;
        const cmd = `object create ${spawnTemplate} ${x.toFixed(2)} ${pos.y.toFixed(2)} ${z.toFixed(2)}`;
        ctx.send(new ConGenericMessage(cmd, 100));
        await ctx.wait(700);
      }
      await ctx.wait(2_000);
      unsubResponses();
      for (const r of responses) {
        const m = r.match(/NetworkId:\s*(\d+)/);
        if (m?.[1] !== undefined) {
          observed.spawnedIds.push(BigInt(m[1]) as NetworkId);
        }
      }

      // Disable god mode again — the test must be real.
      if (!SKIP_PROVISIONING) {
        await adminGodModeOff(ctx);
        await ctx.wait(250);
      }

      if (observed.spawnedIds.length === 0) {
        observed.spawnFailureReason = `/object create returned no NetworkId. Likely template '${spawnTemplate}' is unknown. Responses: ${JSON.stringify(responses)}`;
        console.warn(`[live-combat:${opts.profession}] ${observed.spawnFailureReason}`);
        return;
      }
      console.warn(
        `[live-combat:${opts.profession}] spawned ${observed.spawnedIds.length} ${spawnTemplate}`,
      );

      // Settle for baselines on the new creatures so combat.targets() can see them.
      await ctx.wait(2_500);

      // ── INSTALL COMBAT BEHAVIOR ────────────────────────────────────────
      const cb = installCombatBehavior(ctx, {
        profession: opts.profession,
        verify: true,
        logFn: (tag, payload) => {
          if (tag === 'combat:tick-loop:error' || tag === 'combat:tick:error') {
            observed.combatErrors.push(`${tag}: ${JSON.stringify(payload)}`);
          }
          if (tag === 'combat:fire' || tag === 'combat:heal') {
            observed.abilityCallCount++;
          }
        },
      });
      observed.installOk = true;
      cb.onEngage(() => {
        observed.engagedAtLeastOnce = true;
      });
      cb.onDisengage(() => {
        observed.disengagedAtLeastOnce = true;
      });

      // Aggro the first spawned NPC + force-engage the behavior. The
      // engagement watcher normally trips on incoming hits, but in the
      // test we're the aggressor — the tusken may take a few ticks to
      // reciprocate, and if our first attack kills it the watcher never
      // sees a defender flag at all. Force-engage so the rotation starts.
      const firstTarget = observed.spawnedIds[0];
      if (firstTarget !== undefined) {
        ctx.attackTarget(firstTarget);
        await cb.engage({ targetId: firstTarget });
      }

      // Hand control to combat for up to RUN_MS.
      try {
        await cb.runHostOperation(
          (signal) =>
            new Promise<void>((resolve, reject) => {
              const t = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
              }, RUN_MS);
              (t as { unref?: () => void }).unref?.();
              const onAbort = (): void => {
                clearTimeout(t);
                reject(new Error('combat-took-over'));
              };
              signal.addEventListener('abort', onAbort, { once: true });
            }),
        );
      } catch {
        // Expected — combat aborted the wait.
      }

      // Wait for combat to settle if still engaged.
      let settled = 0;
      while (cb.engaged && settled < 10_000) {
        await ctx.wait(1_000);
        settled += 1_000;
      }

      // Snapshot final state.
      observed.postHp = ctx.character.health.current;
      observed.postHpMax = ctx.character.health.max;
      observed.targetsAtEnd = ctx.combat.targets().length;

      // Cleanup: re-enable god mode + destroy any survivors so the next test
      // doesn't inherit hostile creatures (the admin account-pool is shared).
      await adminGodModeOn(ctx);
      await ctx.wait(250);
      for (const id of observed.spawnedIds) {
        ctx.send(new ConGenericMessage(`object destroy ${id.toString()}`, 101));
        await ctx.wait(150);
      }
      cb.dispose();
      await ctx.wait(1_500);
    },
  });

  // Assertions.
  expect(lifecycleResult.zonedInAt, 'zonedInAt populated').not.toBeNull();
  expect(lifecycleResult.scriptResult?.error, 'script did not throw').toBeUndefined();

  if (observed.spawnedIds.length === 0) {
    throw new Error(`admin-spawn failed: ${observed.spawnFailureReason ?? '(unknown)'}`);
  }

  expect(observed.installOk, 'installCombatBehavior succeeded').toBe(true);
  expect(observed.combatErrors, 'no tick-loop errors').toEqual([]);
  expect(observed.engagedAtLeastOnce, 'engaged on aggro').toBe(true);
  expect(observed.abilityCallCount, 'at least one rotation ability fired').toBeGreaterThanOrEqual(
    1,
  );
  expect(observed.postHp, 'character alive at end of test').toBeGreaterThan(0);

  if (REQUIRE_KILLS) {
    expect(
      observed.targetsAtEnd,
      'LIVE_COMBAT_REQUIRE_KILLS set; expected 0 surviving aggressors',
    ).toBe(0);
  } else if (observed.targetsAtEnd > 0) {
    console.warn(
      `[live-combat:${opts.profession}] ${observed.targetsAtEnd} target(s) still alive at end. Set LIVE_COMBAT_REQUIRE_KILLS=1 to enforce.`,
    );
  }

  console.warn(
    `[live-combat:${opts.profession}] DONE: spawned=${observed.spawnedIds.length} engaged=${observed.engagedAtLeastOnce} disengaged=${observed.disengagedAtLeastOnce} abilities=${observed.abilityCallCount} hp=${observed.postHp}/${observed.postHpMax} survivors=${observed.targetsAtEnd}`,
  );

  return observed;
}
