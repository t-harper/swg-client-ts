/**
 * NGE profession-pick wire — CM_setProfessionTemplate (1116) and
 * CM_setCurrentWorkingSkill (1115). Sent by the live Windows client when
 * the player picks a class from the `ws_professiontemplateselect` UI
 * mediator (opened by `respec.startNpcRespec` after the player clicks OK
 * on the @click_respec:respec_title confirmation prompt).
 *
 * Both subtypes share the same trailer shape: a single `std::string`.
 *
 * Wire flow on profession pick (captured 2026-05-18, Officer pick):
 *
 *     ObjControllerMessage(
 *       flags=0x2b, message=CM_setProfessionTemplate=1116,
 *       networkId=playerOid, value=0,
 *       data = std::string "officer_1a"       // 12 bytes (u16 len + 10 UTF-8)
 *     )
 *     ObjControllerMessage(
 *       flags=0x2b, message=CM_setCurrentWorkingSkill=1115,
 *       networkId=playerOid, value=0,
 *       data = std::string "class_officer_phase1_novice"   // 29 bytes
 *     )
 *
 * Server handlers:
 *   PlayerCreatureController.cpp:1722 → PlayerObject::setSkillTemplate
 *   (PlayerObject.cpp:6479) writes m_skillTemplate, fires
 *   TRIG_SKILL_TEMPLATE_CHANGED to scripts.
 *
 *   PlayerCreatureController forwards CM_setCurrentWorkingSkill to
 *   PlayerObject::setCurrentWorkingSkill.
 *
 * Source: GameControllerMessage.def:967-968,
 *   MessageQueueSelectProfessionTemplate.cpp.
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

/** Shared trailer for both CM_setProfessionTemplate and CM_setCurrentWorkingSkill. */
export interface ProfessionTemplateData {
  /**
   * The skill-template name (e.g. `"officer_1a"`) for CM_setProfessionTemplate,
   * or the starting working-skill (e.g. `"class_officer_phase1_novice"`) for
   * CM_setCurrentWorkingSkill. Names come from
   * `dsrc/.../skill_template/skill_template.tab`.
   */
  template: string;
}

export const SetProfessionTemplateKind = 'SetProfessionTemplate' as const;
export const SetCurrentWorkingSkillKind = 'SetCurrentWorkingSkill' as const;

function encodeTemplate(stream: IByteStream, data: ProfessionTemplateData): void {
  writeStdString(stream, data.template);
}
function decodeTemplate(iter: IReadIterator): ProfessionTemplateData {
  return { template: readStdString(iter) };
}

export const SetProfessionTemplateDecoder = registerObjControllerSubtype<ProfessionTemplateData>({
  kind: SetProfessionTemplateKind,
  subtypeId: ObjControllerSubtypeIds.CM_setProfessionTemplate,
  encode: encodeTemplate,
  decode: decodeTemplate,
});

export const SetCurrentWorkingSkillDecoder = registerObjControllerSubtype<ProfessionTemplateData>({
  kind: SetCurrentWorkingSkillKind,
  subtypeId: ObjControllerSubtypeIds.CM_setCurrentWorkingSkill,
  encode: encodeTemplate,
  decode: decodeTemplate,
});
