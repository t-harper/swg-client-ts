import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from '../obj-controller/registry.js';
import {
  NpcConversationResponsesDecoder,
  NpcConversationResponsesKind,
} from './npc-conversation-responses.js';

describe('NpcConversationResponses (CM_npcConversationResponses)', () => {
  it('has the right metadata', () => {
    expect(NpcConversationResponsesDecoder.kind).toBe('NpcConversationResponses');
    expect(NpcConversationResponsesDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_npcConversationResponses,
    );
    expect(NpcConversationResponsesDecoder.subtypeId).toBe(224);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(
      ObjControllerSubtypeIds.CM_npcConversationResponses,
    );
    expect(found).toBe(NpcConversationResponsesDecoder);
    expect(objControllerRegistry.getByKind(NpcConversationResponsesKind)).toBe(
      NpcConversationResponsesDecoder,
    );
  });

  it('round-trips an empty list (auto-advance prompt)', () => {
    const s = new ByteStream();
    NpcConversationResponsesDecoder.encode(s, { responses: [] });
    expect(s.toBytes().length).toBe(1);
    const d = NpcConversationResponsesDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.responses).toEqual([]);
  });

  it('round-trips a typical option menu', () => {
    const s = new ByteStream();
    NpcConversationResponsesDecoder.encode(s, {
      responses: ['Yes', 'No', 'Goodbye'],
    });
    const d = NpcConversationResponsesDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.responses).toEqual(['Yes', 'No', 'Goodbye']);
  });

  it('has the exact byte layout for a single-option menu', () => {
    const s = new ByteStream();
    NpcConversationResponsesDecoder.encode(s, { responses: ['ok'] });
    const bytes = s.toBytes();
    // u8 count=1 + UnicodeString 'ok' (4-byte u32 char-count + 4 UTF-16 LE bytes)
    expect(bytes.length).toBe(1 + 4 + 4);
    expect(bytes[0]).toBe(0x01);
    expect(bytes[1]).toBe(0x02);
    expect(bytes[5]).toBe(0x6f);
    expect(bytes[7]).toBe(0x6b);
  });
});
