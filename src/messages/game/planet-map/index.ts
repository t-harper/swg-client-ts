/**
 * Barrel: importing this module triggers self-registration of the
 * planetary-map-locations GameNetworkMessages into the singleton
 * MessageRegistry.
 *
 * The orchestrator's `swg-client.ts` side-effect imports this so the
 * server→client `GetMapLocationsResponseMessage` can be decoded as it
 * arrives (the response to a `GetMapLocationsMessage` the `ctx.map`
 * helpers send post-zone-in).
 *
 * Wire flow:
 *   1. `GetMapLocationsMessage(planet, 0, 0, 0)` (client → server) — the
 *      planet-map cache sends this once per planet, post-zone-in.
 *   2. `GetMapLocationsResponseMessage` (server → client) — the full set
 *      of registered locations on the planet, split into static / dynamic
 *      / persist arrays of `MapLocation`.
 */

export {
  type MapLocation,
  MapLocationCodec,
  MapLocationFlags,
} from './map-location.js';
export {
  GetMapLocationsMessage,
  GetMapLocationsMessageDecoder,
} from './get-map-locations-message.js';
export {
  GetMapLocationsResponseMessage,
  GetMapLocationsResponseMessageDecoder,
} from './get-map-locations-response-message.js';
