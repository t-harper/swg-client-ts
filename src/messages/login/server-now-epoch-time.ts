/**
 * ServerNowEpochTime — INBOUND (server → client)
 *
 * Tells the client what time the server thinks it is (Unix epoch seconds).
 * Sent early in the login handshake; useful for time-sync hints and as
 * a sanity check that wire framing is working.
 *
 * Source: GenericValueTypeMessage<int32> instantiated with the name
 * "ServerNowEpochTime". Search the server tree for the call site:
 *
 *   ServerNowEpochTime const msg(static_cast<int32>(time(nullptr)));
 *   client->send(msg, true);
 *
 * Wire layout (per GenericValueTypeMessage's single AutoVariable<T>):
 *   value : int32 LE
 */

import { defineGenericValueTypeMessage } from '../base.js';
import { I32 } from '../../archive/primitives.js';
import { registerMessage } from '../registry.js';

const def = defineGenericValueTypeMessage<number>('ServerNowEpochTime', I32);

export const ServerNowEpochTime = def.Message;
export const ServerNowEpochTimeDecoder = registerMessage(def.decoder);
