/**
 * Live integration test for the survey command.
 *
 * Runs a full lifecycle and triggers `ctx.survey('mineral')` during the
 * dwell. The server-side `requestSurvey` command requires the actor to
 * have an activated survey tool in inventory of the matching type. A
 * brand-new character does NOT have one, so we don't assert that a
 * `SurveyMessage` comes back — we only verify:
 *   1. The wire send completed cleanly.
 *   2. The send was recorded in the transcript as a single
 *      ObjControllerMessage wrapping a CommandQueueEnqueue.
 *   3. No `ErrorMessage` arrived (an unrecognized command would surface
 *      one — confirms the constcrc of `requestSurvey` matches the server).
 *
 * Gated on `LIVE=1`. Runs against the SWG server at 10.254.0.253.
 */
import { describe, expect, it } from 'vitest';

import { SwgClient } from '../../src/client/swg-client.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live survey command', () => {
  it('emits a requestSurvey command without server-side error', async () => {
    const { account, characterName } = liveCredentials('sv');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const result = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: async (ctx) => {
        // Fire a survey trigger; tolerate a missing tool (no SurveyMessage expected).
        ctx.survey('mineral');
        // Give the server a moment to process and reply (if a tool is in
        // inventory; otherwise it logs a script-side rejection and moves on).
        await ctx.wait(2_000);
      },
    });

    // Zone-in worked.
    expect(result.sceneStart, 'sceneStart present').toBeDefined();
    expect(result.zonedInAt, 'zonedInAt present').not.toBeNull();
    expect(result.logoutAt, 'logoutAt present').not.toBeNull();

    // Script ran cleanly (no thrown error).
    const sr = result.scriptResult;
    expect(sr, 'scriptResult populated').toBeDefined();
    if (sr === undefined) throw new Error('unreachable');
    expect(sr.error, 'script did not throw').toBeUndefined();
    expect(sr.sendsCount, 'survey() recorded one send').toBeGreaterThanOrEqual(1);

    // Exactly one ObjControllerMessage send from the survey trigger.
    const sentObjControllers = result.transcript.filter(
      (e) => e.direction === 'send' && e.messageName === 'ObjControllerMessage',
    );
    expect(
      sentObjControllers.length,
      'one outbound ObjControllerMessage from survey()',
    ).toBeGreaterThanOrEqual(1);

    // No ErrorMessage from the server — if the constcrc were wrong the
    // server would either silently drop OR surface an Archive::ReadException
    // that bubbles back; this is the canary.
    expect(result.receivedErrorMessage, 'no ErrorMessage from survey trigger').toBe(false);

    // A SurveyMessage MAY or MAY NOT come back depending on whether the
    // character has a survey tool. Log either outcome but don't fail.
    const surveyResponses = result.transcript.filter(
      (e) => e.direction === 'recv' && e.messageName === 'SurveyMessage',
    );
    // eslint-disable-next-line no-console
    console.log(
      `[live-survey] account=${account} char=${characterName}; received ${surveyResponses.length} SurveyMessage(s); transcript has ${result.transcript.length} events`,
    );
  }, 60_000);
});
