/**
 * ContainerView — queryable wrapper over a `LifecycleResult` transcript that
 * answers the question "what is inside this container?"
 *
 * The data needed to build the parent→children map is spread across three
 * message types observed during zone-in:
 *
 *   - `SceneCreateObjectByName` / `SceneCreateObjectByCrc` — announces a new
 *      object's NetworkId, transform, and either its template path (ByName)
 *      or template CRC (ByCrc). We collect templateName/templateCrc here.
 *   - `BaselinesMessage` (and `BatchBaselinesMessage` envelopes) — carry the
 *      per-package state. The SHARED package of TANO/CREO/PLAY carries the
 *      object's display name, complexity, condition, etc. — but **NOT** the
 *      parent containerId (that's intentionally not a SHARED variable; the
 *      SHARED package is for publicly visible state, and containment is
 *      conceptually a separate property — `ContainedByProperty` server-side).
 *      We pull `objectName`, `nameStringId`, `complexity`, etc. from here for
 *      the `name` and `shared` fields.
 *   - `UpdateContainmentMessage` — the **only** authoritative source of
 *      parent-container info on the client side. The server sends one for
 *      every contained object during the zone-in flood (see
 *      `ServerObject_Synchronization.cpp:887` — they're emitted right next
 *      to the SceneCreateObject + BaselinesMessage events for the same id).
 *      The message carries (objectId, containerId, slotArrangement).
 *
 * We walk the transcript once, build a `Map<NetworkId, ContainerItem[]>`
 * keyed by parent containerId, then expose a small query API on top.
 *
 * The `containerView()` factory returns a snapshot — it does not subscribe
 * to future transcript appends. If the lifecycle is still running, build the
 * view AFTER it completes (typical case: inside a script body or after
 * `fullLifecycle()` resolves).
 */

import type { TangibleObjectSharedBaseline } from '../messages/game/baselines/index.js';
import { TangibleObjectSharedKind } from '../messages/game/baselines/index.js';
import { SceneCreateObjectByCrc } from '../messages/game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import { UpdateContainmentMessage } from '../messages/game/update-containment-message.js';
import type { NetworkId } from '../types.js';
import { iterBaselines } from './baseline-helpers.js';
import type { TranscriptEvent } from './dispatcher.js';

/**
 * One item inside a container, decoded from the transcript.
 *
 * Fields are best-effort: `name`/`templateName`/`shared` may be `null` if the
 * relevant message hasn't arrived yet (or was sent in a form we don't decode).
 * Consumers should never assume any field is populated beyond `networkId`.
 */
export interface ContainerItem {
  /** This item's NetworkId. */
  networkId: NetworkId;
  /** Template name from `SceneCreateObjectByName`, or `null` if only CRC is known. */
  templateName: string | null;
  /** Template CRC from either Scene* envelope, or `null` if neither was observed. */
  templateCrc: number | null;
  /** Object-type tag (TANO/CREO/etc.) from the most recent baseline; `null` if none. */
  typeId: number | null;
  /**
   * Best-effort display name. Prefers `TangibleObjectSharedBaseline.objectName`
   * (the Unicode free-text override), falls back to the `nameStringId.text`
   * lookup key. `null` if no SHARED baseline decoded.
   */
  name: string | null;
  /** Slot/arrangement id within the parent container (-1 if unknown / unslotted). */
  arrangementId: number;
  /** Other decoded SHARED-baseline fields (condition, complexity, volume, ...). */
  shared: TangibleObjectSharedBaseline | null;
}

type TranscriptSource = { transcript: TranscriptEvent[] } | TranscriptEvent[];

function eventsOf(source: TranscriptSource): TranscriptEvent[] {
  return Array.isArray(source) ? source : source.transcript;
}

/**
 * Per-object info accumulated from the transcript, before being assembled
 * into the parent → ContainerItem[] map. Tracked separately from the public
 * `ContainerItem` because the parent linkage might not exist (e.g. world
 * objects with no container) and we want to dedupe by id.
 */
interface ItemAccumulator {
  networkId: NetworkId;
  templateName: string | null;
  templateCrc: number | null;
  typeId: number | null;
  name: string | null;
  shared: TangibleObjectSharedBaseline | null;
  /** Most-recent observed parent (`null` if no UpdateContainmentMessage). */
  parent: NetworkId | null;
  /** Most-recent observed slot/arrangement (`-1` if not slotted / unknown). */
  arrangementId: number;
}

/**
 * Pick the best display name we can find from a TANO SHARED baseline. The
 * `objectName` (Unicode free-text) wins if non-empty; otherwise we fall back
 * to the `nameStringId.text` lookup key (e.g. `"survival_kit"`).
 */
function pickName(shared: TangibleObjectSharedBaseline): string | null {
  if (shared.objectName !== '') return shared.objectName;
  if (shared.nameStringId.text !== '') return shared.nameStringId.text;
  return null;
}

/**
 * Walk the transcript once and assemble per-object accumulators keyed by
 * NetworkId. Idempotent under reordering — every field uses the most-recent
 * non-null value observed.
 *
 * The Scene-create event for an object usually arrives first, then its
 * baselines, then its `UpdateContainmentMessage`. But the server is free
 * to reorder, batch, or merge — so we tolerate any order.
 */
function buildAccumulators(source: TranscriptSource): Map<NetworkId, ItemAccumulator> {
  const acc = new Map<NetworkId, ItemAccumulator>();

  const ensure = (id: NetworkId): ItemAccumulator => {
    let a = acc.get(id);
    if (a === undefined) {
      a = {
        networkId: id,
        templateName: null,
        templateCrc: null,
        typeId: null,
        name: null,
        shared: null,
        parent: null,
        arrangementId: -1,
      };
      acc.set(id, a);
    }
    return a;
  };

  // Pass 1: scene-create events → templateName / templateCrc
  for (const event of eventsOf(source)) {
    if (event.direction !== 'recv') continue;
    if (event.decoded === null) continue;
    if (event.decoded instanceof SceneCreateObjectByName) {
      const a = ensure(event.decoded.networkId);
      a.templateName = event.decoded.templateName;
    } else if (event.decoded instanceof SceneCreateObjectByCrc) {
      const a = ensure(event.decoded.networkId);
      a.templateCrc = event.decoded.templateCrc;
    } else if (event.decoded instanceof UpdateContainmentMessage) {
      const a = ensure(event.decoded.networkId);
      a.parent = event.decoded.containerId;
      a.arrangementId = event.decoded.slotArrangement;
    }
  }

  // Pass 2: baselines → typeId + (for TANO SHARED) name + shared payload
  for (const b of iterBaselines(source)) {
    const a = ensure(b.target);
    // Track typeId from any baseline observed for this object — last wins.
    a.typeId = b.typeId;
    if (b.decodedBaseline?.kind === TangibleObjectSharedKind) {
      const shared = b.decodedBaseline.data as TangibleObjectSharedBaseline;
      a.shared = shared;
      const pickedName = pickName(shared);
      if (pickedName !== null) a.name = pickedName;
    }
  }

  return acc;
}

function toItem(a: ItemAccumulator): ContainerItem {
  return {
    networkId: a.networkId,
    templateName: a.templateName,
    templateCrc: a.templateCrc,
    typeId: a.typeId,
    name: a.name,
    arrangementId: a.arrangementId,
    shared: a.shared,
  };
}

/**
 * Walk the transcript and return a `Map<NetworkId, ContainerItem[]>` keyed by
 * parent container. Useful for building multiple ContainerViews efficiently or
 * for diagnostic dumps.
 *
 * Items without a known parent (`UpdateContainmentMessage` never observed)
 * are not included in the map — they're treated as world objects.
 */
export function buildContainerIndex(source: TranscriptSource): Map<NetworkId, ContainerItem[]> {
  const acc = buildAccumulators(source);
  const byParent = new Map<NetworkId, ContainerItem[]>();
  for (const a of acc.values()) {
    if (a.parent === null) continue;
    // A "no container" parent value (0n) is conceptually the world; skip.
    if (a.parent === 0n) continue;
    let list = byParent.get(a.parent);
    if (list === undefined) {
      list = [];
      byParent.set(a.parent, list);
    }
    list.push(toItem(a));
  }
  return byParent;
}

/**
 * Queryable view over a single container's direct contents.
 *
 * `items()` returns a snapshot — mutating the returned array won't affect the
 * view, but the items themselves are shared (don't mutate them either; treat
 * everything as readonly).
 *
 * Nested containers (e.g. a backpack inside the inventory) are NOT recursed
 * automatically: build a separate ContainerView for the child container's id.
 */
export class ContainerView {
  readonly containerId: NetworkId;
  private readonly _items: ContainerItem[];

  constructor(containerId: NetworkId, items: ContainerItem[]) {
    this.containerId = containerId;
    this._items = items;
  }

  /** Items directly inside this container (NOT recursive). */
  items(): ContainerItem[] {
    return [...this._items];
  }

  /** Number of direct children. */
  size(): number {
    return this._items.length;
  }

  /** First child matching `pred`, or `null` if none. */
  findFirst(pred: (it: ContainerItem) => boolean): ContainerItem | null {
    for (const it of this._items) {
      if (pred(it)) return it;
    }
    return null;
  }

  /** All children matching `pred`, in insertion order. */
  findAll(pred: (it: ContainerItem) => boolean): ContainerItem[] {
    return this._items.filter(pred);
  }

  /**
   * Children whose `name` matches `pattern`. `pattern` is either a substring
   * (case-sensitive) or a `RegExp`. Items without a decoded name are excluded.
   */
  findByName(pattern: string | RegExp): ContainerItem[] {
    const matcher = patternToMatcher(pattern);
    return this._items.filter((it) => it.name !== null && matcher(it.name));
  }

  /**
   * Children whose `templateName` matches `pattern`. `pattern` is either a
   * substring (case-sensitive) or a `RegExp`. Items only known by CRC
   * (templateName null) are excluded.
   */
  findByTemplate(pattern: string | RegExp): ContainerItem[] {
    const matcher = patternToMatcher(pattern);
    return this._items.filter((it) => it.templateName !== null && matcher(it.templateName));
  }

  /** True iff at least one baseline named this container as its parent. */
  hasItems(): boolean {
    return this._items.length > 0;
  }
}

function patternToMatcher(pattern: string | RegExp): (s: string) => boolean {
  if (pattern instanceof RegExp) return (s) => pattern.test(s);
  return (s) => s.includes(pattern);
}

/**
 * Build a ContainerView for `containerId` from a `LifecycleResult` (or just
 * its raw transcript). Returns an empty view if no children were observed.
 */
export function containerView(source: TranscriptSource, containerId: NetworkId): ContainerView {
  const index = buildContainerIndex(source);
  const items = index.get(containerId) ?? [];
  return new ContainerView(containerId, items);
}
