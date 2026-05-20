/**
 * ControlClient — the socket-client side of the control protocol.
 *
 * One {@link controlRequest} call opens a Unix-domain-socket connection,
 * writes a single NDJSON request line, reads the matching response line,
 * and closes. Used by the `swg-ts-cli ctl` subcommand; also handy for
 * tests and ad-hoc tooling.
 */

import { connect } from 'node:net';
import { type ControlRequest, type ControlResponse, encodeLine, readLines } from './protocol.js';

let requestCounter = 0;

/** A request to send — `id` is generated automatically. */
export interface ControlRequestSpec {
  kind: 'query' | 'action';
  name: string;
  params?: Record<string, unknown>;
}

/**
 * Send one request to a control socket and resolve with the response.
 * Rejects on connection failure, timeout, or a closed socket. A non-`ok`
 * {@link ControlResponse} (an application-level error) still *resolves* —
 * the caller inspects `response.ok`.
 */
export async function controlRequest(
  socketPath: string,
  spec: ControlRequestSpec,
  opts: { timeoutMs?: number } = {},
): Promise<ControlResponse> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const id = `cli-${Date.now().toString(36)}-${(requestCounter++).toString(36)}`;
  const request: ControlRequest = {
    id,
    kind: spec.kind,
    name: spec.name,
    ...(spec.params !== undefined ? { params: spec.params } : {}),
  };

  return new Promise<ControlResponse>((resolve, reject) => {
    const socket = connect(socketPath);
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      action();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`control request timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );
    timer.unref?.();

    socket.on('error', (err: NodeJS.ErrnoException) => {
      const hint =
        err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
          ? ` — no live session at ${socketPath}`
          : '';
      finish(() => reject(new Error(`control socket unreachable${hint}: ${err.message}`)));
    });
    socket.on('connect', () => {
      socket.write(encodeLine(request));
    });

    void (async () => {
      try {
        for await (const line of readLines(socket)) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            (parsed as { id?: unknown }).id === id
          ) {
            finish(() => resolve(parsed as ControlResponse));
            return;
          }
        }
        finish(() => reject(new Error('control socket closed before responding')));
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    })();
  });
}
