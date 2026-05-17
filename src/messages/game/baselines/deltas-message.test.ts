import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { writeStdString } from '../../../archive/string.js';
import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import {
  CreoSharedNpIndices,
  DeltasMessage,
  decodeGroupDelta,
  decodeGroupInviterDelta,
} from './deltas-message.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

// Side-effect import: ensure all decoders register.
import './index.js';

describe('DeltasMessage', () => {
  it('has the right metadata', () => {
    expect(DeltasMessage.messageName).toBe('DeltasMessage');
    expect(DeltasMessage.varCount).toBe(5);
    expect(DeltasMessage.typeCrc).toBeGreaterThan(0);
  });

  it('is registered in the global registry', () => {
    expect(messageRegistry.getByCrc(DeltasMessage.typeCrc)).toBeDefined();
  });

  it('round-trips encode → decode (empty package)', () => {
    const original = new DeltasMessage(
      0xfeed_facen,
      ObjectTypeTags.CREO,
      BaselinePackageIds.SHARED_NP,
      new Uint8Array(0),
    );
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(5);
    expect(typeCrc).toBe(DeltasMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    expect(decoder).toBeDefined();
    const decoded = decoder?.decodePayload(payload);
    expect(decoded).toBeInstanceOf(DeltasMessage);
    if (!(decoded instanceof DeltasMessage)) throw new Error('typeguard');

    expect(decoded.target).toBe(0xfeed_facen);
    expect(decoded.typeId).toBe(ObjectTypeTags.CREO);
    expect(decoded.typeIdString).toBe('CREO');
    expect(decoded.packageId).toBe(BaselinePackageIds.SHARED_NP);
    expect(decoded.packageBytes.length).toBe(0);
    expect(decoded.dirtyCount).toBe(0);
    expect(decoded.firstDirtyIndex).toBeNull();
  });

  it('round-trips with a non-empty package and exposes dirty-list header', () => {
    // Build a 1-item dirty list: [u16 count=1][u16 index=14][8 bytes payload]
    const pkg = new ByteStream();
    pkg.writeU16(1);
    pkg.writeU16(14);
    for (let i = 0; i < 8; i++) pkg.writeU8(0xab);
    const pkgBytes = pkg.toBytes();

    const original = new DeltasMessage(
      0x1234_5678n,
      ObjectTypeTags.CREO,
      BaselinePackageIds.SHARED_NP,
      pkgBytes,
    );
    const bytes = encodeMessage(original);

    const { payload } = parseHeader(bytes);
    const decoded = DeltasMessage.decodePayload(payload);
    expect(decoded.target).toBe(0x1234_5678n);
    expect(decoded.typeId).toBe(ObjectTypeTags.CREO);
    expect(decoded.packageId).toBe(BaselinePackageIds.SHARED_NP);
    expect(decoded.packageBytes.length).toBe(pkgBytes.length);
    expect(decoded.dirtyCount).toBe(1);
    expect(decoded.firstDirtyIndex).toBe(14);
  });

  it('decodes the m_groupInviter delta payload (golden bytes from a live invite)', () => {
    // From a live capture against swg-server: invitee's CreatureObject
    // SHARED_NP package, index 14 (m_groupInviter) delta:
    //   01 00     dirtyCount = 1
    //   0e 00     memberIndex = 14
    //   f5 90 c7 22 00 00 00 00   inviterId = 0x22c790f5
    //   08 00 54 73 4c 69 76 65 30 31    "TsLive01" (std::string)
    //   00 00 00 00 00 00 00 00          inviterShipId = 0
    const hex =
      '01000e00f590c72200000000080054734c69766530310000000000000000';
    const pkgBytes = new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));
    expect(pkgBytes.length).toBe(30);

    const msg = new DeltasMessage(
      0x238e0e8fn,
      ObjectTypeTags.CREO,
      BaselinePackageIds.SHARED_NP,
      pkgBytes,
    );
    expect(msg.dirtyCount).toBe(1);
    expect(msg.firstDirtyIndex).toBe(CreoSharedNpIndices.M_GROUP_INVITER);

    const decoded = decodeGroupInviterDelta(msg);
    expect(decoded).not.toBeNull();
    expect(decoded?.inviterId).toBe(0x22c790f5n);
    expect(decoded?.inviterName).toBe('TsLive01');
    expect(decoded?.inviterShipId).toBe(0n);
  });

  it('decodes a "clear inviter" m_groupInviter delta', () => {
    // Server-driven clear after accept / decline / timeout:
    //   01 00     dirtyCount = 1
    //   0e 00     memberIndex = 14
    //   00 00 00 00 00 00 00 00   inviterId = 0
    //   00 00                       empty std::string
    //   00 00 00 00 00 00 00 00   shipId = 0
    const pkg = new ByteStream();
    pkg.writeU16(1);
    pkg.writeU16(14);
    pkg.writeI64(0n);
    writeStdString(pkg, '');
    pkg.writeI64(0n);
    const msg = new DeltasMessage(0x1n, ObjectTypeTags.CREO, BaselinePackageIds.SHARED_NP, pkg.toBytes());
    const decoded = decodeGroupInviterDelta(msg);
    expect(decoded?.inviterId).toBe(0n);
    expect(decoded?.inviterName).toBe('');
    expect(decoded?.inviterShipId).toBe(0n);
  });

  it('decodeGroupInviterDelta returns null for the wrong shape', () => {
    // Wrong typeId
    const pkg = new ByteStream();
    pkg.writeU16(1);
    pkg.writeU16(14);
    pkg.writeI64(0n);
    writeStdString(pkg, '');
    pkg.writeI64(0n);
    const wrongType = new DeltasMessage(0x1n, ObjectTypeTags.PLAY, BaselinePackageIds.SHARED_NP, pkg.toBytes());
    expect(decodeGroupInviterDelta(wrongType)).toBeNull();

    // Wrong packageId
    const wrongPkg = new DeltasMessage(0x1n, ObjectTypeTags.CREO, BaselinePackageIds.SHARED, pkg.toBytes());
    expect(decodeGroupInviterDelta(wrongPkg)).toBeNull();

    // Wrong dirty index
    const wrongIdx = new ByteStream();
    wrongIdx.writeU16(1);
    wrongIdx.writeU16(13); // m_group, not m_groupInviter
    wrongIdx.writeI64(0n);
    const wrongIdxMsg = new DeltasMessage(0x1n, ObjectTypeTags.CREO, BaselinePackageIds.SHARED_NP, wrongIdx.toBytes());
    expect(decodeGroupInviterDelta(wrongIdxMsg)).toBeNull();
  });

  it('decodes the m_group delta payload', () => {
    // 01 00     dirtyCount = 1
    // 0d 00     memberIndex = 13
    // 78 56 34 12 00 00 00 00   groupId = 0x12345678
    const pkg = new ByteStream();
    pkg.writeU16(1);
    pkg.writeU16(13);
    pkg.writeI64(0x12345678n);
    const msg = new DeltasMessage(0x42n, ObjectTypeTags.CREO, BaselinePackageIds.SHARED_NP, pkg.toBytes());
    expect(msg.firstDirtyIndex).toBe(CreoSharedNpIndices.M_GROUP);

    const decoded = decodeGroupDelta(msg);
    expect(decoded?.groupId).toBe(0x12345678n);
  });

  it('handles a malformed (too-short) package gracefully', () => {
    // Only the u32 length prefix says 1 byte of payload; not enough to parse the [u16 count].
    const stream = new ByteStream();
    stream.writeU16(5); // varCount
    stream.writeU32(DeltasMessage.typeCrc);
    stream.writeI64(0n); // target
    stream.writeU32(ObjectTypeTags.CREO); // typeId
    stream.writeU8(BaselinePackageIds.SHARED_NP); // packageId
    stream.writeU32(1); // packageLen
    stream.writeU8(0xff);

    const { payload } = parseHeader(stream.toBytes());
    const decoded = DeltasMessage.decodePayload(payload);
    expect(decoded.packageBytes.length).toBe(1);
    expect(decoded.dirtyCount).toBe(0);
    expect(decoded.firstDirtyIndex).toBeNull();
  });
});
