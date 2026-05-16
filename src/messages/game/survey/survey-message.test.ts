import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { SurveyMessage } from './survey-message.js';

// Side-effect import (registers decoder)
import './survey-message.js';

describe('SurveyMessage', () => {
  it('has the expected metadata', () => {
    expect(SurveyMessage.messageName).toBe('SurveyMessage');
    expect(SurveyMessage.varCount).toBe(2);
    expect(SurveyMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips an empty result (no sample points)', () => {
    const original = new SurveyMessage([]);
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(2);
    expect(typeCrc).toBe(SurveyMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder missing');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(SurveyMessage);
    if (!(decoded instanceof SurveyMessage)) throw new Error('typeguard');
    expect(decoded.data).toEqual([]);
  });

  it('round-trips a realistic radial result (3 points)', () => {
    const original = new SurveyMessage([
      { location: { x: 100, y: 50, z: -200 }, efficiency: 0.95 },
      { location: { x: 105, y: 50, z: -195 }, efficiency: 0.72 },
      { location: { x: 110, y: 50, z: -205 }, efficiency: 0.31 },
    ]);
    const bytes = encodeMessage(original);
    const { payload } = parseHeader(bytes);
    const decoded = SurveyMessage.decodePayload(payload);
    expect(decoded.data).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const a = decoded.data[i];
      const b = original.data[i];
      if (a === undefined || b === undefined) throw new Error('missing point');
      expect(a.location.x).toBeCloseTo(b.location.x, 4);
      expect(a.location.y).toBeCloseTo(b.location.y, 4);
      expect(a.location.z).toBeCloseTo(b.location.z, 4);
      expect(a.efficiency).toBeCloseTo(b.efficiency, 5);
    }
  });

  it('has the exact byte layout we expect (one point)', () => {
    const msg = new SurveyMessage([{ location: { x: 0, y: 0, z: 0 }, efficiency: 0 }]);
    const bytes = encodeMessage(msg);
    // Header: varCount=2 (u16 LE) + typeCrc (u32 LE) = 6 bytes
    // Payload: u32 count=1 (4 bytes) + Vector (3 * 4 = 12) + f32 efficiency (4) = 20 bytes
    // Total = 6 + 20 = 26
    expect(bytes.length).toBe(26);
    // varCount = 2 LE
    expect(bytes[0]).toBe(0x02);
    expect(bytes[1]).toBe(0x00);
    // count = 1 LE at offset 6
    expect(bytes[6]).toBe(0x01);
    expect(bytes[7]).toBe(0x00);
    expect(bytes[8]).toBe(0x00);
    expect(bytes[9]).toBe(0x00);
    // Vector (12 bytes of zeros) + efficiency (4 bytes of zeros) — all zero
    for (let i = 10; i < 26; i++) {
      expect(bytes[i]).toBe(0x00);
    }
  });
});
