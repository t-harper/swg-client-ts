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
