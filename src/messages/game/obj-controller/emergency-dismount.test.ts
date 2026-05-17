import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { EmergencyDismountDecoder, EmergencyDismountKind } from './emergency-dismount.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('EmergencyDismount (CM_emergencyDismountForRider)', () => {
  it('has the right metadata', () => {
    expect(EmergencyDismountDecoder.kind).toBe('EmergencyDismount');
    expect(EmergencyDismountDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_emergencyDismountForRider,
    );
    expect(EmergencyDismountDecoder.subtypeId).toBe(540);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(
      ObjControllerSubtypeIds.CM_emergencyDismountForRider,
    );
    expect(found).toBe(EmergencyDismountDecoder);
    expect(objControllerRegistry.getByKind(EmergencyDismountKind)).toBe(EmergencyDismountDecoder);
  });

  it('round-trips an empty trailer', () => {
    const s = new ByteStream();
    EmergencyDismountDecoder.encode(s, {});
    expect(s.toBytes().length).toBe(0);
    const d = EmergencyDismountDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual({});
  });
});
