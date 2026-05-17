/**
 * InventoryView — always-accessible, auto-synced view of the player's
 * inventory. Layered over `WorldModel` (which is the single source of truth
 * for object containment + baselines) so the items list always reflects the
 * latest server-pushed `UpdateContainmentMessage` / `BaselinesMessage` /
 * `DeltasMessage` / `SceneCreateObject*` / `SceneDestroyObject` traffic.
 *
 * Lifecycle:
 *   1. Constructed at zone-in with a WorldModel reference + the player's
 *      NetworkId.
 *   2. `attach()` subscribes to WorldModel `'create' | 'baseline' |
 *      'containment' | 'transform'` events. The inventory container's
 *      NetworkId is discovered via three complementary strategies, in
 *      preference order:
 *        (a) **template-name match** — the first object whose `templateName`
 *            matches `(^|/)(shared_)?character_inventory.iff$` wins. Same
 *            logic as `extractInventoryContainerId` in baseline-helpers.
 *            Reliable when the server pushes via `SceneCreateObjectByName`.
 *        (b) **SHARED-baseline nameStringId match** — current swg-server
 *            builds push player-direct children via CRC only (no template
 *            name on the wire), but each child carries a `TangibleObjectShared`
 *            baseline whose `nameStringId.text === 'inventory'` and
 *            `nameStringId.table === 'item_n'`. This is the canonical
 *            slot-name source — empirically the most reliable signal on
 *            the live cluster as of 2026-05.
 *        (c) **player-child heuristic** — last-resort fallback: among the
 *            player's direct children, pick the one with the most
 *            descendants. Empirically the inventory holds 5-12+ items
 *            while datapad/bank/mission_bag hold 0-3 — but this can
 *            misfire if the player has lots of unfilled mission slots
 *            queued. Only used when neither (a) nor (b) succeeded.
 *   3. `items` is recomputed on each access from `world.filter(o =>
 *      o.containerId === containerId)` — derived state, never duplicated.
 *   4. `detach()` unsubscribes; called at script-context teardown / logout.
 *
 * The view is purely reactive — it never sends anything. The auto-open
 * `ClientOpenContainerMessage` is fired by the game-stage orchestrator, not
 * by this class.
 */

import {
  BaselinePackageIds,
  ObjectTypeTags,
  type ResourceContainerObjectSharedBaseline,
  type TangibleObjectSharedBaseline,
} from '../messages/game/baselines/index.js';
import type { NetworkId } from '../types.js';
import type { WorldEvent, WorldModel, WorldObject } from './world-model.js';

/** Same template pattern as `extractInventoryContainerId` in baseline-helpers. */
const PLAYER_INVENTORY_TEMPLATE_PATTERN = /(^|\/)(shared_)?character_inventory\.iff$/;

/**
 * Capacity of the player inventory container (volume units). The capacity
 * is not in any baseline — `VolumeContainer.m_totalVolume` is set
 * server-side from the SHARED template's `containerVolumeLimit` field
 * (see `~/code/swg-main/dsrc/.../shared_character_inventory.tpf:21`).
 * The current Windows-client value is 80 for the inventory; expose it as
 * a constant here so the client can derive `freeSlots` without round-
 * tripping the asset.
 *
 * Override via {@link InventoryViewImpl.setTotalSlots} if a later
 * Bestine-style expansion changes this on a particular character.
 */
export const DEFAULT_PLAYER_INVENTORY_VOLUME = 80;

/**
 * Canonical slot-name signal from the TANO SHARED baseline. The inventory
 * always carries `nameStringId = { table: 'item_n', text: 'inventory' }`
 * (see `serverGame/.../CreatureObject.cpp` — the inventory is created with
 * `setObjectNameStringId(StringId("item_n", "inventory"))`).
 */
const INVENTORY_NAME_STRING_TEXT = 'inventory';
const INVENTORY_NAME_STRING_TABLE = 'item_n';

/**
 * Minimum descendant-count for a player-direct child to be pinned as the
 * inventory via the heuristic path. Empirically the inventory holds 5-12+
 * items for admin-pool reuse characters, while the datapad / bank / mission
 * bag typically hold 0-3. A threshold of 3 distinguishes them reliably.
 */
const PLAYER_CHILD_HEURISTIC_MIN_DESCENDANTS = 3;

/**
 * One item directly inside the player's inventory container.
 *
 * `templateName` / `name` may be `null` until the relevant scene-create /
 * SHARED baseline arrives — consumers should treat them as best-effort
 * hints rather than guarantees.
 */
export interface InventoryItem {
  /** This item's NetworkId. */
  readonly networkId: NetworkId;
  /** Template path from `SceneCreateObjectByName`, or `null` if only CRC is known. */
  readonly templateName: string | null;
  /**
   * Customization name from the SHARED baseline (Unicode `objectName`
   * override, else the `nameStringId.text` lookup key). `null` if no
   * SHARED baseline has been observed yet.
   */
  readonly name: string | null;
  /** Slot/arrangement id within the inventory (`-1` if unknown / unslotted). */
  readonly arrangementId: number;
  /** Container holding this item — always equals `inventoryView.containerId`. */
  readonly containerId: NetworkId;
}

/**
 * One ResourceContainerObject (RCNO) currently sitting in the player's
 * inventory. Resource crates show up in the inventory like any other item,
 * but they carry an RCNO SHARED baseline that includes the live quantity
 * + resource-type NetworkId — surface those here so callers can ask
 * "how much iron do I have?" without manually walking baselines.
 */
export interface InventoryResourceCrate {
  /** This crate's NetworkId — same as the {@link InventoryItem.networkId}. */
  readonly containerId: NetworkId;
  /** NetworkId of the underlying ResourceTypeObject. */
  readonly resourceType: NetworkId;
  /** Current units of resource stacked in this crate. */
  readonly quantity: number;
}

/**
 * Live, query-able view of the player's inventory contents. Implementation
 * is derived state over `WorldModel`; do not store a separate copy of the
 * items list — read `view.items` every time.
 */
export interface InventoryView {
  /** The inventory container's NetworkId. `null` until zone-in completes. */
  readonly containerId: NetworkId | null;
  /**
   * Live snapshot of all items in the inventory. Recomputed from the
   * WorldModel on each access — `containerId === null` ⇒ empty array.
   */
  readonly items: ReadonlyArray<InventoryItem>;
  /**
   * True once the container has been discovered AND we've observed at least
   * one inbound mutation for it (a SHARED baseline on the inventory itself,
   * a `UpdateContainmentMessage` for a child, etc.). Useful for "wait until
   * the inventory is fully populated" loops.
   */
  readonly ready: boolean;
  /**
   * Slots currently used. Counted as the number of items directly inside
   * the inventory container (each item takes one inventory slot regardless
   * of its volume — the live server enforces a per-character limit on
   * top-level inventory items, not on stacked volume).
   *
   * Equal to `items.length`.
   */
  readonly usedSlots: number;
  /**
   * Total inventory slot capacity. Defaults to
   * {@link DEFAULT_PLAYER_INVENTORY_VOLUME} (80, matching the SHARED
   * template asset). Overridable via {@link InventoryViewImpl.setTotalSlots}
   * for characters with extended capacity.
   *
   * The wire NEVER carries this value — `VolumeContainer.m_totalVolume`
   * is a server-only field set from the SHARED template's
   * `containerVolumeLimit` field.
   */
  readonly totalSlots: number;
  /** Free slots = `totalSlots - usedSlots`. Clamped at 0. */
  readonly freeSlots: number;
  /**
   * Items whose `templateName` matches `re` (case-insensitive on the
   * regex's own flags). Items only known by CRC are excluded.
   */
  findByTemplate(re: RegExp): InventoryItem[];
  /** Look up one item by exact NetworkId; `undefined` if not present. */
  findById(id: NetworkId): InventoryItem | undefined;
  /**
   * All ResourceContainerObject (RCNO) entries currently in the
   * inventory, with their live resource-type + quantity pulled from each
   * crate's RCNO SHARED baseline. Returns `[]` if none in inventory or
   * if no SHARED baselines have arrived yet.
   */
  resources(): InventoryResourceCrate[];
}

/**
 * Pick a display name from the TANO SHARED baseline. Same rule as
 * `container-view.pickName`: prefer the Unicode `objectName` override
 * when non-empty, else fall back to the `nameStringId.text` lookup key.
 */
function pickName(shared: TangibleObjectSharedBaseline): string | null {
  if (shared.objectName !== '') return shared.objectName;
  if (shared.nameStringId.text !== '') return shared.nameStringId.text;
  return null;
}

/**
 * Concrete implementation of {@link InventoryView}. Subscribes to a
 * `WorldModel` to discover the inventory container NetworkId and to flag
 * `ready` once the inventory has received at least one inbound update.
 *
 * The orchestrator constructs one per game-stage; the script context
 * exposes it as `ctx.inventory`. Call `detach()` at script teardown.
 */
/**
 * Discovery preference order — higher values win over lower. Once a higher
 * source identifies the inventory, lower sources cannot override it.
 */
const enum DiscoverySource {
  NONE = 0,
  HEURISTIC = 1,
  NAME_STRING = 2,
  TEMPLATE = 3,
  PINNED = 4,
}

export class InventoryViewImpl implements InventoryView {
  private _containerId: NetworkId | null = null;
  private discoverySource: DiscoverySource = DiscoverySource.NONE;
  private _ready = false;
  private _totalSlots: number = DEFAULT_PLAYER_INVENTORY_VOLUME;
  private unsubscribe: (() => void) | null = null;
  /**
   * NetworkIds directly contained by the player — candidates for the
   * SHARED-baseline + heuristic inventory pick. Pre-populated during
   * `attach()` and kept fresh by the containment event handler.
   */
  private readonly playerDirectChildren = new Set<NetworkId>();

  constructor(
    private readonly world: WorldModel,
    private readonly playerNetworkId: NetworkId,
  ) {}

  get containerId(): NetworkId | null {
    return this._containerId;
  }

  get ready(): boolean {
    return this._ready;
  }

  get items(): ReadonlyArray<InventoryItem> {
    if (this._containerId === null) return [];
    const containerId = this._containerId;
    const out: InventoryItem[] = [];
    for (const obj of this.world.objects()) {
      if (obj.containerId !== containerId) continue;
      out.push(this.toItem(obj, containerId));
    }
    return out;
  }

  get usedSlots(): number {
    if (this._containerId === null) return 0;
    const containerId = this._containerId;
    let count = 0;
    for (const obj of this.world.objects()) {
      if (obj.containerId === containerId) count++;
    }
    return count;
  }

  get totalSlots(): number {
    return this._totalSlots;
  }

  get freeSlots(): number {
    const free = this._totalSlots - this.usedSlots;
    return free < 0 ? 0 : free;
  }

  /**
   * Override the inventory's slot capacity. Useful when a character has
   * an extended inventory (Bestine perks, GM-issued bumps, etc.) and the
   * default {@link DEFAULT_PLAYER_INVENTORY_VOLUME} doesn't match. Set to
   * 0 to disable derived `freeSlots` calculations entirely.
   */
  setTotalSlots(slots: number): void {
    this._totalSlots = slots;
  }

  resources(): InventoryResourceCrate[] {
    if (this._containerId === null) return [];
    const containerId = this._containerId;
    const out: InventoryResourceCrate[] = [];
    for (const obj of this.world.objects()) {
      if (obj.containerId !== containerId) continue;
      // RCNO items carry a typeId tag of 'RCNO' once their first
      // baseline arrives. Pre-baseline items (typeId === 0) are
      // skipped to avoid false positives.
      if (obj.typeId !== ObjectTypeTags.RCNO) continue;
      const shared = obj.baselines.get(BaselinePackageIds.SHARED);
      if (shared === undefined || shared instanceof Uint8Array) continue;
      const rcno = shared as Partial<ResourceContainerObjectSharedBaseline>;
      if (rcno.resourceType === undefined || rcno.quantity === undefined) continue;
      out.push({
        containerId: obj.id,
        resourceType: rcno.resourceType,
        quantity: rcno.quantity,
      });
    }
    return out;
  }

  findByTemplate(re: RegExp): InventoryItem[] {
    if (this._containerId === null) return [];
    const containerId = this._containerId;
    const out: InventoryItem[] = [];
    for (const obj of this.world.objects()) {
      if (obj.containerId !== containerId) continue;
      const tpl = obj.templateName;
      if (tpl === undefined) continue;
      if (!re.test(tpl)) continue;
      out.push(this.toItem(obj, containerId));
    }
    return out;
  }

  findById(id: NetworkId): InventoryItem | undefined {
    if (this._containerId === null) return undefined;
    const obj = this.world.get(id);
    if (obj === undefined) return undefined;
    if (obj.containerId !== this._containerId) return undefined;
    return this.toItem(obj, this._containerId);
  }

  /**
   * Manually pin the inventory container id. Used in tests / when the
   * caller already knows it (e.g. from a prior session via the admin
   * console). Sets `ready` to true once the world has at least one
   * inbound for that container, and locks discovery so further events
   * don't override the pinned id.
   */
  setContainerId(id: NetworkId): void {
    this._containerId = id;
    this.discoverySource = DiscoverySource.PINNED;
    if (this.world.has(id) || this.hasAnyChild(id)) {
      this._ready = true;
    }
  }

  /**
   * Subscribe to the WorldModel and start auto-discovering the inventory
   * container. Idempotent — calling twice is a no-op.
   */
  attach(): void {
    if (this.unsubscribe !== null) return;

    // Pre-scan the world: try template-name → SHARED-baseline → heuristic.
    // Each path can override an earlier-set lower-priority pick.
    for (const obj of this.world.objects()) {
      const tpl = obj.templateName;
      if (tpl !== undefined && PLAYER_INVENTORY_TEMPLATE_PATTERN.test(tpl)) {
        this.setDiscovered(obj.id, DiscoverySource.TEMPLATE);
        break;
      }
    }
    // Pre-scan player-direct-children for the heuristic / SHARED scan.
    for (const obj of this.world.objects()) {
      if (obj.containerId === this.playerNetworkId) {
        this.playerDirectChildren.add(obj.id);
      }
    }
    if (this.discoverySource < DiscoverySource.NAME_STRING) {
      this.applyNameStringScan();
    }
    if (this.discoverySource < DiscoverySource.HEURISTIC) {
      this.applyPlayerChildHeuristic();
    }
    if (this._containerId !== null && (this.world.has(this._containerId) || this.hasAnyChild(this._containerId))) {
      this._ready = true;
    }

    this.unsubscribe = this.world.on((e) => this.onEvent(e));
  }

  /**
   * Update `_containerId` if `source` is higher-priority than what got us
   * the current id. Lower-priority sources cannot override a higher one
   * even when their candidate differs.
   */
  private setDiscovered(id: NetworkId, source: DiscoverySource): void {
    if (source <= this.discoverySource) return;
    this._containerId = id;
    this.discoverySource = source;
  }

  /** Unsubscribe from the WorldModel. Idempotent. */
  detach(): void {
    if (this.unsubscribe === null) return;
    this.unsubscribe();
    this.unsubscribe = null;
  }

  private onEvent(e: WorldEvent): void {
    // 1) Template-name discovery (highest priority among auto sources).
    if (
      this.discoverySource < DiscoverySource.TEMPLATE &&
      (e.kind === 'create' || e.kind === 'transform')
    ) {
      const tpl = e.object.templateName;
      if (tpl !== undefined && PLAYER_INVENTORY_TEMPLATE_PATTERN.test(tpl)) {
        this.setDiscovered(e.object.id, DiscoverySource.TEMPLATE);
        this._ready = true;
        return;
      }
    }

    // 2) Maintain the player-direct-children set + run the SHARED-baseline
    //    + heuristic discovery paths on each relevant event (until the
    //    template-name path wins).
    if (e.kind === 'containment') {
      if (e.containerId === this.playerNetworkId) {
        this.playerDirectChildren.add(e.object.id);
      } else if (this.playerDirectChildren.has(e.object.id)) {
        // The child moved OUT of the player's slotted container.
        this.playerDirectChildren.delete(e.object.id);
      }
    }

    // 2a) SHARED-baseline nameStringId scan. The inventory's TANO SHARED
    //     baseline has `nameStringId = {table: 'item_n', text: 'inventory'}`.
    if (this.discoverySource < DiscoverySource.NAME_STRING) {
      if (e.kind === 'baseline' && this.matchesInventoryNameString(e.data)) {
        // Only accept if this object is a direct child of the player
        // (defensive against name collisions elsewhere in the world).
        if (e.object.containerId === this.playerNetworkId) {
          this.setDiscovered(e.object.id, DiscoverySource.NAME_STRING);
        }
      } else if (e.kind === 'containment' || e.kind === 'create') {
        // A new player-direct child may already have its SHARED baseline
        // in WorldObject.baselines — re-scan when containment shifts.
        this.applyNameStringScan();
      }
    }

    // 2b) Heuristic fallback (last priority).
    if (this.discoverySource < DiscoverySource.HEURISTIC && e.kind === 'containment') {
      this.applyPlayerChildHeuristic();
    }

    if (this._containerId === null) return;
    const containerId = this._containerId;

    // 3) Flag ready on the first inbound that touches the inventory itself
    //    (baseline / scene-create for the container) or any child of it.
    if (this._ready) return;
    switch (e.kind) {
      case 'create':
      case 'baseline':
      case 'delta':
      case 'transform':
        if (e.object.id === containerId || e.object.containerId === containerId) {
          this._ready = true;
        }
        break;
      case 'containment':
        if (e.containerId === containerId || e.object.id === containerId) {
          this._ready = true;
        }
        break;
      case 'destroy':
        // Destroys never flip ready on — they only matter once we already are.
        break;
    }
  }

  /** True iff `data` is a typed TANO SHARED baseline naming the inventory slot. */
  private matchesInventoryNameString(data: unknown): boolean {
    if (data === null || data === undefined) return false;
    if (typeof data !== 'object') return false;
    if (data instanceof Uint8Array) return false;
    const candidate = data as Partial<TangibleObjectSharedBaseline>;
    if (candidate.nameStringId === undefined) return false;
    const ns = candidate.nameStringId;
    return ns.text === INVENTORY_NAME_STRING_TEXT && ns.table === INVENTORY_NAME_STRING_TABLE;
  }

  /**
   * Look for a player-direct child whose SHARED baseline names the
   * inventory slot. Idempotent — only writes when we don't yet have a
   * higher-priority discovery.
   */
  private applyNameStringScan(): void {
    if (this.discoverySource >= DiscoverySource.NAME_STRING) return;
    for (const candidate of this.playerDirectChildren) {
      const obj = this.world.get(candidate);
      if (obj === undefined) continue;
      const shared = obj.baselines.get(BaselinePackageIds.SHARED);
      if (this.matchesInventoryNameString(shared)) {
        this.setDiscovered(candidate, DiscoverySource.NAME_STRING);
        return;
      }
    }
  }

  /**
   * Heuristic: pick the player's direct child with the most descendants
   * as the inventory. Only runs when neither the template-name nor the
   * SHARED-baseline path has won.
   */
  private applyPlayerChildHeuristic(): void {
    if (this.discoverySource >= DiscoverySource.NAME_STRING) return;
    if (this._ready && this._containerId !== null && this.discoverySource >= DiscoverySource.HEURISTIC) {
      return;
    }

    let bestId: NetworkId | null = null;
    let bestCount = 0;
    for (const candidate of this.playerDirectChildren) {
      let count = 0;
      for (const obj of this.world.objects()) {
        if (obj.containerId === candidate) count++;
      }
      if (count > bestCount && count >= PLAYER_CHILD_HEURISTIC_MIN_DESCENDANTS) {
        bestCount = count;
        bestId = candidate;
      }
    }
    if (bestId !== null) {
      this.setDiscovered(bestId, DiscoverySource.HEURISTIC);
    }
  }

  private hasAnyChild(containerId: NetworkId): boolean {
    for (const obj of this.world.objects()) {
      if (obj.containerId === containerId) return true;
    }
    return false;
  }

  private toItem(obj: WorldObject, containerId: NetworkId): InventoryItem {
    const shared = obj.baselines.get(BaselinePackageIds.SHARED);
    let name: string | null = null;
    // The WorldModel stores the decoded baseline data directly (not the
    // {kind, data} wrapper) — see WorldModel.onBaseline. Only attempt to
    // read object-name fields when the value looks like a typed TANO SHARED
    // baseline.
    if (shared !== undefined && !(shared instanceof Uint8Array)) {
      const candidate = shared as TangibleObjectSharedBaseline;
      if (typeof candidate.objectName === 'string' && candidate.nameStringId !== undefined) {
        name = pickName(candidate);
      }
    }
    return {
      networkId: obj.id,
      templateName: obj.templateName ?? null,
      name,
      arrangementId: obj.slotArrangement,
      containerId,
    };
  }
}
