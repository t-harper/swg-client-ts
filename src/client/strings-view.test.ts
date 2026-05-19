import { describe, expect, it, vi } from 'vitest';

import type { Knowledge, StringKB, TerrainKB } from './knowledge.js';
import { createStringsView } from './strings-view.js';

/**
 * Hand-rolled mock `Knowledge` that exposes only the `strings` lens — the
 * view doesn't touch `terrain` or `preload`, so we leave those as `null!`
 * casts to keep the test surface minimal. Tests that need to assert on
 * `knowledge.strings.resolve` calls inject vi.fn()s here.
 */
function makeMockKnowledge(strings: Partial<StringKB>): Knowledge {
  const filled: StringKB = {
    resolve: strings.resolve ?? vi.fn(async () => null),
    resolveFile: strings.resolveFile ?? vi.fn(async () => null),
    evict: strings.evict ?? vi.fn(),
    clear: strings.clear ?? vi.fn(),
    size: strings.size ?? ((): number => 0),
  };
  return {
    terrain: null as unknown as TerrainKB,
    strings: filled,
    preload: vi.fn(async () => {}),
    clear: vi.fn(),
  };
}

describe('createStringsView', () => {
  describe('resolve(file, key)', () => {
    it('delegates to knowledge.strings.resolve with the file + key verbatim', async () => {
      const resolve = vi.fn(async () => 'You declared residency in Theed.');
      const view = createStringsView({
        knowledge: makeMockKnowledge({ resolve }),
      });
      const result = await view.resolve('city/city', 'declared_residence');
      expect(result).toBe('You declared residency in Theed.');
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith('city/city', 'declared_residence');
    });

    it('returns null when the KB returns null (missing file or key)', async () => {
      const resolve = vi.fn(async () => null);
      const view = createStringsView({
        knowledge: makeMockKnowledge({ resolve }),
      });
      expect(await view.resolve('city/city', 'does_not_exist')).toBeNull();
    });

    it('propagates errors thrown by the underlying KB (does NOT swallow)', async () => {
      const resolve = vi.fn(async () => {
        throw new Error('asset missing');
      });
      const view = createStringsView({
        knowledge: makeMockKnowledge({ resolve }),
      });
      await expect(view.resolve('city/city', 'declared_residence')).rejects.toThrow(
        'asset missing',
      );
    });
  });

  describe('resolve(token) shorthand', () => {
    it('splits @file:key on the first colon and calls resolve(file, key)', async () => {
      const resolve = vi.fn(async () => 'You declared residency in Theed.');
      const view = createStringsView({
        knowledge: makeMockKnowledge({ resolve }),
      });
      const result = await view.resolve('@city/city:declared_residence');
      expect(result).toBe('You declared residency in Theed.');
      expect(resolve).toHaveBeenCalledWith('city/city', 'declared_residence');
    });

    it('accepts the token form without a leading @', async () => {
      const resolve = vi.fn(async () => 'hello');
      const view = createStringsView({
        knowledge: makeMockKnowledge({ resolve }),
      });
      await view.resolve('city/city:declared_residence');
      expect(resolve).toHaveBeenCalledWith('city/city', 'declared_residence');
    });

    it('handles keys that themselves contain colons (only splits on the FIRST colon)', async () => {
      const resolve = vi.fn(async () => 'ok');
      const view = createStringsView({
        knowledge: makeMockKnowledge({ resolve }),
      });
      await view.resolve('@cmd_err:bad:syntax:weird');
      expect(resolve).toHaveBeenCalledWith('cmd_err', 'bad:syntax:weird');
    });

    it('lets explicit key arg override the parsed token key', async () => {
      const resolve = vi.fn(async () => 'override won');
      const view = createStringsView({
        knowledge: makeMockKnowledge({ resolve }),
      });
      const result = await view.resolve('@city/city:parsed_key', 'overrideKey');
      expect(result).toBe('override won');
      // Explicit override → resolve called with overrideKey, not parsed_key.
      expect(resolve).toHaveBeenCalledWith('city/city', 'overrideKey');
    });

    it('throws a clear error if called with a bare file name + no colon + no explicit key', async () => {
      const view = createStringsView({
        knowledge: makeMockKnowledge({}),
      });
      await expect(view.resolve('city/city')).rejects.toThrow(/missing key/);
      // Also the `@`-stripped bare-file case — same error.
      await expect(view.resolve('@city/city')).rejects.toThrow(/missing key/);
    });
  });

  describe('resolveFile(file)', () => {
    it('delegates to knowledge.strings.resolveFile with the file verbatim', async () => {
      const fakeTable = new Map<string, string>([
        ['declared_residence', 'You declared residency.'],
        ['ai_already_in_city', 'You are already in a city.'],
      ]);
      const resolveFile = vi.fn(async () => fakeTable as ReadonlyMap<string, string>);
      const view = createStringsView({
        knowledge: makeMockKnowledge({ resolveFile }),
      });
      const table = await view.resolveFile('city/city');
      expect(table).toBe(fakeTable);
      expect(resolveFile).toHaveBeenCalledWith('city/city');
    });

    it('returns null when the KB has no such file', async () => {
      const resolveFile = vi.fn(async () => null);
      const view = createStringsView({
        knowledge: makeMockKnowledge({ resolveFile }),
      });
      expect(await view.resolveFile('city/does_not_exist')).toBeNull();
    });

    it('strips a leading @ from the file argument before forwarding', async () => {
      const resolveFile = vi.fn(async () => null);
      const view = createStringsView({
        knowledge: makeMockKnowledge({ resolveFile }),
      });
      await view.resolveFile('@city/city');
      // The KB sees the un-prefixed file path.
      expect(resolveFile).toHaveBeenCalledWith('city/city');
    });

    it('drops a trailing :key suffix when the caller pastes a full token', async () => {
      const resolveFile = vi.fn(async () => null);
      const view = createStringsView({
        knowledge: makeMockKnowledge({ resolveFile }),
      });
      await view.resolveFile('@city/city:declared_residence');
      // resolveFile only cares about the file portion.
      expect(resolveFile).toHaveBeenCalledWith('city/city');
    });
  });

  describe('isolation between Knowledge instances', () => {
    it('views built over different Knowledge instances delegate to their own KB', async () => {
      const resolveA = vi.fn(async () => 'from A');
      const resolveB = vi.fn(async () => 'from B');
      const viewA = createStringsView({
        knowledge: makeMockKnowledge({ resolve: resolveA }),
      });
      const viewB = createStringsView({
        knowledge: makeMockKnowledge({ resolve: resolveB }),
      });
      expect(await viewA.resolve('foo', 'bar')).toBe('from A');
      expect(await viewB.resolve('foo', 'bar')).toBe('from B');
      expect(resolveA).toHaveBeenCalledTimes(1);
      expect(resolveB).toHaveBeenCalledTimes(1);
    });
  });
});
