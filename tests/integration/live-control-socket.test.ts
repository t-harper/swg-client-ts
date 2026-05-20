/**
 * Live integration test for the control socket.
 *
 * Gated on `LIVE=1`. Runs against the SWG server at 10.254.0.253.
 *
 * Zones a real session in with `controlSocket` set, then drives it entirely
 * over the Unix-domain control socket:
 *   - polls `status` until the session is attached + zoned in
 *   - `listSessions()` discovers the session sidecar
 *   - `get character` / `world` / `inventory` / `location` all decode
 *   - `pause` → `resume` flips the directive
 *   - `say` fires an in-game chat line
 *   - `stop` ends the session; the lifecycle promise resolves with a logout
 */
import { describe, expect, it } from 'vitest';
import { controlRequest } from '../../src/client/control/control-client.js';
import { listSessions, socketPathFor } from '../../src/client/control/socket-registry.js';
import { SwgClient } from '../../src/client/swg-client.js';
import type { ScenarioFn } from '../../src/index.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live control socket', () => {
  it('queries and steers a zoned-in session over the control socket', async () => {
    const { account, characterName } = await liveCredentials('cs');
    await sessionSettle();
    const sessionName = `livectl-${Date.now().toString(36)}`;
    const socketPath = socketPathFor(sessionName);
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    // A long dwell — the test ends it early with `ctl stop`. A non-zero
    // remaining hold is skipped once `stop` flips the directive.
    const scriptProvider = async (): Promise<ScenarioFn> => {
      return async (ctx) => {
        await ctx.wait(120_000);
      };
    };

    const lifecyclePromise = client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 120_000,
      controlSocket: sessionName,
      scriptProvider,
    });

    try {
      // Poll until the session is attached + zoned in.
      const deadline = Date.now() + 60_000;
      let zonedIn = false;
      while (Date.now() < deadline) {
        try {
          const resp = await controlRequest(socketPath, { kind: 'query', name: 'status' });
          if (resp.ok && (resp.data as { zonedIn?: boolean }).zonedIn === true) {
            zonedIn = true;
            break;
          }
        } catch {
          // socket not bound yet — keep polling
        }
        await new Promise((r) => setTimeout(r, 1_000));
      }
      expect(zonedIn, 'session attached + zoned in').toBe(true);

      // status reports a live, reload-capable session.
      const status = await controlRequest(socketPath, { kind: 'query', name: 'status' });
      expect(status.ok).toBe(true);
      if (status.ok) {
        const d = status.data as Record<string, unknown>;
        expect(d.scriptRunning).toBe(true);
        expect(d.reloadCapable).toBe(true);
      }

      // listSessions() discovers the session sidecar.
      const sessions = await listSessions();
      expect(sessions.some((s) => s.name === sessionName)).toBe(true);

      // character query — returns the live session's character sheet.
      // (On a pooled/reused account `fullLifecycle` adopts an existing
      // character, so we don't assert a specific name — only that the
      // socket round-trips a real, populated character sheet.)
      const character = await controlRequest(socketPath, { kind: 'query', name: 'character' });
      expect(character.ok).toBe(true);
      if (character.ok) {
        const sheet = character.data as { name?: unknown; level?: unknown };
        expect(typeof sheet.name).toBe('string');
        expect((sheet.name as string).length).toBeGreaterThan(0);
        expect(typeof sheet.level).toBe('number');
      }

      // world query — at least the player object is present.
      const world = await controlRequest(socketPath, {
        kind: 'query',
        name: 'world',
        params: { limit: 5 },
      });
      expect(world.ok).toBe(true);
      if (world.ok) {
        const d = world.data as { totalObjects: number; returnedObjects: number };
        expect(d.totalObjects).toBeGreaterThan(0);
        expect(d.returnedObjects).toBeLessThanOrEqual(5);
      }

      // inventory + location queries decode without error.
      expect((await controlRequest(socketPath, { kind: 'query', name: 'inventory' })).ok).toBe(
        true,
      );
      expect((await controlRequest(socketPath, { kind: 'query', name: 'location' })).ok).toBe(true);

      // pause → resume flips the directive.
      await controlRequest(socketPath, { kind: 'action', name: 'pause' });
      const paused = await controlRequest(socketPath, { kind: 'query', name: 'status' });
      if (paused.ok) expect((paused.data as { directive: string }).directive).toBe('paused');
      await controlRequest(socketPath, { kind: 'action', name: 'resume' });
      const resumed = await controlRequest(socketPath, { kind: 'query', name: 'status' });
      if (resumed.ok) expect((resumed.data as { directive: string }).directive).toBe('run');

      // say — fire an in-game chat line through the bot.
      const said = await controlRequest(socketPath, {
        kind: 'action',
        name: 'say',
        params: { text: 'hello from the control socket' },
      });
      expect(said.ok).toBe(true);

      // stop — ends the session.
      const stopped = await controlRequest(socketPath, { kind: 'action', name: 'stop' });
      expect(stopped.ok).toBe(true);

      const result = await lifecyclePromise;
      expect(result.logoutAt, 'session logged out cleanly').not.toBeNull();
    } finally {
      // Ensure the lifecycle is not left dwelling if an assertion threw early.
      try {
        await controlRequest(socketPath, { kind: 'action', name: 'stop' }, { timeoutMs: 3_000 });
      } catch {
        // already stopped / socket gone
      }
      await lifecyclePromise.catch(() => undefined);
    }
  }, 180_000);
});
