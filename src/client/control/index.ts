/**
 * Control socket — a Unix-domain-socket channel for querying and steering a
 * running scripted SWG session.
 *
 * A session host (a bot, or any `fullLifecycle` with `controlSocket` set)
 * binds a {@link ControlServer}; external clients connect with
 * {@link controlRequest} to read live state (world / character / inventory /
 * …) and issue write-actions (stop / logout / restart / pause / resume /
 * reload / say / trigger).
 *
 * See `src/client/control/` module files for the layered pieces:
 *  - `protocol.ts`       — NDJSON wire format.
 *  - `session-control.ts`— the directive state machine.
 *  - `socket-registry.ts`— `~/.swg-ts-client/sessions/` path + discovery.
 *  - `projections.ts`    — JSON projections of the live views.
 *  - `session-handle.ts` — request → `ScriptContext` dispatch.
 *  - `control-server.ts` — the socket listener.
 *  - `control-client.ts` — the socket client.
 *  - `supervisor.ts`     — the outer restart/reload lifecycle loop.
 */

export * from './protocol.js';
export * from './session-control.js';
export * from './socket-registry.js';
export * from './projections.js';
export * from './session-handle.js';
export * from './control-server.js';
export * from './control-client.js';
export * from './supervisor.js';
