import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcI32, fcStdString, fcU32, roundTrip } from '../_fuzz-helpers.js';
import { LoginEnumCluster, type LoginEnumClusterData } from './login-enum-cluster.js';

const fcClusterEntry = (): fc.Arbitrary<LoginEnumClusterData> =>
  fc.record({
    clusterId: fcU32(),
    name: fcStdString({ maxLen: 64 }),
    timeZone: fcI32(),
  });

describe('LoginEnumCluster (fuzz)', () => {
  it('round-trips arbitrary cluster lists', () => {
    fc.assert(
      fc.property(fc.array(fcClusterEntry(), { maxLength: 16 }), fcI32(), (clusters, max) => {
        const m = new LoginEnumCluster(clusters, max);
        const decoded = roundTrip(m, LoginEnumCluster);
        assertWireEqual(
          { clusters: decoded.clusters, max: decoded.maxCharactersPerAccount },
          { clusters: m.clusters, max: m.maxCharactersPerAccount },
        );
      }),
      { numRuns: 100 },
    );
  });

  it('round-trips the empty-cluster case', () => {
    const m = new LoginEnumCluster([], 0);
    const decoded = roundTrip(m, LoginEnumCluster);
    assertWireEqual(decoded.clusters, []);
  });
});
