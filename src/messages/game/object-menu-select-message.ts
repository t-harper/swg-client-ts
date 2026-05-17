/**
 * ObjectMenuSelectMessage — client → server.
 *
 * Sent when the player clicks an item in the radial menu of an object. The
 * server routes this through `Client::receiveClientMessage` (Client.cpp:1629)
 * which triggers `TRIG_OBJECT_MENU_SELECT` on the target's script object —
 * e.g. `survey_tool_script.OnObjectMenuSelect(self, player, item)`.
 *
 * Typical flow:
 *   1. Client sends `ObjControllerMessage(CM_objectMenuRequest=326)` with the
 *      target's NetworkId to ask "what's in your radial menu?"
 *   2. Server replies with `ObjControllerMessage(CM_objectMenuResponse=327)`
 *      carrying the populated `ObjectMenuItem[]`.
 *   3. User clicks an item (e.g. "Use" = ITEM_USE = 21). Client sends THIS
 *      message — a top-level GameNetworkMessage, NOT an ObjController subtype
 *      — with `targetId` = the object and `selectedItemId` = the radial item
 *      type (see `RadialMenuTypes` below for stable IDs).
 *   4. Server fires the target's `OnObjectMenuSelect` script trigger.
 *
 * Wire layout:
 *   [NetworkId (i64 LE)]  targetId       (the radial menu's object)
 *   [u16]                 selectedItemId (a menu_info_types.* int — stable
 *                                         across client/server, see RadialMenuTypes)
 *
 * Field naming note: the C++ ctor calls the first field `m_playerId` but it's
 * actually the TARGET object's NetworkId (the server reads it back as
 * `m.getNetworkId()` and uses it to look up the target — Client.cpp:1632).
 * We use the accurate name `targetId` here.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/ObjectMenuSelectMessage.cpp
 *
 * The C++ `MESSAGE_TYPE` literal is `"ObjectMenuSelectMessage::MESSAGE_TYPE"`
 * (with the `::MESSAGE_TYPE` suffix) — this is unusual but matches the C++
 * pattern verbatim, and the typeCrc is derived from that exact string.
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('ObjectMenuSelectMessage::MESSAGE_TYPE');

/**
 * Radial-menu item type IDs. The standard ones the client and server share —
 * mirror of `menu_info_types.java`. Add more as needed.
 *
 * Source:
 *   /home/tharper/code/swg-main/dsrc/sku.0/sys.server/compiled/game/script/menu_info_types.java
 */
export const RadialMenuTypes = {
  UNKNOWN: 0,
  COMBAT_TARGET: 1,
  COMBAT_ATTACK: 3,
  EXAMINE: 7,
  TRADE_START: 9,
  ITEM_PICKUP: 11,
  ITEM_EQUIP: 12,
  ITEM_UNEQUIP: 13,
  ITEM_DROP: 14,
  ITEM_DESTROY: 15,
  ITEM_OPEN: 17,
  ITEM_OPEN_NEW_WINDOW: 18,
  ITEM_ACTIVATE: 19,
  ITEM_DEACTIVATE: 20,
  /** Survey tool "Use" radial — triggers the resource-class survey UI. */
  ITEM_USE: 21,
  ITEM_USE_SELF: 22,
  ITEM_USE_OTHER: 23,
  ITEM_MAIL: 25,
  CONVERSE_START: 26,
  CRAFT_OPTIONS: 30,
  LOOT: 36,
  /**
   * "Call" on a pet control device — server fires
   * `pet_control_device.OnObjectMenuSelect(PET_CALL)` which spawns the
   * controlled pet/vehicle out of the datapad into the world. The same
   * value triggers a STORE if the pet is already out (the server toggles
   * on the called/stored state — see `pet_control_device.java:202`).
   */
  PET_CALL: 45,
  /**
   * "Store" on a pet control device. In practice the server treats `PET_CALL`
   * as a toggle so most code paths use 45 for both call and store; this is
   * the dedicated id when you want to be explicit (used in some legacy
   * radial paths that build a separate "menu_store" sub-entry).
   */
  PET_STORE: 60,
  /**
   * "Generate vehicle" — explicit radial for spawning the vehicle from its
   * datapad PCD. Functionally the same wire-effect as `PET_CALL` for
   * rideable-type PCDs (see CALLABLE_TYPE_RIDEABLE handling).
   */
  VEHICLE_GENERATE: 61,
  /** "Store vehicle" — explicit radial counterpart to `VEHICLE_GENERATE`. */
  VEHICLE_STORE: 62,
  /** "Offer ride" — passenger-invite for multi-seat vehicles. */
  VEHICLE_OFFER_RIDE: 68,
  /**
   * "Command" sub-menu root on a pet's radial. Triggers the listAllCommands
   * UI in `pet_control_device.OnObjectMenuSelect(PET_COMMAND)`.
   */
  PET_COMMAND: 224,
  /** Pet-command: follow master. Dispatch via `ObjectMenuSelectMessage(petId, PET_FOLLOW)`. */
  PET_FOLLOW: 225,
  /** Pet-command: stay at current position. */
  PET_STAY: 226,
  /** Pet-command: guard a friendly. */
  PET_GUARD: 227,
  /** Pet-command: mark a creature as friend (won't attack). */
  PET_FRIEND: 228,
  /** Pet-command: attack the master's current combat target. */
  PET_ATTACK: 229,
  /** Pet-command: patrol between learned patrol points. */
  PET_PATROL: 230,
  /** "Mount" on a pet/vehicle radial (functionally equivalent to `useAbility('mount', mountId)`). */
  SERVER_PET_MOUNT: 288,
  /** "Dismount" on a pet/vehicle radial (equivalent to `useAbility('dismount')`). */
  SERVER_PET_DISMOUNT: 289,
} as const;

export class ObjectMenuSelectMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + targetId + selectedItemId */
  static override readonly varCount = 3;

  constructor(
    /** NetworkId of the object whose radial menu the selection came from. */
    public readonly targetId: NetworkId,
    /** Radial menu item type — see `RadialMenuTypes` for stable IDs. */
    public readonly selectedItemId: number,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.targetId);
    stream.writeU16(this.selectedItemId);
  }

  static decodePayload(iter: IReadIterator): ObjectMenuSelectMessage {
    const targetId = NetworkIdCodec.decode(iter);
    const selectedItemId = iter.readU16();
    return new ObjectMenuSelectMessage(targetId, selectedItemId);
  }
}

export const ObjectMenuSelectMessageDecoder = registerMessage(asDecoder(ObjectMenuSelectMessage));
