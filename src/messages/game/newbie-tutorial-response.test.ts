import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { encodeMessage, parseHeader } from '../base.js';
import { NewbieTutorialResponse } from './newbie-tutorial-response.js';

describe('NewbieTutorialResponse', () => {
  it('has the expected metadata', () => {
    expect(NewbieTutorialResponse.messageName).toBe('NewbieTutorialResponse');
    expect(NewbieTutorialResponse.typeCrc).toBeGreaterThan(0);
    expect(NewbieTutorialResponse.varCount).toBe(2);
  });

  it('round-trips the "clientReady" response', () => {
    const msg = new NewbieTutorialResponse('clientReady');
    const s = new ByteStream();
    msg.encodePayload(s);
    const decoded = NewbieTutorialResponse.decodePayload(new ReadIterator(s.toBytes()));
    expect(decoded).toBeInstanceOf(NewbieTutorialResponse);
    expect(decoded.response).toBe('clientReady');
  });

  it('round-trips an arbitrary string', () => {
    const msg = new NewbieTutorialResponse('some-other-trigger-name');
    const bytes = encodeMessage(msg);
    const { typeCrc, varCount } = parseHeader(bytes);
    expect(typeCrc).toBe(NewbieTutorialResponse.typeCrc);
    expect(varCount).toBe(NewbieTutorialResponse.varCount);
  });

  it('handles an empty response string', () => {
    const msg = new NewbieTutorialResponse('');
    const s = new ByteStream();
    msg.encodePayload(s);
    const decoded = NewbieTutorialResponse.decodePayload(new ReadIterator(s.toBytes()));
    expect(decoded.response).toBe('');
  });
});
