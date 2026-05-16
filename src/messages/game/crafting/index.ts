/**
 * Side-effect imports + named exports for the crafting wire types.
 *
 * On the wire, every crafting message is the variable-length trailer of an
 * `ObjControllerMessage` (identified by a `CM_*` controller-message id —
 * see `obj-controller/registry.ts`). The two server→client schematic-shape
 * messages (`DraftSchematics`, `ManufactureSchematic`) live in this folder
 * because they're meaningful top-level concepts in the crafting lifecycle;
 * the client→server step messages (CraftingStart, CraftingFinish,
 * CraftingSlotAssign, CraftingSlotEmpty, CraftingExperiment,
 * CraftSelectSchematic) live alongside the other subtypes under
 * `obj-controller/`.
 *
 * Side-effect importing this barrel from `swg-client.ts` registers all the
 * crafting subtype decoders so the dispatcher's ObjController trailer
 * dispatch finds them.
 */

export {
  DraftSchematicsDecoder,
  DraftSchematicsKind,
  type DraftSchematicEntry,
  type DraftSchematicsData,
} from './draft-schematics-message.js';
export {
  CraftingIngredientType,
  type CraftingIngredientTypeValue,
  ManufactureSchematicDecoder,
  ManufactureSchematicKind,
  type ManufactureSchematicData,
  type ManufactureSchematicSlot,
  type ManufactureSchematicSlotOption,
  type StringIdValue as ManufactureSchematicStringId,
} from './manufacture-schematic-message.js';
