/**
 * Barrel: importing this module triggers self-registration of every mission
 * message into its appropriate registry.
 *
 * Two registries are involved:
 *
 *   1. `messageRegistry` (GameNetworkMessage layer) — receives
 *      `PopulateMissionBrowserMessage`, the only true top-level mission
 *      message. The actual list of missions is delivered as a payload of
 *      NetworkIds; the mission DATA (title, reward, location, etc.) arrives
 *      separately as `MissionObject` SHARED baselines into the player's
 *      invisible mission bag — see `../baselines/mission-object-baseline-3.ts`.
 *
 *   2. `objControllerRegistry` (ObjController subtype layer) — receives the
 *      request/response message-queue subtypes that drive the mission flow:
 *      `MissionListRequest` (CM=245), `MissionAcceptRequest` /
 *      `MissionRemoveRequest` (CM=249/251) and their responses (CM=250/252/256),
 *      plus `MissionAbort` (CM=322).
 *
 * Side-effect-import this barrel from places that want the mission decoders
 * loaded (e.g. `swg-client.ts`):
 *
 *   import './messages/game/missions/index.js';
 *
 * Out of MVP scope (parked):
 *   - `MissionListResponse` (CM=246): wire shape is
 *     `AutoArray<MessageQueueMissionListResponseData>` where each entry is
 *     ~15 fields (StringIds + Unicode::Strings + planet/region names).
 *     Modern servers populate the mission browser via SHARED baselines plus
 *     `PopulateMissionBrowserMessage`; the per-mission response data largely
 *     duplicates what the baselines carry. Skipped to keep the scope of
 *     this work focused on the wire path actually exercised by acceptance.
 *   - `MissionDetailsResponse` (CM=248): even larger struct
 *     (`MessageQueueMissionDetailsResponseData` has 17 fields, several of
 *     which are nested `TokenData` structures). Same rationale as above.
 *   - `MessageQueueMissionCreateRequest`: used by the in-game mission-creation
 *     UI; not part of the accept/abort flow this client targets.
 *   - `ChangeMissionObjectiveMessage`: does not exist in this branch of the
 *     C++ source. Objective changes are delivered as deltas on the
 *     `MissionObject` baseline (the `m_status` AutoDeltaVariable in the
 *     SHARED package).
 */

export {
  type MissionAbortData,
  MissionAbortDecoder,
  MissionAbortKind,
} from './mission-abort.js';
export {
  type MissionGenericRequestData,
  MissionAcceptRequestDecoder,
  MissionAcceptRequestKind,
  MissionRemoveRequestDecoder,
  MissionRemoveRequestKind,
} from './mission-generic-request.js';
export {
  type MissionGenericResponseData,
  MissionAcceptResponseDecoder,
  MissionAcceptResponseKind,
  MissionCreateResponseDecoder,
  MissionCreateResponseKind,
  MissionRemoveResponseDecoder,
  MissionRemoveResponseKind,
} from './mission-generic-response.js';
export {
  type MissionListRequestData,
  MissionListRequestDecoder,
  MissionListRequestFlags,
  MissionListRequestKind,
} from './mission-list-request.js';
export {
  PopulateMissionBrowserMessage,
  PopulateMissionBrowserMessageDecoder,
} from './populate-mission-browser-message.js';
