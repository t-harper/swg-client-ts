/**
 * ControlServer — the Unix-domain-socket listener for one running session.
 *
 * Pure transport: it binds `~/.swg-ts-client/sessions/<name>.sock`, reads
 * NDJSON request lines, and forwards each to whatever {@link SessionHandle}
 * is currently attached. The server outlives individual scenario runs — a
 * supervisor binds it once for the whole process and the game-stage swaps
 * the attached handle on every script run / reload.
 *
 * While no session is attached the server answers from a stub handle so a
 * client polling `status` during zone-in still gets a useful reply.
 */

import { chmod, rm, stat } from 'node:fs/promises';
import { type Server, type Socket, connect, createServer } from 'node:net';
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlResponse,
  encodeLine,
  errorResponse,
  parseRequest,
  readLines,
} from './protocol.js';
import { type ControlServerInfo, type SessionHandle, buildStubHandle } from './session-handle.js';
import {
  type SessionMetadata,
  ensureSessionsDir,
  removeSessionFiles,
  sanitizeSessionName,
  socketPathFor,
  writeSessionMetadata,
} from './socket-registry.js';

export interface ControlServerOptions {
  /** Session name → `~/.swg-ts-client/sessions/<name>.sock`. */
  name: string;
  /** Whether `restart` is available (host runs under a supervisor loop). */
  supervised?: boolean;
  /** Login account — recorded in the metadata sidecar. */
  account?: string | null;
  /** Character name — may be refined later via {@link ControlServer.updateMetadata}. */
  character?: string | null;
  /** Planet — may be refined later. */
  planet?: string | null;
}

/** Milliseconds to wait when probing whether an existing socket is alive. */
const PROBE_TIMEOUT_MS = 500;

export class ControlServer {
  private readonly _metadata: SessionMetadata;
  private server: Server | null = null;
  private readonly connections = new Set<Socket>();
  private currentHandle: SessionHandle;
  private started = false;

  constructor(opts: ControlServerOptions) {
    const name = sanitizeSessionName(opts.name);
    this._metadata = {
      name,
      pid: process.pid,
      account: opts.account ?? null,
      character: opts.character ?? null,
      planet: opts.planet ?? null,
      socketPath: socketPathFor(name),
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      supervised: opts.supervised ?? false,
      startedAt: new Date().toISOString(),
    };
    this.currentHandle = buildStubHandle({ metadata: this._metadata });
  }

  /** The session's metadata sidecar contents. */
  get metadata(): SessionMetadata {
    return this._metadata;
  }

  /** Server info handed to the handles this server builds. */
  get serverInfo(): ControlServerInfo {
    return { metadata: this._metadata };
  }

  /** Absolute path of the bound socket. */
  get socketPath(): string {
    return this._metadata.socketPath;
  }

  /** Whether `restart` is available for sessions on this server. */
  get supervised(): boolean {
    return this._metadata.supervised;
  }

  /**
   * Bind the socket. Cleans up a stale socket file left by a crashed
   * predecessor; throws if a *live* server already owns the path.
   */
  async start(): Promise<void> {
    if (this.started) return;
    await ensureSessionsDir();
    await this.clearStaleSocket();

    const server = createServer((socket) => {
      void this.onConnection(socket);
    });
    server.on('error', (err) => {
      process.stderr.write(`[control] server error: ${err.message}\n`);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      server.listen(this.socketPath, () => {
        server.off('error', onError);
        resolve();
      });
    });
    // The control socket must never, by itself, keep the process alive —
    // the running scenario does that. stop() tears it down explicitly.
    server.unref();
    this.server = server;
    this.started = true;
    // Owner-only access. A tiny race exists between listen() and chmod();
    // acceptable for a single-user developer tool.
    await chmod(this.socketPath, 0o600).catch(() => undefined);
    await writeSessionMetadata(this._metadata);
  }

  /** Refine the metadata sidecar (e.g. once the real character is known). */
  async updateMetadata(
    patch: Partial<Pick<SessionMetadata, 'account' | 'character' | 'planet'>>,
  ): Promise<void> {
    if (patch.account !== undefined) this._metadata.account = patch.account;
    if (patch.character !== undefined) this._metadata.character = patch.character;
    if (patch.planet !== undefined) this._metadata.planet = patch.planet;
    if (this.started) await writeSessionMetadata(this._metadata).catch(() => undefined);
  }

  /** Attach a live session handle — subsequent requests route to it. */
  attachSession(handle: SessionHandle): void {
    this.currentHandle = handle;
  }

  /** Detach the live session — requests fall back to the stub handle. */
  detachSession(): void {
    this.currentHandle = buildStubHandle({ metadata: this._metadata });
  }

  /** Close the socket, drop all connections, and remove the on-disk files. */
  async stop(): Promise<void> {
    this.detachSession();
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (this.server !== null) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    this.started = false;
    await removeSessionFiles(this._metadata.name);
  }

  /** Per-connection request loop. One request line in, one response line out. */
  private async onConnection(socket: Socket): Promise<void> {
    this.connections.add(socket);
    socket.unref();
    socket.on('error', () => {
      // client hung up mid-write — nothing to do, the loop will end
    });
    try {
      for await (const line of readLines(socket)) {
        const parsed = parseRequest(line);
        let response: ControlResponse;
        if (!parsed.ok) {
          response = errorResponse(parsed.id, 'bad_request', parsed.message);
        } else {
          try {
            response = await this.currentHandle.handle(parsed.request);
          } catch (err) {
            response = errorResponse(
              parsed.request.id,
              'session_error',
              err instanceof Error ? err.message : String(err),
            );
          }
        }
        if (!socket.writableEnded) socket.write(encodeLine(response));
      }
    } catch (err) {
      // readLines throws on an over-long line — report once, then close.
      if (!socket.writableEnded) {
        socket.write(
          encodeLine(
            errorResponse('', 'bad_request', err instanceof Error ? err.message : String(err)),
          ),
        );
      }
    } finally {
      this.connections.delete(socket);
      socket.end();
    }
  }

  /**
   * If the socket path already exists, decide whether it is live (another
   * server owns it — fatal) or stale (a crashed predecessor — unlink it).
   */
  private async clearStaleSocket(): Promise<void> {
    const exists = await stat(this.socketPath).then(
      () => true,
      () => false,
    );
    if (!exists) return;
    if (await probeSocketAlive(this.socketPath)) {
      throw new Error(`control socket ${this.socketPath} is already in use by a live session`);
    }
    await rm(this.socketPath, { force: true });
  }
}

/** Connect briefly to a socket path — true if something answers. */
function probeSocketAlive(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(alive);
    };
    const client = connect(path);
    client.once('connect', () => finish(true));
    client.once('error', () => finish(false));
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
}
