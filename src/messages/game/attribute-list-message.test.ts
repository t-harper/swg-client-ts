import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { AttributeListMessage } from './attribute-list-message.js';

describe('AttributeListMessage', () => {
  it('has the expected metadata', () => {
    expect(AttributeListMessage.messageName).toBe('AttributeListMessage');
    expect(AttributeListMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips an empty list', () => {
    const m = new AttributeListMessage(42n, '', [], 1);
    const s = new ByteStream();
    m.encodePayload(s);
    const d = AttributeListMessage.decodePayload(new ReadIterator(s.toBytes()));
    expect(d.networkId).toBe(42n);
    expect(d.staticItemName).toBe('');
    expect(d.data.length).toBe(0);
    expect(d.revision).toBe(1);
  });

  it('round-trips populated attribute list', () => {
    const m = new AttributeListMessage(
      0x0001_0002_0003_0004n,
      'static_item_42',
      [
        { key: 'attr1', value: 'Value One' },
        { key: 'attr2', value: 'Value Two' },
      ],
      7,
    );
    const s = new ByteStream();
    m.encodePayload(s);
    const iter = new ReadIterator(s.toBytes());
    const d = AttributeListMessage.decodePayload(iter);
    expect(iter.remaining).toBe(0);
    expect(d.data.length).toBe(2);
    expect(d.data[0]?.key).toBe('attr1');
    expect(d.data[0]?.value).toBe('Value One');
    expect(d.data[1]?.key).toBe('attr2');
    expect(d.data[1]?.value).toBe('Value Two');
    expect(d.revision).toBe(7);
  });
});
