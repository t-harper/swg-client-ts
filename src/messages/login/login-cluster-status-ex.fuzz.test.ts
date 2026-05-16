import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcStdString, fcU32, roundTrip } from '../_fuzz-helpers.js';
import { LoginClusterStatusEx, type LoginClusterStatusExData } from './login-cluster-status-ex.js';

const fcEntry = (): fc.Arbitrary<LoginClusterStatusExData> =>
  fc.record({
    clusterId: fcU32(),
    branch: fcStdString({ maxLen: 64 }),
    networkVersion: fcStdString({ maxLen: 32 }),
    version: fcU32(),
    reserved1: fcU32(),
    reserved2: fcU32(),
    reserved3: fcU32(),
    reserved4: fcU32(),
  });

describe('LoginClusterStatusEx (fuzz)', () => {
  it('round-trips arbitrary entries', () => {
    fc.assert(
      fc.property(fc.array(fcEntry(), { maxLength: 16 }), (clusters) => {
        const m = new LoginClusterStatusEx(clusters);
        const decoded = roundTrip(m, LoginClusterStatusEx);
        assertWireEqual(decoded.clusters, m.clusters);
      }),
      { numRuns: 100 },
    );
  });

  it('round-trips the empty case', () => {
    const m = new LoginClusterStatusEx([]);
    const decoded = roundTrip(m, LoginClusterStatusEx);
    assertWireEqual(decoded.clusters, []);
  });
});
