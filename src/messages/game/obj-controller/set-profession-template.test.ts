import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import {
  SetCurrentWorkingSkillDecoder,
  SetCurrentWorkingSkillKind,
  SetProfessionTemplateDecoder,
  SetProfessionTemplateKind,
} from './set-profession-template.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('NGE profession-pick subtypes', () => {
  describe('SetProfessionTemplate (CM_setProfessionTemplate = 1116)', () => {
    it('has the right metadata', () => {
      expect(SetProfessionTemplateDecoder.kind).toBe('SetProfessionTemplate');
      expect(SetProfessionTemplateDecoder.subtypeId).toBe(
        ObjControllerSubtypeIds.CM_setProfessionTemplate,
      );
      expect(SetProfessionTemplateDecoder.subtypeId).toBe(1116);
    });

    it('self-registers in the subtype registry', () => {
      expect(
        objControllerRegistry.getById(ObjControllerSubtypeIds.CM_setProfessionTemplate),
      ).toBe(SetProfessionTemplateDecoder);
      expect(objControllerRegistry.getByKind(SetProfessionTemplateKind)).toBe(
        SetProfessionTemplateDecoder,
      );
    });

    // Golden bytes from a live Windows-client capture, 2026-05-18, Officer pick.
    // The full 38-byte ObjControllerMessage was:
    //   05 00                       varCount=5
    //   46 5e ce 80                 typeCrc (ObjControllerMessage, LE)
    //   2b 00 00 00                 flags = 0x2b
    //   5c 04 00 00                 message = 1116 (CM_setProfessionTemplate)
    //   c9 5a 42 23 00 00 00 00     networkId = 591551177
    //   00 00 00 00                 value = 0
    //   0a 00                       string length = 10
    //   6f 66 66 69 63 65 72 5f 31 61   "officer_1a"
    //
    // The decoder only sees the trailing std::string (12 bytes after the
    // 20-byte ObjControllerMessage header is peeled off).
    it('encodes/decodes "officer_1a" to/from the live-captured trailer bytes', () => {
      const s = new ByteStream();
      SetProfessionTemplateDecoder.encode(s, { template: 'officer_1a' });
      const bytes = s.toBytes();
      expect(Buffer.from(bytes).toString('hex')).toBe('0a006f6666696365725f3161');
      const d = SetProfessionTemplateDecoder.decode(new ReadIterator(bytes));
      expect(d.template).toBe('officer_1a');
    });

    it('round-trips other class templates', () => {
      for (const tpl of ['officer_1a', 'commando_1a', 'medic_1a', 'spy_1a', 'smuggler_1a', 'bounty_hunter_1a']) {
        const s = new ByteStream();
        SetProfessionTemplateDecoder.encode(s, { template: tpl });
        const d = SetProfessionTemplateDecoder.decode(new ReadIterator(s.toBytes()));
        expect(d.template).toBe(tpl);
      }
    });
  });

  describe('SetCurrentWorkingSkill (CM_setCurrentWorkingSkill = 1115)', () => {
    it('has the right metadata', () => {
      expect(SetCurrentWorkingSkillDecoder.kind).toBe('SetCurrentWorkingSkill');
      expect(SetCurrentWorkingSkillDecoder.subtypeId).toBe(
        ObjControllerSubtypeIds.CM_setCurrentWorkingSkill,
      );
      expect(SetCurrentWorkingSkillDecoder.subtypeId).toBe(1115);
    });

    it('self-registers in the subtype registry', () => {
      expect(
        objControllerRegistry.getById(ObjControllerSubtypeIds.CM_setCurrentWorkingSkill),
      ).toBe(SetCurrentWorkingSkillDecoder);
      expect(objControllerRegistry.getByKind(SetCurrentWorkingSkillKind)).toBe(
        SetCurrentWorkingSkillDecoder,
      );
    });

    // Golden bytes from the same live capture — the working-skill ObjControllerMessage
    // sent immediately after CM_setProfessionTemplate when picking Officer. Trailer is
    // 29 bytes: u16 length=27 + "class_officer_phase1_novice" UTF-8.
    it('encodes/decodes "class_officer_phase1_novice" to/from the live trailer bytes', () => {
      const s = new ByteStream();
      SetCurrentWorkingSkillDecoder.encode(s, {
        template: 'class_officer_phase1_novice',
      });
      const bytes = s.toBytes();
      expect(Buffer.from(bytes).toString('hex')).toBe(
        '1b00636c6173735f6f6666696365725f7068617365315f6e6f76696365',
      );
      const d = SetCurrentWorkingSkillDecoder.decode(new ReadIterator(bytes));
      expect(d.template).toBe('class_officer_phase1_novice');
    });
  });
});
