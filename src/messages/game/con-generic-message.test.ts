import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../base.js';
import { messageRegistry } from '../registry.js';
import { ConGenericMessage } from './con-generic-message.js';
import './con-generic-message.js';

describe('ConGenericMessage', () => {
  it('has the right metadata', () => {
    expect(ConGenericMessage.messageName).toBe('ConGenericMessage');
    expect(ConGenericMessage.varCount).toBe(3);
    expect(ConGenericMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const cmd = 'object createIn 1234 object/intangible/vehicle/landspeeder_av21_pcd.iff';
    const original = new ConGenericMessage(cmd, 42);
    const bytes = encodeMessage(original);
    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(3);
    expect(typeCrc).toBe(ConGenericMessage.typeCrc);
    const decoder = messageRegistry.getByCrc(typeCrc);
    if (decoder === undefined) throw new Error('decoder not registered');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(ConGenericMessage);
    if (!(decoded instanceof ConGenericMessage)) throw new Error('typeguard');
    expect(decoded.msg).toBe(cmd);
    expect(decoded.msgId).toBe(42);
  });
});
