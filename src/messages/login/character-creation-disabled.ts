/**
 * CharacterCreationDisabled — INBOUND (LoginServer → client)
 *
 * Server tells the client which character-class / profession strings are
 * currently disabled for creation. The payload is `std::set<std::string>`,
 * which on the wire is `int32 LE count + N std::string`.
 *
 * Source: GenericValueTypeMessage<std::set<std::string>> instantiated
 * with the name "CharacterCreationDisabled".
 *
 * Wire layout:
 *   value : std::set<std::string> = int32 LE count + N std::string
 */

import { defineGenericValueTypeMessage } from '../base.js';
import { SetCodec } from '../../archive/containers.js';
import { StringCodec } from '../../archive/string.js';
import { registerMessage } from '../registry.js';

const def = defineGenericValueTypeMessage<Set<string>>('CharacterCreationDisabled', SetCodec(StringCodec));

export const CharacterCreationDisabled = def.Message;
export const CharacterCreationDisabledDecoder = registerMessage(def.decoder);
