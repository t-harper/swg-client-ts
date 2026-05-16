import fc from 'fast-check';
import { describe, it } from 'vitest';

import { ClusterStatus, PopulationStatus } from '../../types.js';
import { assertWireEqual, fcI32, fcStdString, fcU16, fcU32, roundTrip } from '../_fuzz-helpers.js';
import { LoginClusterStatus, type LoginClusterStatusData } from './login-cluster-status.js';

const fcEntry = (): fc.Arbitrary<LoginClusterStatusData> =>
  fc.record({
    clusterId: fcU32(),
    connectionServerAddress: fcStdString({ maxLen: 64 }),
    connectionServerPort: fcU16(),
    connectionServerPingPort: fcU16(),
    populationOnline: fcI32(),
    populationOnlineStatus: fc.constantFrom(
      ...(Object.values(PopulationStatus).filter(
        (v) => typeof v === 'number',
      ) as PopulationStatus[]),
    ),
    maxCharactersPerAccount: fcI32(),
    timeZone: fcI32(),
    status: fc.constantFrom(
      ...(Object.values(ClusterStatus).filter((v) => typeof v === 'number') as ClusterStatus[]),
    ),
    dontRecommend: fc.boolean(),
    onlinePlayerLimit: fcU32(),
    onlineFreeTrialLimit: fcU32(),
    isAdmin: fc.boolean(),
    isSecret: fc.boolean(),
  });

describe('LoginClusterStatus (fuzz)', () => {
  it('round-trips arbitrary cluster lists', () => {
    fc.assert(
      fc.property(fc.array(fcEntry(), { minLength: 1, maxLength: 8 }), (clusters) => {
        const m = new LoginClusterStatus(clusters);
        const decoded = roundTrip(m, LoginClusterStatus);
        assertWireEqual(decoded.clusters, m.clusters);
      }),
      { numRuns: 100 },
    );
  });

  it('round-trips the empty case', () => {
    const m = new LoginClusterStatus([]);
    const decoded = roundTrip(m, LoginClusterStatus);
    assertWireEqual(decoded.clusters, []);
  });
});
