/**
 * Sanity check that all connection + game + chat message classes load cleanly
 * and register unique constcrcs. Catches collisions early — they'd indicate
 * either a typo in messageName or a bug in our constcrc port.
 *
 * Complements `registry.test.ts` (which exercises the lookup API on login
 * messages only) by enumerating every connection + game class and asserting
 * that every one of them self-registered.
 */

import { describe, expect, it } from 'vitest';
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
import { BaselinesMessage } from './game/baselines/baselines-message.js';
import { BatchBaselinesMessage } from './game/baselines/batch-baselines-message.js';
import { ChatInstantMessageToCharacter } from './game/chat/chat-instant-message-to-character.js';
import { ChatInstantMessageToClient } from './game/chat/chat-instant-message-to-client.js';
import { ChatPersistentMessageToServer } from './game/chat/chat-persistent-message-to-server.js';
import { ChatRequestRoomList } from './game/chat/chat-request-room-list.js';
import { ChatRoomList } from './game/chat/chat-room-list.js';
import { ChatSendToRoom } from './game/chat/chat-send-to-room.js';
import { CmdSceneReady } from './game/cmd-scene-ready.js';
import { CmdStartScene } from './game/cmd-start-scene.js';
import { HeartBeat } from './game/heart-beat.js';
import { LogoutMessage } from './game/logout-message.js';
import { ObjControllerMessage } from './game/obj-controller-message.js';
import { SceneCreateObjectByCrc } from './game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from './game/scene-create-object-by-name.js';
import { SceneEndBaselines } from './game/scene-end-baselines.js';
import { UpdateTransformMessage } from './game/update-transform-message.js';
import { messageRegistry } from './registry.js';

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
  BaselinesMessage,
  BatchBaselinesMessage,
  ChatInstantMessageToCharacter,
  ChatInstantMessageToClient,
  ChatRequestRoomList,
  ChatRoomList,
  ChatSendToRoom,
  ChatPersistentMessageToServer,
];

describe('message registration', () => {
  it('exports 28 message classes', () => {
    expect(ALL_DECODERS.length).toBe(28);
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

  it('all classes self-registered with the singleton registry', () => {
    for (const d of ALL_DECODERS) {
      const found = messageRegistry.getByCrc(d.typeCrc);
      expect(found, `${d.messageName} not registered`).toBeDefined();
      expect(found?.messageName).toBe(d.messageName);
    }
  });

  it('every class declares a varCount >= 1', () => {
    for (const d of ALL_DECODERS) {
      expect(d.varCount, `${d.messageName} varCount`).toBeGreaterThanOrEqual(1);
    }
  });
});
