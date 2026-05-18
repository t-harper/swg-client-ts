/**
 * Travel-system message classes.
 *
 * The ticket-purchase wire flow consists of:
 *   1. `ObjectMenuSelectMessage(terminal, ITEM_USE=21)` (client → server,
 *      reuses the generic radial-menu message — not in this dir).
 *   2. `EnterTicketPurchaseModeMessage` (server → client) — enters the
 *      hard-coded ticket-purchase UI scoped to the terminal's planet/point.
 *   3. `PlanetTravelPointListRequest` (client → server) — one per
 *      destination planet the client wants to populate.
 *   4. `PlanetTravelPointListResponse` (server → client) — parallel arrays
 *      of (name, position, cost, isInterplanetary).
 *   5. `purchaseTicket` command (client → server, via the regular
 *      command-queue / `useAbility`) — params:
 *      `"<planet1> <point1> <planet2> <point2> <roundtrip> <instant>"`,
 *      with spaces in point names encoded as `_` (server applies
 *      `underscoreToSpace` in CommandCppFuncs.cpp:5466).
 *   6. The server-side script (`travel.purchaseTicket`) debits credits +
 *      creates a `travel_ticket` tangible item in the player's inventory.
 *   7. Use is `boardShuttle` command (CRC 1573732770) with `targetId =
 *      shuttleNetworkId`, `params = <ticketId-as-string>` — sent only when
 *      the player is within boarding range of a shuttle whose departure
 *      point matches the ticket. Server fires `CmdStartScene` for the
 *      destination scene.
 */

export {
  EnterTicketPurchaseModeMessage,
  EnterTicketPurchaseModeMessageDecoder,
} from './enter-ticket-purchase-mode-message.js';
export {
  PlanetTravelPointListRequest,
  PlanetTravelPointListRequestDecoder,
} from './planet-travel-point-list-request.js';
export {
  PlanetTravelPointListResponse,
  PlanetTravelPointListResponseDecoder,
} from './planet-travel-point-list-response.js';
