import { describe, expect, it } from 'vitest';
import { constcrc } from '../../../crc/constcrc.js';
import { hashCommand } from './command-hash.js';

describe('hashCommand', () => {
  it('lowercases the input before hashing (case-insensitive)', () => {
    expect(hashCommand('Attack')).toBe(hashCommand('attack'));
    expect(hashCommand('ATTACK')).toBe(hashCommand('attack'));
    expect(hashCommand('AtTaCk')).toBe(hashCommand('attack'));
  });

  it('returns the same value as constcrc on the lowercased name', () => {
    for (const name of ['attack', 'prone', 'crouch', 'stand', 'sit', 'berserk1', 'intimidate1']) {
      expect(hashCommand(name)).toBe(constcrc(name));
    }
  });

  it('handles empty string (returns 0 per constcrc spec)', () => {
    expect(hashCommand('')).toBe(0);
  });

  it('produces distinct hashes for distinct commands (no obvious collision)', () => {
    const names = ['attack', 'prone', 'crouch', 'stand', 'sit', 'meditate', 'holster', 'draw'];
    const hashes = new Set(names.map(hashCommand));
    expect(hashes.size).toBe(names.length);
  });

  it('hashes are 32-bit unsigned (non-negative, < 2^32)', () => {
    for (const name of ['attack', 'berserk1', 'intimidate1']) {
      const h = hashCommand(name);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });
});
