import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcNetworkId, fcU32, roundTrip } from '../_fuzz-helpers.js';
import { GameServerForLoginMessage } from './game-server-for-login.js';

describe('GameServerForLoginMessage (fuzz)', () => {
  it('round-trips arbitrary (stationId, server, characterId) triples', () => {
    fc.assert(
      fc.property(fcU32(), fcU32(), fcNetworkId(), (stationId, server, characterId) => {
        const m = new GameServerForLoginMessage(stationId, server, characterId);
        const decoded = roundTrip(m, GameServerForLoginMessage);
        assertWireEqual(
          {
            stationId: decoded.stationId,
            server: decoded.server,
            characterId: decoded.characterId,
          },
          { stationId: m.stationId, server: m.server, characterId: m.characterId },
        );
      }),
      { numRuns: 200 },
    );
  });
});
