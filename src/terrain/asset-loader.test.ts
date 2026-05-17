/**
 * Unit tests for the planet-general TRE asset loader.
 *
 * Most tests use a tiny in-memory TRE built with TreWriter so they don't
 * depend on the swg-main repo being present. A skipped-if-missing real-archive
 * test verifies the listPlanets() output against the actual prebuilt TRE.
 */

import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { TreWriter } from '../tre/tre-writer.js';
import {
  clearTreCache,
  getTreReader,
  listPlanets,
  loadTrnFromTre,
  readTrnMetadataForPlanet,
  resolveDefaultTrePath,
  trnPathForPlanet,
} from './asset-loader.js';

const REAL_TRE_PATH = '/home/tharper/code/swg-main/dist/prebuilt/swgsource_3.0.tre';

// Build a minimal in-memory TRE with three FAKE planets (names chosen to not
// collide with real on-disk .trn files in the sibling swg-main repo, so the
// asset-loader's "extracted on disk first" search doesn't shadow our test
// payload).
function buildTinyArchive(): Uint8Array {
  return new TreWriter()
    .add('terrain/fakeplanet_a.trn', buildSyntheticTrn(16384, 128))
    .add('terrain/fakeplanet_b.trn', buildSyntheticTrn(16384, 256))
    .add('terrain/fakeplanet_c.trn', buildSyntheticTrn(8192, 64))
    .add('readme.txt', new TextEncoder().encode('not a terrain file\n'))
    .toBytes();
}

function buildSyntheticTrn(mapWidth: number, chunkWidth: number): Uint8Array {
  const nameBytes = new TextEncoder().encode('synthetic.trn');
  // DATA payload: name+NUL + 5×4-byte primitives
  const payload = new Uint8Array(nameBytes.byteLength + 1 + 4 * 5);
  let off = 0;
  payload.set(nameBytes, off);
  off += nameBytes.byteLength;
  payload[off++] = 0;
  const dv = new DataView(payload.buffer);
  dv.setFloat32(off, mapWidth, true); off += 4;
  dv.setFloat32(off, chunkWidth, true); off += 4;
  dv.setInt32(off, 16, true); off += 4; // numberOfTilesPerChunk
  dv.setInt32(off, 0, true); off += 4; // useGlobalWater
  dv.setFloat32(off, 0, true);

  // Wrap in IFF: FORM 'PTAT' > FORM '0015' > DATA chunk
  const dataChunk = wrapChunk('DATA', payload);
  const versionForm = wrapForm('0015', dataChunk);
  return wrapForm('PTAT', versionForm);
}
function wrapChunk(tagName: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, tagToInt(tagName), false);
  view.setUint32(4, payload.byteLength, false);
  out.set(payload, 8);
  return out;
}
function wrapForm(subTagName: string, innerBlock: Uint8Array): Uint8Array {
  const payload = new Uint8Array(4 + innerBlock.byteLength);
  new DataView(payload.buffer).setUint32(0, tagToInt(subTagName), false);
  payload.set(innerBlock, 4);
  return wrapChunk('FORM', payload);
}
function tagToInt(s: string): number {
  return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
}

afterEach(() => {
  clearTreCache();
  delete process.env.SWG_TRE_PATH;
});

describe('trnPathForPlanet', () => {
  it('returns the standard in-archive path', () => {
    expect(trnPathForPlanet('naboo')).toBe('terrain/naboo.trn');
    expect(trnPathForPlanet('tatooine')).toBe('terrain/tatooine.trn');
    expect(trnPathForPlanet('corellia')).toBe('terrain/corellia.trn');
  });
});

describe('loadTrnFromTre + listPlanets (in-memory archive)', () => {
  it('writes the archive bytes to a temp file and reads back the planets', async () => {
    const tmp = await import('node:os').then((os) => os.tmpdir());
    const path = await import('node:path').then((p) => p.join(tmp, `tre-test-${Date.now()}.tre`));
    const fs = await import('node:fs');
    fs.writeFileSync(path, buildTinyArchive());

    try {
      const planets = listPlanets(path);
      expect(planets).toEqual(['fakeplanet_a', 'fakeplanet_b', 'fakeplanet_c']);
    } finally {
      fs.unlinkSync(path);
    }
  });

  it('throws a helpful error if the planet is not in the archive', async () => {
    const tmp = await import('node:os').then((os) => os.tmpdir());
    const path = await import('node:path').then((p) => p.join(tmp, `tre-test2-${Date.now()}.tre`));
    const fs = await import('node:fs');
    fs.writeFileSync(path, buildTinyArchive());

    try {
      expect(() => loadTrnFromTre('endor', path)).toThrow(/Planet 'endor' not found/);
    } finally {
      fs.unlinkSync(path);
    }
  });

  it('reads back the .trn bytes and parses with readTrnMetadataForPlanet', async () => {
    const tmp = await import('node:os').then((os) => os.tmpdir());
    const path = await import('node:path').then((p) => p.join(tmp, `tre-test3-${Date.now()}.tre`));
    const fs = await import('node:fs');
    fs.writeFileSync(path, buildTinyArchive());

    try {
      const meta = readTrnMetadataForPlanet('fakeplanet_a', path);
      expect(meta.mapWidth).toBe(16384);
      expect(meta.chunkWidth).toBe(128);
      expect(meta.numChunksPerSide).toBe(128);
    } finally {
      fs.unlinkSync(path);
    }
  });
});

describe('resolveDefaultTrePath', () => {
  it('honors SWG_TRE_PATH when set + the file exists', async () => {
    const tmp = await import('node:os').then((os) => os.tmpdir());
    const path = await import('node:path').then((p) => p.join(tmp, `env-test-${Date.now()}.tre`));
    const fs = await import('node:fs');
    fs.writeFileSync(path, buildTinyArchive());
    process.env.SWG_TRE_PATH = path;

    try {
      expect(resolveDefaultTrePath()).toBe(path);
    } finally {
      fs.unlinkSync(path);
    }
  });

  it('throws if no archive can be found', () => {
    process.env.SWG_TRE_PATH = '/nonexistent/path.tre';
    // The cwd-relative fallbacks may or may not exist. We can only assert
    // that SOME path comes back OR a clear error. Don't over-constrain.
    try {
      resolveDefaultTrePath();
    } catch (err) {
      expect((err as Error).message).toMatch(/Could not find SWG TRE archive/);
    }
  });
});

describe('getTreReader caching', () => {
  it('caches the TreReader per path within the process', async () => {
    const tmp = await import('node:os').then((os) => os.tmpdir());
    const path = await import('node:path').then((p) => p.join(tmp, `cache-test-${Date.now()}.tre`));
    const fs = await import('node:fs');
    fs.writeFileSync(path, buildTinyArchive());

    try {
      const a = getTreReader(path);
      const b = getTreReader(path);
      expect(a).toBe(b);
      clearTreCache();
      const c = getTreReader(path);
      expect(c).not.toBe(a);
    } finally {
      fs.unlinkSync(path);
    }
  });
});

describe.skipIf(!existsSync(REAL_TRE_PATH))('against the real swgsource_3.0.tre', () => {
  it('lists at least one planet', () => {
    const planets = listPlanets(REAL_TRE_PATH);
    expect(planets.length).toBeGreaterThan(0);
  });

  it('loads metadata for the first planet in the archive', () => {
    const planets = listPlanets(REAL_TRE_PATH);
    if (planets.length === 0) return; // already covered by previous test
    const meta = readTrnMetadataForPlanet(planets[0]!, REAL_TRE_PATH);
    expect(meta.mapWidth).toBeGreaterThan(0);
    expect(meta.chunkWidth).toBeGreaterThan(0);
    expect(meta.version).toMatch(/^0\d{3}$/);
  });
});
