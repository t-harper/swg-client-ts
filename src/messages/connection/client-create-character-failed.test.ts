import { describe, expect, it } from 'vitest';
import { StubByteStream, StubReadIterator } from '../../archive/_stub-byte-stream.js';
import {
  ClientCreateCharacterFailed,
  type StringId,
  readStringId,
  writeStringId,
} from './client-create-character-failed.js';

describe('ClientCreateCharacterFailed', () => {
  it('has the expected metadata', () => {
    expect(ClientCreateCharacterFailed.messageName).toBe('ClientCreateCharacterFailed');
    expect(ClientCreateCharacterFailed.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips the StringId triple', () => {
    const sid: StringId = { table: 'ui_charcreate', textIndex: 0, name: 'name_too_long' };
    const s = new StubByteStream();
    writeStringId(s, sid);
    const d = readStringId(new StubReadIterator(s.toBytes()));
    expect(d).toEqual(sid);
  });

  it('round-trips the whole message', () => {
    const m = new ClientCreateCharacterFailed('BadName', {
      table: 'ui_charcreate',
      textIndex: 0,
      name: 'name_declined',
    });
    const s = new StubByteStream();
    m.encodePayload(s);
    const iter = new StubReadIterator(s.toBytes());
    const d = ClientCreateCharacterFailed.decodePayload(iter);
    expect(iter.remaining).toBe(0);
    expect(d.name).toBe('BadName');
    expect(d.errorMessage.table).toBe('ui_charcreate');
    expect(d.errorMessage.name).toBe('name_declined');
  });
});
