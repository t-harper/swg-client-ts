/**
 * Live integration test: exercise `ctx.survey.lastResults`, `ctx.missions.*`,
 * and `ctx.crafting.session` against the running swg-server.
 *
 * Gated on `LIVE=1`. Runs a full Stage 1 → 4 lifecycle. During the dwell:
 *   1. Admin-spawn a `survey_tool_mineral` into the player's inventory.
 *   2. Fetch the resource list for the tool (server-driven), pick the
 *      first available type name, and call `ctx.survey(toolId, name)`.
 *   3. Wait for the inbound `SurveyMessage` to settle, then read
 *      `ctx.survey.lastResults` — must be non-null and carry the
 *      requested resource type plus a non-empty point list.
 *   4. Try to call `ctx.requestMissionList` against a nearby mission
 *      terminal if one exists in the world; otherwise just assert the
 *      cache is readable. Either way `ctx.missions.active` must not throw.
 *   5. Crafting cache: assert `ctx.crafting.session.active === false`
 *      before doing anything (the documented stale-state limitation means
 *      we can't reliably end-to-end a craft in a live test).
 *
 * Account must be in `stella_admin.tab` for `/object createIn` to work
 * (the default `tslive*` admin pool is whitelisted).
 */
import { describe, expect, it } from 'vitest';

import { SwgClient } from '../../src/client/swg-client.js';
import { ConGenericMessage } from '../../src/messages/game/con-generic-message.js';
import { ObjectTypeTags } from '../../src/messages/game/baselines/index.js';
import { ResourceListForSurveyMessage } from '../../src/messages/game/survey/index.js';
import type { NetworkId } from '../../src/types.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

const SURVEY_TOOL_TEMPLATE = 'object/tangible/survey_tool/survey_tool_mineral.iff';

describe.skipIf(!LIVE)('live ScriptContext caches: survey + missions + crafting', () => {
  it('survey cache populates lastResults; missions cache is queryable; crafting starts inactive', async () => {
    const { account, characterName } = await liveCredentials('cch');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const observed = {
      // Survey ---
      inventoryReady: false,
      surveyToolId: null as NetworkId | null,
      surveyToolSpawnResponses: [] as string[],
      allConGenericResponses: [] as string[],
      resourceListFetched: false,
      resourceTypeName: null as string | null,
      surveyLastResults: null as {
        resourceType: string;
        pointCount: number;
        bestConcentration: number | null;
      } | null,
      // Missions ---
      missionTerminalsNearby: 0,
      missionsActiveBefore: -1,
      missionsActiveAfter: -1,
      missionsThrew: false,
      // Crafting ---
      craftingActiveAtStart: true,
      bailReason: null as string | null,
    };

    const lifecycleResult = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: async (ctx) => {
        // === SETUP ============================================================
        // Wait for inventory auto-discovery before we try to drop a tool into it.
        const t0 = Date.now();
        while (!ctx.inventory.ready && Date.now() - t0 < 5_000) {
          await ctx.wait(100);
        }
        observed.inventoryReady = ctx.inventory.ready;
        if (!ctx.inventory.containerId) {
          observed.bailReason = 'inventory containerId never discovered';
          return;
        }
        const invId = ctx.inventory.containerId;

        // Crafting is necessarily inactive at the start of a fresh dwell
        // (the server-side `m_craftingStage` is per-player and starts
        // un-set; even if a previous session leaked stale state, the
        // SCRIPT context's local cache resets to inactive on each
        // `createScriptContext` call).
        observed.craftingActiveAtStart = ctx.crafting.session.active;

        // === SURVEY ===========================================================
        // 1. Admin-spawn a mineral survey tool into the inventory.
        //    Subscribe to ConGenericMessage replies for the entire survey
        //    flow so we can diagnose silently-failing admin commands.
        const allConGenericResponses: string[] = [];
        const unsubAllCon = ctx.dispatcher.onMessage(ConGenericMessage, (m) => {
          allConGenericResponses.push(m.msg);
        });
        // Set god mode via the standard CommandQueue path — same approach
        // as live-datapad-auto.test.ts. The setGodMode command-table entry
        // maps to `commandFuncAdminSetGodMode` which fires immediately.
        ctx.useAbility('setGodMode', 0n, '1');
        // Generous settle — admin-mode application can take a couple of
        // seconds to propagate before subsequent /object and /resource
        // commands are recognized.
        await ctx.wait(3_000);
        const spawnResponses: string[] = [];
        const unsubSpawn = ctx.dispatcher.onMessage(ConGenericMessage, (m) => {
          spawnResponses.push(m.msg);
        });
        ctx.send(new ConGenericMessage(`object createIn ${SURVEY_TOOL_TEMPLATE} ${invId.toString()}`, 200));
        await ctx.wait(3_000);
        unsubSpawn();
        observed.surveyToolSpawnResponses = spawnResponses.slice(0, 6);
        // Parse the new tool's NetworkId straight from the ConGeneric reply.
        // The server echoes "NetworkId: <id>" on success — much more
        // reliable than scanning inventory by template (the live server
        // pushes admin-spawned items via SceneCreateObjectByCrc and
        // `templateName` is left null on those WorldObjects).
        let spawnedToolId: NetworkId | null = null;
        for (const r of spawnResponses) {
          const m = r.match(/NetworkId:\s*(\d+)/);
          if (m && m[1] !== undefined) {
            spawnedToolId = BigInt(m[1]);
            break;
          }
        }
        if (spawnedToolId === null) {
          observed.bailReason =
            `/object createIn did not echo a NetworkId within 2.5s. ` +
            `Account ${account} may not be in stella_admin.tab. ` +
            `Responses: ${JSON.stringify(spawnResponses)}`;
          return;
        }
        observed.surveyToolId = spawnedToolId;

        // 2. Brief settle so the WorldModel picks up the new object (the
        //    server sends a SceneCreateObjectByCrc + baselines burst right
        //    after the spawn response).
        await ctx.wait(1_500);

        // 3. Discover what resource type names are available on the current
        //    planet via the admin `resource getSurveyList` command. This
        //    bypasses survey_tool_script's OnObjectMenuSelect — which won't
        //    work for fresh admin-spawned tools because it requires
        //    `VAR_SETTINGS_PLAYER` to be set on the tool (only set by the
        //    SUI range-setter dialog, not by admin spawn).
        //
        //    `resource getSurveyList <className> <toolId>` directly calls
        //    `SurveySystem::requestResourceListForSurvey` server-side, which
        //    pushes a `ResourceListForSurveyMessage` to the client.
        try {
          const listResponses: ResourceListForSurveyMessage[] = [];
          const unsubList = ctx.dispatcher.onMessage(ResourceListForSurveyMessage, (m) => {
            listResponses.push(m);
          });
          // Send the admin command up to 3 times if no response comes —
          // the server occasionally drops the first ConGeneric reply when
          // it arrives within a few hundred ms of a setGodMode propagation.
          for (let attempt = 0; attempt < 3 && listResponses.length === 0; attempt++) {
            ctx.send(
              new ConGenericMessage(
                `resource getSurveyList mineral ${spawnedToolId.toString()}`,
                203 + attempt,
              ),
            );
            // Wait up to 4s for each attempt.
            const attemptDeadline = Date.now() + 4_000;
            while (listResponses.length === 0 && Date.now() < attemptDeadline) {
              await ctx.wait(150);
            }
          }
          unsubList();
          let pickedResourceName: string | null = null;
          if (listResponses.length === 0) {
            observed.bailReason =
              'admin `resource getSurveyList mineral` returned no ResourceListForSurveyMessage within 5s';
          } else {
            const resourceList = listResponses[0]?.data ?? [];
            observed.resourceListFetched = true;
            if (resourceList.length === 0) {
              observed.bailReason =
                'admin `resource getSurveyList mineral` returned an empty list (no mineral resources spawned right now)';
            } else {
              const first = resourceList[0];
              if (first !== undefined) {
                pickedResourceName = first.resourceName;
                observed.resourceTypeName = first.resourceName;
              }
            }
          }

          if (pickedResourceName !== null) {
            // 4. Trigger the survey via the admin `resource survey` command —
            //    same rationale: bypasses the survey_tool_script's
            //    OnRequestSurvey nested-container / posture checks that can
            //    fail in admin contexts. Format:
            //      `resource survey <className> <typeName> <range> <numPoints>`
            //
            //    BUT — we still need `ctx.survey()` to fire so the cache
            //    tags the incoming SurveyMessage with the resource type
            //    name. We call ctx.survey() (which sends `requestsurvey`
            //    via command-queue) just to record the pending resource
            //    type in the cache; then send the admin command which is
            //    what actually causes the SurveyMessage to come back.
            ctx.survey(spawnedToolId, pickedResourceName);
            ctx.send(
              new ConGenericMessage(
                `resource survey mineral ${pickedResourceName} 64 5`,
                204,
              ),
            );
            // Wait up to 15s for SurveyMessage to arrive.
            const surveyDeadline = Date.now() + 15_000;
            while (ctx.survey.lastResults === null && Date.now() < surveyDeadline) {
              await ctx.wait(250);
            }
            const lr = ctx.survey.lastResults;
            if (lr !== null) {
              const best = ctx.survey.bestKnown(pickedResourceName);
              observed.surveyLastResults = {
                resourceType: lr.resourceType,
                pointCount: lr.points.length,
                bestConcentration: best?.concentration ?? null,
              };
            }
          }
        } catch (err) {
          observed.bailReason = `survey flow threw: ${err instanceof Error ? err.message : String(err)}`;
        }

        // === MISSIONS =========================================================
        // ctx.missions.active should always be readable (cache shape is
        // present even when empty). Snapshot before and after a best-effort
        // `requestMissionList` to a nearby terminal.
        try {
          observed.missionsActiveBefore = ctx.missions.active.length;

          // Scan the WorldModel for any TANO whose templateName matches a
          // mission terminal. On Mos Eisley there are usually several
          // (planetary, faction, etc.) within radial range.
          const terminals = ctx.world
            .byType(ObjectTypeTags.TANO)
            .filter((o) => o.templateName !== undefined && /mission_terminal/.test(o.templateName));
          observed.missionTerminalsNearby = terminals.length;

          if (terminals.length > 0) {
            const t = terminals[0];
            if (t !== undefined) {
              ctx.requestMissionList(t.id, { flags: 0 });
              await ctx.wait(3_000);
            }
          } else {
            // No terminal in range — just settle and re-read.
            await ctx.wait(500);
          }
          observed.missionsActiveAfter = ctx.missions.active.length;
        } catch (err) {
          observed.missionsThrew = true;
          observed.bailReason =
            (observed.bailReason ?? '') +
            ` mission flow threw: ${err instanceof Error ? err.message : String(err)}`;
        }
        unsubAllCon();
        observed.allConGenericResponses = allConGenericResponses.slice(0, 20);

        // Cleanup: destroy the survey tool we spawned so it doesn't leak
        // into future test runs. Best-effort — ignore errors.
        if (spawnedToolId !== null) {
          ctx.send(new ConGenericMessage(`object destroy ${spawnedToolId.toString()}`, 250));
          await ctx.wait(300);
        }
      },
    });

    // === ASSERTIONS =========================================================
    expect(lifecycleResult.zonedInAt, 'zoned in successfully').not.toBeNull();
    expect(lifecycleResult.scriptResult?.error, 'script did not throw').toBeUndefined();
    expect(observed.inventoryReady, 'inventory must be ready by dwell start').toBe(true);

    // Crafting cache: must start inactive (script just started — no session
    // open at this point unless server-side stale state somehow leaked, in
    // which case the cache's reset on construction still keeps us at false).
    expect(
      observed.craftingActiveAtStart,
      'ctx.crafting.session.active must be false at script start',
    ).toBe(false);

    // Survey cache: tool must have spawned + the live survey flow must have
    // returned a SurveyMessage that the cache captured.
    expect(
      observed.surveyToolId,
      `survey tool must spawn via /object createIn (bailReason=${observed.bailReason ?? 'n/a'})`,
    ).not.toBeNull();
    expect(
      observed.resourceListFetched,
      `resource list must fetch successfully via admin getSurveyList (bailReason=${observed.bailReason ?? 'n/a'})`,
    ).toBe(true);
    expect(
      observed.resourceTypeName,
      'a resource type name must be selected from the survey list',
    ).not.toBeNull();
    expect(
      observed.surveyLastResults,
      `ctx.survey.lastResults must populate after the live SurveyMessage arrives ` +
        `(bailReason=${observed.bailReason ?? 'n/a'})`,
    ).not.toBeNull();
    if (observed.surveyLastResults !== null) {
      expect(
        observed.surveyLastResults.resourceType,
        'cache must tag results with the requested resource type',
      ).toBe(observed.resourceTypeName);
      expect(
        observed.surveyLastResults.pointCount,
        'survey result must carry at least one sample point',
      ).toBeGreaterThan(0);
      expect(
        observed.surveyLastResults.bestConcentration,
        'bestKnown() must return a sample after lastResults populates',
      ).not.toBeNull();
    }

    // Missions cache: must be readable (no throws). The count may be 0 if
    // the cluster's mission spawner hasn't put anything in range yet — that
    // is itself fine, the test is about cache-shape integrity, not
    // populated content.
    expect(observed.missionsThrew, 'ctx.missions.* must not throw').toBe(false);
    expect(
      observed.missionsActiveBefore,
      'ctx.missions.active.length must be readable (>=0)',
    ).toBeGreaterThanOrEqual(0);
    expect(
      observed.missionsActiveAfter,
      'ctx.missions.active.length after request must be readable (>=0)',
    ).toBeGreaterThanOrEqual(0);

    // Diagnostic — useful when the soft missions check returns 0.
    // eslint-disable-next-line no-console
    console.log(
      `[live-cache-survey-mission] account=${account} character=${characterName}\n` +
        `  inventoryReady=${observed.inventoryReady}\n` +
        `  surveyToolId=${observed.surveyToolId?.toString() ?? 'null'}\n` +
        `  resourceList fetched=${observed.resourceListFetched} type=${observed.resourceTypeName ?? 'null'}\n` +
        `  surveyLastResults=${JSON.stringify(observed.surveyLastResults)}\n` +
        `  missionTerminalsNearby=${observed.missionTerminalsNearby}\n` +
        `  missions.active before=${observed.missionsActiveBefore} after=${observed.missionsActiveAfter}\n` +
        `  craftingActiveAtStart=${observed.craftingActiveAtStart}\n` +
        `  bailReason=${observed.bailReason ?? 'none'}\n` +
        `  ConGeneric responses (first 20):\n` +
        observed.allConGenericResponses.map((r, i) => `    [${i}] ${r}`).join('\n'),
    );
  }, 120_000);
});
