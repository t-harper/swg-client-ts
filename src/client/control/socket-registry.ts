/**
 * Socket-file path conventions + the discovery sidecar for control sockets.
 *
 * Each running session listens on a Unix-domain socket under
 * `~/.swg-ts-client/sessions/<name>.sock` and writes a `<name>.json`
 * metadata sidecar next to it so a `ctl list` can enumerate live sessions
 * without connecting to every socket.
 *
 * `~/.swg-ts-client/` is the same runtime directory the character pool
 * uses — it lives outside the repo, so nothing here is committed.
 */

import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A control session's discovery sidecar (`<name>.json`). */
export interface SessionMetadata {
  /** Session name — the `<name>` in `<name>.sock` / `<name>.json`. */
  name: string;
  /** PID of the process hosting the session. */
  pid: number;
  /** Account the session logged in as, if known. */
  account: string | null;
  /** Character name, if known. */
  character: string | null;
  /** Planet, if known. */
  planet: string | null;
  /** Absolute path of the `.sock` file. */
  socketPath: string;
  /** Control protocol version the host speaks. */
  protocolVersion: number;
  /** Whether `restart` is available (host runs under a supervisor loop). */
  supervised: boolean;
  /** ISO timestamp the session bound its socket. */
  startedAt: string;
}

/** A `listSessions()` entry — metadata plus a liveness check on the PID. */
export interface SessionListEntry extends SessionMetadata {
  /** True if the host PID still appears to be running. */
  pidAlive: boolean;
}

const SESSION_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** The directory holding every session's `.sock` + `.json` files. */
export function sessionsDir(): string {
  return join(homedir(), '.swg-ts-client', 'sessions');
}

/**
 * Validate a session name. Allowed: ASCII letters, digits, `.`, `_`, `-`.
 * Rejects anything that could escape `sessionsDir()` (slashes, `..`, etc.).
 */
export function sanitizeSessionName(name: string): string {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`invalid session name "${name}" — allowed characters: letters, digits, . _ -`);
  }
  return name;
}

/** Absolute path of `<name>`'s Unix-domain socket. */
export function socketPathFor(name: string): string {
  return join(sessionsDir(), `${sanitizeSessionName(name)}.sock`);
}

/** Absolute path of `<name>`'s metadata sidecar. */
export function metadataPathFor(name: string): string {
  return join(sessionsDir(), `${sanitizeSessionName(name)}.json`);
}

/** Create `sessionsDir()` if it does not exist. */
export async function ensureSessionsDir(): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true });
}

/** Write `<name>.json` atomically (temp file + rename). */
export async function writeSessionMetadata(meta: SessionMetadata): Promise<void> {
  await ensureSessionsDir();
  const path = metadataPathFor(meta.name);
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

/** Read `<name>.json`, or `null` if missing / unparseable. */
export async function readSessionMetadata(name: string): Promise<SessionMetadata | null> {
  try {
    const raw = await readFile(metadataPathFor(name), 'utf8');
    const parsed = JSON.parse(raw) as SessionMetadata;
    if (typeof parsed.name !== 'string' || typeof parsed.socketPath !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Best-effort removal of `<name>`'s metadata sidecar and socket file. */
export async function removeSessionFiles(name: string): Promise<void> {
  await rm(metadataPathFor(name), { force: true }).catch(() => undefined);
  await rm(socketPathFor(name), { force: true }).catch(() => undefined);
}

/** True if `pid` appears to be a running process owned by anyone. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but is owned by another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Enumerate every session sidecar in `sessionsDir()`, each tagged with a
 * `pidAlive` liveness check. Does not connect to the sockets — the `ctl`
 * client probes liveness over the wire when it needs a definitive answer.
 */
export async function listSessions(): Promise<SessionListEntry[]> {
  let files: string[];
  try {
    files = await readdir(sessionsDir());
  } catch {
    return [];
  }
  const out: SessionListEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const meta = await readSessionMetadata(f.slice(0, -5));
    if (meta === null) continue;
    out.push({ ...meta, pidAlive: pidAlive(meta.pid) });
  }
  return out;
}
