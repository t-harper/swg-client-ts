import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { ResourceListForSurveyMessage } from './resource-list-for-survey-message.js';

// Side-effect import (registers decoder)
import './resource-list-for-survey-message.js';

describe('ResourceListForSurveyMessage', () => {
  it('has the expected metadata', () => {
    expect(ResourceListForSurveyMessage.messageName).toBe('ResourceListForSurveyMessage');
    expect(ResourceListForSurveyMessage.varCount).toBe(4);
    expect(ResourceListForSurveyMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips an empty list', () => {
    const original = new ResourceListForSurveyMessage([], '', 0n);
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(4);
    expect(typeCrc).toBe(ResourceListForSurveyMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder missing');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(ResourceListForSurveyMessage);
    if (!(decoded instanceof ResourceListForSurveyMessage)) throw new Error('typeguard');
    expect(decoded.data).toEqual([]);
    expect(decoded.surveyType).toBe('');
    expect(decoded.surveyToolId).toBe(0n);
  });

  it('round-trips a realistic mineral-tool result', () => {
    const original = new ResourceListForSurveyMessage(
      [
        {
          resourceName: 'Heshurium',
          resourceId: 0x1234abcdn,
          parentClassName: 'iron_class_3',
        },
        {
          resourceName: 'Quor Glass',
          resourceId: 0x5678def0n,
          parentClassName: 'crystalline_gemstone',
        },
      ],
      'mineral',
      0xdeadbeefn,
    );
    const bytes = encodeMessage(original);
    const { payload } = parseHeader(bytes);
    const decoded = ResourceListForSurveyMessage.decodePayload(payload);
    expect(decoded.data).toHaveLength(2);
    expect(decoded.data[0]).toEqual(original.data[0]);
    expect(decoded.data[1]).toEqual(original.data[1]);
    expect(decoded.surveyType).toBe('mineral');
    expect(decoded.surveyToolId).toBe(0xdeadbeefn);
  });

  it('round-trips signed NetworkIds (high bit set)', () => {
    // NetworkId is i64; the top half of the unsigned range becomes negative.
    const negativeId = -1n;
    const original = new ResourceListForSurveyMessage([], 'flora', negativeId);
    const bytes = encodeMessage(original);
    const { payload } = parseHeader(bytes);
    const decoded = ResourceListForSurveyMessage.decodePayload(payload);
    expect(decoded.surveyToolId).toBe(negativeId);
  });

  it('preserves item order on the wire (matches std::vector semantics)', () => {
    const original = new ResourceListForSurveyMessage(
      [
        { resourceName: 'A', resourceId: 1n, parentClassName: 'class_a' },
        { resourceName: 'B', resourceId: 2n, parentClassName: 'class_b' },
        { resourceName: 'C', resourceId: 3n, parentClassName: 'class_c' },
      ],
      'mineral',
      42n,
    );
    const bytes = encodeMessage(original);
    const { payload } = parseHeader(bytes);
    const decoded = ResourceListForSurveyMessage.decodePayload(payload);
    expect(decoded.data.map((d) => d.resourceName)).toEqual(['A', 'B', 'C']);
    expect(decoded.data.map((d) => d.resourceId)).toEqual([1n, 2n, 3n]);
  });

  it('has the exact byte layout we expect (empty list)', () => {
    const msg = new ResourceListForSurveyMessage([], '', 0n);
    const bytes = encodeMessage(msg);
    // Header: varCount=4 (u16 LE) + typeCrc (u32 LE) = 6 bytes
    // Payload: u32 count=0 (4 bytes) + u16 surveyType len=0 (2) + i64 toolId=0 (8) = 14
    // Total = 6 + 14 = 20
    expect(bytes.length).toBe(20);
    // varCount = 4 LE
    expect(bytes[0]).toBe(0x04);
    expect(bytes[1]).toBe(0x00);
    // u32 count = 0 LE at offset 6
    expect(bytes[6]).toBe(0x00);
    expect(bytes[9]).toBe(0x00);
    // u16 surveyType-length = 0 at offset 10
    expect(bytes[10]).toBe(0x00);
    expect(bytes[11]).toBe(0x00);
    // i64 surveyToolId = 0 at offset 12 (8 bytes, all zero)
    for (let i = 12; i < 20; i++) {
      expect(bytes[i]).toBe(0x00);
    }
  });
});
