import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from '../obj-controller/registry.js';
import {
  NpcConversationSelectDecoder,
  NpcConversationSelectKind,
} from './npc-conversation-select.js';

describe('NpcConversationSelectMessage (CM_npcConversationSelect)', () => {
  it('has the right metadata', () => {
    expect(NpcConversationSelectDecoder.kind).toBe('NpcConversationSelectMessage');
    expect(NpcConversationSelectDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_npcConversationSelect,
    );
    expect(NpcConversationSelectDecoder.subtypeId).toBe(225);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_npcConversationSelect);
    expect(found).toBe(NpcConversationSelectDecoder);
    expect(objControllerRegistry.getByKind(NpcConversationSelectKind)).toBe(
      NpcConversationSelectDecoder,
    );
  });

  it('encodes / decodes an empty trailer (response index lives in parent.value)', () => {
    const s = new ByteStream();
    NpcConversationSelectDecoder.encode(s, {});
    expect(s.toBytes().length).toBe(0);
    const d = NpcConversationSelectDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual({});
  });
});
