/**
 * GameNetworkMessage base: every concrete wire message extends this and
 * provides:
 *
 *   - `static readonly messageName: string` — the C++ class name
 *   - `static readonly typeCrc: number`     — constcrc(messageName)
 *   - `encodePayload(stream)`               — serialize fields in
 *                                             C++ addVariable order
 *   - `static decodePayload(iter)`          — read same order, return instance
 *
 * Wire layout on the SOE-app side (after SOE framing/decompression):
 *   [u32 LE typeCrc][payload bytes]
 *
 * Source: /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/common/GameNetworkMessage.{h,cpp}
 */

import { ByteStream } from '../archive/byte-stream.js';
import { ReadIterator } from '../archive/read-iterator.js';
import { ReadException } from '../archive/interface.js';
import type { IByteStream, ICodec, IReadIterator } from '../archive/interface.js';
import type { GameNetworkMessage, MessageDecoder } from './interface.js';
import { constcrc } from '../crc/constcrc.js';

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
 * Serialize a complete message (header CRC + payload) into bytes ready to
 * hand off to the SOE transport's `sendApp()`.
 */
export function encodeMessage(message: GameNetworkMessage): Uint8Array {
  const ctor = message.constructor as unknown as { typeCrc: number; messageName: string };
  if (typeof ctor.typeCrc !== 'number') {
    throw new Error(
      `${message.constructor.name} is missing static typeCrc — did you forget to extend defineMessage()?`,
    );
  }
  const stream = new ByteStream();
  stream.writeU32(ctor.typeCrc);
  message.encodePayload(stream);
  return stream.toBytes();
}

/**
 * Parse the 4-byte CRC header from a complete app payload and return
 * the CRC plus a sub-iterator positioned at the payload. Caller hands
 * the sub-iterator to `decoder.decodePayload(iter)`.
 */
export function parseHeader(bytes: Uint8Array): { typeCrc: number; payload: ReadIterator } {
  if (bytes.length < 4) {
    throw new ReadException(
      'GameNetworkMessage header is 4 bytes — got truncated payload',
      4,
      bytes.length,
    );
  }
  const iter = new ReadIterator(bytes);
  const typeCrc = iter.readU32();
  const payload = iter.subIterator(iter.remaining);
  return { typeCrc, payload };
}

/**
 * Factory: turns a class with a static `messageName` + `typeCrc` and a
 * static `decodePayload` into a `MessageDecoder` the registry can store.
 *
 * Conceptually the constructor itself is the decoder, but TS doesn't
 * make static methods covariant — so the constructor satisfies the
 * decoder interface only if we tighten the static side. This helper does
 * that.
 */
export function asDecoder<T extends GameNetworkMessage>(
  ctor: {
    readonly messageName: string;
    readonly typeCrc: number;
    decodePayload(iter: IReadIterator): T;
  },
): MessageDecoder<T> {
  return {
    messageName: ctor.messageName,
    typeCrc: ctor.typeCrc,
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
 *     ...
 *   }
 *
 * (the explicit re-exposure exists because TS's structural-type matching
 * doesn't propagate readonly statics through generic constraints).
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
  new (value: T): GameNetworkMessage & { value: T };
  decodePayload(iter: IReadIterator): GameNetworkMessage & { value: T };
}
