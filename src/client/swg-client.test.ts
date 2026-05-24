import { describe, expect, it } from 'vitest';

import type { CharacterInfo } from '../types.js';
import { makeNamedCharacterPicker } from './swg-client.js';

const char = (name: string, id = 1n): CharacterInfo => ({
  name,
  networkId: id,
  clusterId: 1,
  characterType: 1,
  objectTemplateId: 0,
});

describe('makeNamedCharacterPicker', () => {
  it('returns the named character when present', () => {
    const picker = makeNamedCharacterPicker('MyJedi');
    const cs = [char('MyMedic', 100n), char('MyJedi', 200n), char('MyScout', 300n)];
    expect(picker(cs).networkId).toBe(200n);
  });

  it('throws (no silent fallback) when the named character is absent and others exist', () => {
    const picker = makeNamedCharacterPicker('MyJedi');
    const cs = [char('MyMedic', 100n), char('MyEntertainer', 300n)];
    expect(() => picker(cs)).toThrowError(/Character "MyJedi" not found/);
    expect(() => picker(cs)).toThrowError(/MyMedic, MyEntertainer/);
  });

  it('throws when the chars list is empty', () => {
    const picker = makeNamedCharacterPicker('MyJedi');
    expect(() => picker([])).toThrowError(/Character "MyJedi" not found/);
    expect(() => picker([])).toThrowError(/\(none\)/);
  });

  it('is case-sensitive on the character name', () => {
    const picker = makeNamedCharacterPicker('MyJedi');
    expect(() => picker([char('myjedi')])).toThrowError(/Character "MyJedi" not found/);
  });

  it('handles a character list of size 1 where the only entry matches', () => {
    const picker = makeNamedCharacterPicker('OnlyOne');
    expect(picker([char('OnlyOne', 42n)]).networkId).toBe(42n);
  });
});
