import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { encodeMessage, parseHeader } from '../base.js';
import { ExpertiseRequestMessage } from './expertise-request.js';

describe('ExpertiseRequestMessage', () => {
  it('has the expected metadata', () => {
    expect(ExpertiseRequestMessage.messageName).toBe('ExpertiseRequestMessage');
    expect(ExpertiseRequestMessage.typeCrc).toBe(0xc19085d5);
    expect(ExpertiseRequestMessage.varCount).toBe(3);
  });

  // Golden bytes from a live Windows-client capture, 2026-05-18:
  //   Character allocated one Commando expertise `expertise_co_blast_resistance_1`
  //   via the in-game Expertise window. Captured from tcpdump on UDP 44463.
  //
  //   varCount = 3 (LE u16)        0300
  //   typeCrc  = 0xc19085d5 (LE)   d585 90c1
  //   addList count = 1 (LE u32)   0100 0000
  //   string len = 31 (LE u16)     1f00
  //   "expertise_co_blast_resistance_1" (31 bytes UTF-8)
  //   clearAllExpertisesFirst = 0  00
  const LIVE_CAPTURE_HEX =
    '0300d58590c1010000001f006578706572746973655f636f5f626c6173745f726573697374616e63655f3100';

  it('matches live Windows-client wire bytes (single expertise, no clear)', () => {
    const msg = new ExpertiseRequestMessage(
      ['expertise_co_blast_resistance_1'],
      false,
    );
    const bytes = encodeMessage(msg);
    expect(Buffer.from(bytes).toString('hex')).toBe(LIVE_CAPTURE_HEX);
  });

  it('decodes the captured bytes back to the original payload', () => {
    const bytes = Uint8Array.from(Buffer.from(LIVE_CAPTURE_HEX, 'hex'));
    const { typeCrc, varCount, payload } = parseHeader(bytes);
    expect(typeCrc).toBe(0xc19085d5);
    expect(varCount).toBe(3);
    const decoded = ExpertiseRequestMessage.decodePayload(payload);
    expect(decoded.addExpertisesList).toEqual(['expertise_co_blast_resistance_1']);
    expect(decoded.clearAllExpertisesFirst).toBe(false);
  });

  it('round-trips an empty list with clearAllExpertisesFirst=true (Reset button)', () => {
    const original = new ExpertiseRequestMessage([], true);
    const stream = new ByteStream();
    original.encodePayload(stream);
    const decoded = ExpertiseRequestMessage.decodePayload(
      new ReadIterator(stream.toBytes()),
    );
    expect(decoded.addExpertisesList).toEqual([]);
    expect(decoded.clearAllExpertisesFirst).toBe(true);
  });

  it('round-trips a multi-string batch (admin god-mode bulk grant)', () => {
    const original = new ExpertiseRequestMessage(
      [
        'expertise_co_blast_resistance_1',
        'expertise_co_blast_resistance_2',
        'expertise_co_blast_resistance_3',
      ],
      false,
    );
    const stream = new ByteStream();
    original.encodePayload(stream);
    const decoded = ExpertiseRequestMessage.decodePayload(
      new ReadIterator(stream.toBytes()),
    );
    expect(decoded.addExpertisesList).toEqual(original.addExpertisesList);
    expect(decoded.clearAllExpertisesFirst).toBe(false);
  });
});
