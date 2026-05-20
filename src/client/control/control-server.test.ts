import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlRequest } from './control-client.js';
import { ControlServer } from './control-server.js';
import { type ControlResponse, okResponse, readLines } from './protocol.js';
import type { SessionHandle } from './session-handle.js';
import { ensureSessionsDir, socketPathFor } from './socket-registry.js';

// The control socket lives under `~/.swg-ts-client/sessions/`; point HOME at
// a temp dir so the test never touches the real runtime directory.
let origHome: string | undefined;
let tmpHome: string;

beforeAll(() => {
  origHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'swg-ctl-test-'));
  process.env.HOME = tmpHome;
});

afterAll(() => {
  if (origHome === undefined) {
    // `delete` is the only way to truly unset an env var — assigning
    // `undefined` would coerce to the string "undefined".
    // biome-ignore lint/performance/noDelete: env vars must be unset via delete
    delete process.env.HOME;
  } else {
    process.env.HOME = origHome;
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

let counter = 0;
function uniqueName(): string {
  return `test-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

/** Send one raw (possibly malformed) line and read the first response line. */
function rawLine(socketPath: string, line: string): Promise<ControlResponse> {
  return new Promise<ControlResponse>((resolve, reject) => {
    const sock = connect(socketPath);
    sock.on('error', reject);
    sock.on('connect', () => sock.write(`${line}\n`));
    void (async () => {
      for await (const l of readLines(sock)) {
        sock.destroy();
        resolve(JSON.parse(l) as ControlResponse);
        return;
      }
      reject(new Error('socket closed with no response'));
    })();
  });
}

describe('ControlServer', () => {
  it('answers status from the stub handle when no session is attached', async () => {
    const server = new ControlServer({ name: uniqueName() });
    await server.start();
    try {
      const resp = await controlRequest(server.socketPath, { kind: 'query', name: 'status' });
      expect(resp.ok).toBe(true);
      if (resp.ok) {
        expect((resp.data as { sessionAttached: boolean }).sessionAttached).toBe(false);
      }
    } finally {
      await server.stop();
    }
  });

  it('routes requests to an attached session handle, then back to the stub', async () => {
    const server = new ControlServer({ name: uniqueName() });
    await server.start();
    const seen: string[] = [];
    const handle: SessionHandle = {
      handle(req) {
        seen.push(`${req.kind}:${req.name}`);
        return okResponse(req.id, { echoed: req.name });
      },
    };
    server.attachSession(handle);
    try {
      const resp = await controlRequest(server.socketPath, { kind: 'query', name: 'world' });
      expect(resp.ok).toBe(true);
      if (resp.ok) expect((resp.data as { echoed: string }).echoed).toBe('world');
      expect(seen).toEqual(['query:world']);

      server.detachSession();
      const after = await controlRequest(server.socketPath, { kind: 'action', name: 'stop' });
      expect(after.ok).toBe(false);
      if (!after.ok) expect(after.error.code).toBe('no_session');
    } finally {
      await server.stop();
    }
  });

  it('handles multiple sequential requests on one connection', async () => {
    const server = new ControlServer({ name: uniqueName() });
    await server.start();
    server.attachSession({ handle: (req) => okResponse(req.id, { n: req.name }) });
    try {
      const a = await controlRequest(server.socketPath, { kind: 'query', name: 'status' });
      const b = await controlRequest(server.socketPath, { kind: 'query', name: 'world' });
      expect(a.ok && b.ok).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('returns bad_request for a malformed line', async () => {
    const server = new ControlServer({ name: uniqueName() });
    await server.start();
    try {
      const resp = await rawLine(server.socketPath, 'not json at all');
      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.code).toBe('bad_request');
    } finally {
      await server.stop();
    }
  });

  it('stop() removes the socket file', async () => {
    const server = new ControlServer({ name: uniqueName() });
    await server.start();
    expect(existsSync(server.socketPath)).toBe(true);
    await server.stop();
    expect(existsSync(server.socketPath)).toBe(false);
  });

  it('clears a stale socket file before binding', async () => {
    const name = uniqueName();
    await ensureSessionsDir();
    writeFileSync(socketPathFor(name), ''); // a stale regular file at the path
    const server = new ControlServer({ name });
    await server.start(); // must detect the dead path and rebind
    try {
      const resp = await controlRequest(server.socketPath, { kind: 'query', name: 'status' });
      expect(resp.ok).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('refuses to bind when a live server already owns the name', async () => {
    const name = uniqueName();
    const a = new ControlServer({ name });
    await a.start();
    const b = new ControlServer({ name });
    try {
      await expect(b.start()).rejects.toThrow(/already in use/);
    } finally {
      await a.stop();
    }
  });

  it('reports supervised + restart capability via the metadata', async () => {
    const server = new ControlServer({ name: uniqueName(), supervised: true });
    await server.start();
    try {
      expect(server.supervised).toBe(true);
      const resp = await controlRequest(server.socketPath, { kind: 'query', name: 'status' });
      if (resp.ok) expect((resp.data as { supervised: boolean }).supervised).toBe(true);
    } finally {
      await server.stop();
    }
  });
});
