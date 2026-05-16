import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { encodeMessage, parseHeader } from '../base.js';
import { messageRegistry } from '../registry.js';
import { UpdateTransformWithParentMessage } from './update-transform-with-parent-message.js';

// Side-effect import (registration)
import './update-transform-with-parent-message.js';

describe('UpdateTransformWithParentMessage', () => {
  it('has the expected metadata', () => {
    expect(UpdateTransformWithParentMessage.messageName).toBe('UpdateTransformWithParentMessage');
    expect(UpdateTransformWithParentMessage.typeCrc).toBeGreaterThan(0);
    expect(UpdateTransformWithParentMessage.varCount).toBe(11);
  });

  it('encodes a 30-byte fixed payload in addVariable order (cellId FIRST)', () => {
    // [u64 cellId][u64 netid][i16 px][i16 py][i16 pz][i32 seq][i8 speed][i8 yaw][i8 lookYaw][i8 useLook]
    const cellId = 0x0aaa_bbbb_cccc_ddddn;
    const netId = 0x0011_2233_4455_6677n;
    const m = new UpdateTransformWithParentMessage(
      cellId,
      netId,
      80, // pos*8: 10m
      0,
      -64, // pos*8: -8m
      99,
      5,
      24,
      0,
      0,
    );
    const s = new ByteStream();
    m.encodePayload(s);
    const bytes = s.toBytes();
    expect(bytes.length).toBe(8 + 8 + 2 * 3 + 4 + 4); // 30

    const iter = new ReadIterator(bytes);
    const d = UpdateTransformWithParentMessage.decodePayload(iter);
    expect(iter.remaining).toBe(0);
    expect(d.cellId).toBe(cellId);
    expect(d.networkId).toBe(netId);
    expect(d.positionX).toBe(80);
    expect(d.positionY).toBe(0);
    expect(d.positionZ).toBe(-64);
    expect(d.sequenceNumber).toBe(99);
    expect(d.speed).toBe(5);
    expect(d.yaw).toBe(24);
    expect(d.lookAtYaw).toBe(0);
    expect(d.useLookAtYaw).toBe(0);
  });

  it('round-trips encode → decode via the registry', () => {
    const original = new UpdateTransformWithParentMessage(
      0x4242n, // cellId
      0xfeedn, // networkId
      400, // 50m
      8, // 1m
      -200, // -25m
      7,
      6,
      -32, // -2 rad ish
      16, // 1 rad ish lookAtYaw
      1,
    );
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(11);
    expect(typeCrc).toBe(UpdateTransformWithParentMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder not registered');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(UpdateTransformWithParentMessage);
    if (!(decoded instanceof UpdateTransformWithParentMessage)) throw new Error('typeguard');

    expect(decoded.cellId).toBe(original.cellId);
    expect(decoded.networkId).toBe(original.networkId);
    expect(decoded.positionX).toBe(original.positionX);
    expect(decoded.positionY).toBe(original.positionY);
    expect(decoded.positionZ).toBe(original.positionZ);
    expect(decoded.sequenceNumber).toBe(original.sequenceNumber);
    expect(decoded.speed).toBe(original.speed);
    expect(decoded.yaw).toBe(original.yaw);
    expect(decoded.lookAtYaw).toBe(original.lookAtYaw);
    expect(decoded.useLookAtYaw).toBe(original.useLookAtYaw);
  });

  it('has the exact byte layout we expect', () => {
    // cellId = 0x0102030405060708n, networkId = 0x1112131415161718n,
    // posX = 0x0001 = 1, posY = 0x0002 = 2, posZ = 0xfffe = -2
    // seq = 0x0000_0003 = 3, speed = 4, yaw = 5, lookAtYaw = 6, useLookAtYaw = 1
    const m = new UpdateTransformWithParentMessage(
      0x0102030405060708n,
      0x1112131415161718n,
      1,
      2,
      -2,
      3,
      4,
      5,
      6,
      1,
    );
    const bytes = encodeMessage(m);
    // varCount = 11 (LE u16) → 0B 00
    // typeCrc (LE u32) → 4 bytes
    // cellId (LE u64) → 08 07 06 05 04 03 02 01
    // networkId (LE u64) → 18 17 16 15 14 13 12 11
    // posX (LE i16) → 01 00
    // posY (LE i16) → 02 00
    // posZ (LE i16) → FE FF
    // seq (LE i32) → 03 00 00 00
    // speed, yaw, lookAtYaw, useLookAtYaw → 04 05 06 01
    // Total: 2 + 4 + 8 + 8 + 6 + 4 + 4 = 36 bytes
    expect(bytes.length).toBe(36);
    // varCount = 11
    expect(bytes[0]).toBe(0x0b);
    expect(bytes[1]).toBe(0x00);
    // cellId starts at offset 6 (after varCount + typeCrc)
    expect(bytes[6]).toBe(0x08);
    expect(bytes[7]).toBe(0x07);
    expect(bytes[8]).toBe(0x06);
    expect(bytes[9]).toBe(0x05);
    expect(bytes[10]).toBe(0x04);
    expect(bytes[11]).toBe(0x03);
    expect(bytes[12]).toBe(0x02);
    expect(bytes[13]).toBe(0x01);
    // networkId starts at offset 14
    expect(bytes[14]).toBe(0x18);
    expect(bytes[15]).toBe(0x17);
    expect(bytes[16]).toBe(0x16);
    expect(bytes[17]).toBe(0x15);
    expect(bytes[18]).toBe(0x14);
    expect(bytes[19]).toBe(0x13);
    expect(bytes[20]).toBe(0x12);
    expect(bytes[21]).toBe(0x11);
    // positions
    expect(bytes[22]).toBe(0x01);
    expect(bytes[23]).toBe(0x00);
    expect(bytes[24]).toBe(0x02);
    expect(bytes[25]).toBe(0x00);
    expect(bytes[26]).toBe(0xfe);
    expect(bytes[27]).toBe(0xff);
    // sequence
    expect(bytes[28]).toBe(0x03);
    expect(bytes[29]).toBe(0x00);
    expect(bytes[30]).toBe(0x00);
    expect(bytes[31]).toBe(0x00);
    // speed, yaw, lookAtYaw, useLookAtYaw
    expect(bytes[32]).toBe(0x04);
    expect(bytes[33]).toBe(0x05);
    expect(bytes[34]).toBe(0x06);
    expect(bytes[35]).toBe(0x01);
  });

  it('drains trailing bytes defensively', () => {
    const m = new UpdateTransformWithParentMessage(1n, 2n, 0, 0, 0, 0, 0, 0, 0, 0);
    const s = new ByteStream();
    m.encodePayload(s);
    const padded = new Uint8Array(s.toBytes().length + 4);
    padded.set(s.toBytes(), 0);
    const iter = new ReadIterator(padded);
    const d = UpdateTransformWithParentMessage.decodePayload(iter);
    expect(d.cellId).toBe(1n);
    expect(d.networkId).toBe(2n);
    expect(iter.remaining).toBe(0);
  });

  it('handles signed NetworkIds (negative bigint) round-trip', () => {
    // SWG NetworkIds are signed i64. The high-bit (0x8000_0000_0000_0000n) case.
    const cellId = -1n;
    const netId = -0x7000000000000000n;
    const m = new UpdateTransformWithParentMessage(cellId, netId, 0, 0, 0, 0, 0, 0, 0, 0);
    const s = new ByteStream();
    m.encodePayload(s);
    const iter = new ReadIterator(s.toBytes());
    const d = UpdateTransformWithParentMessage.decodePayload(iter);
    expect(d.cellId).toBe(cellId);
    expect(d.networkId).toBe(netId);
  });
});
