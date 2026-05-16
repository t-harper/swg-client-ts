/**
 * Barrel: importing this module triggers self-registration of every survey
 * GameNetworkMessage into the singleton MessageRegistry.
 *
 * The orchestrator's `swg-client.ts` side-effect imports this so survey
 * messages can be decoded as they arrive (e.g. an inbound SurveyMessage
 * after the player triggers the survey tool's radial menu).
 *
 * Request side: there is no `RequestSurveyMessage` top-level class — the
 * survey trigger flows through the standard command queue as a
 * `requestSurvey` ability (verified in
 * /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/command/CommandCppFuncs.cpp:2761
 * and registered in
 * /home/tharper/code/swg-main/dsrc/sku.0/sys.shared/compiled/game/datatables/command/command_table.tab:927).
 * `ScriptContext.survey(resourceClass)` wraps that command for callers.
 *
 * Out of MVP scope (parked):
 *   - `MessageQueueResourceWeights` — an ObjController MessageQueue subtype
 *     (not a top-level message), carries crafting/assembly weight metadata for
 *     schematic ingredient matching. Adds non-trivial nested-pair encoding;
 *     see clientGameServer/MessageQueueResourceWeights.{h,cpp}.
 */

export {
  type ResourceListItem,
  ResourceListForSurveyMessage,
  ResourceListForSurveyMessageDecoder,
} from './resource-list-for-survey-message.js';
export {
  type SurveyPoint,
  SurveyMessage,
  SurveyMessageDecoder,
} from './survey-message.js';
