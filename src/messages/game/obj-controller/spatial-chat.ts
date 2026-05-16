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
 * Common values of `chatType`. The full table is in
 * `chat/spatial_chat_types.iff` (SpatialChatManager assigns ids in
 * install-order starting at 1: `say=1`, `add=2`, ...). `chatType=0` reaches
 * the server as "no specific type" — the chat still broadcasts (volume is
 * what gates the radius, not chatType), but the server logs it as a generic
 * "spatial" message rather than a typed one. For correctness pass `Say=1`
 * etc; for backwards compat with hand-written tests we kept the
 * conventional `Say=0, Shout=1, Whisper=2` enum that consumers grew used
 * to.  The numeric value flows through to the wire unmodified.
 */
export const SpatialChatType = {
  /** /say — speaks to everyone within ~50m (default volume from spatial_chat_types.iff). */
  Say: 0,
  /** /shout — speaks to everyone within ~100m. */
  Shout: 1,
  /** /whisper — directed at a single target (~25m). Pair with `targetId`. */
  Whisper: 2,
} as const;

/**
 * Server-side volume defaults from `spatial_chat_types.iff`:
 *
 *   - default (anything not in VOLS, including `say`): 50m
 *   - `yell` / `shout`:                                100m
 *   - `whisper` / `emote`:                             25m
 *
 * The server uses `volume` literally as the broadcast radius:
 * `ServerObject::speakText` reads `distance = static_cast<float>(getVolume())`
 * and calls `ServerWorld::getSpatialChatListeners(*this, distance, results)`.
 * **volume=0 means a zero-radius sphere → nobody hears the chat** (not
 * even the sender — and the server emits no broadcast packets at all).
 *
 * `ctx.say()` does NOT use `CM_spatialChatSend` directly — the server's
 * `allowFromClient` registry rejects that subtype from non-admin clients.
 * Instead it routes through the `spatialChatInternal` CommandQueue path,
 * which lets the server fill in the volume from the data file itself. The
 * defaults here are for callers who DO want to construct a
 * `MessageQueueSpatialChat` directly (admin/script paths, or for tests).
 */
const DEFAULT_VOLUME_SAY = 50;
const DEFAULT_VOLUME_SHOUT = 100;
const DEFAULT_VOLUME_WHISPER = 25;

/**
 * Look up the canonical server-side volume for a chat type. Falls back to
 * 50m for anything not explicitly known (matches SpatialChatManager's
 * `s_defaultVolume = 50` after loading `spatial_chat_types.iff`).
 */
export function defaultVolumeForChatType(chatType: number): number {
  if (chatType === SpatialChatType.Shout) return DEFAULT_VOLUME_SHOUT;
  if (chatType === SpatialChatType.Whisper) return DEFAULT_VOLUME_WHISPER;
  return DEFAULT_VOLUME_SAY;
}

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
 *
 * Volume defaults to `defaultVolumeForChatType(chatType)` (50m for Say,
 * 100m for Shout, 25m for Whisper) — matching what `SpatialChatManager`
 * fills in server-side. Set `volume: 0` explicitly only if you want the
 * server to drop the broadcast (see the comment on `defaultVolumeForChatType`).
 */
export function makeSpatialChatData(
  sourceId: NetworkId,
  text: string,
  overrides: Partial<Omit<SpatialChatData, 'sourceId' | 'text'>> = {},
): SpatialChatData {
  const chatType = overrides.chatType ?? SpatialChatType.Say;
  return {
    sourceId,
    targetId: overrides.targetId ?? 0n,
    text,
    flags: overrides.flags ?? 0,
    volume: overrides.volume ?? defaultVolumeForChatType(chatType),
    chatType,
    moodType: overrides.moodType ?? 0,
    language: overrides.language ?? 0,
    outOfBand: overrides.outOfBand ?? '',
    sourceName: overrides.sourceName ?? '',
  };
}
