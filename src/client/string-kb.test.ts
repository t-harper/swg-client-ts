/**
 * Tests for `StringKBImpl` — the lazy `.stf` cache.
 *
 * All cases inject a fake `loadFile` via `StringKBOptions.loadFile`, so the
 * suite is fully filesystem-free. The integration with the real asset
 * loader is exercised indirectly through `tests/integration/` and the
 * one on-disk fixture test below.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { StringKBImpl } from './string-kb.js';

/**
 * Build the bytes for a 1-entry STF programmatically. Same shape as the
 * builder in `src/iff/stf-reader.test.ts` but kept local so this file
 * stands on its own.
 */
function buildStfBytes(entries: ReadonlyArray<{ key: string; value: string }>): Uint8Array {
  const records = entries.map((e, i) => ({ id: i + 1, ...e }));
  const wideBytes = records.reduce((a, r) => a + 12 + r.value.length * 2, 0);
  const narrowBytes = records.reduce((a, r) => a + 8 + r.key.length, 0);
  const out = new Uint8Array(5 + 8 + wideBytes + narrowBytes);
  const view = new DataView(out.buffer);
  let off = 0;
  view.setUint32(off, 0xabcd, true);
  off += 4;
  view.setUint8(off, 1);
  off += 1;
  view.setUint32(off, records.length + 1, true);
  off += 4;
  view.setUint32(off, records.length, true);
  off += 4;
  for (const r of records) {
    view.setUint32(off, r.id, true);
    off += 4;
    view.setUint32(off, 0xffffffff, true);
    off += 4;
    view.setUint32(off, r.value.length, true);
    off += 4;
    for (let i = 0; i < r.value.length; ++i) {
      view.setUint16(off, r.value.charCodeAt(i), true);
      off += 2;
    }
  }
  for (const r of records) {
    view.setUint32(off, r.id, true);
    off += 4;
    view.setUint32(off, r.key.length, true);
    off += 4;
    for (let i = 0; i < r.key.length; ++i) {
      view.setUint8(off, r.key.charCodeAt(i));
      off += 1;
    }
  }
  return out;
}

describe('StringKBImpl — laziness + caching', () => {
  it('does NOT call loadFile until resolveFile is invoked', () => {
    const loadFile = vi.fn(async () =>
      buildStfBytes([{ key: 'declared_residence', value: 'Declared!' }]),
    );
    new StringKBImpl({ loadFile });
    expect(loadFile).not.toHaveBeenCalled();
  });

  it('does NOT call loadFile until resolve is invoked', () => {
    const loadFile = vi.fn(async () => buildStfBytes([{ key: 'a', value: 'A' }]));
    new StringKBImpl({ loadFile });
    expect(loadFile).not.toHaveBeenCalled();
  });

  it('caches per-file — repeated resolveFile calls fire loadFile exactly once', async () => {
    const loadFile = vi.fn(async () =>
      buildStfBytes([{ key: 'declared_residence', value: 'You declared.' }]),
    );
    const kb = new StringKBImpl({ loadFile });
    const a = await kb.resolveFile('city/city');
    const b = await kb.resolveFile('city/city');
    const c = await kb.resolveFile('city/city');
    expect(loadFile).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a?.get('declared_residence')).toBe('You declared.');
    expect(kb.size()).toBe(1);
  });

  it('coalesces concurrent resolveFile calls for the same file into one in-flight promise', async () => {
    const loadFile = vi.fn(async (_lang: string, _file: string) => {
      // Force a microtask hop so the second caller observes the in-flight
      // promise rather than racing to completion.
      await new Promise((r) => setTimeout(r, 0));
      return buildStfBytes([{ key: 'k', value: 'v' }]);
    });
    const kb = new StringKBImpl({ loadFile });
    const [a, b, c] = await Promise.all([
      kb.resolveFile('city/city'),
      kb.resolveFile('city/city'),
      kb.resolveFile('city/city'),
    ]);
    expect(loadFile).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('passes the configured language to loadFile', async () => {
    const loadFile = vi.fn(async () => buildStfBytes([{ key: 'k', value: 'v' }]));
    const kb = new StringKBImpl({ language: 'ja', loadFile });
    await kb.resolveFile('city/city');
    expect(loadFile).toHaveBeenCalledWith('ja', 'city/city');
  });

  it('defaults the language to "en" when none is configured', async () => {
    const loadFile = vi.fn(async () => buildStfBytes([{ key: 'k', value: 'v' }]));
    const kb = new StringKBImpl({ loadFile });
    await kb.resolveFile('city/city');
    expect(loadFile).toHaveBeenCalledWith('en', 'city/city');
  });
});

describe('StringKBImpl — failure handling', () => {
  it('returns null when loadFile throws, and does NOT cache the failure', async () => {
    let attempt = 0;
    const loadFile = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('asset not found');
      return buildStfBytes([{ key: 'k', value: 'after retry' }]);
    });
    const kb = new StringKBImpl({ loadFile });

    const first = await kb.resolveFile('city/city');
    expect(first).toBeNull();
    expect(kb.size()).toBe(0);

    const second = await kb.resolveFile('city/city');
    expect(second).not.toBeNull();
    expect(second?.get('k')).toBe('after retry');
    expect(loadFile).toHaveBeenCalledTimes(2);
    expect(kb.size()).toBe(1);
  });

  it('returns null when the bytes are malformed, and does NOT cache the failure', async () => {
    let attempt = 0;
    const loadFile = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01]); // bad magic
      return buildStfBytes([{ key: 'k', value: 'recovered' }]);
    });
    const kb = new StringKBImpl({ loadFile });

    expect(await kb.resolveFile('city/city')).toBeNull();
    expect(kb.size()).toBe(0);
    expect(await kb.resolveFile('city/city')).not.toBeNull();
  });

  it('resolve() returns null on a missing file', async () => {
    const loadFile = vi.fn(async () => {
      throw new Error('not found');
    });
    const kb = new StringKBImpl({ loadFile });
    expect(await kb.resolve('city/city', 'declared_residence')).toBeNull();
  });

  it('resolve() returns null on a missing key in a present file', async () => {
    const loadFile = vi.fn(async () => buildStfBytes([{ key: 'declared_residence', value: 'Hi' }]));
    const kb = new StringKBImpl({ loadFile });
    expect(await kb.resolve('city/city', 'declared_residence')).toBe('Hi');
    expect(await kb.resolve('city/city', 'no_such_key')).toBeNull();
  });
});

describe('StringKBImpl — @file:key shorthand parsing', () => {
  it('strips the leading @ and splits on : when key is empty', async () => {
    const loadFile = vi.fn(async () =>
      buildStfBytes([{ key: 'declared_residence', value: 'Done!' }]),
    );
    const kb = new StringKBImpl({ loadFile });
    const result = await kb.resolve('@city/city:declared_residence', '');
    expect(result).toBe('Done!');
    expect(loadFile).toHaveBeenCalledWith('en', 'city/city');
  });

  it('treats the explicit key arg as authoritative when both forms are present', async () => {
    const loadFile = vi.fn(async () =>
      buildStfBytes([
        { key: 'declared_residence', value: 'Wrong!' },
        { key: 'override_key', value: 'Right!' },
      ]),
    );
    const kb = new StringKBImpl({ loadFile });
    // `:declared_residence` is in the file arg, but the second arg wins.
    const result = await kb.resolve('@city/city:declared_residence', 'override_key');
    expect(result).toBe('Right!');
  });

  it('handles a plain @file (no colon) + separate key arg', async () => {
    const loadFile = vi.fn(async () => buildStfBytes([{ key: 'foo', value: 'F' }]));
    const kb = new StringKBImpl({ loadFile });
    expect(await kb.resolve('@city/city', 'foo')).toBe('F');
    expect(loadFile).toHaveBeenCalledWith('en', 'city/city');
  });

  it('normalizes the @ prefix on resolveFile too (cache key is bare file)', async () => {
    const loadFile = vi.fn(async () => buildStfBytes([{ key: 'k', value: 'v' }]));
    const kb = new StringKBImpl({ loadFile });
    const a = await kb.resolveFile('@city/city');
    const b = await kb.resolveFile('city/city');
    expect(a).toBe(b);
    expect(loadFile).toHaveBeenCalledTimes(1);
  });

  it('strips an inline :key suffix on resolveFile (cache key is bare file)', async () => {
    const loadFile = vi.fn(async () => buildStfBytes([{ key: 'k', value: 'v' }]));
    const kb = new StringKBImpl({ loadFile });
    const a = await kb.resolveFile('city/city:declared_residence');
    const b = await kb.resolveFile('city/city');
    expect(a).toBe(b);
    expect(loadFile).toHaveBeenCalledTimes(1);
  });

  it('returns null for pathological input (just "@" or ":key")', async () => {
    const loadFile = vi.fn(async () => buildStfBytes([{ key: 'k', value: 'v' }]));
    const kb = new StringKBImpl({ loadFile });
    expect(await kb.resolveFile('@')).toBeNull();
    expect(await kb.resolveFile(':foo')).toBeNull();
    expect(loadFile).not.toHaveBeenCalled();
  });
});

describe('StringKBImpl — eviction + clear + size', () => {
  it('evict(file) drops just that file; subsequent resolve reloads it', async () => {
    const loadFile = vi.fn(async (_lang: string, _file: string) =>
      buildStfBytes([{ key: 'k', value: 'v' }]),
    );
    const kb = new StringKBImpl({ loadFile });
    await kb.resolveFile('city/city');
    await kb.resolveFile('survey/survey');
    expect(kb.size()).toBe(2);

    kb.evict('city/city');
    expect(kb.size()).toBe(1);

    await kb.resolveFile('city/city');
    expect(loadFile).toHaveBeenCalledTimes(3); // 2 initial + 1 reload
    expect(kb.size()).toBe(2);
  });

  it('evict accepts the @file shorthand and removes the same cache key', async () => {
    const loadFile = vi.fn(async () => buildStfBytes([{ key: 'k', value: 'v' }]));
    const kb = new StringKBImpl({ loadFile });
    await kb.resolveFile('city/city');
    expect(kb.size()).toBe(1);
    kb.evict('@city/city:any_key');
    expect(kb.size()).toBe(0);
  });

  it('clear() drops every cached file', async () => {
    const loadFile = vi.fn(async () => buildStfBytes([{ key: 'k', value: 'v' }]));
    const kb = new StringKBImpl({ loadFile });
    await kb.resolveFile('city/city');
    await kb.resolveFile('survey/survey');
    await kb.resolveFile('cmd_err');
    expect(kb.size()).toBe(3);
    kb.clear();
    expect(kb.size()).toBe(0);
  });
});

describe('StringKBImpl — on-disk smoke test (skipped when fixtures not staged)', () => {
  // Real-asset round-trip. The unit suite injects loadFile by default so
  // this is the only spot that exercises the production filesystem chain.
  // Project rule: skip paths are errors EXCEPT the outer runner gate.
  // We gate via it.skipIf so a missing fixture surfaces as a runner-level
  // skip rather than a silent pass.
  const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'stf-hair-lookat-en.stf');
  const fixturePresent = existsSync(fixturePath);

  it.skipIf(!fixturePresent)(
    'loads the real hair_lookat fixture via a custom loadFile',
    async () => {
      const loadFile = async (_lang: string, _file: string): Promise<Uint8Array> =>
        readFileSync(fixturePath);
      const kb = new StringKBImpl({ loadFile });
      const value = await kb.resolve('hair_lookat', 'default');
      expect(value).toBe('hair');
    },
  );
});
