/**
 * Standalone helper to delete a character via the LoginServer wire path.
 *
 * Flow:
 *   1. Open a fresh SOE UDP socket to LoginServer.
 *   2. Send LoginClientId (LoginServer.cpp:1122 sends the avatar list back
 *      automatically — we wait for EnumerateCharacterId both to confirm
 *      the credential was accepted AND to make sure the target oid
 *      actually belongs to this account before issuing the delete).
 *   3. Send DeleteCharacterMessage(clusterId, characterId).
 *   4. Wait for DeleteCharacterReplyMessage.
 *   5. Disconnect.
 *
 * Important caveat: `rc_OK` from the reply only means LoginServer accepted
 * the request and queued an async DB task. The character continues to
 * appear in `EnumerateCharacterId` until the deletion lands server-side
 * (typically seconds, but can be longer under load — the DB task is run
 * by `TaskDeleteCharacter`). Callers that need to confirm the delete
 * actually completed should reconnect a few seconds later and re-fetch
 * the avatar list.
 *
 * Source: /home/tharper/code/swg-main/src/engine/server/application/LoginServer/src/shared/ClientConnection.cpp:125-143
 */

import type { ServerEndpoint, NetworkId, CharacterInfo } from '../types.js';
import { MessageDispatcher } from './dispatcher.js';
import { SoeConnection } from '../soe/connection.js';
import { LoginClientId } from '../messages/login/login-client-id.js';
import { EnumerateCharacterId } from '../messages/connection/enumerate-character-id.js';
import { DeleteCharacterMessage } from '../messages/login/delete-character-message.js';
import {
  DeleteCharacterReplyMessage,
  DeleteCharacterResult,
} from '../messages/login/delete-character-reply-message.js';

export interface DeleteCharacterOptions {
  /** LoginServer endpoint — same one used for normal login. */
  loginServer: ServerEndpoint;
  /** Account name (dev-mode server ignores password). */
  account: string;
  /** Optional password (dev mode ignores). */
  password?: string;
  /**
   * The character oid (from `LoginStageResult.characters[].networkId` or
   * `CharacterInfo.networkId`) to delete.
   */
  characterId: NetworkId;
  /**
   * Cluster id the character lives on. Defaults to 1 (the only cluster
   * on the swg-server reference build). LoginServer uses this to route
   * the delete to the right DB.
   */
  clusterId?: number;
  /** How long to wait for the avatar list + reply. Default 15s. */
  timeoutMs?: number;
}

export interface DeleteCharacterReply {
  /** The result code the server returned. */
  resultCode: DeleteCharacterResult;
  /** Human-readable name from the enum. */
  resultName: 'OK' | 'AlreadyInProgress' | 'ClusterDown' | `Unknown(${number})`;
  /**
   * The avatar list as it stood at the moment we received the reply —
   * the deleted character likely STILL appears here because the DB
   * deletion task hasn't run yet (see the file-level doc-comment).
   */
  avatarListAtReply: readonly CharacterInfo[];
}

function resultName(code: DeleteCharacterResult): DeleteCharacterReply['resultName'] {
  switch (code) {
    case DeleteCharacterResult.OK: return 'OK';
    case DeleteCharacterResult.AlreadyInProgress: return 'AlreadyInProgress';
    case DeleteCharacterResult.ClusterDown: return 'ClusterDown';
    default: return `Unknown(${code as number})`;
  }
}

export async function deleteCharacter(
  opts: DeleteCharacterOptions,
): Promise<DeleteCharacterReply> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const clusterId = opts.clusterId ?? 1;

  let dispatcher: MessageDispatcher | null = null;
  const connection = new SoeConnection({
    endpoint: opts.loginServer,
    onAppMessage: (payload) => {
      dispatcher?.handleAppMessage(payload);
    },
  });
  dispatcher = new MessageDispatcher({ connection, stageLabel: 'login' });

  try {
    await connection.connect();

    // Set up the avatar-list wait BEFORE sending the credential.
    const enumCharP = dispatcher.waitFor(EnumerateCharacterId, { timeoutMs });
    dispatcher.send(new LoginClientId(opts.account, opts.password ?? ''));
    const enumChar = await enumCharP;
    const avatarList = enumChar.toCharacterInfos();

    if (!avatarList.some((c) => c.networkId === opts.characterId)) {
      throw new Error(
        `Character oid ${opts.characterId.toString()} not found on account "${opts.account}" — avatar list returned ${avatarList.length} characters: [${avatarList.map((c) => `${c.name}=${c.networkId.toString()}`).join(', ')}]`,
      );
    }

    // Send the delete + wait for the reply.
    const replyP = dispatcher.waitFor(DeleteCharacterReplyMessage, { timeoutMs });
    dispatcher.send(new DeleteCharacterMessage(clusterId, opts.characterId));
    const reply = await replyP;

    return {
      resultCode: reply.resultCode,
      resultName: resultName(reply.resultCode),
      avatarListAtReply: avatarList,
    };
  } finally {
    try {
      await connection.disconnect();
    } catch {
      /* ignore — best-effort cleanup */
    }
  }
}
