import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { GameServerForLoginMessage } from './game-server-for-login.js';

describe('GameServerForLoginMessage', () => {
  it('has the expected metadata', () => {
    expect(GameServerForLoginMessage.messageName).toBe('GameServerForLoginMessage');
    expect(GameServerForLoginMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips [u32 stationId][u32 server][NetworkId characterId]', () => {
    const m = new GameServerForLoginMessage(0xdeadbeef, 1234, 0x0011_2233_4455_6677n);
    const s = new ByteStream();
    m.encodePayload(s);
    expect(s.toBytes().length).toBe(4 + 4 + 8);
    const d = GameServerForLoginMessage.decodePayload(new ReadIterator(s.toBytes()));
    expect(d.stationId).toBe(0xdeadbeef);
    expect(d.server).toBe(1234);
    expect(d.characterId).toBe(0x0011_2233_4455_6677n);
  });
});
