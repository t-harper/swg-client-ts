/**
 * SuiPageData / SuiCommand decoder — the payload of `SuiCreatePageMessage`
 * and `SuiUpdatePageMessage`.
 *
 * Wire layout (`SuiPageData::put`,
 * ~/code/swg-main/src/engine/shared/library/sharedGame/src/shared/sui/SuiPageData.cpp:223):
 *   [i32 LE]                  pageId
 *   [stdString]               pageName
 *   [std::vector<SuiCommand>] commands               // i32 LE count + items
 *   [NetworkId i64 LE]        associatedObjectId
 *   [Vector 3×f32 LE]         associatedLocation      // sentinel = Vector::maxXYZ
 *   [f32 LE]                  maxRangeFromObject
 *
 * Each `SuiCommand` (`SuiCommand::put`,
 * ~/code/swg-main/src/engine/shared/library/sharedGame/src/shared/sui/SuiCommand.cpp:321):
 *   [u8]                                type            // SuiCommand::Type enum
 *   [std::vector<Unicode::String>]      parametersWide  // i32 LE count + UCS-2 strings
 *   [std::vector<std::string>]          parametersNarrow// i32 LE count + UTF-8 strings
 *
 * The C++ `SuiCommand` is a flat tagged union: a single `type` byte chooses
 * which slots inside `parametersWide` / `parametersNarrow` are meaningful.
 * The enum (SuiCommand.h:28) has 9 values:
 *
 *   0 SCT_none                       — empty placeholder
 *   1 SCT_clearDataSource            — narrow=[widget]
 *   2 SCT_addChildWidget             — narrow=[widget, widgetType, widgetName]
 *   3 SCT_setProperty                — narrow=[widget, propertyName], wide=[propertyValue]
 *   4 SCT_addDataItem                — narrow=[widget, dataItemName],          wide=[dataItemValue]
 *   5 SCT_subscribeToEvent           — narrow=[widget, eventTypeByte, callback, [widget,property]…],
 *                                      wide=[]
 *   6 SCT_addDataSourceContainer     — narrow=[widget, name],                  wide=[value]
 *   7 SCT_clearDataSourceContainer   — narrow=[widget]
 *   8 SCT_addDataSource              — narrow=[widget, name],                  wide=[value]
 *
 * The first narrow parameter is ALWAYS the target widget name; the rest are
 * type-specific. The unicode `subscribeToEvent` event type is packed as the
 * first byte of a 1-char std::string (SuiCommand.cpp:138-141).
 *
 * For maximum forward-compat the public `SuiCommand` tagged-union variants
 * preserve all wire fields verbatim, and any byte value outside 0..8 is
 * wrapped as `{ type: 'unknown', commandType, parametersWide, parametersNarrow }`
 * so we round-trip losslessly even when the server gains a new command type.
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import { Vector3Codec } from '../../../archive/transform.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import type { NetworkId, Vector3 } from '../../../types.js';

/**
 * Enum mirror of C++ `SuiCommand::Type` (SuiCommand.h:28). Values are
 * stable — used as the on-the-wire `u8` type byte.
 */
export const SuiCommandType = {
  None: 0,
  ClearDataSource: 1,
  AddChildWidget: 2,
  SetProperty: 3,
  AddDataItem: 4,
  SubscribeToEvent: 5,
  AddDataSourceContainer: 6,
  ClearDataSourceContainer: 7,
  AddDataSource: 8,
} as const;

export type SuiCommandTypeValue = (typeof SuiCommandType)[keyof typeof SuiCommandType];

/** `subscribeToEvent` packs widget/property subscription pairs after the first 3 narrow params. */
export interface SuiWidgetPropertySubscription {
  widgetName: string;
  propertyName: string;
}

/**
 * Tagged union of every decoded `SuiCommand`. Each variant preserves the
 * full wire payload (including the always-present `targetWidget` head of
 * `parametersNarrow`).
 *
 * Unknown command types are wrapped as `{ type: 'unknown' }` carrying the
 * raw `parametersWide` / `parametersNarrow` vectors so we round-trip
 * losslessly without throwing on a future server-side enum addition.
 */
export type SuiCommand =
  | { type: 'none'; targetWidget: string }
  | { type: 'clearDataSource'; targetWidget: string }
  | { type: 'addChildWidget'; targetWidget: string; widgetType: string; widgetName: string }
  | { type: 'setProperty'; targetWidget: string; propertyName: string; propertyValue: string }
  | { type: 'addDataItem'; targetWidget: string; dataItemName: string; dataItemValue: string }
  | {
      type: 'subscribeToEvent';
      targetWidget: string;
      eventType: number;
      callback: string;
      propertySubscriptions: SuiWidgetPropertySubscription[];
    }
  | {
      type: 'addDataSourceContainer';
      targetWidget: string;
      dataSourceContainerName: string;
      dataSourceContainerValue: string;
    }
  | { type: 'clearDataSourceContainer'; targetWidget: string }
  | { type: 'addDataSource'; targetWidget: string; dataSourceName: string; dataSourceValue: string }
  | {
      type: 'unknown';
      /** Raw u8 command type byte that didn't match any known SuiCommandType. */
      commandType: number;
      parametersWide: string[];
      parametersNarrow: string[];
    };

/**
 * The fully decoded payload of `SuiCreatePageMessage` / `SuiUpdatePageMessage`.
 */
export interface SuiPageData {
  pageId: number;
  pageName: string;
  commands: SuiCommand[];
  associatedObjectId: NetworkId;
  associatedLocation: Vector3;
  maxRangeFromObject: number;
}

// ---------------------------------------------------------------------------
// Inner helpers — std::vector<UnicodeString> / std::vector<std::string>
// ---------------------------------------------------------------------------

/** std::vector<UnicodeString>: i32 LE count + UCS-2 strings. */
function readUnicodeStringVector(iter: IReadIterator): string[] {
  const n = iter.readI32();
  if (n < 0) {
    throw new RangeError(`SuiCommand parametersWide: negative length ${n}`);
  }
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(readUnicodeString(iter));
  }
  return out;
}

function writeUnicodeStringVector(stream: IByteStream, value: readonly string[]): void {
  stream.writeI32(value.length);
  for (const v of value) {
    writeUnicodeString(stream, v);
  }
}

/** std::vector<std::string>: i32 LE count + UTF-8 strings. */
function readStdStringVector(iter: IReadIterator): string[] {
  const n = iter.readI32();
  if (n < 0) {
    throw new RangeError(`SuiCommand parametersNarrow: negative length ${n}`);
  }
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(readStdString(iter));
  }
  return out;
}

function writeStdStringVector(stream: IByteStream, value: readonly string[]): void {
  stream.writeI32(value.length);
  for (const v of value) {
    writeStdString(stream, v);
  }
}

// ---------------------------------------------------------------------------
// SuiCommand: raw <-> tagged-union conversion
// ---------------------------------------------------------------------------

/**
 * Promote a raw `(type, parametersWide, parametersNarrow)` triple into the
 * appropriate tagged-union variant. Any time the wire shape is malformed
 * for a known type (e.g. SCT_setProperty with only 1 narrow param) we
 * fall back to the `unknown` variant so we don't lose data.
 */
function decodeSuiCommand(
  commandType: number,
  parametersWide: string[],
  parametersNarrow: string[],
): SuiCommand {
  // The C++ ctor always seeds parametersNarrow[0] with the target widget
  // name, so for the typed variants we require at least one narrow param.
  const targetWidget = parametersNarrow.length > 0 ? (parametersNarrow[0] as string) : '';

  switch (commandType) {
    case SuiCommandType.None:
      return { type: 'none', targetWidget };

    case SuiCommandType.ClearDataSource:
      return { type: 'clearDataSource', targetWidget };

    case SuiCommandType.AddChildWidget:
      // initAddChildWidget pushes [widgetType, widgetName]; combined with the
      // target widget seed, narrow must be 3.
      if (parametersNarrow.length < 3) break;
      return {
        type: 'addChildWidget',
        targetWidget,
        widgetType: parametersNarrow[1] as string,
        widgetName: parametersNarrow[2] as string,
      };

    case SuiCommandType.SetProperty:
      // initSetProperty pushes narrow=[propertyName], wide=[propertyValue]
      if (parametersNarrow.length < 2 || parametersWide.length < 1) break;
      return {
        type: 'setProperty',
        targetWidget,
        propertyName: parametersNarrow[1] as string,
        propertyValue: parametersWide[0] as string,
      };

    case SuiCommandType.AddDataItem:
      if (parametersNarrow.length < 2 || parametersWide.length < 1) break;
      return {
        type: 'addDataItem',
        targetWidget,
        dataItemName: parametersNarrow[1] as string,
        dataItemValue: parametersWide[0] as string,
      };

    case SuiCommandType.SubscribeToEvent: {
      // initSubscribeToEvent pushes narrow=[eventTypeByte, callback]; combined
      // with the target widget seed, narrow has at least 3 entries. Beyond
      // that, addPropertySubscriptionToEvent appends pairs (widget, property).
      if (parametersNarrow.length < 3) break;
      const eventTypeStr = parametersNarrow[1] as string;
      const eventType = eventTypeStr.length > 0 ? (eventTypeStr.charCodeAt(0) & 0xff) : 0;
      const callback = parametersNarrow[2] as string;

      const propertySubscriptions: SuiWidgetPropertySubscription[] = [];
      for (let i = 3; i + 1 < parametersNarrow.length; i += 2) {
        propertySubscriptions.push({
          widgetName: parametersNarrow[i] as string,
          propertyName: parametersNarrow[i + 1] as string,
        });
      }

      return {
        type: 'subscribeToEvent',
        targetWidget,
        eventType,
        callback,
        propertySubscriptions,
      };
    }

    case SuiCommandType.AddDataSourceContainer:
      if (parametersNarrow.length < 2 || parametersWide.length < 1) break;
      return {
        type: 'addDataSourceContainer',
        targetWidget,
        dataSourceContainerName: parametersNarrow[1] as string,
        dataSourceContainerValue: parametersWide[0] as string,
      };

    case SuiCommandType.ClearDataSourceContainer:
      return { type: 'clearDataSourceContainer', targetWidget };

    case SuiCommandType.AddDataSource:
      if (parametersNarrow.length < 2 || parametersWide.length < 1) break;
      return {
        type: 'addDataSource',
        targetWidget,
        dataSourceName: parametersNarrow[1] as string,
        dataSourceValue: parametersWide[0] as string,
      };
  }

  // Either commandType is outside 0..8 or the shape didn't match what we
  // expect for a typed variant — fall back to the lossless 'unknown' wrapper.
  return {
    type: 'unknown',
    commandType,
    parametersWide,
    parametersNarrow,
  };
}

/** Reverse: realize a tagged-union variant back to `(type, wide, narrow)`. */
function encodeSuiCommandRaw(
  command: SuiCommand,
): { commandType: number; parametersWide: string[]; parametersNarrow: string[] } {
  switch (command.type) {
    case 'none':
      return {
        commandType: SuiCommandType.None,
        parametersWide: [],
        parametersNarrow: [command.targetWidget],
      };

    case 'clearDataSource':
      return {
        commandType: SuiCommandType.ClearDataSource,
        parametersWide: [],
        parametersNarrow: [command.targetWidget],
      };

    case 'addChildWidget':
      return {
        commandType: SuiCommandType.AddChildWidget,
        parametersWide: [],
        parametersNarrow: [command.targetWidget, command.widgetType, command.widgetName],
      };

    case 'setProperty':
      return {
        commandType: SuiCommandType.SetProperty,
        parametersWide: [command.propertyValue],
        parametersNarrow: [command.targetWidget, command.propertyName],
      };

    case 'addDataItem':
      return {
        commandType: SuiCommandType.AddDataItem,
        parametersWide: [command.dataItemValue],
        parametersNarrow: [command.targetWidget, command.dataItemName],
      };

    case 'subscribeToEvent': {
      // C++ packs the eventType as the FIRST CHAR (byte) of a 1-char string.
      const eventTypeStr = String.fromCharCode(command.eventType & 0xff);
      const narrow: string[] = [command.targetWidget, eventTypeStr, command.callback];
      for (const sub of command.propertySubscriptions) {
        narrow.push(sub.widgetName, sub.propertyName);
      }
      return {
        commandType: SuiCommandType.SubscribeToEvent,
        parametersWide: [],
        parametersNarrow: narrow,
      };
    }

    case 'addDataSourceContainer':
      return {
        commandType: SuiCommandType.AddDataSourceContainer,
        parametersWide: [command.dataSourceContainerValue],
        parametersNarrow: [command.targetWidget, command.dataSourceContainerName],
      };

    case 'clearDataSourceContainer':
      return {
        commandType: SuiCommandType.ClearDataSourceContainer,
        parametersWide: [],
        parametersNarrow: [command.targetWidget],
      };

    case 'addDataSource':
      return {
        commandType: SuiCommandType.AddDataSource,
        parametersWide: [command.dataSourceValue],
        parametersNarrow: [command.targetWidget, command.dataSourceName],
      };

    case 'unknown':
      return {
        commandType: command.commandType & 0xff,
        parametersWide: [...command.parametersWide],
        parametersNarrow: [...command.parametersNarrow],
      };
  }
}

/**
 * Encode a single `SuiCommand` to its wire bytes:
 *   [u8 type][i32 wideCount][wide…][i32 narrowCount][narrow…]
 */
export function writeSuiCommand(stream: IByteStream, command: SuiCommand): void {
  const raw = encodeSuiCommandRaw(command);
  stream.writeU8(raw.commandType);
  writeUnicodeStringVector(stream, raw.parametersWide);
  writeStdStringVector(stream, raw.parametersNarrow);
}

/** Decode a single `SuiCommand` from a read cursor. */
export function readSuiCommand(iter: IReadIterator): SuiCommand {
  const commandType = iter.readU8();
  const parametersWide = readUnicodeStringVector(iter);
  const parametersNarrow = readStdStringVector(iter);
  return decodeSuiCommand(commandType, parametersWide, parametersNarrow);
}

// ---------------------------------------------------------------------------
// SuiPageData top-level encode / decode
// ---------------------------------------------------------------------------

/**
 * Encode a `SuiPageData` into the supplied stream — matches `SuiPageData::put`
 * field-for-field (no length framing; callers wrap the bytes in their own
 * message envelope).
 */
export function writeSuiPageData(stream: IByteStream, data: SuiPageData): void {
  stream.writeI32(data.pageId);
  writeStdString(stream, data.pageName);
  // std::vector<SuiCommand>: i32 LE count + items
  stream.writeI32(data.commands.length);
  for (const c of data.commands) {
    writeSuiCommand(stream, c);
  }
  NetworkIdCodec.encode(stream, data.associatedObjectId);
  Vector3Codec.encode(stream, data.associatedLocation);
  stream.writeF32(data.maxRangeFromObject);
}

/** Encode a `SuiPageData` into a fresh byte buffer. */
export function encodeSuiPageData(data: SuiPageData): Uint8Array {
  const stream = new ByteStream();
  writeSuiPageData(stream, data);
  return stream.toBytes();
}

/** Decode a `SuiPageData` from a read cursor. */
export function readSuiPageData(iter: IReadIterator): SuiPageData {
  const pageId = iter.readI32();
  const pageName = readStdString(iter);
  const commandCount = iter.readI32();
  if (commandCount < 0) {
    throw new RangeError(`SuiPageData commands: negative length ${commandCount}`);
  }
  const commands: SuiCommand[] = [];
  for (let i = 0; i < commandCount; i++) {
    commands.push(readSuiCommand(iter));
  }
  const associatedObjectId = NetworkIdCodec.decode(iter);
  const associatedLocation = Vector3Codec.decode(iter);
  const maxRangeFromObject = iter.readF32();
  return {
    pageId,
    pageName,
    commands,
    associatedObjectId,
    associatedLocation,
    maxRangeFromObject,
  };
}

/** Decode a `SuiPageData` from a flat Uint8Array (e.g. message `pageData` bytes). */
export function decodeSuiPageData(bytes: Uint8Array): SuiPageData {
  const iter = new ReadIterator(bytes);
  return readSuiPageData(iter);
}

/**
 * Best-effort fast-path: peek the leading 4 bytes of an encoded `SuiPageData`
 * blob to extract just the `pageId` without paying for a full decode. Useful
 * for transcript inspection of raw bytes when full decoding isn't required.
 *
 * Returns `null` if the buffer is too short to contain a pageId.
 */
export function peekSuiPageId(bytes: Uint8Array): number | null {
  if (bytes.length < 4) return null;
  const b = bytes;
  // i32 LE; sign-extend with `| 0`
  return (
    (((b[0] ?? 0) | ((b[1] ?? 0) << 8) | ((b[2] ?? 0) << 16) | ((b[3] ?? 0) << 24)) | 0)
  );
}
