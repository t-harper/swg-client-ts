/**
 * Barrel: importing this module triggers self-registration of every chat
 * GameNetworkMessage into the singleton MessageRegistry.
 *
 * The orchestrator's `swg-client.ts` side-effect imports this so chat
 * messages can be decoded as they arrive (e.g. inbound
 * ChatInstantMessageToClient tells).
 *
 * Spatial chat (`/say`, `/shout`) is NOT a top-level GameNetworkMessage —
 * it's an ObjControllerMessage subtype (CONTROLLER_MESSAGE_SPATIAL_CHAT,
 * see MessageQueueSpatialChat in
 * /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueSpatialChat.{h,cpp}).
 * It's owned by the obj-controller per-subtype work — not duplicated here.
 */

export {
  ChatInstantMessageToCharacter,
  ChatInstantMessageToCharacterDecoder,
} from './chat-instant-message-to-character.js';
export {
  ChatInstantMessageToClient,
  ChatInstantMessageToClientDecoder,
} from './chat-instant-message-to-client.js';
export {
  ChatRequestRoomList,
  ChatRequestRoomListDecoder,
} from './chat-request-room-list.js';
export { ChatRoomList, ChatRoomListDecoder } from './chat-room-list.js';
export { ChatSendToRoom, ChatSendToRoomDecoder } from './chat-send-to-room.js';
export {
  ChatPersistentMessageToServer,
  ChatPersistentMessageToServerDecoder,
  PERSISTENT_MESSAGE_MAX_SIZE,
} from './chat-persistent-message-to-server.js';
export {
  type ChatAvatarId,
  ChatAvatarIdCodec,
  chatAvatarId,
  readChatAvatarId,
  writeChatAvatarId,
} from './chat-avatar-id.js';
export {
  type ChatRoomData,
  ChatRoomDataCodec,
  ChatRoomType,
  readChatRoomData,
  writeChatRoomData,
} from './chat-room-data.js';
