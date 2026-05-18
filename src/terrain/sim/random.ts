/**
 * `RandomGenerator` — bit-exact port of `sharedRandom/RandomGenerator.{h,cpp}`.
 *
 * Algorithm: Numerical Recipes ran1() — Park-Miller LCG with shuffle table.
 *
 * **Why bit-exact matters:** the `MultiFractal` noise engine seeds its
 * permutation table by calling `RandomGenerator::randomReal()` 256+ times.
 * If our sequence differs from the C++ implementation's by even one
 * value, the entire noise field is shuffled differently and offline
 * heights diverge from the live server.
 *
 * Constants:
 *   IM   = 2147483647 (2³¹ - 1, the Mersenne prime modulus)
 *   IA   = 16807      (Park-Miller multiplier)
 *   IQ   = 127773     (IM / IA)
 *   IR   = 2836       (IM % IA)
 *   NTAB = 322        (shuffle table size — UNUSUAL: NR std is 32; SWG used 322)
 *
 * Constructor sets `idnum = -seed`, `iy = 0`; the first call to
 * `randomNumber()` re-initializes by walking j from NTAB+7 down to 0,
 * filling iv[0..NTAB-1] from the seeded LCG.
 */

const IM = 2147483647;
const IA = 16807;
const IQ = 127773;
const IR = 2836;
const NTAB = 322;
const AM = 1 / IM;
const NDIV = 1 + (IM - 1) / NTAB;

export class RandomGenerator {
  // i32 internally — JS bitwise ops keep them in int32 range.
  private idnum: number;
  private iy: number;
  private iv: Int32Array;

  /**
   * Construct with an explicit uint32 seed. Mirrors the `explicit
   * RandomGenerator(uint32 newSeed)` constructor at `RandomGenerator.h:84`.
   */
  constructor(seed: number) {
    // C++: idnum (-static_cast<int32>(newSeed)). Mask seed to uint32 then
    // negate as int32.
    const u32 = seed >>> 0;
    // -u32 as int32 — handles 0 → 0 correctly (no negation past int32 min).
    this.idnum = (-u32) | 0;
    this.iy = 0;
    this.iv = new Int32Array(NTAB);
  }

  /** Reset to a new seed. */
  setSeed(seed: number): void {
    const u32 = seed >>> 0;
    this.idnum = (-u32) | 0;
    this.iy = 0;
    this.iv.fill(0);
  }

  /** Current internal seed (for debug parity with C++). */
  getSeed(): number {
    return this.idnum;
  }

  /**
   * The core int32 random — `randomNumber()` in
   * `RandomGenerator.cpp:38-70`. Returns a positive int32 < IM.
   */
  randomNumber(): number {
    let j: number;
    let k: number;

    if (this.idnum <= 0 || this.iy === 0) {
      // (Re-)initialize. C++ guards `-idnum < 1` so a seed of 0 produces
      // idnum=1; otherwise idnum = -idnum.
      if (-this.idnum < 1) this.idnum = 1;
      else this.idnum = -this.idnum;

      for (j = NTAB + 7; j >= 0; j--) {
        k = (this.idnum / IQ) | 0;
        // idnum = IA * (idnum - k*IQ) - IR*k
        this.idnum = Math.imul(IA, this.idnum - k * IQ) - IR * k;
        if (this.idnum < 0) this.idnum = (this.idnum + IM) | 0;
        if (j < NTAB) this.iv[j] = this.idnum;
      }
      this.iy = this.iv[0] as number;
    }

    k = (this.idnum / IQ) | 0;
    this.idnum = Math.imul(IA, this.idnum - k * IQ) - IR * k;
    if (this.idnum < 0) this.idnum = (this.idnum + IM) | 0;
    j = (this.iy / NDIV) | 0;
    this.iy = this.iv[j] as number;
    this.iv[j] = this.idnum;
    return this.iy;
  }

  /** Real in [0, 1] — `randomReal()` in `RandomGenerator.h:121`. */
  randomReal(): number {
    return this.randomNumber() * AM;
  }

  /** Real in [0, range]. */
  randomRealRange(range: number): number {
    return this.randomReal() * range;
  }

  /** Real in [low, high]. */
  randomRealLowHigh(low: number, high: number): number {
    return low + (high - low) * this.randomReal();
  }

  /** Int in [0, max_int32]. */
  random(): number {
    return this.randomNumber();
  }

  /** Int in [0, range). */
  randomInt(range: number): number {
    return (this.randomReal() * range) | 0;
  }
}
