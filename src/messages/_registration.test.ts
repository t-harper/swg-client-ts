/**
 * Sanity check that all 20 message classes load cleanly and register
 * unique constcrcs. Catches collisions early — they'd indicate either
 * a typo in messageName or a bug in our constcrc port.
 *
 * Stream B's real registry.ts will likely have an equivalent test,
 * making this one redundant after Phase 2. That's fine; remove on merge.
 */

import { describe, expect, it } from 'vitest';
import { _stubRegistry } from './_stub-base.js';
import { ClientCreateCharacterFailed } from './connection/client-create-character-failed.js';
import { ClientCreateCharacterSuccess } from './connection/client-create-character-success.js';
import { ClientCreateCharacter } from './connection/client-create-character.js';
import { ClientIdMsg } from './connection/client-id-msg.js';
import { ClientPermissionsMessage } from './connection/client-permissions-message.js';
import { EnumerateCharacterId } from './connection/enumerate-character-id.js';
import { ErrorMessage } from './connection/error-message.js';
import { GameServerForLoginMessage } from './connection/game-server-for-login.js';
import { SelectCharacter } from './connection/select-character.js';
import { StationIdHasJediSlot } from './connection/station-id-has-jedi-slot.js';
import { AttributeListMessage } from './game/attribute-list-message.js';
import { CmdSceneReady } from './game/cmd-scene-ready.js';
import { CmdStartScene } from './game/cmd-start-scene.js';
import { HeartBeat } from './game/heart-beat.js';
import { LogoutMessage } from './game/logout-message.js';
import { ObjControllerMessage } from './game/obj-controller-message.js';
import { SceneCreateObjectByCrc } from './game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from './game/scene-create-object-by-name.js';
import { SceneEndBaselines } from './game/scene-end-baselines.js';
import { UpdateTransformMessage } from './game/update-transform-message.js';

const ALL_DECODERS = [
  ClientIdMsg,
  ClientPermissionsMessage,
  StationIdHasJediSlot,
  EnumerateCharacterId,
  ClientCreateCharacter,
  ClientCreateCharacterSuccess,
  ClientCreateCharacterFailed,
  SelectCharacter,
  GameServerForLoginMessage,
  ErrorMessage,
  CmdStartScene,
  SceneCreateObjectByCrc,
  SceneCreateObjectByName,
  SceneEndBaselines,
  CmdSceneReady,
  HeartBeat,
  LogoutMessage,
  ObjControllerMessage,
  UpdateTransformMessage,
  AttributeListMessage,
];

describe('message registration', () => {
  it('exports 20 message classes', () => {
    expect(ALL_DECODERS.length).toBe(20);
  });

  it('every class has a non-empty messageName', () => {
    for (const d of ALL_DECODERS) {
      expect(d.messageName).toBeTruthy();
      expect(d.messageName.length).toBeGreaterThan(2);
    }
  });

  it('every class has a non-zero constcrc', () => {
    for (const d of ALL_DECODERS) {
      expect(d.typeCrc).toBeGreaterThan(0);
    }
  });

  it('typeCrcs are unique across all messages', () => {
    const seen = new Set<number>();
    for (const d of ALL_DECODERS) {
      expect(seen.has(d.typeCrc)).toBe(false);
      seen.add(d.typeCrc);
    }
  });

  it('all classes self-registered with the stub registry', () => {
    const reg = _stubRegistry();
    for (const d of ALL_DECODERS) {
      const found = reg.get(d.typeCrc);
      expect(found, `${d.messageName} not registered`).toBeDefined();
      expect(found?.messageName).toBe(d.messageName);
    }
  });
});
