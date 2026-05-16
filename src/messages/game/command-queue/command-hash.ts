/**
 * hashCommand — compute the 32-bit constcrc of an ability/command name.
 *
 * Combat / posture / social ability names are short lowercase strings
 * ("attack", "prone", "crouch", "berserk1", etc.). The wire field on
 * MessageQueueCommandQueueEnqueue is the constcrc of the name with case
 * folded to lowercase (the server's CommandTable lookup is case-insensitive
 * but the hash is computed against the lowercase form).
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/command/CommandTable.cpp
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedFoundation/include/public/sharedFoundation/CrcConstexpr.hpp
 */

import { constcrc } from '../../../crc/constcrc.js';

export function hashCommand(name: string): number {
  return constcrc(name.toLowerCase());
}
