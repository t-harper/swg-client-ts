import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { EnterTicketPurchaseModeMessage } from './enter-ticket-purchase-mode-message.js';
import { PlanetTravelPointListRequest } from './planet-travel-point-list-request.js';
import { PlanetTravelPointListResponse } from './planet-travel-point-list-response.js';

describe('EnterTicketPurchaseModeMessage', () => {
  it('has the expected metadata', () => {
    expect(EnterTicketPurchaseModeMessage.messageName).toBe('EnterTicketPurchaseModeMessage');
    expect(EnterTicketPurchaseModeMessage.typeCrc).toBeGreaterThan(0);
    expect(EnterTicketPurchaseModeMessage.varCount).toBe(4);
  });

  it('encodes [planet][point][instantTravel] to the expected bytes', () => {
    const stream = new ByteStream();
    new EnterTicketPurchaseModeMessage('tatooine', 'mos_eisley', false).encodePayload(stream);
    const bytes = stream.toBytes();
    expect(bytes).toEqual(
      new Uint8Array([
        // std::string "tatooine" — u16 LE len 8 + ascii
        0x08, 0x00, 0x74, 0x61, 0x74, 0x6f, 0x6f, 0x69, 0x6e, 0x65,
        // std::string "mos_eisley" — u16 LE len 10 + ascii
        0x0a, 0x00, 0x6d, 0x6f, 0x73, 0x5f, 0x65, 0x69, 0x73, 0x6c, 0x65, 0x79,
        // bool false → 0x00
        0x00,
      ]),
    );
  });

  it('round-trips encode → decode (instant=true)', () => {
    const stream = new ByteStream();
    new EnterTicketPurchaseModeMessage('naboo', 'theed', true).encodePayload(stream);
    const decoded = EnterTicketPurchaseModeMessage.decodePayload(
      new ReadIterator(stream.toBytes()),
    );
    expect(decoded.planetName).toBe('naboo');
    expect(decoded.travelPointName).toBe('theed');
    expect(decoded.instantTravel).toBe(true);
  });
});

describe('PlanetTravelPointListRequest', () => {
  it('has the expected metadata', () => {
    expect(PlanetTravelPointListRequest.messageName).toBe('PlanetTravelPointListRequest');
    expect(PlanetTravelPointListRequest.typeCrc).toBeGreaterThan(0);
    expect(PlanetTravelPointListRequest.varCount).toBe(3);
  });

  it('encodes [networkId][planet] to the expected bytes', () => {
    const stream = new ByteStream();
    new PlanetTravelPointListRequest(0x42n, 'tatooine').encodePayload(stream);
    expect(stream.toBytes()).toEqual(
      new Uint8Array([
        // NetworkId u64 LE 0x42
        0x42, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        // std::string "tatooine"
        0x08, 0x00, 0x74, 0x61, 0x74, 0x6f, 0x6f, 0x69, 0x6e, 0x65,
      ]),
    );
  });

  it('round-trips encode → decode', () => {
    const stream = new ByteStream();
    new PlanetTravelPointListRequest(0x123456789abcdefn, 'corellia').encodePayload(stream);
    const decoded = PlanetTravelPointListRequest.decodePayload(new ReadIterator(stream.toBytes()));
    expect(decoded.networkId).toBe(0x123456789abcdefn);
    expect(decoded.planetName).toBe('corellia');
  });
});

describe('PlanetTravelPointListResponse', () => {
  it('has the expected metadata', () => {
    expect(PlanetTravelPointListResponse.messageName).toBe('PlanetTravelPointListResponse');
    expect(PlanetTravelPointListResponse.typeCrc).toBeGreaterThan(0);
    expect(PlanetTravelPointListResponse.varCount).toBe(6);
  });

  it('round-trips a multi-point payload', () => {
    const stream = new ByteStream();
    new PlanetTravelPointListResponse(
      'tatooine',
      ['Mos Eisley', 'Bestine'],
      [
        { x: 3500, y: 5, z: -4800 },
        { x: -1300, y: 12, z: -3600 },
      ],
      [100, 100],
      [true, false],
    ).encodePayload(stream);
    const decoded = PlanetTravelPointListResponse.decodePayload(new ReadIterator(stream.toBytes()));
    expect(decoded.planetName).toBe('tatooine');
    expect(decoded.travelPointNameList).toEqual(['Mos Eisley', 'Bestine']);
    expect(decoded.travelPointCostList).toEqual([100, 100]);
    expect(decoded.travelPointInterplanetaryList).toEqual([true, false]);
    expect(decoded.travelPointPointList).toHaveLength(2);
    expect(decoded.travelPointPointList[0]?.x).toBeCloseTo(3500);
    expect(decoded.travelPointPointList[1]?.z).toBeCloseTo(-3600);
  });

  it('handles an empty point list', () => {
    const stream = new ByteStream();
    new PlanetTravelPointListResponse('endor', [], [], [], []).encodePayload(stream);
    const decoded = PlanetTravelPointListResponse.decodePayload(new ReadIterator(stream.toBytes()));
    expect(decoded.planetName).toBe('endor');
    expect(decoded.travelPointNameList).toEqual([]);
    expect(decoded.travelPointPointList).toEqual([]);
    expect(decoded.travelPointCostList).toEqual([]);
    expect(decoded.travelPointInterplanetaryList).toEqual([]);
  });
});
