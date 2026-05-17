/**
 * BankView — always-accessible, auto-synced view of the player's bank
 * container. Mirrors {@link InventoryView} (see `inventory-view.ts`) but
 * scoped to the player's `'bank'` slot rather than `'inventory'`.
 *
 * Wire surface:
 *   - The bank container is a per-player slot child of the CreatureObject
 *     (`SlotNames::bank` == `"bank"`, see
 *     `~/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CreatureObject.cpp:471`).
 *     The container's template is `object/tangible/bank/character_bank.iff`
 *     (server-side; the SHARED form sent to the client is
 *     `object/tangible/bank/shared_character_bank.iff`).
 *   - Unlike the inventory + datapad, the live server does NOT auto-open
 *     the bank container at zone-in. The bank's contents only flow over the
 *     wire after the server-side `openBankContainer(bank, player)` JNI call
 *     fires `client->openContainer(*bankContainer, 0, "")` — this happens
 *     when the player picks the "Bank Items" sub-menu on a bank terminal's
 *     radial (see `dsrc/.../script/terminal/bank.java:81-89` →
 *     `ScriptMethodsBank.cpp:openBankContainer`).
 *   - From the wire perspective, this is functionally equivalent to a
 *     `ClientOpenContainerMessage(bankContainerId, "")` initiated by the
 *     server — but the trigger is the radial-Use on the bank terminal, NOT
 *     a client-initiated open. So `BankView.use()` fires the radial-Use
 *     (an `ObjectMenuSelectMessage(terminalId, ITEM_USE=21)`) to ask the
 *     terminal to open the SUI bank menu; from there the bank itself is
 *     opened via `ClientOpenContainerMessage(bankId, "")` if the caller
 *     wants the items list populated immediately.
 *
 * Discovery follows the same 3-tier strategy as the inventory:
 *   (a) template-name match (`(^|/)(shared_)?character_bank\.iff$`)
 *   (b) SHARED-baseline `nameStringId={item_n, bank}` on a player-direct
 *       child (the inventory uses `text='inventory'`; the bank uses
 *       `text='bank'` — set via `setObjectNameStringId(StringId("item_n","bank"))`
 *       implied by the bank template's `objectName = "item_n" "bank"`).
 *
 * Heuristic-by-descendant-count is intentionally OMITTED for the bank: the
 * bank is usually empty until the player explicitly opens it, so a count-
 * based heuristic would consistently misfire.
 */

import { ObjectMenuSelectMessage, RadialMenuTypes } from '../messages/game/object-menu-select-message.js';
import {
  BaselinePackageIds,
  type TangibleObjectSharedBaseline,
} from '../messages/game/baselines/index.js';
import type { NetworkId } from '../types.js';
import type { MessageDispatcher } from './dispatcher.js';
import type { InventoryItem } from './inventory-view.js';
import type { WorldEvent, WorldModel, WorldObject } from './world-model.js';

/** Template path pattern matching the player's bank container. */
const PLAYER_BANK_TEMPLATE_PATTERN = /(^|\/)(shared_)?character_bank\.iff$/;

/**
 * Canonical slot-name signal from the TANO SHARED baseline. The bank slot
 * carries `nameStringId = { table: 'item_n', text: 'bank' }` — derived
 * from the shared template's `objectName = "item_n" "bank"` (see
 * `~/code/swg-main/dsrc/.../shared_character_bank.tpf:10`).
 */
const BANK_NAME_STRING_TEXT = 'bank';
const BANK_NAME_STRING_TABLE = 'item_n';

/**
 * Matches templates that look like a bank TERMINAL (not the player's
 * personal bank slot). Picks up `terminal_bank.iff`, the wall / floor
 * `terminal_bank_*` furniture variants, etc.
 */
const BANK_TERMINAL_TEMPLATE_PATTERN = /bank_terminal|terminal_bank/i;

/**
 * One item directly inside the player's bank container. Same shape as
 * {@link InventoryItem} so consumers can reuse helpers that work on either.
 */
export type BankItem = InventoryItem;

/**
 * Live, query-able view of the player's bank container. The instance is
 * exposed as `ctx.bank` and stays current as long as the script context
 * is alive — `detach()` is called automatically at teardown.
 */
export interface BankView {
  /** The bank container's NetworkId. `null` until discovered. */
  readonly containerId: NetworkId | null;
  /**
   * Live snapshot of items in the bank. Empty until the server opens the
   * container in response to a {@link BankView.use} call.
   */
  readonly items: ReadonlyArray<BankItem>;
  /**
   * True once the container has been discovered AND we've observed at
   * least one inbound update for it (or any of its children).
   */
  readonly ready: boolean;
  /**
   * "Use" a bank terminal — equivalent to right-click → Use in the
   * Windows client. If `terminalId` is supplied, sends
   * `ObjectMenuSelectMessage(terminalId, ITEM_USE=21)` directly. Otherwise
   * scans `world` for the nearest object whose template path looks like a
   * bank terminal and uses that. Throws if no terminal is in scope.
   *
   * The radial Use on a bank terminal opens the server-side SUI bank menu
   * AND, once the user picks "Bank Items" sub-menu (or the script sends a
   * `ClientOpenContainerMessage(bankId, "")` directly), the server begins
   * streaming the bank container's children to the client — at which
   * point `items` becomes populated and `ready` flips to `true`.
   *
   * Returns the terminal NetworkId that was selected.
   */
  use(terminalId?: NetworkId): NetworkId;
  /**
   * Items whose `templateName` matches `re` (case-insensitive on the
   * regex's own flags). Items only known by CRC are excluded.
   */
  findByTemplate(re: RegExp): BankItem[];
  /** Look up one item by exact NetworkId; `undefined` if not present. */
  findById(id: NetworkId): BankItem | undefined;
}

/**
 * Discovery preference order — higher values win over lower. Once a
 * higher source identifies the bank, lower sources cannot override it.
 */
const enum DiscoverySource {
  NONE = 0,
  NAME_STRING = 2,
  TEMPLATE = 3,
  PINNED = 4,
}

/**
 * Pick a display name from the TANO SHARED baseline. Same rule as
 * {@link InventoryViewImpl.pickName} — `objectName` (free-text override)
 * wins, else the `nameStringId.text` lookup key, else `null`.
 */
function pickName(shared: TangibleObjectSharedBaseline): string | null {
  if (shared.objectName !== '') return shared.objectName;
  if (shared.nameStringId.text !== '') return shared.nameStringId.text;
  return null;
}

/**
 * Concrete implementation of {@link BankView}. Subscribes to a
 * {@link WorldModel} to discover the bank container NetworkId and to
 * flag `ready` once the container has received at least one inbound
 * update.
 *
 * Construction takes both the WorldModel and the dispatcher (for `use()`
 * sends). Call `attach()` after construction, `detach()` at teardown.
 */
export class BankViewImpl implements BankView {
  private _containerId: NetworkId | null = null;
  private discoverySource: DiscoverySource = DiscoverySource.NONE;
  private _ready = false;
  private unsubscribe: (() => void) | null = null;
  /**
   * NetworkIds directly contained by the player — candidates for the
   * SHARED-baseline bank pick.
   */
  private readonly playerDirectChildren = new Set<NetworkId>();

  constructor(
    private readonly world: WorldModel,
    private readonly dispatcher: MessageDispatcher,
    private readonly playerNetworkId: NetworkId,
  ) {}

  get containerId(): NetworkId | null {
    return this._containerId;
  }

  get ready(): boolean {
    return this._ready;
  }

  get items(): ReadonlyArray<BankItem> {
    if (this._containerId === null) return [];
    const containerId = this._containerId;
    const out: BankItem[] = [];
    for (const obj of this.world.objects()) {
      if (obj.containerId !== containerId) continue;
      out.push(this.toItem(obj, containerId));
    }
    return out;
  }

  findByTemplate(re: RegExp): BankItem[] {
    if (this._containerId === null) return [];
    const containerId = this._containerId;
    const out: BankItem[] = [];
    for (const obj of this.world.objects()) {
      if (obj.containerId !== containerId) continue;
      const tpl = obj.templateName;
      if (tpl === undefined) continue;
      if (!re.test(tpl)) continue;
      out.push(this.toItem(obj, containerId));
    }
    return out;
  }

  findById(id: NetworkId): BankItem | undefined {
    if (this._containerId === null) return undefined;
    const obj = this.world.get(id);
    if (obj === undefined) return undefined;
    if (obj.containerId !== this._containerId) return undefined;
    return this.toItem(obj, this._containerId);
  }

  /**
   * Manually pin the bank container id. Used by tests and by callers
   * who already know the id (e.g. discovered via the admin console).
   */
  setContainerId(id: NetworkId): void {
    this._containerId = id;
    this.discoverySource = DiscoverySource.PINNED;
    if (this.world.has(id) || this.hasAnyChild(id)) {
      this._ready = true;
    }
  }

  /**
   * Use a bank terminal. See {@link BankView.use}.
   */
  use(terminalId?: NetworkId): NetworkId {
    const id = terminalId ?? this.findNearestBankTerminal();
    if (id === null) {
      throw new Error(
        'BankView.use(): no terminalId supplied and no bank terminal found in WorldModel — ' +
          'walk closer to a bank or pass an explicit terminalId.',
      );
    }
    this.dispatcher.send(new ObjectMenuSelectMessage(id, RadialMenuTypes.ITEM_USE));
    return id;
  }

  /**
   * Subscribe to the WorldModel and start auto-discovering the bank
   * container. Idempotent — calling twice is a no-op.
   */
  attach(): void {
    if (this.unsubscribe !== null) return;

    // Pre-scan: template-name → SHARED-baseline. The bank doesn't use
    // the count-based heuristic (it's empty until the player opens it).
    for (const obj of this.world.objects()) {
      const tpl = obj.templateName;
      if (tpl !== undefined && PLAYER_BANK_TEMPLATE_PATTERN.test(tpl)) {
        this.setDiscovered(obj.id, DiscoverySource.TEMPLATE);
        break;
      }
    }
    for (const obj of this.world.objects()) {
      if (obj.containerId === this.playerNetworkId) {
        this.playerDirectChildren.add(obj.id);
      }
    }
    if (this.discoverySource < DiscoverySource.NAME_STRING) {
      this.applyNameStringScan();
    }
    if (
      this._containerId !== null &&
      (this.world.has(this._containerId) || this.hasAnyChild(this._containerId))
    ) {
      this._ready = true;
    }

    this.unsubscribe = this.world.on((e) => this.onEvent(e));
  }

  /**
   * Update `_containerId` if `source` is higher-priority than what got
   * us the current id.
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
    // 1) Template-name discovery (highest priority).
    if (
      this.discoverySource < DiscoverySource.TEMPLATE &&
      (e.kind === 'create' || e.kind === 'transform')
    ) {
      const tpl = e.object.templateName;
      if (tpl !== undefined && PLAYER_BANK_TEMPLATE_PATTERN.test(tpl)) {
        this.setDiscovered(e.object.id, DiscoverySource.TEMPLATE);
        this._ready = true;
        return;
      }
    }

    // 2) Maintain player-direct-children set + run SHARED-baseline
    //    discovery on relevant events.
    if (e.kind === 'containment') {
      if (e.containerId === this.playerNetworkId) {
        this.playerDirectChildren.add(e.object.id);
      } else if (this.playerDirectChildren.has(e.object.id)) {
        this.playerDirectChildren.delete(e.object.id);
      }
    }

    if (this.discoverySource < DiscoverySource.NAME_STRING) {
      if (e.kind === 'baseline' && this.matchesBankNameString(e.data)) {
        if (e.object.containerId === this.playerNetworkId) {
          this.setDiscovered(e.object.id, DiscoverySource.NAME_STRING);
        }
      } else if (e.kind === 'containment' || e.kind === 'create') {
        this.applyNameStringScan();
      }
    }

    if (this._containerId === null) return;
    const containerId = this._containerId;

    // 3) Flag ready on the first inbound that touches the bank itself
    //    or any of its children.
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
        break;
    }
  }

  /** True iff `data` is a typed TANO SHARED baseline naming the bank slot. */
  private matchesBankNameString(data: unknown): boolean {
    if (data === null || data === undefined) return false;
    if (typeof data !== 'object') return false;
    if (data instanceof Uint8Array) return false;
    const candidate = data as Partial<TangibleObjectSharedBaseline>;
    if (candidate.nameStringId === undefined) return false;
    const ns = candidate.nameStringId;
    return ns.text === BANK_NAME_STRING_TEXT && ns.table === BANK_NAME_STRING_TABLE;
  }

  /**
   * Look for a player-direct child whose SHARED baseline names the
   * bank slot. Idempotent.
   */
  private applyNameStringScan(): void {
    if (this.discoverySource >= DiscoverySource.NAME_STRING) return;
    for (const candidate of this.playerDirectChildren) {
      const obj = this.world.get(candidate);
      if (obj === undefined) continue;
      const shared = obj.baselines.get(BaselinePackageIds.SHARED);
      if (this.matchesBankNameString(shared)) {
        this.setDiscovered(candidate, DiscoverySource.NAME_STRING);
        return;
      }
    }
  }

  /**
   * Find the closest bank terminal in the world model. Used by
   * {@link BankView.use} when no explicit `terminalId` is supplied.
   * Returns `null` if no candidates are in scope.
   */
  private findNearestBankTerminal(): NetworkId | null {
    // Anchor on the player's last-known world position so "nearest"
    // matches what the user expects. Fall back to (0,0,0) if the
    // player's pose hasn't been tracked yet.
    const me = this.world.get(this.playerNetworkId);
    const here = me?.position ?? { x: 0, y: 0, z: 0 };
    let bestId: NetworkId | null = null;
    let bestD2 = Number.POSITIVE_INFINITY;
    for (const obj of this.world.objects()) {
      const tpl = obj.templateName;
      if (tpl === undefined) continue;
      if (!BANK_TERMINAL_TEMPLATE_PATTERN.test(tpl)) continue;
      // The character_bank slot template ALSO has "bank" in its path —
      // exclude it (it's the per-player slot, not a terminal).
      if (PLAYER_BANK_TEMPLATE_PATTERN.test(tpl)) continue;
      const dx = obj.position.x - here.x;
      const dz = obj.position.z - here.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestId = obj.id;
      }
    }
    return bestId;
  }

  private hasAnyChild(containerId: NetworkId): boolean {
    for (const obj of this.world.objects()) {
      if (obj.containerId === containerId) return true;
    }
    return false;
  }

  private toItem(obj: WorldObject, containerId: NetworkId): BankItem {
    const shared = obj.baselines.get(BaselinePackageIds.SHARED);
    let name: string | null = null;
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
