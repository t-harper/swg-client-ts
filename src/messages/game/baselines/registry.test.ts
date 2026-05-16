import { describe, expect, it } from 'vitest';

import { ReadIterator } from '../../../archive/read-iterator.js';
import {
  type BaselineDecoder,
  BaselinePackageIds,
  ObjectTypeTags,
  baselineRegistry,
  stringToTag,
  tagToString,
  tryDecodeBaseline,
} from './registry.js';

// Side-effect import to make sure all decoders are registered.
import './index.js';

describe('baseline registry', () => {
  describe('tag conversions', () => {
    it('round-trips TANO', () => {
      const tag = stringToTag('TANO');
      expect(tag).toBe(ObjectTypeTags.TANO);
      expect(tagToString(tag)).toBe('TANO');
    });

    it('round-trips PLAY', () => {
      const tag = stringToTag('PLAY');
      expect(tag).toBe(ObjectTypeTags.PLAY);
      expect(tagToString(tag)).toBe('PLAY');
    });

    it('round-trips CREO', () => {
      const tag = stringToTag('CREO');
      expect(tag).toBe(ObjectTypeTags.CREO);
      expect(tagToString(tag)).toBe('CREO');
    });

    it('byte order: TANO first char is low byte of u32', () => {
      // 'T' = 0x54, 'A' = 0x41, 'N' = 0x4E, 'O' = 0x4F
      // LE: low byte first → 0x54 + (0x41 << 8) + (0x4E << 16) + (0x4F << 24)
      expect(ObjectTypeTags.TANO).toBe(0x4f4e4154);
    });

    it('rejects non-4-char input', () => {
      expect(() => stringToTag('TAN')).toThrow();
      expect(() => stringToTag('TANGY')).toThrow();
    });
  });

  describe('registry dispatch', () => {
    it('returns null for an unregistered (typeId, packageId)', () => {
      const result = tryDecodeBaseline(
        ObjectTypeTags.SHIP,
        BaselinePackageIds.CLIENT_ONLY,
        new Uint8Array(0),
        (b) => new ReadIterator(b),
      );
      expect(result).toBeNull();
    });

    it('returns null when registered decoder throws on malformed payload', () => {
      // Pass an empty payload to TangibleObjectShared (which expects at least
      // a u16 memberCount). The decoder should throw, registry should swallow.
      const result = tryDecodeBaseline(
        ObjectTypeTags.TANO,
        BaselinePackageIds.SHARED,
        new Uint8Array(0),
        (b) => new ReadIterator(b),
      );
      expect(result).toBeNull();
    });

    it('rejects collision for the same (typeId, packageId)', () => {
      // Build a phantom decoder colliding with TANO baseline 3
      const phantom: BaselineDecoder<unknown> = {
        kind: 'PhantomCollision',
        typeId: ObjectTypeTags.TANO,
        packageId: BaselinePackageIds.SHARED,
        expectedMemberCount: 1,
        decode: () => null,
      };
      expect(() => baselineRegistry.register(phantom)).toThrow();
    });

    it('finds the TANO/SHARED decoder', () => {
      const d = baselineRegistry.get(ObjectTypeTags.TANO, BaselinePackageIds.SHARED);
      expect(d).toBeDefined();
      expect(d?.kind).toBe('TangibleObjectShared');
    });

    it('finds the PLAY/SHARED decoder', () => {
      const d = baselineRegistry.get(ObjectTypeTags.PLAY, BaselinePackageIds.SHARED);
      expect(d).toBeDefined();
      expect(d?.kind).toBe('PlayerObjectShared');
    });

    it('finds the TANO/SHARED_NP decoder', () => {
      const d = baselineRegistry.get(ObjectTypeTags.TANO, BaselinePackageIds.SHARED_NP);
      expect(d).toBeDefined();
      expect(d?.kind).toBe('TangibleObjectSharedNp');
    });

    it('finds the PLAY/SHARED_NP decoder', () => {
      const d = baselineRegistry.get(ObjectTypeTags.PLAY, BaselinePackageIds.SHARED_NP);
      expect(d).toBeDefined();
      expect(d?.kind).toBe('PlayerObjectSharedNp');
    });
  });
});
