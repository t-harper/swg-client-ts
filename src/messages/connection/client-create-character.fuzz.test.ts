import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  assertWireEqual,
  fcF32,
  fcStdString,
  fcUnicodeString,
  roundTrip,
} from '../_fuzz-helpers.js';
import { ClientCreateCharacter } from './client-create-character.js';

describe('ClientCreateCharacter (fuzz)', () => {
  it('round-trips arbitrary character-creation params', () => {
    fc.assert(
      fc.property(
        fc.record({
          characterName: fcUnicodeString({ maxLen: 32 }),
          templateName: fcStdString({ maxLen: 128 }),
          scaleFactor: fcF32(),
          startingLocation: fcStdString({ maxLen: 32 }),
          appearanceData: fcStdString({ maxLen: 64 }),
          hairTemplateName: fcStdString({ maxLen: 128 }),
          hairAppearanceData: fcStdString({ maxLen: 64 }),
          profession: fcStdString({ maxLen: 32 }),
          jedi: fc.boolean(),
          biography: fcUnicodeString({ maxLen: 128 }),
          useNewbieTutorial: fc.boolean(),
          skillTemplate: fcStdString({ maxLen: 32 }),
          workingSkill: fcStdString({ maxLen: 32 }),
        }),
        (params) => {
          const m = new ClientCreateCharacter(params);
          const decoded = roundTrip(m, ClientCreateCharacter);
          assertWireEqual(
            {
              characterName: decoded.characterName,
              templateName: decoded.templateName,
              scaleFactor: decoded.scaleFactor,
              startingLocation: decoded.startingLocation,
              appearanceData: decoded.appearanceData,
              hairTemplateName: decoded.hairTemplateName,
              hairAppearanceData: decoded.hairAppearanceData,
              profession: decoded.profession,
              jedi: decoded.jedi,
              biography: decoded.biography,
              useNewbieTutorial: decoded.useNewbieTutorial,
              skillTemplate: decoded.skillTemplate,
              workingSkill: decoded.workingSkill,
            },
            {
              characterName: m.characterName,
              templateName: m.templateName,
              scaleFactor: m.scaleFactor,
              startingLocation: m.startingLocation,
              appearanceData: m.appearanceData,
              hairTemplateName: m.hairTemplateName,
              hairAppearanceData: m.hairAppearanceData,
              profession: m.profession,
              jedi: m.jedi,
              biography: m.biography,
              useNewbieTutorial: m.useNewbieTutorial,
              skillTemplate: m.skillTemplate,
              workingSkill: m.workingSkill,
            },
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
