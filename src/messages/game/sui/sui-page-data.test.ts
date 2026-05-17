import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import {
  type SuiCommand,
  type SuiPageData,
  SuiCommandType,
  decodeSuiPageData,
  encodeSuiPageData,
  peekSuiPageId,
  readSuiCommand,
  readSuiPageData,
  writeSuiCommand,
  writeSuiPageData,
} from './sui-page-data.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundTripCommand(cmd: SuiCommand): SuiCommand {
  const stream = new ByteStream();
  writeSuiCommand(stream, cmd);
  const iter = new ReadIterator(stream.toBytes());
  const decoded = readSuiCommand(iter);
  expect(iter.remaining).toBe(0);
  return decoded;
}

function roundTripPageData(data: SuiPageData): SuiPageData {
  const bytes = encodeSuiPageData(data);
  return decodeSuiPageData(bytes);
}

function emptyPage(overrides: Partial<SuiPageData> = {}): SuiPageData {
  return {
    pageId: 0,
    pageName: '',
    commands: [],
    associatedObjectId: 0n,
    associatedLocation: { x: 0, y: 0, z: 0 },
    maxRangeFromObject: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SuiCommand: per-variant round-trips
// ---------------------------------------------------------------------------

describe('SuiCommand variants', () => {
  it('round-trips none', () => {
    const cmd: SuiCommand = { type: 'none', targetWidget: 'root' };
    expect(roundTripCommand(cmd)).toEqual(cmd);
  });

  it('round-trips clearDataSource', () => {
    const cmd: SuiCommand = { type: 'clearDataSource', targetWidget: 'lst.items' };
    expect(roundTripCommand(cmd)).toEqual(cmd);
  });

  it('round-trips addChildWidget', () => {
    const cmd: SuiCommand = {
      type: 'addChildWidget',
      targetWidget: 'frm.main',
      widgetType: 'SUIWidgetPage',
      widgetName: 'pnl.child',
    };
    expect(roundTripCommand(cmd)).toEqual(cmd);
  });

  it('round-trips setProperty (unicode value)', () => {
    const cmd: SuiCommand = {
      type: 'setProperty',
      targetWidget: 'cmp.title',
      propertyName: 'Text',
      propertyValue: 'Bank Terminal — 1,234 cr',
    };
    expect(roundTripCommand(cmd)).toEqual(cmd);
  });

  it('round-trips addDataItem (unicode value with BMP chars)', () => {
    const cmd: SuiCommand = {
      type: 'addDataItem',
      targetWidget: 'lst.items',
      dataItemName: 'item.0',
      dataItemValue: 'Stim Pack A — ¤500',
    };
    expect(roundTripCommand(cmd)).toEqual(cmd);
  });

  it('round-trips subscribeToEvent with no property subscriptions', () => {
    const cmd: SuiCommand = {
      type: 'subscribeToEvent',
      targetWidget: 'btn.ok',
      eventType: 4,
      callback: 'handler.ok',
      propertySubscriptions: [],
    };
    expect(roundTripCommand(cmd)).toEqual(cmd);
  });

  it('round-trips subscribeToEvent with property subscriptions', () => {
    const cmd: SuiCommand = {
      type: 'subscribeToEvent',
      targetWidget: 'btn.ok',
      eventType: 7,
      callback: 'handler.ok',
      propertySubscriptions: [
        { widgetName: 'fld.amount', propertyName: 'LocalText' },
        { widgetName: 'cmb.account', propertyName: 'SelectedRow' },
      ],
    };
    expect(roundTripCommand(cmd)).toEqual(cmd);
  });

  it('handles subscribeToEvent eventType > 127 (high-bit byte)', () => {
    const cmd: SuiCommand = {
      type: 'subscribeToEvent',
      targetWidget: 'btn.kbd',
      eventType: 0xfe,
      callback: 'cb',
      propertySubscriptions: [],
    };
    expect(roundTripCommand(cmd)).toEqual(cmd);
  });

  it('round-trips addDataSourceContainer', () => {
    const cmd: SuiCommand = {
      type: 'addDataSourceContainer',
      targetWidget: 'lst.items',
      dataSourceContainerName: 'Root',
      dataSourceContainerValue: 'first/path',
    };
    expect(roundTripCommand(cmd)).toEqual(cmd);
  });

  it('round-trips clearDataSourceContainer', () => {
    const cmd: SuiCommand = { type: 'clearDataSourceContainer', targetWidget: 'lst.items' };
    expect(roundTripCommand(cmd)).toEqual(cmd);
  });

  it('round-trips addDataSource', () => {
    const cmd: SuiCommand = {
      type: 'addDataSource',
      targetWidget: 'lst.items',
      dataSourceName: 'ds.bank',
      dataSourceValue: 'caption',
    };
    expect(roundTripCommand(cmd)).toEqual(cmd);
  });

  it('wraps unknown command types losslessly', () => {
    // Write an unknown command type (255) directly to bytes
    const stream = new ByteStream();
    stream.writeU8(255);
    // wide vector: 1 entry, "alpha"
    stream.writeI32(1);
    stream.writeU32(5);
    for (const ch of 'alpha') stream.writeU16(ch.charCodeAt(0));
    // narrow vector: 2 entries, "widget", "extra"
    stream.writeI32(2);
    writeStdString(stream, 'widget');
    writeStdString(stream, 'extra');

    const iter = new ReadIterator(stream.toBytes());
    const decoded = readSuiCommand(iter);
    expect(decoded).toEqual({
      type: 'unknown',
      commandType: 255,
      parametersWide: ['alpha'],
      parametersNarrow: ['widget', 'extra'],
    });

    // Round-trips back to the same bytes
    const reStream = new ByteStream();
    writeSuiCommand(reStream, decoded);
    expect(Array.from(reStream.toBytes())).toEqual(Array.from(stream.toBytes()));
  });

  it('wraps a malformed known type (missing parameters) as unknown', () => {
    // SetProperty (3) requires narrow=[widget, propertyName] + wide=[value].
    // Provide narrow=[widget] only → falls back to unknown.
    const stream = new ByteStream();
    stream.writeU8(SuiCommandType.SetProperty);
    stream.writeI32(0); // wide empty
    stream.writeI32(1);
    writeStdString(stream, 'comp.foo');

    const iter = new ReadIterator(stream.toBytes());
    const decoded = readSuiCommand(iter);
    expect(decoded.type).toBe('unknown');
    if (decoded.type !== 'unknown') throw new Error('typeguard');
    expect(decoded.commandType).toBe(SuiCommandType.SetProperty);
    expect(decoded.parametersNarrow).toEqual(['comp.foo']);
    expect(decoded.parametersWide).toEqual([]);
  });

  it('every typed variant produces the same u8 type byte as the SuiCommandType enum', () => {
    const samples: Array<[SuiCommand, number]> = [
      [{ type: 'none', targetWidget: 'w' }, SuiCommandType.None],
      [{ type: 'clearDataSource', targetWidget: 'w' }, SuiCommandType.ClearDataSource],
      [
        { type: 'addChildWidget', targetWidget: 'w', widgetType: 't', widgetName: 'n' },
        SuiCommandType.AddChildWidget,
      ],
      [
        { type: 'setProperty', targetWidget: 'w', propertyName: 'p', propertyValue: 'v' },
        SuiCommandType.SetProperty,
      ],
      [
        { type: 'addDataItem', targetWidget: 'w', dataItemName: 'i', dataItemValue: 'v' },
        SuiCommandType.AddDataItem,
      ],
      [
        {
          type: 'subscribeToEvent',
          targetWidget: 'w',
          eventType: 1,
          callback: 'c',
          propertySubscriptions: [],
        },
        SuiCommandType.SubscribeToEvent,
      ],
      [
        {
          type: 'addDataSourceContainer',
          targetWidget: 'w',
          dataSourceContainerName: 'n',
          dataSourceContainerValue: 'v',
        },
        SuiCommandType.AddDataSourceContainer,
      ],
      [
        { type: 'clearDataSourceContainer', targetWidget: 'w' },
        SuiCommandType.ClearDataSourceContainer,
      ],
      [
        { type: 'addDataSource', targetWidget: 'w', dataSourceName: 'n', dataSourceValue: 'v' },
        SuiCommandType.AddDataSource,
      ],
    ];
    for (const [cmd, expectedTypeByte] of samples) {
      const stream = new ByteStream();
      writeSuiCommand(stream, cmd);
      expect(stream.toBytes()[0]).toBe(expectedTypeByte);
    }
  });
});

// ---------------------------------------------------------------------------
// SuiPageData: top-level round-trips
// ---------------------------------------------------------------------------

describe('SuiPageData', () => {
  it('round-trips a minimal empty page', () => {
    const data = emptyPage();
    expect(roundTripPageData(data)).toEqual(data);
  });

  it('round-trips a populated page with mixed commands', () => {
    const data: SuiPageData = emptyPage({
      pageId: 42,
      pageName: 'banker.terminal',
      commands: [
        { type: 'addChildWidget', targetWidget: 'root', widgetType: 'Page', widgetName: 'main' },
        { type: 'setProperty', targetWidget: 'main', propertyName: 'Text', propertyValue: 'Hi' },
        {
          type: 'subscribeToEvent',
          targetWidget: 'main.btnOk',
          eventType: 4,
          callback: '',
          propertySubscriptions: [{ widgetName: 'fld.amount', propertyName: 'LocalText' }],
        },
        { type: 'clearDataSource', targetWidget: 'lst.items' },
      ],
      associatedObjectId: 0x123456789abcdef0n,
      associatedLocation: { x: -1.5, y: 2.25, z: 3.75 },
      maxRangeFromObject: 16.5,
    });
    expect(roundTripPageData(data)).toEqual(data);
  });

  it('preserves Vector::maxXYZ "unset" sentinel through round-trip', () => {
    // C++ sentinel is (REAL_MAX, REAL_MAX, REAL_MAX); we just have to not
    // touch / quantize whatever the wire delivers.
    const REAL_MAX = 3.4028234663852886e38; // FLT_MAX
    const data: SuiPageData = emptyPage({
      pageId: 1,
      associatedLocation: { x: REAL_MAX, y: REAL_MAX, z: REAL_MAX },
    });
    const round = roundTripPageData(data);
    expect(round.associatedLocation.x).toBe(REAL_MAX);
    expect(round.associatedLocation.y).toBe(REAL_MAX);
    expect(round.associatedLocation.z).toBe(REAL_MAX);
  });

  it('decode preserves the first 4 bytes as the LE i32 pageId', () => {
    const data = emptyPage({ pageId: 0x12345678 });
    const bytes = encodeSuiPageData(data);
    expect(bytes[0]).toBe(0x78);
    expect(bytes[1]).toBe(0x56);
    expect(bytes[2]).toBe(0x34);
    expect(bytes[3]).toBe(0x12);
    expect(peekSuiPageId(bytes)).toBe(0x12345678);
    expect(decodeSuiPageData(bytes).pageId).toBe(0x12345678);
  });

  it('handles negative pageIds (i32 LE)', () => {
    const data = emptyPage({ pageId: -1 });
    const bytes = encodeSuiPageData(data);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xff);
    expect(bytes[2]).toBe(0xff);
    expect(bytes[3]).toBe(0xff);
    expect(peekSuiPageId(bytes)).toBe(-1);
    expect(decodeSuiPageData(bytes).pageId).toBe(-1);
  });

  it('peekSuiPageId returns null for under-length buffers', () => {
    expect(peekSuiPageId(new Uint8Array(0))).toBeNull();
    expect(peekSuiPageId(new Uint8Array([0x01, 0x02, 0x03]))).toBeNull();
  });

  it('round-trips a page that includes an unknown command (lossless)', () => {
    // Build via writer so we can inject a synthetic unknown command, then
    // confirm decode → encode produces identical bytes.
    const data: SuiPageData = emptyPage({
      pageId: 99,
      pageName: 'mixed',
      commands: [
        { type: 'setProperty', targetWidget: 'a', propertyName: 'P', propertyValue: 'V' },
        {
          type: 'unknown',
          commandType: 254,
          parametersWide: ['wide'],
          parametersNarrow: ['target', 'extra'],
        },
        { type: 'clearDataSource', targetWidget: 'lst' },
      ],
    });
    const bytes = encodeSuiPageData(data);
    const decoded = decodeSuiPageData(bytes);
    expect(decoded).toEqual(data);
    expect(Array.from(encodeSuiPageData(decoded))).toEqual(Array.from(bytes));
  });

  it('rejects a negative command count', () => {
    const stream = new ByteStream();
    stream.writeI32(7); // pageId
    stream.writeU16(0); // empty pageName
    stream.writeI32(-1); // bogus negative count
    expect(() => decodeSuiPageData(stream.toBytes())).toThrow(/negative length/);
  });

  it('writeSuiPageData / readSuiPageData are direct inverses on a stream', () => {
    const data: SuiPageData = emptyPage({
      pageId: 5,
      pageName: 'direct',
      commands: [{ type: 'clearDataSource', targetWidget: 'x' }],
    });
    const stream = new ByteStream();
    writeSuiPageData(stream, data);
    const iter = new ReadIterator(stream.toBytes());
    expect(readSuiPageData(iter)).toEqual(data);
    expect(iter.remaining).toBe(0);
  });
});
