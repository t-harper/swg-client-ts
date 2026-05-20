import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_PROTOCOL_VERSION,
  encodeLine,
  errorResponse,
  okResponse,
  parseRequest,
  readLines,
  toJsonSafe,
} from './protocol.js';

async function collect(stream: Readable, maxLineBytes?: number): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readLines(stream, maxLineBytes)) out.push(line);
  return out;
}

describe('control protocol — readLines', () => {
  it('reassembles lines split across chunk boundaries', async () => {
    const stream = Readable.from(['{"a":1}\n{"b', '":2}\n{"c":3}', '\n']);
    expect(await collect(stream)).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('yields a trailing unterminated line', async () => {
    expect(await collect(Readable.from(['hello']))).toEqual(['hello']);
  });

  it('skips blank lines', async () => {
    expect(await collect(Readable.from(['\n\na\n\n']))).toEqual(['a']);
  });

  it('throws on an over-long line', async () => {
    await expect(collect(Readable.from(['x'.repeat(50)]), 16)).rejects.toThrow(/exceeded/);
  });
});

describe('control protocol — parseRequest', () => {
  it('parses a well-formed request', () => {
    const r = parseRequest('{"id":"1","kind":"query","name":"status"}');
    expect(r).toEqual({ ok: true, request: { id: '1', kind: 'query', name: 'status' } });
  });

  it('parses params', () => {
    const r = parseRequest('{"id":"1","kind":"query","name":"world","params":{"limit":5}}');
    expect(r.ok && r.request.params).toEqual({ limit: 5 });
  });

  it('rejects invalid JSON', () => {
    expect(parseRequest('{not json').ok).toBe(false);
  });

  it('rejects a bad kind but recovers the id', () => {
    const r = parseRequest('{"id":"x","kind":"frob","name":"status"}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.id).toBe('x');
  });

  it('rejects a missing name', () => {
    expect(parseRequest('{"id":"x","kind":"query"}').ok).toBe(false);
  });

  it('rejects non-object params', () => {
    expect(parseRequest('{"id":"x","kind":"query","name":"world","params":[]}').ok).toBe(false);
  });
});

describe('control protocol — encodeLine / toJsonSafe', () => {
  it('encodes a response with a trailing newline', () => {
    const line = encodeLine(okResponse('1', { value: 1 }));
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ id: '1', ok: true, data: { value: 1 } });
  });

  it('normalizes bigint / Date / Uint8Array / Map / Set', () => {
    const safe = toJsonSafe({
      big: 5n,
      when: new Date(0),
      bytes: new Uint8Array([0, 255]),
      map: new Map([['k', 'v']]),
      set: new Set([1, 2]),
    });
    expect(safe).toEqual({
      big: '5',
      when: '1970-01-01T00:00:00.000Z',
      bytes: '00ff',
      map: { k: 'v' },
      set: [1, 2],
    });
  });

  it('encodes a bigint-laden payload without throwing', () => {
    expect(() => encodeLine(okResponse('1', { networkId: 123n }))).not.toThrow();
  });

  it('errorResponse carries the code + message', () => {
    expect(errorResponse('9', 'no_session', 'nope')).toEqual({
      id: '9',
      ok: false,
      error: { code: 'no_session', message: 'nope' },
    });
  });

  it('exposes a protocol version', () => {
    expect(CONTROL_PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
  });
});
