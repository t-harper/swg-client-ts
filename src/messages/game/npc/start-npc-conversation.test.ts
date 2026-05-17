import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from '../obj-controller/registry.js';
import {
  NpcConversationStarter,
  StartNpcConversationDecoder,
  StartNpcConversationKind,
} from './start-npc-conversation.js';

describe('StartNpcConversation (CM_npcConversationStart)', () => {
  it('has the right metadata', () => {
    expect(StartNpcConversationDecoder.kind).toBe('StartNpcConversation');
    expect(StartNpcConversationDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_npcConversationStart,
    );
    expect(StartNpcConversationDecoder.subtypeId).toBe(221);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_npcConversationStart);
    expect(found).toBe(StartNpcConversationDecoder);
    expect(objControllerRegistry.getByKind(StartNpcConversationKind)).toBe(
      StartNpcConversationDecoder,
    );
  });

  it('round-trips encode → decode', () => {
    const s = new ByteStream();
    StartNpcConversationDecoder.encode(s, {
      npc: 0x123456789abcdef0n,
      starter: NpcConversationStarter.Player,
      conversationName: 'hello_quest',
      appearanceOverrideTemplateCrc: 0xdeadbeef,
    });
    const d = StartNpcConversationDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.npc).toBe(0x123456789abcdef0n);
    expect(d.starter).toBe(0);
    expect(d.conversationName).toBe('hello_quest');
    expect(d.appearanceOverrideTemplateCrc).toBe(0xdeadbeef);
  });

  it('has the exact byte layout for a minimal payload', () => {
    const s = new ByteStream();
    StartNpcConversationDecoder.encode(s, {
      npc: 1n,
      starter: 0,
      conversationName: '',
      appearanceOverrideTemplateCrc: 0,
    });
    const bytes = s.toBytes();
    // NetworkId (i64 LE) = 8 bytes for 1n: 01 00 00 00 00 00 00 00
    // starter (u8) = 1 byte: 00
    // conversationName (empty stdString) = 2 bytes: 00 00
    // appearanceOverrideTemplateCrc (u32 LE) = 4 bytes: 00 00 00 00
    // Total: 15 bytes
    expect(bytes.length).toBe(15);
    expect(Array.from(bytes)).toEqual([
      0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
  });
});
