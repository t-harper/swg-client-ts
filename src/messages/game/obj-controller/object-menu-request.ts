/**
 * ObjectMenuRequest (CM_objectMenuRequest = 326) — bidirectional.
 *
 * Sent when a client right-clicks an object to populate the radial menu.
 * The CLIENT sends this with `data = []` and the server replies with a
 * matching `ObjectMenuResponse` carrying the populated menu items. The
 * server may also send `ObjectMenuRequest` (server→client) for the
 * "out-of-range" indicator update.
 *
 * The same handler is registered for both CM_objectMenuRequest and
 * CM_objectMenuResponse — the wire format is identical, only the
 * direction differs (see MessageQueueObjectMenuRequest::install at
 * MessageQueueObjectMenuRequest.cpp:23-29).
 *
 * Wire layout (trailer only):
 *   [NetworkId (i64 LE)]      targetId
 *   [NetworkId (i64 LE)]      requestorId
 *   [i32]                     menuItemCount
 *   for each menu item:
 *     [u8]                    id
 *     [u8]                    parent
 *     [u16]                   menuItemType
 *     [u8]                    flags        (F_enabled=0x01, F_serverNotify=0x02, F_outOfRange=0x04)
 *     [UnicodeString]         label        (u32 char-count + UTF-16 LE bytes)
 *   [u8]                      sequence
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueObjectMenuRequest.cpp:49-76
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/ObjectMenuRequestDataArchive.h:27-45
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import type { NetworkId } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

/** Bit flags for `ObjectMenuRequestData.flags`. Source: ObjectMenuRequestData.cpp. */
export const ObjectMenuItemFlags = {
  Enabled: 0x01,
  ServerNotify: 0x02,
  OutOfRange: 0x04,
} as const;

export interface ObjectMenuItem {
  id: number;
  parent: number;
  menuItemType: number;
  flags: number;
  label: string;
}

export interface ObjectMenuData {
  targetId: NetworkId;
  requestorId: NetworkId;
  items: ObjectMenuItem[];
  sequence: number;
}

function encodeMenu(stream: IByteStream, data: ObjectMenuData): void {
  NetworkIdCodec.encode(stream, data.targetId);
  NetworkIdCodec.encode(stream, data.requestorId);
  stream.writeI32(data.items.length);
  for (const item of data.items) {
    stream.writeU8(item.id);
    stream.writeU8(item.parent);
    stream.writeU16(item.menuItemType);
    stream.writeU8(item.flags);
    writeUnicodeString(stream, item.label);
  }
  stream.writeU8(data.sequence);
}

function decodeMenu(iter: IReadIterator): ObjectMenuData {
  const targetId = NetworkIdCodec.decode(iter);
  const requestorId = NetworkIdCodec.decode(iter);
  const itemCount = iter.readI32();
  if (itemCount < 0) {
    throw new RangeError(`ObjectMenuRequest decode: negative item count ${itemCount}`);
  }
  const items: ObjectMenuItem[] = [];
  for (let i = 0; i < itemCount; i++) {
    items.push({
      id: iter.readU8(),
      parent: iter.readU8(),
      menuItemType: iter.readU16(),
      flags: iter.readU8(),
      label: readUnicodeString(iter),
    });
  }
  const sequence = iter.readU8();
  return { targetId, requestorId, items, sequence };
}

export const ObjectMenuRequestKind = 'ObjectMenuRequest' as const;

export const ObjectMenuRequestDecoder = registerObjControllerSubtype<ObjectMenuData>({
  kind: ObjectMenuRequestKind,
  subtypeId: ObjControllerSubtypeIds.CM_objectMenuRequest,
  encode: encodeMenu,
  decode: decodeMenu,
});

/** Re-exported so the response module can share the encode/decode helpers. */
export { encodeMenu as _encodeObjectMenu, decodeMenu as _decodeObjectMenu };
