/**
 * Building permission updates — CM_addAllowed (403), CM_removeAllowed (404),
 * CM_addBanned (405), CM_removeBanned (406). Server → server (cross-auth).
 *
 * Sent by a non-authoritative copy of a `BuildingObject` or `CellObject` to
 * the authoritative copy when a permission grant / revocation needs to be
 * applied. The wire format is identical for all four subtypes — a single
 * `std::string` carrying the player name or `"guild:<abbrev>"` token that's
 * being added to (or removed from) the corresponding access list.
 *
 * The user-facing flow that ultimately triggers one of these wire messages is
 * the `permissionListModify` command-queue command:
 *
 *   useAbility('permissionListModify', structureOid,
 *              '<targetPlayerName> <ENTRY|BAN|ADMIN|HOPPER> <add>')
 *
 * `permissionListModify` fires the `OnPermissionListModify` script trigger
 * (see `dsrc/.../player/player_building.java:221`). That trigger calls
 * `player_structure.modify{Entry,Ban,Admin,Hopper}List`, which on a non-
 * authoritative copy of the structure forwards via these CM ids. The live
 * client never decodes these directly — we model them so transcripts of
 * cross-auth-server traffic (or local-loop server-only test rigs) decode
 * cleanly into something inspectable.
 *
 * Wire layout (trailer only — the 20-byte ObjControllerMessage header is
 * peeled off upstream):
 *   [std::string]  name        // player name OR "guild:<abbrev>"
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/BuildingObject.cpp:486-588
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CellObject.cpp:301-400
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/controller/BuildingController.cpp:32-67
 *   /home/tharper/code/swg-main/src/engine/server/library/serverNetworkMessages/src/shared/core/SetupServerNetworkMessages.cpp:1377-1380
 *     (packString / unpackString — the trailer is a single std::string)
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/GameControllerMessage.def:510-513
 *     (CM_addAllowed=403, CM_removeAllowed=404, CM_addBanned=405, CM_removeBanned=406)
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

/**
 * Shared trailer shape for all four building-permission subtypes.
 * `name` is the player display-name (e.g. `"Guild03"`) OR a guild token of
 * the form `"guild:<abbrev>"`.
 */
export interface BuildingPermissionData {
  /** Player name OR `"guild:<abbrev>"`. Bounded to 40 chars server-side. */
  name: string;
}

export const AddAllowedKind = 'AddAllowed' as const;
export const RemoveAllowedKind = 'RemoveAllowed' as const;
export const AddBannedKind = 'AddBanned' as const;
export const RemoveBannedKind = 'RemoveBanned' as const;

/**
 * `encode` / `decode` body for a single-`std::string` trailer. All four
 * subtypes share this — only the `kind` + `subtypeId` differ.
 */
function encodeName(stream: IByteStream, data: BuildingPermissionData): void {
  writeStdString(stream, data.name);
}
function decodeName(iter: IReadIterator): BuildingPermissionData {
  return { name: readStdString(iter) };
}

export const AddAllowedDecoder = registerObjControllerSubtype<BuildingPermissionData>({
  kind: AddAllowedKind,
  subtypeId: ObjControllerSubtypeIds.CM_addAllowed,
  encode: encodeName,
  decode: decodeName,
});

export const RemoveAllowedDecoder = registerObjControllerSubtype<BuildingPermissionData>({
  kind: RemoveAllowedKind,
  subtypeId: ObjControllerSubtypeIds.CM_removeAllowed,
  encode: encodeName,
  decode: decodeName,
});

export const AddBannedDecoder = registerObjControllerSubtype<BuildingPermissionData>({
  kind: AddBannedKind,
  subtypeId: ObjControllerSubtypeIds.CM_addBanned,
  encode: encodeName,
  decode: decodeName,
});

export const RemoveBannedDecoder = registerObjControllerSubtype<BuildingPermissionData>({
  kind: RemoveBannedKind,
  subtypeId: ObjControllerSubtypeIds.CM_removeBanned,
  encode: encodeName,
  decode: decodeName,
});
