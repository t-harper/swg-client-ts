import { describe, expect, it } from 'vitest';
import { StubByteStream, StubReadIterator } from '../../archive/_stub-byte-stream.js';
import { CmdSceneReady } from './cmd-scene-ready.js';

describe('CmdSceneReady', () => {
  it('has the expected metadata', () => {
    expect(CmdSceneReady.messageName).toBe('CmdSceneReady');
    expect(CmdSceneReady.typeCrc).toBeGreaterThan(0);
  });

  it('encodes an empty payload', () => {
    const m = new CmdSceneReady();
    const s = new StubByteStream();
    m.encodePayload(s);
    expect(s.toBytes().length).toBe(0);
  });

  it('decodes from empty buffer', () => {
    const iter = new StubReadIterator(new Uint8Array(0));
    const d = CmdSceneReady.decodePayload(iter);
    expect(d).toBeInstanceOf(CmdSceneReady);
    expect(iter.remaining).toBe(0);
  });
});
