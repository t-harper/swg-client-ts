import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
// Side-effect imports: every subtype self-registers on first load.
import './index.js';
import {
  type ObjControllerSubtypeDecoder,
  ObjControllerSubtypeIds,
  objControllerRegistry,
  tryDecodeSubtype,
} from './registry.js';

describe('ObjController subtype registry', () => {
  it('has all 8 modeled subtypes registered', () => {
    for (const [name, id] of Object.entries(ObjControllerSubtypeIds)) {
      const found = objControllerRegistry.getById(id);
      expect(found, `${name} (id=${id}) not registered`).toBeDefined();
    }
  });

  it('returns disjoint kinds per id', () => {
    const seenKinds = new Set<string>();
    for (const [, decoder] of objControllerRegistry.entries()) {
      expect(seenKinds.has(decoder.kind)).toBe(false);
      seenKinds.add(decoder.kind);
    }
  });

  it('tryDecodeSubtype returns null for an unknown subtype id', () => {
    const result = tryDecodeSubtype(
      0xdead_beef,
      new Uint8Array([1, 2, 3, 4]),
      (b) => new ReadIterator(b),
    );
    expect(result).toBeNull();
  });

  it('tryDecodeSubtype returns a typed object for a known subtype', () => {
    // Encode a known subtype (PostureChange) and dispatch via the registry
    const decoder = objControllerRegistry.getById(
      ObjControllerSubtypeIds.CM_setPosture,
    ) as ObjControllerSubtypeDecoder<{ posture: number; isClientImmediate: boolean }>;
    expect(decoder).toBeDefined();
    const s = new ByteStream();
    decoder.encode(s, { posture: 8, isClientImmediate: true });
    const result = tryDecodeSubtype(
      ObjControllerSubtypeIds.CM_setPosture,
      s.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('PostureChange');
    const data = result?.data as { posture: number; isClientImmediate: boolean };
    expect(data.posture).toBe(8);
    expect(data.isClientImmediate).toBe(true);
  });

  it('tryDecodeSubtype swallows decode errors (returns null on under-read)', () => {
    // PostureChange expects 2 bytes; give 1 and expect a clean null
    const result = tryDecodeSubtype(
      ObjControllerSubtypeIds.CM_setPosture,
      new Uint8Array([0]),
      (b) => new ReadIterator(b),
    );
    expect(result).toBeNull();
  });
});
