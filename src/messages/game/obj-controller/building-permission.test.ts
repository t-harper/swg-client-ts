import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import {
  AddAllowedDecoder,
  AddAllowedKind,
  AddBannedDecoder,
  AddBannedKind,
  RemoveAllowedDecoder,
  RemoveAllowedKind,
  RemoveBannedDecoder,
  RemoveBannedKind,
} from './building-permission.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('BuildingPermission subtypes', () => {
  describe('AddAllowed (CM_addAllowed = 403)', () => {
    it('has the right metadata', () => {
      expect(AddAllowedDecoder.kind).toBe('AddAllowed');
      expect(AddAllowedDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_addAllowed);
      expect(AddAllowedDecoder.subtypeId).toBe(403);
    });

    it('self-registers in the subtype registry', () => {
      const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_addAllowed);
      expect(found).toBe(AddAllowedDecoder);
      expect(objControllerRegistry.getByKind(AddAllowedKind)).toBe(AddAllowedDecoder);
    });

    it('round-trips encode → decode for a plain player name', () => {
      const s = new ByteStream();
      AddAllowedDecoder.encode(s, { name: 'Guild03' });
      const bytes = s.toBytes();
      // 2-byte LE length prefix (7) + "Guild03" = 9 bytes
      expect(bytes.length).toBe(9);
      const d = AddAllowedDecoder.decode(new ReadIterator(bytes));
      expect(d.name).toBe('Guild03');
    });

    it('round-trips encode → decode for a guild abbrev token', () => {
      const s = new ByteStream();
      AddAllowedDecoder.encode(s, { name: 'guild:TSC' });
      const d = AddAllowedDecoder.decode(new ReadIterator(s.toBytes()));
      expect(d.name).toBe('guild:TSC');
    });

    it('encodes an empty name as just the 2-byte zero length prefix', () => {
      const s = new ByteStream();
      AddAllowedDecoder.encode(s, { name: '' });
      const bytes = s.toBytes();
      expect(Array.from(bytes)).toEqual([0x00, 0x00]);
      const d = AddAllowedDecoder.decode(new ReadIterator(bytes));
      expect(d.name).toBe('');
    });

    it('has the exact byte layout for name="Bob" (ASCII)', () => {
      const s = new ByteStream();
      AddAllowedDecoder.encode(s, { name: 'Bob' });
      const bytes = s.toBytes();
      // 0x03,0x00 = length 3 LE; 'B','o','b' = 0x42,0x6f,0x62
      expect(Array.from(bytes)).toEqual([0x03, 0x00, 0x42, 0x6f, 0x62]);
    });
  });

  describe('RemoveAllowed (CM_removeAllowed = 404)', () => {
    it('has the right metadata', () => {
      expect(RemoveAllowedDecoder.kind).toBe('RemoveAllowed');
      expect(RemoveAllowedDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_removeAllowed);
      expect(RemoveAllowedDecoder.subtypeId).toBe(404);
    });

    it('self-registers in the subtype registry', () => {
      const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_removeAllowed);
      expect(found).toBe(RemoveAllowedDecoder);
      expect(objControllerRegistry.getByKind(RemoveAllowedKind)).toBe(RemoveAllowedDecoder);
    });

    it('round-trips encode → decode', () => {
      const s = new ByteStream();
      RemoveAllowedDecoder.encode(s, { name: 'Guild05' });
      const d = RemoveAllowedDecoder.decode(new ReadIterator(s.toBytes()));
      expect(d.name).toBe('Guild05');
    });
  });

  describe('AddBanned (CM_addBanned = 405)', () => {
    it('has the right metadata', () => {
      expect(AddBannedDecoder.kind).toBe('AddBanned');
      expect(AddBannedDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_addBanned);
      expect(AddBannedDecoder.subtypeId).toBe(405);
    });

    it('self-registers in the subtype registry', () => {
      const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_addBanned);
      expect(found).toBe(AddBannedDecoder);
      expect(objControllerRegistry.getByKind(AddBannedKind)).toBe(AddBannedDecoder);
    });

    it('round-trips encode → decode', () => {
      const s = new ByteStream();
      AddBannedDecoder.encode(s, { name: 'BadActor' });
      const d = AddBannedDecoder.decode(new ReadIterator(s.toBytes()));
      expect(d.name).toBe('BadActor');
    });
  });

  describe('RemoveBanned (CM_removeBanned = 406)', () => {
    it('has the right metadata', () => {
      expect(RemoveBannedDecoder.kind).toBe('RemoveBanned');
      expect(RemoveBannedDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_removeBanned);
      expect(RemoveBannedDecoder.subtypeId).toBe(406);
    });

    it('self-registers in the subtype registry', () => {
      const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_removeBanned);
      expect(found).toBe(RemoveBannedDecoder);
      expect(objControllerRegistry.getByKind(RemoveBannedKind)).toBe(RemoveBannedDecoder);
    });

    it('round-trips encode → decode', () => {
      const s = new ByteStream();
      RemoveBannedDecoder.encode(s, { name: 'BadActor' });
      const d = RemoveBannedDecoder.decode(new ReadIterator(s.toBytes()));
      expect(d.name).toBe('BadActor');
    });
  });

  describe('shared wire shape', () => {
    it('all four subtypes produce identical bytes for the same name', () => {
      const expected = (() => {
        const s = new ByteStream();
        AddAllowedDecoder.encode(s, { name: 'TestPlayer' });
        return Array.from(s.toBytes());
      })();
      for (const dec of [
        RemoveAllowedDecoder,
        AddBannedDecoder,
        RemoveBannedDecoder,
      ]) {
        const s = new ByteStream();
        dec.encode(s, { name: 'TestPlayer' });
        expect(Array.from(s.toBytes())).toEqual(expected);
      }
    });
  });
});
