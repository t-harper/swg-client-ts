/**
 * GameNetworkMessage base: every concrete wire message extends this and
 * provides:
 *
 *   - `static readonly messageName: string` — the C++ class name
 *   - `static readonly typeCrc: number`     — constcrc(messageName)
 *   - `static readonly varCount: number`    — number of AutoVariables on the
 *                                             wire (= 1 for cmd + N payload fields)
 *   - `encodePayload(stream)`               — serialize fields in
 *                                             C++ addVariable order
 *   - `static decodePayload(iter)`          — read same order, return instance
 *
 * Wire layout on the SOE-app side (after SOE framing/decompression):
 *   [u16 LE varCount][u32 LE typeCrc][payload bytes]
 *
 * The leading `[u16 LE varCount]` comes from `Archive::AutoByteStream::pack`
 * (AutoByteStream.cpp line 96): every packed AutoByteStream emits its member
 * count first. GameNetworkMessage's base ctor adds `cmd` (the typeCrc) as the
 * first AutoVariable, so varCount is always >= 1 (== 1 for empty messages
 * like HeartBeat / LogoutMessage / CmdSceneReady).
 *
 * Source: /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/common/GameNetworkMessage.{h,cpp}
 * Source: /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/AutoByteStream.cpp (line 96)
 */

import { ByteStream } from '../archive/byte-stream.js';
import { ReadException } from '../archive/interface.js';
import type { IByteStream, ICodec, IReadIterator } from '../archive/interface.js';
import { ReadIterator } from '../archive/read-iterator.js';
import { constcrc } from '../crc/constcrc.js';
import type { GameNetworkMessage, MessageDecoder } from './interface.js';

/**
 * The on-wire NetworkVersionId string — must match the server's hardcoded
 * value in `GameNetworkMessage::NetworkVersionId`. Used by LoginClientId
 * and ClientIdMsg.
 *
 * Source: /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/common/GameNetworkMessage.cpp:21
 */
export const NETWORK_VERSION_ID = '20100225-17:43';

/**
 * Re-export so consumers have a one-stop import. Concrete subclasses
 * still extend `GameNetworkMessage` from the interface module.
 */
export { GameNetworkMessage } from './interface.js';

/**
 * Serialize a complete message (varCount + CRC header + payload) into bytes
 * ready to hand off to the SOE transport's `sendApp()`.
 */
export function encodeMessage(message: GameNetworkMessage): Uint8Array {
  const ctor = message.constructor as unknown as {
    typeCrc: number;
    messageName: string;
    varCount: number;
  };
  if (typeof ctor.typeCrc !== 'number') {
    throw new Error(
      `${message.constructor.name} is missing static typeCrc — did you forget to extend defineMessage()?`,
    );
  }
  if (typeof ctor.varCount !== 'number') {
    throw new Error(
      `${message.constructor.name} is missing static varCount — every GameNetworkMessage subclass must declare it (1 + number of payload AutoVariables)`,
    );
  }
  const stream = new ByteStream();
  stream.writeU16(ctor.varCount);
  stream.writeU32(ctor.typeCrc);
  message.encodePayload(stream);
  return stream.toBytes();
}

/**
 * Parse the AutoByteStream variable-count prefix + 4-byte CRC header from a
 * complete app payload. Returns the parsed `varCount`, the `typeCrc`, plus a
 * sub-iterator positioned at the payload. Caller hands the sub-iterator to
 * `decoder.decodePayload(iter)`.
 *
 * The parsed varCount is returned for diagnostic / sanity-check use; dispatch
 * is always done by CRC. A caller may verify `varCount === decoder.varCount`
 * if it wants to log a warning on protocol skew.
 */
export function parseHeader(bytes: Uint8Array): {
  varCount: number;
  typeCrc: number;
  payload: ReadIterator;
} {
  if (bytes.length < 6) {
    throw new ReadException(
      'GameNetworkMessage header is 6 bytes (u16 varCount + u32 typeCrc) — got truncated payload',
      6,
      bytes.length,
    );
  }
  const iter = new ReadIterator(bytes);
  const varCount = iter.readU16();
  const typeCrc = iter.readU32();
  const payload = iter.subIterator(iter.remaining);
  return { varCount, typeCrc, payload };
}

/**
 * Factory: turns a class with a static `messageName` + `typeCrc` + `varCount`
 * and a static `decodePayload` into a `MessageDecoder` the registry can store.
 *
 * Conceptually the constructor itself is the decoder, but TS doesn't
 * make static methods covariant — so the constructor satisfies the
 * decoder interface only if we tighten the static side. This helper does
 * that.
 */
export function asDecoder<T extends GameNetworkMessage>(ctor: {
  readonly messageName: string;
  readonly typeCrc: number;
  readonly varCount: number;
  decodePayload(iter: IReadIterator): T;
}): MessageDecoder<T> {
  return {
    messageName: ctor.messageName,
    typeCrc: ctor.typeCrc,
    varCount: ctor.varCount,
    decodePayload: (iter) => ctor.decodePayload(iter),
  };
}

/**
 * Build the boilerplate static metadata for a message class. Used as:
 *
 *   class LoginClientId extends GameNetworkMessage {
 *     static readonly meta = defineMessageMeta('LoginClientId');
 *     static readonly messageName = LoginClientId.meta.messageName;
 *     static readonly typeCrc = LoginClientId.meta.typeCrc;
 *     static readonly varCount = 4;     // cmd + id + key + version
 *     ...
 *   }
 *
 * (the explicit re-exposure exists because TS's structural-type matching
 * doesn't propagate readonly statics through generic constraints).
 *
 * NOTE: `varCount` is not derived here — every subclass must hand-declare it
 * to match the C++ class's `addVariable()` count (1 for cmd + N payload).
 */
export function defineMessageMeta(name: string): { messageName: string; typeCrc: number } {
  return { messageName: name, typeCrc: constcrc(name) };
}

/**
 * Generic-value-type message helper.
 *
 * The C++ side has a templated `GenericValueTypeMessage<T>` used for tiny
 * messages that only carry one payload field. ServerNowEpochTime and
 * CharacterCreationDisabled both use this pattern.
 *
 * varCount is always 2 (cmd + value).
 *
 * Returns both the message class and its decoder, ready to register.
 */
export function defineGenericValueTypeMessage<T>(
  messageName: string,
  codec: ICodec<T>,
): {
  Message: GenericValueTypeMessageClass<T>;
  decoder: MessageDecoder<InstanceType<GenericValueTypeMessageClass<T>>>;
} {
  const meta = defineMessageMeta(messageName);

  class GenericValueTypeMessage {
    static readonly messageName = meta.messageName;
    static readonly typeCrc = meta.typeCrc;
    /** cmd + value */
    static readonly varCount = 2;
    constructor(public value: T) {}

    encodePayload(stream: IByteStream): void {
      codec.encode(stream, this.value);
    }

    static decodePayload(iter: IReadIterator): GenericValueTypeMessage {
      return new GenericValueTypeMessage(codec.decode(iter));
    }
  }

  return {
    Message: GenericValueTypeMessage as unknown as GenericValueTypeMessageClass<T>,
    decoder: asDecoder<InstanceType<GenericValueTypeMessageClass<T>>>(
      GenericValueTypeMessage as unknown as GenericValueTypeMessageClass<T>,
    ),
  };
}

/** Helper type alias for the class shape returned by defineGenericValueTypeMessage. */
export interface GenericValueTypeMessageClass<T> {
  readonly messageName: string;
  readonly typeCrc: number;
  readonly varCount: number;
  new (value: T): GameNetworkMessage & { value: T };
  decodePayload(iter: IReadIterator): GameNetworkMessage & { value: T };
}
