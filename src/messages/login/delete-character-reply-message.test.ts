import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { encodeMessage, parseHeader } from '../base.js';
import {
  DeleteCharacterReplyMessage,
  DeleteCharacterResult,
} from './delete-character-reply-message.js';

describe('DeleteCharacterReplyMessage', () => {
  it('has the expected metadata', () => {
    expect(DeleteCharacterReplyMessage.messageName).toBe('DeleteCharacterReplyMessage');
    expect(DeleteCharacterReplyMessage.typeCrc).toBeGreaterThan(0);
    expect(DeleteCharacterReplyMessage.varCount).toBe(2);
  });

  it.each([
    [DeleteCharacterResult.OK, '00000000'],
    [DeleteCharacterResult.AlreadyInProgress, '01000000'],
    [DeleteCharacterResult.ClusterDown, '02000000'],
  ])('encodes resultCode=%i as %s', (code, expectedTrailerHex) => {
    const bytes = encodeMessage(new DeleteCharacterReplyMessage(code));
    expect(bytes.length).toBe(2 + 4 + 4);
    expect(Buffer.from(bytes).toString('hex').slice(12)).toBe(expectedTrailerHex);
  });

  it('round-trips each result code', () => {
    for (const code of [
      DeleteCharacterResult.OK,
      DeleteCharacterResult.AlreadyInProgress,
      DeleteCharacterResult.ClusterDown,
    ]) {
      const original = new DeleteCharacterReplyMessage(code);
      const stream = new ByteStream();
      original.encodePayload(stream);
      const decoded = DeleteCharacterReplyMessage.decodePayload(
        new ReadIterator(stream.toBytes()),
      );
      expect(decoded.resultCode).toBe(code);
    }
  });

  it('survives parseHeader → decodePayload round-trip', () => {
    const bytes = encodeMessage(new DeleteCharacterReplyMessage(DeleteCharacterResult.OK));
    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(2);
    expect(typeCrc).toBe(DeleteCharacterReplyMessage.typeCrc);
    const decoded = DeleteCharacterReplyMessage.decodePayload(payload);
    expect(decoded.resultCode).toBe(DeleteCharacterResult.OK);
  });
});
