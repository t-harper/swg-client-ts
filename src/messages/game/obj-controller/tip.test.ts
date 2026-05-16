import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';
import { TipDecoder, TipKind } from './tip.js';

describe('Tip (CM_scriptTransferMoney)', () => {
  it('has the right metadata', () => {
    expect(TipDecoder.kind).toBe('Tip');
    expect(TipDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_scriptTransferMoney);
    expect(TipDecoder.subtypeId).toBe(364);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_scriptTransferMoney);
    expect(found).toBe(TipDecoder);
    expect(objControllerRegistry.getByKind(TipKind)).toBe(TipDecoder);
  });

  it('round-trips a typical /tip with empty callbacks and dict', () => {
    const data = {
      typeId: 1,
      target: 0xdead_beef_1234n,
      namedAccount: '',
      amount: 500,
      replyTo: 0n,
      successCallback: '',
      failCallback: '',
      packedDictionary: new Uint8Array(0),
    };
    const s = new ByteStream();
    TipDecoder.encode(s, data);
    const d = TipDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.typeId).toBe(1);
    expect(d.target).toBe(0xdead_beef_1234n);
    expect(d.namedAccount).toBe('');
    expect(d.amount).toBe(500);
    expect(d.replyTo).toBe(0n);
    expect(d.successCallback).toBe('');
    expect(d.failCallback).toBe('');
    expect(Array.from(d.packedDictionary)).toEqual([]);
  });

  it('round-trips a script transfer with named account and callbacks', () => {
    const data = {
      typeId: 2,
      target: 0n,
      namedAccount: 'galactic_bank',
      amount: 1_000_000,
      replyTo: 0xaa_bbn,
      successCallback: 'onTipSuccess',
      failCallback: 'onTipFail',
      packedDictionary: new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]),
    };
    const s = new ByteStream();
    TipDecoder.encode(s, data);
    const d = TipDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.typeId).toBe(2);
    expect(d.target).toBe(0n);
    expect(d.namedAccount).toBe('galactic_bank');
    expect(d.amount).toBe(1_000_000);
    expect(d.replyTo).toBe(0xaa_bbn);
    expect(d.successCallback).toBe('onTipSuccess');
    expect(d.failCallback).toBe('onTipFail');
    expect(Array.from(d.packedDictionary)).toEqual([0x01, 0x02, 0x03, 0x04, 0x05]);
  });

  it('handles negative amounts (withdrawals are positive in SWG; signed for safety)', () => {
    const data = {
      typeId: 0,
      target: 1n,
      namedAccount: '',
      amount: -500,
      replyTo: 0n,
      successCallback: '',
      failCallback: '',
      packedDictionary: new Uint8Array(0),
    };
    const s = new ByteStream();
    TipDecoder.encode(s, data);
    const d = TipDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.amount).toBe(-500);
  });

  it('has the expected minimum byte layout (all empty strings, empty dict)', () => {
    const data = {
      typeId: 0,
      target: 0n,
      namedAccount: '',
      amount: 0,
      replyTo: 0n,
      successCallback: '',
      failCallback: '',
      packedDictionary: new Uint8Array(0),
    };
    const s = new ByteStream();
    TipDecoder.encode(s, data);
    const bytes = s.toBytes();
    // 4 (typeId) + 8 (target) + 2 (string=0 len) + 4 (amount) + 8 (replyTo)
    //  + 2 (successCb=0 len) + 2 (failCb=0 len) + 4 (dict=0 len) = 34
    expect(bytes.length).toBe(34);
  });
});
