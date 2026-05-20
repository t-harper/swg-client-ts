/**
 * NDJSON wire protocol for the bot control socket.
 *
 * One JSON object per line, `\n`-terminated. A client writes one
 * {@link ControlRequest} line and reads exactly one {@link ControlResponse}
 * line back, correlated by the request `id`. The transport is a Unix-domain
 * socket — `data` events on a stream do NOT respect message boundaries, so
 * the server (and client) buffer partial chunks via {@link readLines}.
 *
 * The protocol is deliberately tiny: no handshake frame, no framing beyond
 * the newline. A client verifies compatibility by issuing the `status`
 * query, whose response carries `protocolVersion`.
 */

/** Bumped only on a breaking change to the request/response shape. */
export const CONTROL_PROTOCOL_VERSION = 1;

export type ControlRequestKind = 'query' | 'action';

/** Read-only introspection queries. */
export type ControlQueryName =
  | 'status'
  | 'character'
  | 'world'
  | 'inventory'
  | 'location'
  | 'group'
  | 'combat'
  | 'cooldowns'
  | 'datapad'
  | 'knowledge';

/** State-mutating actions. */
export type ControlActionName =
  | 'stop'
  | 'logout'
  | 'restart'
  | 'pause'
  | 'resume'
  | 'reload'
  | 'say'
  | 'trigger';

export type ControlErrorCode =
  /** Request was unparseable / missing required fields / over the line limit. */
  | 'bad_request'
  /** `name` is not a recognized query or action. */
  | 'unknown_command'
  /** The server is up but no live session is currently attached. */
  | 'no_session'
  /** The command is recognized but unavailable in this configuration. */
  | 'not_supported'
  /** The query/action ran but threw. */
  | 'session_error';

/** One request line. `id` is echoed back on the matching response. */
export interface ControlRequest {
  /** Client-chosen correlation id. */
  id: string;
  kind: ControlRequestKind;
  /** A {@link ControlQueryName} or {@link ControlActionName}. */
  name: string;
  /** Optional command parameters (e.g. `world` filters, `say` text). */
  params?: Record<string, unknown>;
}

export interface ControlOkResponse {
  id: string;
  ok: true;
  /** JSON-safe payload — already normalized (no bigint/Date/Uint8Array). */
  data: unknown;
}

export interface ControlErrorResponse {
  id: string;
  ok: false;
  error: { code: ControlErrorCode; message: string };
}

export type ControlResponse = ControlOkResponse | ControlErrorResponse;

/** Build an `ok` response. */
export function okResponse(id: string, data: unknown): ControlOkResponse {
  return { id, ok: true, data };
}

/** Build an `error` response. */
export function errorResponse(
  id: string,
  code: ControlErrorCode,
  message: string,
): ControlErrorResponse {
  return { id, ok: false, error: { code, message } };
}

/** Result of {@link parseRequest}. `id` on the failure branch is best-effort. */
export type ParseRequestResult =
  | { ok: true; request: ControlRequest }
  | { ok: false; id: string; message: string };

/**
 * Parse one NDJSON line into a {@link ControlRequest}. Never throws — a
 * malformed line yields a `{ ok: false }` result carrying whatever `id`
 * could be recovered (so the server can still echo it on the error reply).
 */
export function parseRequest(line: string): ParseRequestResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, id: '', message: 'request is not valid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, id: '', message: 'request must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id : '';
  if (obj.kind !== 'query' && obj.kind !== 'action') {
    return { ok: false, id, message: "request.kind must be 'query' or 'action'" };
  }
  if (typeof obj.name !== 'string' || obj.name === '') {
    return { ok: false, id, message: 'request.name must be a non-empty string' };
  }
  const request: ControlRequest = { id, kind: obj.kind, name: obj.name };
  if (obj.params !== undefined) {
    if (typeof obj.params !== 'object' || obj.params === null || Array.isArray(obj.params)) {
      return { ok: false, id, message: 'request.params must be an object' };
    }
    request.params = obj.params as Record<string, unknown>;
  }
  return { ok: true, request };
}

/**
 * Serialize a request or response to a single NDJSON line (trailing `\n`).
 * Runs {@link toJsonSafe} first so a stray `bigint` (NetworkId) in a
 * projection can never throw `JSON.stringify`.
 */
export function encodeLine(value: ControlRequest | ControlResponse): string {
  return `${JSON.stringify(toJsonSafe(value))}\n`;
}

/**
 * Recursively normalize a value into a JSON-safe form: `bigint` → decimal
 * string, `Date` → ISO string, `Uint8Array` → hex string, `Map` → object
 * (string keys) or `[key, value][]` (non-string keys), `Set` → array.
 * Mirrors `normalizeForSnapshot` in `world-model.ts`.
 */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (value instanceof Map) {
    let allStringKeys = true;
    for (const k of value.keys()) {
      if (typeof k !== 'string') {
        allStringKeys = false;
        break;
      }
    }
    if (allStringKeys) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value) out[k as string] = toJsonSafe(v);
      return out;
    }
    return [...value].map(([k, v]) => [toJsonSafe(k), toJsonSafe(v)]);
  }
  if (value instanceof Set) return [...value].map(toJsonSafe);
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const norm = toJsonSafe(v);
      if (norm !== undefined) out[k] = norm;
    }
    return out;
  }
  return value;
}

/**
 * Yield complete UTF-8 lines from a readable stream, buffering partial
 * chunks across `data` events. Blank lines are skipped. Throws if a single
 * line exceeds `maxLineBytes` — a guard against an unbounded buffer from a
 * peer that never sends a newline.
 */
export async function* readLines(
  stream: NodeJS.ReadableStream,
  maxLineBytes = 1 << 20,
): AsyncGenerator<string> {
  let buf = '';
  for await (const chunk of stream) {
    buf += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() !== '') yield line;
      nl = buf.indexOf('\n');
    }
    if (buf.length > maxLineBytes) {
      throw new Error(`control protocol: line exceeded ${maxLineBytes} bytes`);
    }
  }
  if (buf.trim() !== '') yield buf;
}
