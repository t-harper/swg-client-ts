/**
 * CraftingSessionCache — live cache of the in-flight crafting session.
 *
 * Subscribes to the dispatcher's inbound `ObjControllerMessage` stream
 * and reconstructs the active session from:
 *   - `CM_draftSchematicsMessage` (258)        — schematic list at session open
 *   - `CM_draftSlotsMessage`      (259)        — slot layout for the selected schematic
 *   - `CM_craftingResult`         (268)        — server's success/failure for steps
 *
 * The session flips active the moment a `DraftSlots` push arrives (the
 * server has instantiated the ManufactureSchematicObject at that point).
 * On a successful `CM_craftingResult` for `CM_createPrototype` (266) or
 * `CM_cancelCraftingSession` (272) the cache resets to `{active:false}`.
 *
 * Per-slot `assignedId` tracking is updated by the script context calling
 * `recordSlotAssign` / `recordSlotEmpty` from `assignCraftingSlot` /
 * `clearCraftingSlot` — the server doesn't echo per-slot state, so the
 * client mirrors its own intent.
 */

import {
  DraftSchematicsKind,
  type ManufactureSchematicData,
  ManufactureSchematicKind,
  type ManufactureSchematicSlot,
} from '../messages/game/crafting/index.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import {
  type CraftingResultData,
  CraftingResultKind,
  ObjControllerSubtypeIds,
} from '../messages/game/obj-controller/index.js';
import type { NetworkId } from '../types.js';
import type { MessageDispatcher } from './dispatcher.js';

/** One slot's name + assignment state inside an active session. */
export interface CraftingSessionSlot {
  /** Slot name (the StringId.text from the wire). */
  name: string;
  /** Optional slots can be skipped without blocking `canFinish`. */
  optional: boolean;
  /**
   * Locally-tracked ingredient assigned to this slot, or `null` if empty.
   * Updated by `recordSlotAssign`/`recordSlotEmpty` since the server
   * doesn't echo per-slot state back on the wire.
   */
  assignedId: NetworkId | null;
}

/** The "currently selected schematic" record on an active session. */
export interface CraftingSessionSchematic {
  /** ManufactureSchematicObject NetworkId (server's in-flight instance). */
  id: NetworkId;
  /**
   * The first slot's StringId.table (e.g. `craft_artisan_n`). The wire
   * doesn't carry a top-level schematic title; consumers that need a
   * proper display name should resolve it from `DraftSchematicEntry.serverCrc`
   * via their own template-name table. Empty when no slots are present.
   */
  name: string;
  slots: CraftingSessionSlot[];
}

/**
 * Discriminated union: either no session is open, or one is active.
 */
export type CraftingSessionState =
  | { active: false }
  | {
      active: true;
      schematic: CraftingSessionSchematic;
      /** Convenience mirror of `schematic.slots` — same array, same indices. */
      slots: CraftingSessionSlot[];
      /**
       * Always 0 — neither `DraftSlots` nor `CraftingResult` carry the
       * remaining-experimentation-points value. Consumers wanting the real
       * count should read the PLAYER baseline's `m_experimentPoints` via
       * the WorldModel.
       */
      experimentationPointsRemaining: number;
      /**
       * True iff every non-optional slot has an `assignedId`. The local
       * "good to call `finishCrafting`" gate — the server still validates
       * resource quality / quantity / station type on its end.
       */
      canFinish: boolean;
    };

/** Public surface exposed on `ctx.crafting`. */
export interface CraftingCacheView {
  readonly session: CraftingSessionState;
}

export class CraftingSessionCacheImpl implements CraftingCacheView {
  private current: ManufactureSchematicData | null = null;
  private slotState: Array<NetworkId | null> = [];
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly dispatcher: MessageDispatcher) {}

  /** Subscribe to inbound ObjControllerMessage stream. Idempotent. */
  attach(): void {
    if (this.unsubscribe !== null) return;
    this.unsubscribe = this.dispatcher.onMessage(ObjControllerMessage, (m) => this.onInbound(m));
  }

  /** Unsubscribe and reset session state. Idempotent. */
  detach(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.reset();
  }

  /** Force the cache back to `{ active: false }`. */
  reset(): void {
    this.current = null;
    this.slotState = [];
  }

  get session(): CraftingSessionState {
    if (this.current === null) return { active: false };
    const slots = this.buildSlots(this.current.slots);
    const canFinish = slots.every((s) => s.optional || s.assignedId !== null);
    return {
      active: true,
      schematic: {
        id: this.current.manfSchemId,
        name: this.current.slots[0]?.name.table ?? '',
        slots,
      },
      slots,
      experimentationPointsRemaining: 0,
      canFinish,
    };
  }

  /** Called by `ctx.assignCraftingSlot` after the wire send. */
  recordSlotAssign(slotIndex: number, ingredientId: NetworkId): void {
    if (this.current === null) return;
    if (slotIndex < 0 || slotIndex >= this.slotState.length) return;
    this.slotState[slotIndex] = ingredientId;
  }

  /** Called by `ctx.clearCraftingSlot` after the wire send. */
  recordSlotEmpty(slotIndex: number): void {
    if (this.current === null) return;
    if (slotIndex < 0 || slotIndex >= this.slotState.length) return;
    this.slotState[slotIndex] = null;
  }

  private onInbound(m: ObjControllerMessage): void {
    if (m.decodedSubtype === null) return;
    const kind = m.decodedSubtype.kind;
    if (kind === ManufactureSchematicKind) {
      const data = m.decodedSubtype.data as ManufactureSchematicData;
      this.current = data;
      this.slotState = data.slots.map(() => null);
      return;
    }
    // DraftSchematics carries the player's known-schematic list — does NOT
    // imply an active session by itself, so we don't touch `current` here.
    // The session becomes active when DraftSlots arrives.
    if (kind === DraftSchematicsKind) return;
    if (kind === CraftingResultKind) {
      const data = m.decodedSubtype.data as CraftingResultData;
      // CM_cancelCraftingSession = 272 (no constant in our registry).
      const finishedSession =
        data.requestId === ObjControllerSubtypeIds.CM_createPrototype ||
        data.requestId === 272;
      // Reset only on SUCCESS — failures leave the session open for retry.
      if (finishedSession && data.response > 0) this.reset();
    }
  }

  private buildSlots(rawSlots: ManufactureSchematicSlot[]): CraftingSessionSlot[] {
    return rawSlots.map((s, i) => ({
      name: s.name.text,
      optional: s.optional,
      assignedId: this.slotState[i] ?? null,
    }));
  }
}
