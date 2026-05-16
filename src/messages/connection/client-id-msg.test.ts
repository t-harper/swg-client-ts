import { describe, expect, it } from 'vitest';
import { StubByteStream, StubReadIterator } from '../../archive/_stub-byte-stream.js';
import { ClientIdMsg, DEFAULT_CLIENT_VERSION } from './client-id-msg.js';

describe('ClientIdMsg', () => {
  it('exposes the C++ messageName "ClientIdMsg"', () => {
    expect(ClientIdMsg.messageName).toBe('ClientIdMsg');
  });

  it('precomputes its constcrc', () => {
    // Sanity check: non-zero and stable.
    expect(ClientIdMsg.typeCrc).toBeGreaterThan(0);
    expect(ClientIdMsg.typeCrc).toBeLessThan(0x1_0000_0000);
  });

  it('round-trips encode + decode', () => {
    const token = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x12, 0x34, 0x56, 0x78]);
    const msg = new ClientIdMsg(token, 0, DEFAULT_CLIENT_VERSION);
    const stream = new StubByteStream();
    msg.encodePayload(stream);
    const bytes = stream.toBytes();

    const iter = new StubReadIterator(bytes);
    const decoded = ClientIdMsg.decodePayload(iter);

    expect(decoded.gameBitsToClear).toBe(0);
    expect(decoded.version).toBe(DEFAULT_CLIENT_VERSION);
    expect(Array.from(decoded.token)).toEqual(Array.from(token));
    expect(iter.remaining).toBe(0);
  });

  it('produces the expected golden bytes', () => {
    // gameBitsToClear=0x01020304, token=[0xaa,0xbb], version="v1"
    const token = new Uint8Array([0xaa, 0xbb]);
    const msg = new ClientIdMsg(token, 0x01020304, 'v1');
    const stream = new StubByteStream();
    msg.encodePayload(stream);

    // Expected wire bytes (little-endian):
    //   [u32 gameBitsToClear: 04 03 02 01]
    //   [u32 tokenLen:        02 00 00 00]
    //   [token bytes:         aa bb]
    //   [u16 versionLen:      02 00]
    //   [version bytes:       76 31  ("v1")]
    const expected = new Uint8Array([
      0x04, 0x03, 0x02, 0x01, 0x02, 0x00, 0x00, 0x00, 0xaa, 0xbb, 0x02, 0x00, 0x76, 0x31,
    ]);
    expect(Array.from(stream.toBytes())).toEqual(Array.from(expected));
  });
});
