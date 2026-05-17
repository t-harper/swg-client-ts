/**
 * ChatHandlers — predicate-filtered subscription helpers for inbound chat
 * messages.
 *
 * Each `on*` method takes a predicate (RegExp or function) plus a handler;
 * the handler fires for every matching message until the returned
 * unsubscribe fn is called.
 *
 * Three channels are wired:
 *   - `onSay`   — spatial chat from any nearby speaker. Source is the
 *                 `ObjControllerMessage(CM_spatialChatReceive=244)` decoded
 *                 subtype. Sender info comes from `decodedSubtype.data`
 *                 (`sourceId` + `sourceName`).
 *   - `onTell`  — direct messages — `ChatInstantMessageToClient`.
 *                 Sender info comes from `fromName.name`.
 *   - `onSystemMessage` — server-pushed prose (`ChatSystemMessage`).
 *                 Has no sender (`null`).
 *
 * All subscriptions registered through this helper are tracked together
 * and detached in `detach()`. The script context invokes `detach()` during
 * `runScript` cleanup so per-script subscriptions don't leak across runs.
 */

import { ChatInstantMessageToClient } from '../messages/game/chat/chat-instant-message-to-client.js';
import { ChatSystemMessage } from '../messages/game/chat/chat-system-message.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import {
  ObjControllerSubtypeIds,
  type SpatialChatData,
  SpatialChatKind,
} from '../messages/game/obj-controller/index.js';
import type { NetworkId } from '../types.js';
import type { MessageDispatcher } from './dispatcher.js';

/**
 * Identifies a chat sender by both NetworkId and display name where
 * possible. `id` is `null` when the underlying message doesn't carry a
 * NetworkId (e.g. `ChatInstantMessageToClient` is `ChatAvatarId`-keyed,
 * not NetworkId-keyed).
 */
export interface ChatSender {
  id: NetworkId | null;
  name: string;
}

/**
 * Predicate forms accepted by all `on*` methods. A `RegExp` runs against
 * the message text; a function receives the text and the sender (or
 * `null` for system messages).
 */
export type ChatPredicate<S extends ChatSender | null> =
  | RegExp
  | ((text: string, sender: S) => boolean);

/**
 * Handler signature. Receives the decoded text and the sender (where
 * meaningful).
 */
export type ChatHandler<S extends ChatSender | null> = (text: string, sender: S) => void;

/**
 * The handler surface exposed on `ctx.chat`.
 */
export interface ChatHandlers {
  /**
   * Subscribe to inbound spatial chat (`/say`, `/shout`, `/whisper` —
   * anything the server fans out to nearby observers). Fires for every
   * `ObjControllerMessage(CM_spatialChatReceive=244)` whose text matches
   * `predicate`.
   *
   * @param predicate `RegExp` matched against the text, or a `(text, sender) => boolean`.
   * @param handler   Called with the matched text and the sender.
   * @returns Unsubscribe function.
   */
  onSay(
    predicate: ChatPredicate<ChatSender>,
    handler: ChatHandler<ChatSender>,
  ): () => void;

  /**
   * Subscribe to inbound tells (`ChatInstantMessageToClient`). Fires for
   * every tell whose text matches.
   */
  onTell(
    predicate: ChatPredicate<ChatSender>,
    handler: ChatHandler<ChatSender>,
  ): () => void;

  /**
   * Subscribe to inbound system messages (`ChatSystemMessage`). Sender is
   * always `null` because system messages aren't attributed.
   */
  onSystemMessage(
    predicate: ChatPredicate<null>,
    handler: ChatHandler<null>,
  ): () => void;
}

function matches<S extends ChatSender | null>(
  predicate: ChatPredicate<S>,
  text: string,
  sender: S,
): boolean {
  if (predicate instanceof RegExp) return predicate.test(text);
  return predicate(text, sender);
}

export interface CreateChatHandlersOptions {
  dispatcher: MessageDispatcher;
}

export interface ChatHandlersHandle {
  readonly handlers: ChatHandlers;
  /** Detach every subscription registered through this helper. Idempotent. */
  detach(): void;
}

export function createChatHandlers(opts: CreateChatHandlersOptions): ChatHandlersHandle {
  const { dispatcher } = opts;
  const unsubscribers: Array<() => void> = [];

  /**
   * Wire a single subscription:
   *   - register the dispatcher listener
   *   - track the unsubscribe in the shared list
   *   - return an unsubscribe that removes from the shared list
   */
  function track(unsubscribeDispatcher: () => void): () => void {
    unsubscribers.push(unsubscribeDispatcher);
    return () => {
      const idx = unsubscribers.indexOf(unsubscribeDispatcher);
      if (idx >= 0) {
        unsubscribers.splice(idx, 1);
      }
      unsubscribeDispatcher();
    };
  }

  const handlers: ChatHandlers = {
    onSay(predicate, handler): () => void {
      const dispatcherUnsubscribe = dispatcher.onMessage(ObjControllerMessage, (m) => {
        // Inbound spatial broadcasts arrive as CM_spatialChatReceive=244
        // with a decoded SpatialChat subtype.
        if (m.message !== ObjControllerSubtypeIds.CM_spatialChatReceive) return;
        if (m.decodedSubtype?.kind !== SpatialChatKind) return;
        const data = m.decodedSubtype.data as SpatialChatData;
        const sender: ChatSender = { id: data.sourceId, name: data.sourceName };
        if (!matches(predicate, data.text, sender)) return;
        try {
          handler(data.text, sender);
        } catch {
          // user handler errors shouldn't tear down the dispatcher.
        }
      });
      return track(dispatcherUnsubscribe);
    },

    onTell(predicate, handler): () => void {
      const dispatcherUnsubscribe = dispatcher.onMessage(ChatInstantMessageToClient, (m) => {
        // ChatAvatarId carries .game/.cluster/.name (no NetworkId).
        const sender: ChatSender = { id: null, name: m.fromName.name };
        if (!matches(predicate, m.message, sender)) return;
        try {
          handler(m.message, sender);
        } catch {
          // swallow
        }
      });
      return track(dispatcherUnsubscribe);
    },

    onSystemMessage(predicate, handler): () => void {
      const dispatcherUnsubscribe = dispatcher.onMessage(ChatSystemMessage, (m) => {
        if (!matches(predicate, m.message, null)) return;
        try {
          handler(m.message, null);
        } catch {
          // swallow
        }
      });
      return track(dispatcherUnsubscribe);
    },
  };

  return {
    handlers,
    detach(): void {
      const snapshot = [...unsubscribers];
      unsubscribers.length = 0;
      for (const u of snapshot) {
        try {
          u();
        } catch {
          // swallow
        }
      }
    },
  };
}
