import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';
import {
  SpatialChatKind,
  SpatialChatReceiveDecoder,
  SpatialChatSendDecoder,
  SpatialChatSendKind,
  SpatialChatType,
  makeSpatialChatData,
} from './spatial-chat.js';

describe('SpatialChat (CM_spatialChatSend / CM_spatialChatReceive)', () => {
  it('has the right metadata', () => {
    expect(SpatialChatReceiveDecoder.kind).toBe('SpatialChat');
    expect(SpatialChatReceiveDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_spatialChatReceive);
    expect(SpatialChatReceiveDecoder.subtypeId).toBe(244);

    expect(SpatialChatSendDecoder.kind).toBe('SpatialChatSend');
    expect(SpatialChatSendDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_spatialChatSend);
    expect(SpatialChatSendDecoder.subtypeId).toBe(243);
  });

  it('self-registers in the subtype registry under both ids', () => {
    expect(objControllerRegistry.getById(ObjControllerSubtypeIds.CM_spatialChatReceive)).toBe(
      SpatialChatReceiveDecoder,
    );
    expect(objControllerRegistry.getById(ObjControllerSubtypeIds.CM_spatialChatSend)).toBe(
      SpatialChatSendDecoder,
    );
    expect(objControllerRegistry.getByKind(SpatialChatKind)).toBe(SpatialChatReceiveDecoder);
    expect(objControllerRegistry.getByKind(SpatialChatSendKind)).toBe(SpatialChatSendDecoder);
  });

  it('round-trips encode → decode (broadcast /say)', () => {
    const original = {
      sourceId: 0x1122_3344_5566_7788n,
      targetId: 0n, // area chat
      text: 'hello world',
      flags: 0,
      volume: 0,
      chatType: SpatialChatType.Say,
      moodType: 0,
      language: 0,
      outOfBand: '',
      sourceName: '',
    };
    const s = new ByteStream();
    SpatialChatReceiveDecoder.encode(s, original);
    const d = SpatialChatReceiveDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(original);
  });

  it('round-trips a directed /whisper with non-trivial fields', () => {
    const original = {
      sourceId: 0x1n,
      targetId: 0x2n,
      text: 'pssst',
      flags: 0x0000_00ff,
      volume: 5,
      chatType: SpatialChatType.Whisper,
      moodType: 7,
      language: 3,
      outOfBand: 'oob-token',
      sourceName: 'Alias',
    };
    const s = new ByteStream();
    SpatialChatReceiveDecoder.encode(s, original);
    const d = SpatialChatReceiveDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(original);
  });

  it('handles unicode text with non-ASCII codepoints', () => {
    const original = {
      sourceId: 1n,
      targetId: 0n,
      text: 'héllo 世界',
      flags: 0,
      volume: 0,
      chatType: SpatialChatType.Say,
      moodType: 0,
      language: 0,
      outOfBand: '',
      sourceName: '',
    };
    const s = new ByteStream();
    SpatialChatReceiveDecoder.encode(s, original);
    const d = SpatialChatReceiveDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.text).toBe(original.text);
  });

  it('has the expected byte layout for an empty-text /say', () => {
    const data = {
      sourceId: 1n,
      targetId: 0n,
      text: '',
      flags: 0,
      volume: 0,
      chatType: SpatialChatType.Say,
      moodType: 0,
      language: 0,
      outOfBand: '',
      sourceName: '',
    };
    const s = new ByteStream();
    SpatialChatReceiveDecoder.encode(s, data);
    const bytes = s.toBytes();
    // 8 (sourceId) + 8 (targetId) + 4 (text count=0)
    //   + 4 (flags) + 2 (volume) + 2 (chatType) + 2 (moodType) + 1 (language)
    //   + 4 (oob count=0) + 4 (sourceName count=0) = 39
    expect(bytes.length).toBe(39);
    // sourceId = 1 (LE i64)
    expect(Array.from(bytes.subarray(0, 8))).toEqual([0x01, 0, 0, 0, 0, 0, 0, 0]);
    // targetId = 0
    expect(Array.from(bytes.subarray(8, 16))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // text length (u32 LE) = 0
    expect(Array.from(bytes.subarray(16, 20))).toEqual([0, 0, 0, 0]);
  });

  it('symmetric round-trip via the send-side decoder too', () => {
    const data = makeSpatialChatData(99n, 'test send', { chatType: SpatialChatType.Shout });
    const s = new ByteStream();
    SpatialChatSendDecoder.encode(s, data);
    const decoded = SpatialChatSendDecoder.decode(new ReadIterator(s.toBytes()));
    expect(decoded).toEqual(data);
  });

  it('makeSpatialChatData provides server-compatible defaults', () => {
    const d = makeSpatialChatData(7n, 'hi');
    expect(d.sourceId).toBe(7n);
    expect(d.targetId).toBe(0n);
    expect(d.text).toBe('hi');
    expect(d.flags).toBe(0);
    // Volume defaults to the chatType-canonical radius (50m for Say).
    // Volume = 0 server-side means a zero-radius sphere → nobody hears it.
    expect(d.volume).toBe(50);
    expect(d.chatType).toBe(SpatialChatType.Say);
    expect(d.moodType).toBe(0);
    expect(d.language).toBe(0);
    expect(d.outOfBand).toBe('');
    expect(d.sourceName).toBe('');
  });

  it('makeSpatialChatData picks the canonical volume per chat type', () => {
    expect(makeSpatialChatData(1n, 'a').volume).toBe(50); // Say (default)
    expect(makeSpatialChatData(1n, 'a', { chatType: SpatialChatType.Shout }).volume).toBe(100);
    expect(makeSpatialChatData(1n, 'a', { chatType: SpatialChatType.Whisper }).volume).toBe(25);
  });

  it('makeSpatialChatData honors an explicit volume override (incl. 0 for tests)', () => {
    const explicit = makeSpatialChatData(1n, 'a', { volume: 7 });
    expect(explicit.volume).toBe(7);
    const zero = makeSpatialChatData(1n, 'a', { volume: 0 });
    expect(zero.volume).toBe(0);
  });
});
