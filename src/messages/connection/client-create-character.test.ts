import { describe, expect, it } from 'vitest';
import { StubByteStream, StubReadIterator } from '../../archive/_stub-byte-stream.js';
import { ClientCreateCharacter } from './client-create-character.js';

describe('ClientCreateCharacter', () => {
  it('has the expected metadata', () => {
    expect(ClientCreateCharacter.messageName).toBe('ClientCreateCharacter');
    expect(ClientCreateCharacter.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips the full happy-path payload', () => {
    const m = new ClientCreateCharacter({
      characterName: 'Test Player',
      templateName: 'object/creature/player/shared_human_male.iff',
      scaleFactor: 1.0,
      startingLocation: 'tatooine',
      profession: 'combat_brawler',
    });
    const s = new StubByteStream();
    m.encodePayload(s);
    const iter = new StubReadIterator(s.toBytes());
    const d = ClientCreateCharacter.decodePayload(iter);
    expect(iter.remaining).toBe(0);
    expect(d.characterName).toBe('Test Player');
    expect(d.templateName).toBe('object/creature/player/shared_human_male.iff');
    expect(d.scaleFactor).toBe(1.0);
    expect(d.startingLocation).toBe('tatooine');
    expect(d.profession).toBe('combat_brawler');
    expect(d.appearanceData).toBe('');
    expect(d.hairTemplateName).toBe('');
    expect(d.hairAppearanceData).toBe('');
    expect(d.jedi).toBe(false);
    expect(d.biography).toBe('');
    expect(d.useNewbieTutorial).toBe(false);
    expect(d.skillTemplate).toBe('');
    expect(d.workingSkill).toBe('');
  });

  it('encodes fields in addVariable order (appearance FIRST despite ctor arg order)', () => {
    const m = new ClientCreateCharacter({
      characterName: 'N',
      templateName: 't',
      startingLocation: 's',
      profession: 'p',
    });
    const s = new StubByteStream();
    m.encodePayload(s);
    const bytes = s.toBytes();
    // The first field must be the appearance string (length-prefixed).
    // appearanceData defaults to "" so the wire starts with [u16 0x0000].
    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0x00);
    // Next is characterName as UnicodeString: [u32 char_count=1][U+004E LE]
    expect(bytes[2]).toBe(0x01);
    expect(bytes[3]).toBe(0x00);
    expect(bytes[4]).toBe(0x00);
    expect(bytes[5]).toBe(0x00);
    expect(bytes[6]).toBe(0x4e); // 'N'
    expect(bytes[7]).toBe(0x00);
  });

  it('handles all custom fields including jedi=true and non-default scale', () => {
    const m = new ClientCreateCharacter({
      characterName: 'Jedi-Char',
      templateName: 'object/creature/player/shared_human_female.iff',
      scaleFactor: 1.25,
      startingLocation: 'corellia',
      appearanceData: 'app-data',
      hairTemplateName: 'object/tangible/hair/shared_hair_h_b_01.iff',
      hairAppearanceData: 'hair-app',
      profession: 'jedi',
      jedi: true,
      biography: 'I am Jedi.',
      useNewbieTutorial: true,
      skillTemplate: 'jedi_force_user',
      workingSkill: 'force_discipline_1a',
    });
    const s = new StubByteStream();
    m.encodePayload(s);
    const d = ClientCreateCharacter.decodePayload(new StubReadIterator(s.toBytes()));
    expect(d.jedi).toBe(true);
    expect(d.useNewbieTutorial).toBe(true);
    expect(d.scaleFactor).toBeCloseTo(1.25, 5);
    expect(d.biography).toBe('I am Jedi.');
    expect(d.skillTemplate).toBe('jedi_force_user');
  });
});
