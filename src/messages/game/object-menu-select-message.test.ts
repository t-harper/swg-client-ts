import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { encodeMessage, parseHeader } from '../base.js';
import {
  ObjectMenuSelectMessage,
  ObjectMenuSelectMessageDecoder,
  RadialMenuTypes,
} from './object-menu-select-message.js';

describe('ObjectMenuSelectMessage', () => {
  it('encodes targetId + selectedItemId as 10 wire bytes', () => {
    const m = new ObjectMenuSelectMessage(0x0123456789abcdefn, RadialMenuTypes.ITEM_USE);
    const stream = new ByteStream();
    m.encodePayload(stream);
    const bytes = stream.toBytes();
    expect(bytes.length).toBe(10); // 8 (NetworkId LE) + 2 (u16 LE)
    expect(Array.from(bytes)).toEqual([
      0xef,
      0xcd,
      0xab,
      0x89,
      0x67,
      0x45,
      0x23,
      0x01, // targetId LE
      0x15,
      0x00, // selectedItemId = 21 (ITEM_USE) LE
    ]);
  });

  it('round-trips through decodePayload (NetworkIds are signed i64)', () => {
    const original = new ObjectMenuSelectMessage(0x40ffee1234567890n, RadialMenuTypes.ITEM_USE);
    const stream = new ByteStream();
    original.encodePayload(stream);
    const decoded = ObjectMenuSelectMessage.decodePayload(new ReadIterator(stream.toBytes()));
    expect(decoded.targetId).toBe(original.targetId);
    expect(decoded.selectedItemId).toBe(original.selectedItemId);
  });

  it('full-message round-trip preserves wire framing', () => {
    const original = new ObjectMenuSelectMessage(389671787n, RadialMenuTypes.ITEM_USE);
    const wire = encodeMessage(original);
    // [u16 varCount=3][u32 typeCrc][8b NetworkId][2b selectedItemId] = 16 bytes total
    expect(wire.length).toBe(16);
    const { varCount, typeCrc, payload } = parseHeader(wire);
    expect(varCount).toBe(3);
    expect(typeCrc).toBe(ObjectMenuSelectMessage.typeCrc);
    const decoded = ObjectMenuSelectMessage.decodePayload(payload);
    expect(decoded.targetId).toBe(389671787n);
    expect(decoded.selectedItemId).toBe(21);
  });

  it('decoder is registered and exposes the typeCrc', () => {
    expect(ObjectMenuSelectMessageDecoder.typeCrc).toBe(ObjectMenuSelectMessage.typeCrc);
    expect(ObjectMenuSelectMessageDecoder.messageName).toBe(
      'ObjectMenuSelectMessage::MESSAGE_TYPE',
    );
  });

  it('ITEM_USE constant matches menu_info_types.java (21)', () => {
    expect(RadialMenuTypes.ITEM_USE).toBe(21);
  });

  it('PET_* constants match menu_info_types.java indices', () => {
    expect(RadialMenuTypes.PET_CALL).toBe(45);
    expect(RadialMenuTypes.PET_STORE).toBe(60);
    expect(RadialMenuTypes.VEHICLE_GENERATE).toBe(61);
    expect(RadialMenuTypes.VEHICLE_STORE).toBe(62);
    expect(RadialMenuTypes.VEHICLE_OFFER_RIDE).toBe(68);
    expect(RadialMenuTypes.PET_COMMAND).toBe(224);
    expect(RadialMenuTypes.PET_FOLLOW).toBe(225);
    expect(RadialMenuTypes.PET_STAY).toBe(226);
    expect(RadialMenuTypes.PET_GUARD).toBe(227);
    expect(RadialMenuTypes.PET_FRIEND).toBe(228);
    expect(RadialMenuTypes.PET_ATTACK).toBe(229);
    expect(RadialMenuTypes.PET_PATROL).toBe(230);
    expect(RadialMenuTypes.SERVER_PET_MOUNT).toBe(288);
    expect(RadialMenuTypes.SERVER_PET_DISMOUNT).toBe(289);
  });
});
