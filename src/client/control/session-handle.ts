/**
 * SessionHandle — the bridge between a {@link ControlRequest} and a live
 * scripted session.
 *
 * `ControlServer` is pure transport: it reads NDJSON lines off the socket
 * and calls `handle()` on whatever `SessionHandle` is currently attached.
 * The handle owns the dispatch — it maps query names to the projection
 * functions and action names to {@link SessionControl} transitions /
 * `ScriptContext` calls.
 *
 * Two builders:
 *  - {@link buildSessionHandle} — bound to a {@link SessionControl} and,
 *    optionally, a live `ScriptContext`. The game-stage builds one per
 *    script run (with a `ctx`), and one with `ctx: null` while a session
 *    is alive but no scenario is running (e.g. waiting out a reload that
 *    failed to compile — `ctl reload` must still work).
 *  - {@link buildStubHandle} — used while no session at all is attached
 *    (before zone-in). Answers `status` from the server metadata and
 *    rejects everything else with `no_session`.
 */

import type { ScriptContext } from '../script/context.js';
import {
  projectCombat,
  projectCooldowns,
  projectDatapad,
  projectGroup,
  projectInventory,
  projectKnowledge,
  projectLocation,
  projectWorld,
} from './projections.js';
import {
  type ControlRequest,
  type ControlResponse,
  errorResponse,
  okResponse,
} from './protocol.js';
import type { SessionControl } from './session-control.js';
import type { SessionMetadata } from './socket-registry.js';

/** What `ControlServer` exposes to the handles it builds. */
export interface ControlServerInfo {
  /** The session's discovery-sidecar metadata. */
  metadata: SessionMetadata;
}

/** The contract `ControlServer` calls into per request. */
export interface SessionHandle {
  /** Dispatch one request to a response. Never throws. */
  handle(request: ControlRequest): Promise<ControlResponse> | ControlResponse;
}

export interface BuildSessionHandleOptions {
  /** The live script context, or `null` between script runs. */
  ctx: ScriptContext | null;
  /** The session's directive state machine. */
  sessionControl: SessionControl;
  /** Server metadata + capability info. */
  serverInfo: ControlServerInfo;
  /** Whether `reload` is available (a `scriptProvider` is configured). */
  reloadCapable: boolean;
  /** `Date.now()` when the current scenario run started — for `scriptElapsedMs`. */
  scriptStartedAt: number;
  /** Last reload-compile error, surfaced in `status` while recovering. */
  lastReloadError?: string | null;
}

function strParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = params?.[key];
  return typeof v === 'string' ? v : undefined;
}

/** Common status fields shared by every handle. */
function baseStatus(meta: SessionMetadata, sessionAttached: boolean): Record<string, unknown> {
  return {
    protocolVersion: meta.protocolVersion,
    sessionName: meta.name,
    socketPath: meta.socketPath,
    supervised: meta.supervised,
    pid: meta.pid,
    account: meta.account,
    character: meta.character,
    planet: meta.planet,
    startedAt: meta.startedAt,
    sessionAttached,
  };
}

/**
 * Build a handle bound to a {@link SessionControl}. When `ctx` is non-null
 * a scenario is running and all queries resolve; when `ctx` is null the
 * session is alive but idle (e.g. recovering from a failed reload) and
 * non-`status` queries return `no_session` while the directive actions
 * still work.
 */
export function buildSessionHandle(opts: BuildSessionHandleOptions): SessionHandle {
  const { ctx, sessionControl, serverInfo, reloadCapable, scriptStartedAt } = opts;
  const meta = serverInfo.metadata;

  function status(): Record<string, unknown> {
    const base: Record<string, unknown> = {
      ...baseStatus(meta, true),
      reloadCapable,
      scriptRunning: ctx !== null,
      zonedIn: true,
      directive: sessionControl.directive,
      reason: sessionControl.reason,
      paused: sessionControl.isPaused(),
      triggers: sessionControl.listActions(),
    };
    if (opts.lastReloadError != null) base.lastReloadError = opts.lastReloadError;
    if (ctx === null) {
      base.note = 'session alive but no scenario running (reload in progress)';
      return base;
    }
    const character = ctx.character;
    const location = ctx.location;
    base.scriptElapsedMs = Date.now() - scriptStartedAt;
    base.worldObjectCount = ctx.world.size();
    base.player = {
      networkId: character.networkId.toString(),
      name: character.name,
      level: character.level,
      posture: character.posture,
      ready: character.ready,
      health: character.health,
      action: character.action,
      mind: character.mind,
      performance: character.performance,
      planet: location.planet,
      position: {
        x: location.position.x,
        y: location.position.y,
        z: location.position.z,
      },
      cell:
        location.cell === null
          ? null
          : {
              buildingId: location.cell.buildingId.toString(),
              cellName: location.cell.cellName,
              cellNumber: location.cell.cellNumber,
              isPublic: location.cell.isPublic,
            },
    };
    return base;
  }

  async function runQuery(request: ControlRequest): Promise<ControlResponse> {
    const { id, name, params } = request;
    if (name === 'status') return okResponse(id, status());
    if (ctx === null) {
      return errorResponse(id, 'no_session', 'no scenario is currently running');
    }
    switch (name) {
      case 'character':
        return okResponse(id, ctx.character.toJSON());
      case 'world':
        return okResponse(id, projectWorld(ctx.world, params));
      case 'inventory':
        return okResponse(id, projectInventory(ctx.inventory));
      case 'location':
        return okResponse(id, projectLocation(ctx.location));
      case 'group':
        return okResponse(id, projectGroup(ctx.group));
      case 'combat':
        return okResponse(id, projectCombat(ctx.combat));
      case 'cooldowns':
        return okResponse(id, projectCooldowns(ctx.cooldowns));
      case 'datapad':
        return okResponse(id, projectDatapad(ctx.datapad));
      case 'knowledge':
        return okResponse(id, await projectKnowledge(ctx.knowledge, params));
      default:
        return errorResponse(id, 'unknown_command', `unknown query "${name}"`);
    }
  }

  async function runAction(request: ControlRequest): Promise<ControlResponse> {
    const { id, name, params } = request;
    const reason = strParam(params, 'reason') ?? 'control socket';
    switch (name) {
      case 'pause':
        sessionControl.request('paused', reason);
        return okResponse(id, { directive: sessionControl.directive });
      case 'resume':
        sessionControl.request('run', reason);
        return okResponse(id, { directive: sessionControl.directive });
      case 'stop':
        sessionControl.request('stop', reason);
        return okResponse(id, { directive: sessionControl.directive });
      case 'logout':
        sessionControl.request('logout', reason);
        return okResponse(id, { directive: sessionControl.directive });
      case 'restart':
        if (!meta.supervised) {
          return errorResponse(
            id,
            'not_supported',
            'restart requires the host to run under a supervisor (runSupervised / --supervise)',
          );
        }
        sessionControl.request('restart', reason);
        return okResponse(id, { directive: sessionControl.directive });
      case 'reload':
        if (!reloadCapable) {
          return errorResponse(
            id,
            'not_supported',
            'reload requires a reloadable scenario (scriptProvider) — not configured',
          );
        }
        sessionControl.request('reload', reason);
        return okResponse(id, { directive: sessionControl.directive });
      case 'say': {
        const text = strParam(params, 'text');
        if (text === undefined || text === '') {
          return errorResponse(id, 'bad_request', 'say requires params.text');
        }
        if (ctx === null) {
          return errorResponse(id, 'no_session', 'no scenario running — cannot send chat');
        }
        const target = strParam(params, 'target');
        if (target !== undefined && target !== '') {
          ctx.tell(target, text);
          return okResponse(id, { told: target, text });
        }
        ctx.say(text);
        return okResponse(id, { said: text });
      }
      case 'trigger': {
        const action = strParam(params, 'action');
        if (action === undefined || action === '') {
          return errorResponse(id, 'bad_request', 'trigger requires params.action');
        }
        if (!sessionControl.listActions().includes(action)) {
          return errorResponse(
            id,
            'unknown_command',
            `no trigger named "${action}" — available: ${
              sessionControl.listActions().join(', ') || '(none)'
            }`,
          );
        }
        const args = params?.args;
        const result = await sessionControl.invokeAction(
          action,
          typeof args === 'object' && args !== null && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : undefined,
        );
        return okResponse(id, { triggered: action, result: result ?? null });
      }
      default:
        return errorResponse(id, 'unknown_command', `unknown action "${name}"`);
    }
  }

  return {
    async handle(request: ControlRequest): Promise<ControlResponse> {
      try {
        return request.kind === 'query' ? await runQuery(request) : await runAction(request);
      } catch (err) {
        return errorResponse(
          request.id,
          'session_error',
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  };
}

/**
 * Build the no-session handle. Answers `status` from the server metadata
 * (so a client can poll for the session to come up) and rejects every
 * other command with `no_session`.
 */
export function buildStubHandle(serverInfo: ControlServerInfo): SessionHandle {
  const meta = serverInfo.metadata;
  return {
    handle(request: ControlRequest): ControlResponse {
      if (request.kind === 'query' && request.name === 'status') {
        return okResponse(request.id, {
          ...baseStatus(meta, false),
          zonedIn: false,
          scriptRunning: false,
          note: 'no live session attached — host is starting up, zoning in, or has ended',
        });
      }
      return errorResponse(
        request.id,
        'no_session',
        'no live session is attached to this control socket yet',
      );
    },
  };
}
