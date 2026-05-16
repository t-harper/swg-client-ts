import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encodeMessage } from '../base.js';
import { decodeMessageStrict } from '../registry.js';
import { CharacterCreationDisabled } from './character-creation-disabled.js';

describe('CharacterCreationDisabled (INBOUND, GenericValueTypeMessage<std::set<string>>)', () => {
  it('has the expected constcrc identifier', () => {
    // constcrc("CharacterCreationDisabled") = 0xf41a5265
    expect(CharacterCreationDisabled.typeCrc).toBe(0xf41a5265);
  });

  it('encodes an empty set to [2 varCount][4 CRC][4 i32 LE 0]', () => {
    const msg = new CharacterCreationDisabled(new Set());
    const bytes = encodeMessage(msg);
    const expected = Buffer.concat([
      Buffer.from([0x02, 0x00]),
      Buffer.from([0x65, 0x52, 0x1a, 0xf4]),
      Buffer.from([0, 0, 0, 0]),
    ]);
    expect(Array.from(bytes)).toEqual(Array.from(expected));
  });

  it('round-trips a typical set of disabled profession strings', () => {
    const disabled = new Set(['combat_jedi', 'combat_brawler_master']);
    const msg = new CharacterCreationDisabled(disabled);
    const decoded = decodeMessageStrict(encodeMessage(msg));
    const v = (decoded as InstanceType<typeof CharacterCreationDisabled>).value;
    expect(v).toEqual(disabled);
  });
});
