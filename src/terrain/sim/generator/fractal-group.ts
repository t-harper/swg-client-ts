/**
 * Port of `FractalGroup` (`sharedTerrain/.../FractalGroup.{h,cpp}`).
 *
 * Wire form: `MGRP > 0000 > MFAM* > {DATA(i32 familyId, cstring name), MFRC}`.
 * Stores named MultiFractal families; each family is one MultiFractal
 * instance. Looked up by integer familyId at chunk eval time.
 */

import type { IFractalGroup, IMultiFractal } from '../types.js';
import type { Iff } from '../../../iff/iff.js';
import { MultiFractal } from '../fractal/multi-fractal.js';
import { readMultiFractal } from '../fractal/multi-fractal-reader.js';

export interface FractalFamily {
  id: number;
  name: string;
  multiFractal: IMultiFractal;
}

export class FractalGroup implements IFractalGroup {
  /** Insertion-ordered list of families. */
  readonly families: FractalFamily[] = [];

  /**
   * Read an MGRP form. Cursor must be sitting on the MGRP FORM.
   *
   * Port of `FractalGroup::load` + `load_0000` (FractalGroup.cpp:150-172,
   * 370-404).
   */
  load(iff: Iff): void {
    // Reset existing families first (cpp::load calls reset() before loading).
    this.families.length = 0;

    iff.enterForm('MGRP');

    // The cpp dispatches on the inner version tag — only TAG_0000 is known.
    // We mirror that by entering whatever version is present and validating
    // it matches.
    const version = iff.enterAnyForm();
    if (version !== '0000') {
      throw new Error(`FractalGroup.load: unknown MGRP version '${version}'`);
    }

    // load_0000: loop reading MFAM forms until the 0000 form is exhausted.
    while (!iff.atEndOfForm()) {
      iff.enterForm('MFAM');

      iff.enterChunk('DATA');
      const familyId = iff.readI32();
      const name = iff.readString();
      iff.exitChunk('DATA');

      // Create the family's MultiFractal instance and read it from the
      // embedded MFRC form.
      const multiFractal = new MultiFractal();
      readMultiFractal(iff, multiFractal);

      this.families.push({ id: familyId, name, multiFractal });

      iff.exitForm('MFAM');
    }

    iff.exitForm('0000');
    iff.exitForm('MGRP');
  }

  /**
   * Pre-allocate each family's MultiFractal cache (no-op if cache already
   * sized).
   *
   * Port of `FractalGroup::prepare` (FractalGroup.cpp:217-221).
   */
  prepare(cacheX: number, cacheY: number): void {
    for (const family of this.families) {
      family.multiFractal.allocateCache(cacheX, cacheY);
    }
  }

  getFamilyMultiFractal(id: number): IMultiFractal | null {
    const fam = this.families.find((f) => f.id === id);
    return fam ? fam.multiFractal : null;
  }

  getFamilyName(id: number): string | null {
    const fam = this.families.find((f) => f.id === id);
    return fam ? fam.name : null;
  }

  getNumberOfFamilies(): number {
    return this.families.length;
  }

  getFamilyId(index: number): number {
    return (this.families[index] as FractalFamily).id;
  }

  hasFamily(id: number): boolean {
    return this.families.some((f) => f.id === id);
  }
}
