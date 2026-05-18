/**
 * Feathering functions — port of the static feather-function table in
 * `sharedTerrain/.../TerrainGenerator.cpp` and the helpers in
 * `Feather.h`.
 *
 * Each function takes a normalized [0, 1] amount (where 0 = the very
 * edge of the feather zone, 1 = fully inside) and returns the smoothed
 * inclusion factor.
 */

import { FeatherFunction } from './types.js';

export const Feather = {
  /** Identity — no smoothing. */
  linear(t: number): number {
    return t;
  },

  /** Ease-in: slow start, fast end. Smoothstep variant `t² · (3 - 2t)`. */
  easeIn(t: number): number {
    return t * t;
  },

  /** Ease-out: fast start, slow end. `1 - (1 - t)²`. */
  easeOut(t: number): number {
    const inv = 1 - t;
    return 1 - inv * inv;
  },

  /** Ease-in-out: smoothstep `t² · (3 - 2t)`. */
  easeInOut(t: number): number {
    return t * t * (3 - 2 * t);
  },

  /** Dispatch by enum. */
  feather(fn: FeatherFunction, t: number): number {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    switch (fn) {
      case FeatherFunction.Linear:
        return Feather.linear(t);
      case FeatherFunction.EaseIn:
        return Feather.easeIn(t);
      case FeatherFunction.EaseOut:
        return Feather.easeOut(t);
      case FeatherFunction.EaseInOut:
        return Feather.easeInOut(t);
      default:
        return t;
    }
  },
} as const;
