import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from '../obj-controller/registry.js';
import {
  EMPTY_NPC_STRING_ID,
  StopNpcConversationDecoder,
  StopNpcConversationKind,
} from './stop-npc-conversation.js';

describe('StopNpcConversation (CM_npcConversationStop)', () => {
  it('has the right metadata', () => {
    expect(StopNpcConversationDecoder.kind).toBe('StopNpcConversation');
    expect(StopNpcConversationDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_npcConversationStop,
    );
    expect(StopNpcConversationDecoder.subtypeId).toBe(222);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_npcConversationStop);
    expect(found).toBe(StopNpcConversationDecoder);
    expect(objControllerRegistry.getByKind(StopNpcConversationKind)).toBe(
      StopNpcConversationDecoder,
    );
  });

  it('round-trips a minimal client-side stop (empty StringId / empty Unicode)', () => {
    const s = new ByteStream();
    StopNpcConversationDecoder.encode(s, {
      npc: 7n,
      finalMessageId: EMPTY_NPC_STRING_ID,
      finalMessageProse: '',
      finalResponse: '',
    });
    const d = StopNpcConversationDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.npc).toBe(7n);
    expect(d.finalMessageId).toEqual({ table: '', textIndex: 0, text: '' });
    expect(d.finalMessageProse).toBe('');
    expect(d.finalResponse).toBe('');
  });

  it('round-trips a populated server-side stop with a StringId + farewell prose', () => {
    const s = new ByteStream();
    StopNpcConversationDecoder.encode(s, {
      npc: 0xabcn,
      finalMessageId: { table: 'quest/farewell', textIndex: 0, text: 'see_you_soon' },
      finalMessageProse: 'Safe travels.',
      finalResponse: '',
    });
    const d = StopNpcConversationDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.npc).toBe(0xabcn);
    expect(d.finalMessageId.table).toBe('quest/farewell');
    expect(d.finalMessageId.text).toBe('see_you_soon');
    expect(d.finalMessageProse).toBe('Safe travels.');
    expect(d.finalResponse).toBe('');
  });
});
