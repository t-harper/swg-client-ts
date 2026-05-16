import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
// Side-effect imports: every subtype self-registers on first load.
import './index.js';
// Side-effect: the crafting-folder subtypes register through this registry too.
import '../crafting/index.js';
// Side-effect: the mission-folder subtypes register through this registry too
// (CM_missionListRequest, CM_missionAcceptRequest, etc.).
import '../missions/index.js';
import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { ObjControllerMessage } from '../obj-controller-message.js';
import { type CraftingStartData, CraftingStartDecoder } from './crafting-start.js';
import { GroupInviteDecoder } from './group-invite.js';
import {
  type ObjControllerSubtypeDecoder,
  ObjControllerSubtypeIds,
  objControllerRegistry,
  tryDecodeSubtype,
} from './registry.js';
import {
  type SpatialChatData,
  SpatialChatReceiveDecoder,
  SpatialChatType,
} from './spatial-chat.js';
import { StartDanceDecoder } from './start-dance.js';

describe('ObjController subtype registry', () => {
  it('has every entry in ObjControllerSubtypeIds registered', () => {
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

/**
 * Full parent-message dispatch tests. Build an `ObjControllerMessage` whose
 * `message` is the subtype id, encode it via the top-level `encodeMessage`,
 * then parse it back through `parseHeader` + the message registry and assert
 * the subtype dispatched correctly.
 */
describe('ObjController parent-message dispatch', () => {
  it('dispatches a SpatialChat receive trailer (CM_spatialChatReceive)', () => {
    const chat: SpatialChatData = {
      sourceId: 0x100n,
      targetId: 0n,
      text: 'hello',
      flags: 0,
      volume: 0,
      chatType: SpatialChatType.Say,
      moodType: 0,
      language: 0,
      outOfBand: '',
      sourceName: '',
    };
    const s = new ByteStream();
    SpatialChatReceiveDecoder.encode(s, chat);

    const parent = new ObjControllerMessage(
      0x23, // typical CLIENT_TO_AUTH_SERVER flags
      ObjControllerSubtypeIds.CM_spatialChatReceive,
      0x100n, // sourceCreatureId
      0,
      s.toBytes(),
    );
    const bytes = encodeMessage(parent);

    const { typeCrc, payload } = parseHeader(bytes);
    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('ObjControllerMessage decoder not registered');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(ObjControllerMessage);
    const om = decoded as ObjControllerMessage;
    expect(om.message).toBe(ObjControllerSubtypeIds.CM_spatialChatReceive);
    expect(om.decodedSubtype).not.toBeNull();
    expect(om.decodedSubtype?.kind).toBe('SpatialChat');
    const data = om.decodedSubtype?.data as SpatialChatData;
    expect(data.sourceId).toBe(0x100n);
    expect(data.text).toBe('hello');
    expect(data.chatType).toBe(SpatialChatType.Say);
  });

  it('dispatches a StartDance trailer (CM_setPerformanceType)', () => {
    const s = new ByteStream();
    StartDanceDecoder.encode(s, { performanceType: 12 });

    const parent = new ObjControllerMessage(
      0x23,
      ObjControllerSubtypeIds.CM_setPerformanceType,
      0xabcn, // actor creature id
      0,
      s.toBytes(),
    );
    const bytes = encodeMessage(parent);

    const { typeCrc, payload } = parseHeader(bytes);
    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('ObjControllerMessage decoder not registered');
    const decoded = decoder.decodePayload(payload) as ObjControllerMessage;
    expect(decoded.message).toBe(ObjControllerSubtypeIds.CM_setPerformanceType);
    expect(decoded.decodedSubtype?.kind).toBe('StartDance');
    const data = decoded.decodedSubtype?.data as { performanceType: number };
    expect(data.performanceType).toBe(12);
  });

  it('dispatches a CraftingStart trailer (CM_requestCraftingSession)', () => {
    const s = new ByteStream();
    CraftingStartDecoder.encode(s, { stationId: 0xc0fen, sequenceId: 3 });

    const parent = new ObjControllerMessage(
      0x23,
      ObjControllerSubtypeIds.CM_requestCraftingSession,
      0xabcdn, // player id
      0,
      s.toBytes(),
    );
    const bytes = encodeMessage(parent);

    const { typeCrc, payload } = parseHeader(bytes);
    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('ObjControllerMessage decoder not registered');
    const decoded = decoder.decodePayload(payload) as ObjControllerMessage;
    expect(decoded.message).toBe(ObjControllerSubtypeIds.CM_requestCraftingSession);
    expect(decoded.decodedSubtype?.kind).toBe('CraftingStart');
    const data = decoded.decodedSubtype?.data as CraftingStartData;
    expect(data.stationId).toBe(0xc0fen);
    expect(data.sequenceId).toBe(3);
  });

  it('dispatches a GroupInvite trailer (CM_setGroupInviter)', () => {
    const s = new ByteStream();
    GroupInviteDecoder.encode(s, {
      inviterName: 'Wedge',
      inviterId: 0xfeed_facen,
      inviterShipId: 0n,
    });

    const parent = new ObjControllerMessage(
      0x23,
      ObjControllerSubtypeIds.CM_setGroupInviter,
      0xabcdn, // invitee creature id
      0,
      s.toBytes(),
    );
    const bytes = encodeMessage(parent);

    const { typeCrc, payload } = parseHeader(bytes);
    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('ObjControllerMessage decoder not registered');
    const decoded = decoder.decodePayload(payload) as ObjControllerMessage;
    expect(decoded.message).toBe(ObjControllerSubtypeIds.CM_setGroupInviter);
    expect(decoded.decodedSubtype?.kind).toBe('GroupInvite');
    const data = decoded.decodedSubtype?.data as {
      inviterName: string;
      inviterId: bigint;
      inviterShipId: bigint;
    };
    expect(data.inviterName).toBe('Wedge');
    expect(data.inviterId).toBe(0xfeed_facen);
    expect(data.inviterShipId).toBe(0n);
  });
});
