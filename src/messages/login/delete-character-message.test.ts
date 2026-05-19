import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { encodeMessage, parseHeader } from '../base.js';
import { DeleteCharacterMessage } from './delete-character-message.js';

describe('DeleteCharacterMessage', () => {
  it('has the expected metadata', () => {
    expect(DeleteCharacterMessage.messageName).toBe('DeleteCharacterMessage');
    expect(DeleteCharacterMessage.typeCrc).toBeGreaterThan(0);
    expect(DeleteCharacterMessage.varCount).toBe(3);
  });

  it('encodes (clusterId, characterId) in the documented layout', () => {
    // clusterId=1, characterId=591551177 (PathPick's oid from the live
    // capture). u32 LE clusterId = 01 00 00 00, i64 LE characterId =
    // c9 5a 42 23 00 00 00 00 — same NetworkId bytes seen in the
    // ObjControllerMessage trailer when picking Officer.
    const msg = new DeleteCharacterMessage(1, 591551177n);
    const bytes = encodeMessage(msg);
    // [u16 varCount=3][u32 typeCrc][u32 clusterId=1][i64 characterId]
    expect(bytes.length).toBe(2 + 4 + 4 + 8);
    const hex = Buffer.from(bytes).toString('hex');
    expect(hex.slice(0, 4)).toBe('0300'); // varCount=3 LE
    // tail after the 6-byte header should be clusterId + characterId
    expect(hex.slice(12)).toBe('01000000c95a422300000000');
  });

  it('round-trips encode → decode', () => {
    const original = new DeleteCharacterMessage(1, 591551177n);
    const stream = new ByteStream();
    original.encodePayload(stream);
    const decoded = DeleteCharacterMessage.decodePayload(
      new ReadIterator(stream.toBytes()),
    );
    expect(decoded.clusterId).toBe(1);
    expect(decoded.characterId).toBe(591551177n);
  });

  it('survives parseHeader → decodePayload round-trip', () => {
    const bytes = encodeMessage(new DeleteCharacterMessage(7, 0x0102030405060708n));
    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(3);
    expect(typeCrc).toBe(DeleteCharacterMessage.typeCrc);
    const decoded = DeleteCharacterMessage.decodePayload(payload);
    expect(decoded.clusterId).toBe(7);
    expect(decoded.characterId).toBe(0x0102030405060708n);
  });
});
