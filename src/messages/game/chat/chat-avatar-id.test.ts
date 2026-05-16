import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { chatAvatarId, readChatAvatarId, writeChatAvatarId } from './chat-avatar-id.js';

describe('ChatAvatarId codec', () => {
  it('round-trips a full triple', () => {
    const id = chatAvatarId('han', 'swg', 'SWG');
    const s = new ByteStream();
    writeChatAvatarId(s, id);
    const out = readChatAvatarId(new ReadIterator(s.toBytes()));
    expect(out).toEqual(id);
  });

  it('round-trips empty strings (default ctor)', () => {
    const id = chatAvatarId(''); // gameCode='', cluster='', name=''
    const s = new ByteStream();
    writeChatAvatarId(s, id);
    expect(s.toBytes().length).toBe(6); // three u16 zero-length prefixes
    const out = readChatAvatarId(new ReadIterator(s.toBytes()));
    expect(out).toEqual({ gameCode: '', cluster: '', name: '' });
  });

  it('writes fields in gameCode, cluster, name order', () => {
    // "a" / "b" / "c": each is u16 length=1 + 1 byte ASCII
    const s = new ByteStream();
    writeChatAvatarId(s, chatAvatarId('c', 'b', 'a'));
    const bytes = s.toBytes();
    // Wire = [01 00 'a'][01 00 'b'][01 00 'c']
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(0x01);
    expect(bytes[1]).toBe(0x00);
    expect(bytes[2]).toBe(0x61); // 'a' (gameCode)
    expect(bytes[5]).toBe(0x62); // 'b' (cluster)
    expect(bytes[8]).toBe(0x63); // 'c' (name)
  });
});
