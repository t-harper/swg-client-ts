/**
 * Public interface for GameNetworkMessage framing + the per-message registry.
 *
 * Wire layout of every GameNetworkMessage (after SOE stripping):
 *   [2 bytes]  AutoByteStream variable count (uint16 LE, >= 1)
 *   [4 bytes]  message-type CRC (constcrc(messageName), little-endian uint32)
 *   [N bytes]  Archive-serialized payload
 *
 * The varCount comes from `Archive::AutoByteStream::pack` (AutoByteStream.cpp
 * line 96): every packed AutoByteStream emits its member count first.
 * GameNetworkMessage's base ctor adds `cmd` (the typeCrc) as the first
 * AutoVariable, so varCount is always >= 1.
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/common/GameNetworkMessage.{h,cpp}
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/AutoByteStream.cpp
 */

import type { IByteStream, IReadIterator } from '../archive/interface.js';

/**
 * Base class for every wire message. Concrete subclasses live under
 * `src/messages/{login,connection,game}/`.
 *
 * Subclasses implement:
 *  - `static messageName: string` — the C++ class name, fed to constcrc
 *  - `static varCount: number` — 1 (cmd) + number of payload AutoVariables
 *  - `encodePayload(stream)` — write fields in C++ addVariable order
 *  - `static decodePayload(iter)` — read fields in same order, return a new instance
 */
export abstract class GameNetworkMessage {
  /**
   * The C++ class name string. constcrc(messageName) yields the 4-byte
   * type identifier the server's switch statement matches against.
   */
  static readonly messageName: string;

  /**
   * Number of AutoVariables on the wire — always 1 (cmd) plus the number of
   * payload fields the C++ ctor passes to addVariable(). Empty messages like
   * HeartBeat / LogoutMessage / CmdSceneReady have varCount = 1.
   */
  static readonly varCount: number;

  /** Serialize this message's fields (excluding the varCount + CRC header) */
  abstract encodePayload(stream: IByteStream): void;
}

/** A constructor that decodes the post-header payload into an instance. */
export interface MessageDecoder<T extends GameNetworkMessage = GameNetworkMessage> {
  readonly messageName: string;
  /** Pre-computed: constcrc(messageName) */
  readonly typeCrc: number;
  /** Expected AutoByteStream variable count (1 cmd + N payload fields) */
  readonly varCount: number;
  /** Build an instance from the wire bytes immediately after the varCount+CRC header */
  decodePayload(iter: IReadIterator): T;
}

/**
 * Global registry mapping the 4-byte CRC to the appropriate decoder.
 * Each message class self-registers via `registerMessage()` at module load.
 */
export interface IMessageRegistry {
  /** Register a decoder. Throws if the CRC is already taken (programmer bug). */
  register(decoder: MessageDecoder): void;

  /** Look up by CRC. Returns undefined for unknown message types. */
  getByCrc(crc: number): MessageDecoder | undefined;

  /** Look up by name (debugging only — runtime path uses CRC). */
  getByName(name: string): MessageDecoder | undefined;
}

/** Direction the message travels on the wire (for documentation + sanity checks) */
export enum MessageDirection {
  ClientToServer = 'c2s',
  ServerToClient = 's2c',
  Bidirectional = 'bi',
}

/** Header parse result: varCount + CRC, exposes a reader positioned past both. */
export interface ParsedHeader {
  varCount: number;
  typeCrc: number;
  payload: IReadIterator;
}
