/**
 * Tests for `parseBuildingTemplateInfo` — the SharedObjectTemplate `.iff`
 * field extractor.
 *
 * Three layers of coverage:
 *
 *   1. **Fixture assertion** against the real Mos Eisley cantina shared
 *      template (`tests/fixtures/object-template-cantina-tatooine.iff`,
 *      copied from
 *      `~/code/swg-main/data/sku.0/sys.shared/compiled/game/object/building/tatooine/shared_cantina_tatooine.iff`).
 *      This is the load-bearing assertion for the whole feature: the
 *      extracted `portalLayoutFilename` MUST equal
 *      `'appearance/thm_tato_cantina.pob'`. If this ever breaks, the
 *      navigate path's portal-aware cell entry can't resolve the cantina's
 *      cell graph.
 *   2. **Negative case** built from an `IffWriter`-constructed template
 *      whose only string params are deliberately set to `NONE` — proves
 *      that "template without portal" returns `null` instead of throwing.
 *   3. **Round-trip** via `IffWriter`: programmatically build a minimal
 *      SHOT template with a known `portalLayoutFilename`, serialize,
 *      re-parse, and confirm the value round-trips. This is the
 *      wire-format regression guard for the StringParam encoding.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IffWriter } from './iff.js';
import { parseBuildingTemplateInfo } from './object-template-reader.js';

const FIXTURE_PATH = join(
  process.cwd(),
  'tests',
  'fixtures',
  'object-template-cantina-tatooine.iff',
);

// ---------------------------------------------------------------------------
// Fixture-based tests
// ---------------------------------------------------------------------------
//
// Project rule: skip paths are errors EXCEPT the outer runner gate. We
// gate via `describe.skipIf(!fixturePresent)` so a missing fixture
// surfaces as a runner-level skip rather than a silent pass; if the
// fixture IS present every assertion runs.

describe.skipIf(!existsSync(FIXTURE_PATH))('parseBuildingTemplateInfo — cantina fixture', () => {
  const bytes = existsSync(FIXTURE_PATH) ? readFileSync(FIXTURE_PATH) : new Uint8Array(0);

  it('extracts portalLayoutFilename from the SHOT param block', () => {
    const info = parseBuildingTemplateInfo(
      bytes,
      'object/building/tatooine/shared_cantina_tatooine.iff',
    );
    expect(info.portalLayoutFilename).toBe('appearance/thm_tato_cantina.pob');
  });

  it('appearanceFilename is empty in the leaf template — normalized to null', () => {
    // The cantina SHOT chunk carries `appearanceFilename` as a SINGLE
    // StringParam with value `""` (the appearance is inherited via DERV
    // from `shared_base_cantina.iff` or supplied via the .pob's mesh).
    // Per `normalizeFilename`, the empty string maps to `null` so
    // callers can use `?? fallback` cleanly.
    const info = parseBuildingTemplateInfo(
      bytes,
      'object/building/tatooine/shared_cantina_tatooine.iff',
    );
    expect(info.appearanceFilename).toBeNull();
  });

  it('echoes back the supplied templateName unchanged', () => {
    const name = 'object/building/tatooine/shared_cantina_tatooine.iff';
    const info = parseBuildingTemplateInfo(bytes, name);
    expect(info.templateName).toBe(name);
  });
});

// ---------------------------------------------------------------------------
// Hand-built fixtures (deterministic, no on-disk dependency)
// ---------------------------------------------------------------------------

describe('parseBuildingTemplateInfo — IffWriter round-trip', () => {
  /**
   * Build a minimal SHOT template containing one `portalLayoutFilename`
   * string-param set to the supplied value. The structure mirrors what
   * the C++ template compiler emits:
   *
   *     FORM SHOT
   *       FORM 0010                 (version FORM)
   *         CHUNK PCNT [i32 1]      (one declared param)
   *         CHUNK XXXX              (the one param)
   *           [name "portalLayoutFilename\0"]
   *           [i8  1]               (DataTypeId.SINGLE)
   *           [string "<value>\0"]
   */
  function buildMinimalShotTemplate(portalLayout: string): Uint8Array {
    return new IffWriter()
      .insertForm('SHOT')
      .insertForm('0010')
      .insertChunk('PCNT')
      .writeI32(1)
      .exitChunk()
      .insertChunk('XXXX')
      .writeString('portalLayoutFilename')
      .writeU8(1) // SINGLE
      .writeString(portalLayout)
      .exitChunk()
      .exitForm()
      .exitForm()
      .toBytes();
  }

  it('extracts the value from a hand-built SHOT template (deterministic)', () => {
    const bytes = buildMinimalShotTemplate('appearance/test_building.pob');
    const info = parseBuildingTemplateInfo(bytes, 'object/test/shared_test.iff');
    expect(info).toEqual({
      templateName: 'object/test/shared_test.iff',
      portalLayoutFilename: 'appearance/test_building.pob',
      appearanceFilename: null,
    });
  });

  it('handles both string params declared together in one PCNT block', () => {
    const bytes = new IffWriter()
      .insertForm('SHOT')
      .insertForm('0010')
      .insertChunk('PCNT')
      .writeI32(2)
      .exitChunk()
      .insertChunk('XXXX')
      .writeString('portalLayoutFilename')
      .writeU8(1) // SINGLE
      .writeString('appearance/foo.pob')
      .exitChunk()
      .insertChunk('XXXX')
      .writeString('appearanceFilename')
      .writeU8(1) // SINGLE
      .writeString('appearance/foo.msh')
      .exitChunk()
      .exitForm()
      .exitForm()
      .toBytes();
    const info = parseBuildingTemplateInfo(bytes, 'object/test/shared_two.iff');
    expect(info.portalLayoutFilename).toBe('appearance/foo.pob');
    expect(info.appearanceFilename).toBe('appearance/foo.msh');
  });

  it('returns null when the param is encoded as NONE (DataTypeId 0)', () => {
    // Template declares portalLayoutFilename but leaves it unset (`NONE`).
    // This is the common case for non-building object templates — e.g.
    // creatures, items, weapons — and must NOT be treated as an error.
    const bytes = new IffWriter()
      .insertForm('SHOT')
      .insertForm('0010')
      .insertChunk('PCNT')
      .writeI32(1)
      .exitChunk()
      .insertChunk('XXXX')
      .writeString('portalLayoutFilename')
      .writeU8(0) // NONE
      .exitChunk()
      .exitForm()
      .exitForm()
      .toBytes();
    const info = parseBuildingTemplateInfo(bytes, 'object/test/shared_none.iff');
    expect(info.portalLayoutFilename).toBeNull();
    expect(info.appearanceFilename).toBeNull();
  });

  it('returns null when neither field is declared in the param table', () => {
    // Pretend this template only carries unrelated params (e.g. `scale`,
    // `objectName`). The reader must walk past them without harvesting
    // anything for the two we care about.
    const bytes = new IffWriter()
      .insertForm('SHOT')
      .insertForm('0010')
      .insertChunk('PCNT')
      .writeI32(2)
      .exitChunk()
      .insertChunk('XXXX')
      .writeString('scale')
      // For non-matching params we don't bother encoding a realistic
      // payload — the reader skips the rest of the chunk via `exitChunk`.
      .writeU8(0)
      .exitChunk()
      .insertChunk('XXXX')
      .writeString('snapToTerrain')
      .writeU8(0)
      .exitChunk()
      .exitForm()
      .exitForm()
      .toBytes();
    const info = parseBuildingTemplateInfo(bytes, 'object/test/shared_other.iff');
    expect(info.portalLayoutFilename).toBeNull();
    expect(info.appearanceFilename).toBeNull();
  });

  it('descends through nested template-class FORMs (SBOT → STOT → SHOT)', () => {
    // Real building templates wrap the SHOT level inside STOT inside
    // SBOT. The walker must descend through them.
    const bytes = new IffWriter()
      .insertForm('SBOT')
      .insertForm('0001')
      .insertChunk('PCNT')
      .writeI32(0)
      .exitChunk()
      .exitForm()
      .insertForm('STOT')
      .insertForm('0010')
      .insertChunk('PCNT')
      .writeI32(0)
      .exitChunk()
      .exitForm()
      .insertForm('SHOT')
      .insertForm('0010')
      .insertChunk('PCNT')
      .writeI32(1)
      .exitChunk()
      .insertChunk('XXXX')
      .writeString('portalLayoutFilename')
      .writeU8(1)
      .writeString('appearance/nested_building.pob')
      .exitChunk()
      .exitForm()
      .exitForm()
      .exitForm()
      .exitForm()
      .toBytes();
    const info = parseBuildingTemplateInfo(bytes, 'object/test/shared_nested.iff');
    expect(info.portalLayoutFilename).toBe('appearance/nested_building.pob');
  });

  it('skips DERV inheritance pointers without consuming the inner XXXX', () => {
    // DERV always precedes the version FORM at each template-class level.
    // The walker must skip it (its inner chunk is the base-template path,
    // not a param we want).
    const bytes = new IffWriter()
      .insertForm('SHOT')
      .insertForm('DERV')
      .insertChunk('XXXX')
      .writeString('object/building/base/shared_base_building.iff')
      .exitChunk()
      .exitForm()
      .insertForm('0010')
      .insertChunk('PCNT')
      .writeI32(1)
      .exitChunk()
      .insertChunk('XXXX')
      .writeString('portalLayoutFilename')
      .writeU8(1)
      .writeString('appearance/with_derv.pob')
      .exitChunk()
      .exitForm()
      .exitForm()
      .toBytes();
    const info = parseBuildingTemplateInfo(bytes, 'object/test/shared_derv.iff');
    expect(info.portalLayoutFilename).toBe('appearance/with_derv.pob');
  });
});

describe('parseBuildingTemplateInfo — error handling', () => {
  it('throws on empty input', () => {
    expect(() => parseBuildingTemplateInfo(new Uint8Array(0), 'empty')).toThrow(/empty file/);
  });

  it('throws when the top-level block is not a FORM', () => {
    // A naked chunk (no surrounding FORM) is not a valid object template.
    // The reader detects this before attempting to recurse.
    const bytes = new Uint8Array([
      // chunk tag "JUNK"
      0x4a, 0x55, 0x4e, 0x4b,
      // chunk length 0
      0x00, 0x00, 0x00, 0x00,
    ]);
    expect(() => parseBuildingTemplateInfo(bytes, 'bad-top')).toThrow(/not a FORM/);
  });
});
