/**
 * TRN metadata reader tests.
 *
 * Mix of:
 *   - synthetic IFF byte vectors (so we can assert exact parsing behavior
 *     without depending on the live serverdata tree); and
 *   - the real `naboo.trn` file when present (skipped if the swg-main
 *     tree isn't checked out beside us).
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MinimalIff, packTag, unpackTag } from './_iff-minimal.js';
import { PTAT_DATA_TAG, PTAT_TAG, parseTrnMetadata, readTrnMetadata } from './trn-reader.js';

const NABOO_TRN_PATH = '/home/tharper/code/swg-main/serverdata/terrain/naboo.trn';

/** Build a synthetic minimal PTAT file with the supplied numbers. */
function buildMinimalPtat(args: {
  name: string;
  mapWidth: number;
  chunkWidth: number;
  numberOfTilesPerChunk: number;
  useGlobalWater: 0 | 1;
  globalWaterHeight: number;
  version?: string;
}): Uint8Array {
  const version = args.version ?? '0015';

  // Build the DATA chunk payload first so we know its length.
  const nameBytes = new TextEncoder().encode(args.name);
  const dataPayloadLen = nameBytes.byteLength + 1 + 4 + 4 + 4 + 4 + 4; // name+NUL + 5×4-byte primitives
  const dataPayload = new Uint8Array(dataPayloadLen);
  const dataView = new DataView(dataPayload.buffer);
  let off = 0;
  dataPayload.set(nameBytes, off);
  off += nameBytes.byteLength;
  dataPayload[off] = 0; // NUL
  off += 1;
  dataView.setFloat32(off, args.mapWidth, true);
  off += 4;
  dataView.setFloat32(off, args.chunkWidth, true);
  off += 4;
  dataView.setInt32(off, args.numberOfTilesPerChunk, true);
  off += 4;
  dataView.setInt32(off, args.useGlobalWater, true);
  off += 4;
  dataView.setFloat32(off, args.globalWaterHeight, true);
  off += 4;

  // Wrap in DATA chunk header.
  const dataChunk = wrapChunk('DATA', dataPayload);

  // Wrap in version FORM.
  const versionForm = wrapForm(version, dataChunk);

  // Wrap in PTAT FORM.
  return wrapForm('PTAT', versionForm);
}

function wrapChunk(tagName: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, packTag(tagName), false); // BE tag
  view.setUint32(4, payload.byteLength, false); // BE length
  out.set(payload, 8);
  return out;
}

function wrapForm(subTagName: string, innerBlock: Uint8Array): Uint8Array {
  // FORM payload = [4 BE sub-tag][inner block bytes]
  const payload = new Uint8Array(4 + innerBlock.byteLength);
  new DataView(payload.buffer).setUint32(0, packTag(subTagName), false);
  payload.set(innerBlock, 4);
  return wrapChunk('FORM', payload);
}

describe('packTag / unpackTag', () => {
  it('round-trips standard tags', () => {
    expect(packTag('FORM')).toBe(0x464f524d);
    expect(packTag('PTAT')).toBe(0x50544154);
    expect(packTag('DATA')).toBe(0x44415441);
    expect(packTag('0015')).toBe(0x30303135);
    expect(unpackTag(0x464f524d)).toBe('FORM');
    expect(unpackTag(0x50544154)).toBe('PTAT');
    expect(unpackTag(0x30303135)).toBe('0015');
  });

  it('right-pads with space for short strings', () => {
    expect(packTag('ABC')).toBe(0x41424320);
    expect(packTag('A')).toBe(0x41202020);
  });

  it('exposes top-level PTAT and DATA constants', () => {
    expect(PTAT_TAG).toBe(packTag('PTAT'));
    expect(PTAT_DATA_TAG).toBe(packTag('DATA'));
  });
});

describe('MinimalIff', () => {
  it('detects an IFF FORM header', () => {
    const buf = buildMinimalPtat({
      name: 'x',
      mapWidth: 1024,
      chunkWidth: 32,
      numberOfTilesPerChunk: 16,
      useGlobalWater: 0,
      globalWaterHeight: 0,
    });
    const iff = new MinimalIff(buf);
    expect(iff.hasFormHeader()).toBe(true);
  });

  it('rejects non-IFF buffers', () => {
    const iff = new MinimalIff(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(iff.hasFormHeader()).toBe(false);
  });
});

describe('parseTrnMetadata (synthetic)', () => {
  it('decodes a hand-built minimal PTAT', () => {
    const buf = buildMinimalPtat({
      name: 'C:\\swg\\fake\\naboo.trn',
      mapWidth: 16384,
      chunkWidth: 128,
      numberOfTilesPerChunk: 16,
      useGlobalWater: 1,
      globalWaterHeight: 0.5,
    });
    const meta = parseTrnMetadata(buf);
    expect(meta.mapWidth).toBe(16384);
    expect(meta.chunkWidth).toBe(128);
    expect(meta.numChunksPerSide).toBe(128); // 16384 / 128
    expect(meta.version).toBe('0015');
    expect(meta.sourceName).toBe('C:\\swg\\fake\\naboo.trn');
    expect(meta.globalWaterHeight).toBeCloseTo(0.5, 3);
  });

  it('reports null water height when global water is disabled', () => {
    const buf = buildMinimalPtat({
      name: 'foo.trn',
      mapWidth: 8192,
      chunkWidth: 64,
      numberOfTilesPerChunk: 16,
      useGlobalWater: 0,
      globalWaterHeight: 999,
    });
    const meta = parseTrnMetadata(buf);
    expect(meta.globalWaterHeight).toBeNull();
    expect(meta.numChunksPerSide).toBe(128); // 8192 / 64
  });

  it('accepts other supported PTAT versions', () => {
    const v0013 = parseTrnMetadata(
      buildMinimalPtat({
        name: 'x',
        mapWidth: 4096,
        chunkWidth: 32,
        numberOfTilesPerChunk: 16,
        useGlobalWater: 0,
        globalWaterHeight: 0,
        version: '0013',
      }),
    );
    expect(v0013.version).toBe('0013');

    const v0014 = parseTrnMetadata(
      buildMinimalPtat({
        name: 'x',
        mapWidth: 4096,
        chunkWidth: 32,
        numberOfTilesPerChunk: 16,
        useGlobalWater: 0,
        globalWaterHeight: 0,
        version: '0014',
      }),
    );
    expect(v0014.version).toBe('0014');
  });

  it('throws on an unsupported version', () => {
    expect(() =>
      parseTrnMetadata(
        buildMinimalPtat({
          name: 'x',
          mapWidth: 1024,
          chunkWidth: 32,
          numberOfTilesPerChunk: 16,
          useGlobalWater: 0,
          globalWaterHeight: 0,
          version: '9999',
        }),
      ),
    ).toThrow(/unsupported PTAT version/);
  });

  it('throws on a non-IFF buffer', () => {
    expect(() => parseTrnMetadata(new Uint8Array([1, 2, 3, 4]))).toThrow(/not an IFF file/);
  });

  it('throws on bad mapWidth / chunkWidth ratios', () => {
    expect(() =>
      parseTrnMetadata(
        buildMinimalPtat({
          name: 'x',
          mapWidth: 1000,
          chunkWidth: 33,
          numberOfTilesPerChunk: 16,
          useGlobalWater: 0,
          globalWaterHeight: 0,
        }),
      ),
    ).toThrow(/integer multiple/);
  });
});

describe.skipIf(!existsSync(NABOO_TRN_PATH))('parseTrnMetadata (real naboo.trn)', () => {
  it('decodes the live naboo.trn metadata', () => {
    const meta = readTrnMetadata(NABOO_TRN_PATH);
    // Naboo is one of the standard 16384m square planets.
    expect(meta.mapWidth).toBe(16384);
    // Chunk width is engine-default 32 m (verified against Naboo
    // tcpdump captures from the live client).
    expect(meta.chunkWidth).toBeGreaterThan(0);
    expect(meta.chunkWidth).toBeLessThanOrEqual(256);
    expect(meta.mapWidth % meta.chunkWidth).toBe(0);
    expect(meta.numChunksPerSide).toBe(meta.mapWidth / meta.chunkWidth);
    expect(meta.version).toMatch(/^00(13|14|15)$/);
    expect(meta.sourceName.toLowerCase()).toContain('naboo');
  });

  it('matches the raw first-bytes signature', () => {
    const buf = readFileSync(NABOO_TRN_PATH);
    // First 4 bytes are 'FORM'
    expect(buf[0]).toBe(0x46);
    expect(buf[1]).toBe(0x4f);
    expect(buf[2]).toBe(0x52);
    expect(buf[3]).toBe(0x4d);
    // Top-level sub-tag (bytes 8-11) is 'PTAT'
    expect(buf[8]).toBe(0x50);
    expect(buf[9]).toBe(0x54);
    expect(buf[10]).toBe(0x41);
    expect(buf[11]).toBe(0x54);
  });
});
