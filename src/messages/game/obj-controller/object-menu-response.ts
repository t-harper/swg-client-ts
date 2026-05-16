/**
 * ObjectMenuResponse (CM_objectMenuResponse = 327) — server-to-client.
 *
 * Server reply to an `ObjectMenuRequest`. Carries the populated radial-menu
 * items (with localized labels). The wire format is identical to
 * `ObjectMenuRequest` — same `MessageQueueObjectMenuRequest::pack` handler
 * is registered for both ids in `MessageQueueObjectMenuRequest::install`.
 *
 * Wire layout: see `object-menu-request.ts` (identical).
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueObjectMenuRequest.cpp:27
 */

import {
  type ObjectMenuData,
  _decodeObjectMenu,
  _encodeObjectMenu,
} from './object-menu-request.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export const ObjectMenuResponseKind = 'ObjectMenuResponse' as const;

export const ObjectMenuResponseDecoder = registerObjControllerSubtype<ObjectMenuData>({
  kind: ObjectMenuResponseKind,
  subtypeId: ObjControllerSubtypeIds.CM_objectMenuResponse,
  encode: _encodeObjectMenu,
  decode: _decodeObjectMenu,
});
