/**
 * runSupervised — the OUTER lifecycle loop.
 *
 * Binds one {@link ControlServer} for the whole process lifetime, then runs
 * `client.fullLifecycle()` in a loop. After each lifecycle returns it reads
 * the {@link SessionControl} directive:
 *  - `restart` — reconnect the same character (new connection, warm caches).
 *  - anything else (`stop` / `logout` / the scenario finishing on its own)
 *    — stop the server and return.
 *
 * `reload` is NOT seen here — it is consumed inside `runGameStage`'s inner
 * loop, which re-runs a freshly imported scenario against the SAME live
 * connection without `fullLifecycle` ever returning.
 *
 * Used by the bots' `main()` and by `swg-ts-cli zone --supervise`.
 */

import type { ScenarioFn } from '../script/context.js';
import type { FullLifecycleOptions, LifecycleResult, SwgClient } from '../swg-client.js';
import { ControlServer } from './control-server.js';
import {
  type SessionControl,
  type SessionDirective,
  createSessionControl,
} from './session-control.js';

/** Lifecycle fields the supervisor injects itself. */
type SupervisedLifecycleOptions = Omit<
  FullLifecycleOptions,
  'script' | 'scriptProvider' | 'sessionControl' | 'controlSocket'
>;

export interface RunSupervisedOptions {
  /** The client to run the lifecycle on (its `Knowledge` cache stays warm across restarts). */
  client: SwgClient;
  /**
   * Re-importable scenario source. Called once per script run; on `reload`
   * the game-stage calls it again to pick up edited code. For a bot this
   * dynamically re-imports the bot's `-scenario` module with a cache-bust.
   */
  scriptProvider: () => Promise<ScenarioFn>;
  /** Lifecycle options minus the script/control fields the supervisor injects. */
  lifecycle: SupervisedLifecycleOptions;
  /** Session name → `~/.swg-ts-client/sessions/<name>.sock`. */
  sessionName: string;
  /**
   * Optionally inject a pre-built {@link SessionControl} — e.g. one a
   * SIGINT handler in the caller already holds a reference to. Defaults to
   * a fresh instance.
   */
  sessionControl?: SessionControl;
  /** Optional diagnostic log sink (defaults to no-op). */
  log?: (msg: string) => void;
  /**
   * Milliseconds to wait after a session logs out before reconnecting on
   * `restart`. The server holds the account's session open briefly after
   * LogoutMessage, so an immediate re-login would collide. Default 8000.
   */
  restartSettleMs?: number;
}

export interface RunSupervisedResult {
  /** How many `fullLifecycle` iterations ran. */
  iterations: number;
  /** The last lifecycle's result, or `null` if the first one threw. */
  lastLifecycle: LifecycleResult | null;
  /** The directive that ended the loop. */
  finalDirective: SessionDirective;
}

/** Run a supervised, restartable, reload-capable session loop. */
export async function runSupervised(opts: RunSupervisedOptions): Promise<RunSupervisedResult> {
  const sessionControl = opts.sessionControl ?? createSessionControl();
  const log = opts.log ?? ((): void => undefined);
  const restartSettleMs = opts.restartSettleMs ?? 8_000;

  const server = new ControlServer({
    name: opts.sessionName,
    supervised: true,
    account: opts.lifecycle.account,
    character: opts.lifecycle.characterName ?? null,
    planet: opts.lifecycle.planet ?? null,
  });
  await server.start();
  log(`[supervisor] control socket bound: ${server.socketPath}`);

  let iterations = 0;
  let lastLifecycle: LifecycleResult | null = null;
  try {
    while (true) {
      iterations++;
      log(`[supervisor] starting session (iteration ${iterations})`);
      lastLifecycle = await opts.client.fullLifecycle({
        ...opts.lifecycle,
        scriptProvider: opts.scriptProvider,
        sessionControl,
        controlSocket: server,
      });
      const directive = sessionControl.directive;
      if (directive === 'restart') {
        sessionControl.resetToRun();
        if (restartSettleMs > 0) {
          log(`[supervisor] restart requested — settling ${restartSettleMs}ms before reconnect`);
          await new Promise((r) => setTimeout(r, restartSettleMs));
        } else {
          log('[supervisor] restart requested — reconnecting');
        }
        continue;
      }
      log(`[supervisor] session ended (directive=${directive}) — shutting down`);
      break;
    }
  } finally {
    await server.stop();
  }

  return { iterations, lastLifecycle, finalDirective: sessionControl.directive };
}
