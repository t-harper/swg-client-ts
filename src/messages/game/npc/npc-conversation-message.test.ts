import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from '../obj-controller/registry.js';
import {
  NpcConversationMessageDecoder,
  NpcConversationMessageKind,
} from './npc-conversation-message.js';

describe('NpcConversationMessage (CM_npcConversationMessage)', () => {
  it('has the right metadata', () => {
    expect(NpcConversationMessageDecoder.kind).toBe('NpcConversationMessage');
    expect(NpcConversationMessageDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_npcConversationMessage,
    );
    expect(NpcConversationMessageDecoder.subtypeId).toBe(223);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_npcConversationMessage);
    expect(found).toBe(NpcConversationMessageDecoder);
    expect(objControllerRegistry.getByKind(NpcConversationMessageKind)).toBe(
      NpcConversationMessageDecoder,
    );
  });

  it('round-trips encode → decode', () => {
    const s = new ByteStream();
    NpcConversationMessageDecoder.encode(s, {
      npcMessage: 'Greetings, traveler.',
    });
    const d = NpcConversationMessageDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.npcMessage).toBe('Greetings, traveler.');
  });

  it('preserves Unicode (UTF-16 LE) prompt content', () => {
    const s = new ByteStream();
    NpcConversationMessageDecoder.encode(s, { npcMessage: 'Hello ★' });
    const d = NpcConversationMessageDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.npcMessage).toBe('Hello ★');
  });

  it('has the exact byte layout for a 2-char message', () => {
    const s = new ByteStream();
    NpcConversationMessageDecoder.encode(s, { npcMessage: 'hi' });
    const bytes = s.toBytes();
    // u32 char-count=2 LE + 4 bytes UTF-16 LE
    expect(bytes.length).toBe(8);
    expect(Array.from(bytes)).toEqual([0x02, 0x00, 0x00, 0x00, 0x68, 0x00, 0x69, 0x00]);
  });
});
