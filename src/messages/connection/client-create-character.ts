/**
 * ClientCreateCharacter — client-to-server. Asks the ConnectionServer to
 * create a brand-new character on the cluster.
 *
 * Wire layout (addVariable order from the C++ constructor — note this
 * does NOT match the constructor's argument order):
 *   [string]          appearanceData       (empty string for defaults)
 *   [UnicodeString]   characterName
 *   [string]          templateName         (e.g. object/creature/player/shared_human_male.iff)
 *   [string]          startingLocation     (e.g. tatooine)
 *   [string]          hairTemplateName
 *   [string]          hairAppearanceData
 *   [string]          profession           (e.g. combat_brawler)
 *   [bool]            jedi
 *   [f32]             scaleFactor          (1.0 == default)
 *   [UnicodeString]   biography
 *   [bool]            useNewbieTutorial
 *   [string]          skillTemplate
 *   [string]          workingSkill
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/ClientCentralMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import { readUnicodeString, writeUnicodeString } from '../../archive/unicode-string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('ClientCreateCharacter');

export interface ClientCreateCharacterParams {
  characterName: string;
  templateName: string;
  scaleFactor?: number;
  startingLocation: string;
  appearanceData?: string;
  hairTemplateName?: string;
  hairAppearanceData?: string;
  profession: string;
  jedi?: boolean;
  biography?: string;
  useNewbieTutorial?: boolean;
  skillTemplate?: string;
  workingSkill?: string;
}

export class ClientCreateCharacter extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + 13 fields */
  static override readonly varCount = 14;

  readonly characterName: string;
  readonly templateName: string;
  readonly scaleFactor: number;
  readonly startingLocation: string;
  readonly appearanceData: string;
  readonly hairTemplateName: string;
  readonly hairAppearanceData: string;
  readonly profession: string;
  readonly jedi: boolean;
  readonly biography: string;
  readonly useNewbieTutorial: boolean;
  readonly skillTemplate: string;
  readonly workingSkill: string;

  constructor(p: ClientCreateCharacterParams) {
    super();
    this.characterName = p.characterName;
    this.templateName = p.templateName;
    this.scaleFactor = p.scaleFactor ?? 1.0;
    this.startingLocation = p.startingLocation;
    this.appearanceData = p.appearanceData ?? '';
    this.hairTemplateName = p.hairTemplateName ?? '';
    this.hairAppearanceData = p.hairAppearanceData ?? '';
    this.profession = p.profession;
    this.jedi = p.jedi ?? false;
    this.biography = p.biography ?? '';
    this.useNewbieTutorial = p.useNewbieTutorial ?? false;
    this.skillTemplate = p.skillTemplate ?? '';
    this.workingSkill = p.workingSkill ?? '';
  }

  encodePayload(stream: IByteStream): void {
    writeStdString(stream, this.appearanceData);
    writeUnicodeString(stream, this.characterName);
    writeStdString(stream, this.templateName);
    writeStdString(stream, this.startingLocation);
    writeStdString(stream, this.hairTemplateName);
    writeStdString(stream, this.hairAppearanceData);
    writeStdString(stream, this.profession);
    stream.writeBool(this.jedi);
    stream.writeF32(this.scaleFactor);
    writeUnicodeString(stream, this.biography);
    stream.writeBool(this.useNewbieTutorial);
    writeStdString(stream, this.skillTemplate);
    writeStdString(stream, this.workingSkill);
  }

  static decodePayload(iter: IReadIterator): ClientCreateCharacter {
    const appearanceData = readStdString(iter);
    const characterName = readUnicodeString(iter);
    const templateName = readStdString(iter);
    const startingLocation = readStdString(iter);
    const hairTemplateName = readStdString(iter);
    const hairAppearanceData = readStdString(iter);
    const profession = readStdString(iter);
    const jedi = iter.readBool();
    const scaleFactor = iter.readF32();
    const biography = readUnicodeString(iter);
    const useNewbieTutorial = iter.readBool();
    const skillTemplate = readStdString(iter);
    const workingSkill = readStdString(iter);
    return new ClientCreateCharacter({
      characterName,
      templateName,
      scaleFactor,
      startingLocation,
      appearanceData,
      hairTemplateName,
      hairAppearanceData,
      profession,
      jedi,
      biography,
      useNewbieTutorial,
      skillTemplate,
      workingSkill,
    });
  }
}

export const ClientCreateCharacterDecoder = registerMessage(asDecoder(ClientCreateCharacter));
