/**
 * CLI smoke test for `swg-ts-cli decode-raw`. Hand-crafts a small NDJSON
 * raw-capture file wrapping the existing `session-request-14b.hex` and
 * `session-response-17b.hex` fixtures (plus the LoginEnumCluster reliable
 * packet), then invokes the CLI and asserts it exits 0 with the expected
 * output.
 *
 * Runs under the regular `pnpm test` — no LIVE server required.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EncryptMethod } from '../../src/types.js';

function loadHexFixture(relPath: string): Uint8Array {
  const url = new URL(`../fixtures/${relPath}`, import.meta.url);
  const text = readFileSync(fileURLToPath(url), 'utf8');
  const cleaned = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join(' ')
    .replace(/\s+/g, '');
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.substr(i * 2, 2), 16);
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<SpawnResult> {
  // Locate the CLI relative to this test file — robust to where the worktree
  // lives on disk.
  const cliPath = resolve(fileURLToPath(new URL('../../bin/swg-ts-cli.ts', import.meta.url)));
  return new Promise((resolveResult) => {
    const child = spawn('node', ['--import', 'tsx', cliPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      resolveResult({ code, stdout, stderr });
    });
  });
}

describe('CLI: decode-raw smoke test', () => {
  let tmp: string;
  let captureFile: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'swg-ts-decode-raw-test-'));
    captureFile = join(tmp, 'capture.ndjson');

    // The captured fixtures use these known params (see
    // tests/fixtures/session-response-17b.hex header).
    const ts = 1_700_000_000_000;
    const sessionRequest = loadHexFixture('session-request-14b.hex');
    const sessionResponse = loadHexFixture('session-response-17b.hex');
    const reliableLoginEnum = loadHexFixture('login-enum-cluster-223b.hex');

    const lines = [
      // meta
      JSON.stringify({
        type: 'meta',
        ts,
        localEndpoint: '10.254.0.254:63958',
        remoteEndpoint: '10.254.0.253:44453',
        connectionCode: 0x00294823,
        maxRawPacketSize: 496,
        stage: 'login',
      }),
      // session (decoded from the Confirm)
      JSON.stringify({
        type: 'session',
        ts: ts + 1,
        encryptCode: 0xfe7b4873,
        connectionCode: 0x00294823,
        crcBytes: 2,
        encryptMethods: [EncryptMethod.UserSupplied, EncryptMethod.Xor],
        negotiatedMaxRawPacketSize: 496,
      }),
      // The three frames
      JSON.stringify({
        type: 'frame',
        direction: 'send',
        ts: ts + 1,
        bytes: hex(sessionRequest),
      }),
      JSON.stringify({
        type: 'frame',
        direction: 'recv',
        ts: ts + 2,
        bytes: hex(sessionResponse),
      }),
      JSON.stringify({
        type: 'frame',
        direction: 'recv',
        ts: ts + 5,
        bytes: hex(reliableLoginEnum),
      }),
    ];
    await writeFile(captureFile, `${lines.join('\n')}\n`, 'utf8');
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('decodes the synthetic capture and exits 0', async () => {
    const result = await runCli(['decode-raw', `--input=${captureFile}`]);
    if (result.code !== 0) {
      throw new Error(
        `CLI exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    expect(result.code).toBe(0);

    // SessionRequest, SessionResponse, then the reliable packet
    expect(result.stdout).toMatch(/SessionRequest/);
    expect(result.stdout).toMatch(/SessionResponse/);
    // The reliable packet contains LoginEnumCluster among others
    expect(result.stdout).toMatch(/LoginEnumCluster/);
  }, 30_000);

  it('honors --from and --limit', async () => {
    // Skip the first 2 frames, decode 1
    const result = await runCli(['decode-raw', `--input=${captureFile}`, '--from=2', '--limit=1']);
    expect(result.code).toBe(0);
    // Should NOT contain SessionRequest (frame 0) or SessionResponse (frame 1)
    expect(result.stdout).not.toMatch(/SessionRequest/);
    expect(result.stdout).not.toMatch(/SessionResponse/);
    // SHOULD contain the reliable packet's decoded names
    expect(result.stdout).toMatch(/LoginEnumCluster/);
  }, 30_000);

  it('--verbose prints payload hex', async () => {
    const result = await runCli([
      'decode-raw',
      `--input=${captureFile}`,
      '--from=2',
      '--limit=1',
      '--verbose',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/payload:/);
  }, 30_000);

  it('returns 2 if --input is missing', async () => {
    const result = await runCli(['decode-raw']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/--input/);
  }, 30_000);
});
