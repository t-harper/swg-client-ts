/**
 * Side-effect imports for all ObjController subtype decoders.
 *
 * Each module registers itself with `objControllerRegistry` on first load.
 * Anything that wants subtype dispatch (e.g. `obj-controller-message.ts`
 * decoding a trailer, the orchestrator pre-warming the registry) should
 * import this module — typically as a side-effect-only import:
 *
 *   import './messages/game/obj-controller/index.js';
 *
 * Adding a new subtype? Create the file under this directory and append
 * a line here.
 */

export { AttributeChangedDecoder, AttributeChangedKind } from './attribute-changed.js';
export type { AttributeChangedData } from './attribute-changed.js';
export { CombatActionDecoder, CombatActionKind } from './combat-action.js';
export type {
  CombatActionAttacker,
  CombatActionData,
  CombatActionDefender,
} from './combat-action.js';
export { CombatSpamDataType, CombatSpamDecoder, CombatSpamKind } from './combat-spam.js';
export type {
  CombatSpamData,
  CombatSpamHitDetails,
  CombatSpamMissDetails,
  StringIdValue,
} from './combat-spam.js';
export {
  CraftingExperimentDecoder,
  CraftingExperimentKind,
} from './crafting-experiment.js';
export type {
  CraftingExperimentData,
  CraftingExperimentEntry,
} from './crafting-experiment.js';
export { CraftingFinishDecoder, CraftingFinishKind } from './crafting-finish.js';
export type { CraftingFinishData } from './crafting-finish.js';
export { CraftingResultDecoder, CraftingResultKind } from './crafting-result.js';
export type { CraftingResultData } from './crafting-result.js';
export {
  CraftSelectSchematicDecoder,
  CraftSelectSchematicKind,
} from './crafting-select-schematic.js';
export type { CraftSelectSchematicData } from './crafting-select-schematic.js';
export { CraftingSlotAssignDecoder, CraftingSlotAssignKind } from './crafting-slot-assign.js';
export type { CraftingSlotAssignData } from './crafting-slot-assign.js';
export { CraftingSlotEmptyDecoder, CraftingSlotEmptyKind } from './crafting-slot-empty.js';
export type { CraftingSlotEmptyData } from './crafting-slot-empty.js';
export { CraftingStartDecoder, CraftingStartKind } from './crafting-start.js';
export type { CraftingStartData } from './crafting-start.js';
export { DefenderStatusDecoder, DefenderStatusKind } from './defender-status.js';
export type { DefenderStatusData } from './defender-status.js';
export { GroupAcceptDecoder, GroupAcceptKind } from './group-accept.js';
export type { GroupAcceptData } from './group-accept.js';
export { GroupInviteDecoder, GroupInviteKind } from './group-invite.js';
export type { GroupInviteData } from './group-invite.js';
export { MoodChangeDecoder, MoodChangeKind } from './mood-change.js';
export type { MoodChangeData } from './mood-change.js';
export {
  ObjectMenuItemFlags,
  ObjectMenuRequestDecoder,
  ObjectMenuRequestKind,
} from './object-menu-request.js';
export type { ObjectMenuData, ObjectMenuItem } from './object-menu-request.js';
export { ObjectMenuResponseDecoder, ObjectMenuResponseKind } from './object-menu-response.js';
export { PostureChangeDecoder, PostureChangeKind } from './posture-change.js';
export type { PostureChangeData } from './posture-change.js';
export {
  type DecodedSubtype,
  type ObjControllerSubtypeDecoder,
  ObjControllerSubtypeIds,
  objControllerRegistry,
  registerObjControllerSubtype,
  tryDecodeSubtype,
} from './registry.js';
export { SitOnObjectDecoder, SitOnObjectKind } from './sit-on-object.js';
export type { SitOnObjectData } from './sit-on-object.js';
export {
  makeSpatialChatData,
  SpatialChatKind,
  SpatialChatReceiveDecoder,
  SpatialChatSendDecoder,
  SpatialChatSendKind,
  SpatialChatType,
} from './spatial-chat.js';
export type { SpatialChatData } from './spatial-chat.js';
export { StartDanceDecoder, StartDanceKind } from './start-dance.js';
export type { StartDanceData } from './start-dance.js';
export { TipDecoder, TipKind } from './tip.js';
export type { TipData } from './tip.js';
export { TradeMessageId, TradeStartDecoder, TradeStartKind } from './trade-start.js';
export type { TradeStartData } from './trade-start.js';
