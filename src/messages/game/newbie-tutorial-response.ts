/**
 * NewbieTutorialResponse (client → server).
 *
 * One std::string payload. The Windows client sends this with response
 * `"clientReady"` immediately after `CmdSceneReady` — that triggers the
 * server's `onLoadingScreenComplete` path. Critically, `onLoadingScreenComplete`
 * resets `m_invulnerabilityTimer` from `creatureLoadInvulnerableTimeWithoutClient`
 * (120s default) to `creatureLoadInvulnerableTimeWithClient` (1s default).
 *
 * Without this message, `PlayerCreatureController::handleMove` returns false
 * for ~120 seconds after zone-in because the check is:
 *
 *   if (isTeleporting() || getCreature()->getInvulnerabilityTimer() > 0.f)
 *     return false;
 *
 * There is NO god short-circuit on that check — gods get blocked too. Admin
 * warps like `planetwarp` work because they go through `teleport()` directly
 * (not handleMove), but normal client-driven walks via CM_netUpdateTransform
 * are silently dropped.
 *
 * Wire layout:
 *   [stdString] response
 *
 * varCount = 1 (cmd) + 1 (response) = 2
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/NewbieTutorialResponse.{h,cpp}
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/core/Client.cpp:1735-1748 (server handler)
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CreatureObject.cpp:7620 (onLoadingScreenComplete)
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('NewbieTutorialResponse');

export class NewbieTutorialResponse extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  static override readonly varCount = 2;

  constructor(public readonly response: string) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeStdString(stream, this.response);
  }

  static decodePayload(iter: IReadIterator): NewbieTutorialResponse {
    return new NewbieTutorialResponse(readStdString(iter));
  }
}

export const NewbieTutorialResponseDecoder = registerMessage(asDecoder(NewbieTutorialResponse));
