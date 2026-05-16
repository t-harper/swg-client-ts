/**
 * SpatialChat (CM_spatialChatSend = 243, CM_spatialChatReceive = 244) —
 * bidirectional.
 *
 * The single workhorse subtype for *spatial* chat — `/say`, `/shout`,
 * `/whisper`, plus various combat-banter "emotes" routed through it. The
 * same wire layout is registered under TWO controller-message ids: 243 for
 * the client→server send path, 244 for the server→client receive path
 * (which the server fans out to every observer in earshot).
 *
 * Wire layout (trailer only — the 20-byte ObjControllerMessage header is
 * peeled off upstream; field order from `MessageQueueSpatialChatArchive.cpp:32-41`
 * and `:69-78`):
 *   [NetworkId (i64 LE)]   sourceId
 *   [NetworkId (i64 LE)]   targetId         (or 0 for area chat)
 *   [UnicodeString]        text             (the chat content — UTF-16 LE chars)
 *   [u32]                  flags            (bit flags — see C++ for meanings)
 *   [u16]                  volume           (range-attenuation hint)
 *   [u16]                  chatType         (chatType.iff index: say / shout / ...)
 *   [u16]                  moodType         (moodAnimation.iff index)
 *   [u8]                   language         (server-side language enum)
 *   [UnicodeString]        outOfBand        (proseTable / context tokens; usually "")
 *   [UnicodeString]        sourceName       (display-name override; usually "")
 *
 * Notes:
 *   - `targetId == 0n` for area chat (everyone in earshot); a non-zero id means
 *     directed spatial chat (`/whisper`).
 *   - `language` is on the wire as `uint8` but the constructor takes `uint32`
 *     and DEBUG_FATAL's if it exceeds 255. Treat as 0..255.
 *   - `outOfBand` is normally empty; it carries serialized ProsePackage data
 *     when the message is templated (NPC dialogue, system messages, etc.).
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueSpatialChat.{h,cpp}
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueSpatialChatArchive.cpp
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import type { NetworkId } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

/**
 * Common values of `chatType`. The full table is in `chat/chatType.iff`;
 * these are the most commonly observed ones in unmodded SWG.
 */
export const SpatialChatType = {
  /** /say — speaks to everyone within ~30m. */
  Say: 0,
  /** /shout — speaks to everyone within a larger radius. */
  Shout: 1,
  /** /whisper — directed at a single target. */
  Whisper: 2,
} as const;

export interface SpatialChatData {
  sourceId: NetworkId;
  /** Target id for directed chat; `0n` for broadcast/area chat. */
  targetId: NetworkId;
  /** The chat content. */
  text: string;
  /** Bit-flags. Most messages send 0; the server can set bits for moderator/etc. */
  flags: number;
  /** Volume-attenuation hint (0..65535). Usually 0 for default. */
  volume: number;
  /** Type index from chatType.iff (see `SpatialChatType` for common values). */
  chatType: number;
  /** Mood index from moodAnimation.iff (0 = none). */
  moodType: number;
  /** Language enum (0..255). 0 = "basic" / default. */
  language: number;
  /** Out-of-band ProsePackage data; empty for free-form chat. */
  outOfBand: string;
  /** Optional source display-name override; empty for "use sourceId's normal name". */
  sourceName: string;
}

/**
 * The receive-side kind. We use a single kind for both send and receive
 * paths because the data shape is identical; the `subtypeId` on the
 * registered decoder distinguishes them, and the parent
 * `ObjControllerMessage.message` field tells consumers which direction
 * the message was on the wire.
 *
 * For downstream consumers doing `decodedSubtype.kind === 'SpatialChat'`
 * this exposes the broadcast-receive variant — the common case for any
 * passive observer (a script watching chat) and what the live cluster
 * actually emits to nearby observers when someone says something.
 */
export const SpatialChatKind = 'SpatialChat' as const;
export const SpatialChatSendKind = 'SpatialChatSend' as const;

const codec = {
  encode(stream: IByteStream, data: SpatialChatData): void {
    NetworkIdCodec.encode(stream, data.sourceId);
    NetworkIdCodec.encode(stream, data.targetId);
    writeUnicodeString(stream, data.text);
    stream.writeU32(data.flags);
    stream.writeU16(data.volume);
    stream.writeU16(data.chatType);
    stream.writeU16(data.moodType);
    stream.writeU8(data.language);
    writeUnicodeString(stream, data.outOfBand);
    writeUnicodeString(stream, data.sourceName);
  },
  decode(iter: IReadIterator): SpatialChatData {
    const sourceId = NetworkIdCodec.decode(iter);
    const targetId = NetworkIdCodec.decode(iter);
    const text = readUnicodeString(iter);
    const flags = iter.readU32();
    const volume = iter.readU16();
    const chatType = iter.readU16();
    const moodType = iter.readU16();
    const language = iter.readU8();
    const outOfBand = readUnicodeString(iter);
    const sourceName = readUnicodeString(iter);
    return {
      sourceId,
      targetId,
      text,
      flags,
      volume,
      chatType,
      moodType,
      language,
      outOfBand,
      sourceName,
    };
  },
};

/**
 * Server→client receive — what observers see when someone speaks nearby.
 * Registered under `CM_spatialChatReceive` (244). This is the path the
 * parent dispatcher uses for inbound chat — `decodedSubtype.kind ===
 * 'SpatialChat'` for any received spatial chat.
 */
export const SpatialChatReceiveDecoder = registerObjControllerSubtype<SpatialChatData>({
  kind: SpatialChatKind,
  subtypeId: ObjControllerSubtypeIds.CM_spatialChatReceive,
  encode: codec.encode,
  decode: codec.decode,
});

/**
 * Client→server send — what the client emits when the player types `/say`.
 * Same wire layout, different controller-message id. Registered with a
 * distinct kind (`SpatialChatSend`) so the registry's per-id-disjoint-kind
 * invariant holds; consumers reading received chat should match
 * `SpatialChatKind` rather than this one.
 */
export const SpatialChatSendDecoder = registerObjControllerSubtype<SpatialChatData>({
  kind: SpatialChatSendKind,
  subtypeId: ObjControllerSubtypeIds.CM_spatialChatSend,
  encode: codec.encode,
  decode: codec.decode,
});

/**
 * Helper: build an outbound `MessageQueueSpatialChat` trailer suitable for
 * embedding in an ObjControllerMessage with `message =
 * CM_spatialChatSend`. Most fields default to "neutral" values — the
 * caller normally only sets `sourceId` and `text`.
 */
export function makeSpatialChatData(
  sourceId: NetworkId,
  text: string,
  overrides: Partial<Omit<SpatialChatData, 'sourceId' | 'text'>> = {},
): SpatialChatData {
  return {
    sourceId,
    targetId: overrides.targetId ?? 0n,
    text,
    flags: overrides.flags ?? 0,
    volume: overrides.volume ?? 0,
    chatType: overrides.chatType ?? SpatialChatType.Say,
    moodType: overrides.moodType ?? 0,
    language: overrides.language ?? 0,
    outOfBand: overrides.outOfBand ?? '',
    sourceName: overrides.sourceName ?? '',
  };
}
