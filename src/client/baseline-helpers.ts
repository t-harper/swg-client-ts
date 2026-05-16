/**
 * Helpers for extracting structured findings from a LifecycleResult's
 * `transcript` of decoded baselines. These walk the transcript looking for
 * particular kinds of decoded baseline (or scene-create-object events) and
 * return whatever the consumer is most often asking for.
 *
 * Pattern: caller passes in the `LifecycleResult` (or just its transcript)
 * and gets back a strongly-typed result. We never mutate the input.
 */

import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import { BatchBaselinesMessage } from '../messages/game/baselines/batch-baselines-message.js';
import type {
  DecodedBaseline,
  PlayerObjectSharedBaseline,
} from '../messages/game/baselines/index.js';
import { ObjectTypeTags, PlayerObjectSharedKind } from '../messages/game/baselines/index.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import type { NetworkId } from '../types.js';
import type { TranscriptEvent } from './dispatcher.js';

/** Templates we recognize for in-character containers. */
const PLAYER_INVENTORY_TEMPLATE_PATTERN = /(^|\/)(shared_)?character_inventory\.iff$/;

/**
 * What we need from the transcript-bearing thing: either a `LifecycleResult`
 * (which has `.transcript`) or a raw `TranscriptEvent[]`.
 */
type TranscriptSource = { transcript: TranscriptEvent[] } | TranscriptEvent[];

function eventsOf(source: TranscriptSource): TranscriptEvent[] {
  return Array.isArray(source) ? source : source.transcript;
}

/**
 * Yield every BaselinesMessage in the transcript, flattening any
 * BatchBaselinesMessage envelopes (the server batches baselines during
 * zone-in for efficiency).
 *
 * Exported for reuse by other transcript-walking helpers (e.g. ContainerView)
 * — keep the visibility narrow to "things inside this package" if you can.
 */
export function* iterBaselines(source: TranscriptSource): Iterable<BaselinesMessage> {
  for (const event of eventsOf(source)) {
    if (event.direction !== 'recv') continue;
    if (event.decoded === null) continue;
    if (event.decoded instanceof BaselinesMessage) {
      yield event.decoded;
    } else if (event.decoded instanceof BatchBaselinesMessage) {
      yield* event.decoded.baselines;
    }
  }
}

/**
 * Find all decoded BaselinesMessage events for a given NetworkId. Returns
 * `[ ]` if none. The result is ordered by transcript position (i.e. wire
 * arrival order).
 */
export function extractBaselinesForObject(
  source: TranscriptSource,
  networkId: NetworkId,
): BaselinesMessage[] {
  const out: BaselinesMessage[] = [];
  for (const b of iterBaselines(source)) {
    if (b.target === networkId) out.push(b);
  }
  return out;
}

/**
 * Find all decoded baselines of a given `kind` (e.g. `'PlayerObjectShared'`).
 * Returns the BaselinesMessage envelopes — caller can pull `.target` for the
 * networkId and `.decodedBaseline.data` for the typed payload.
 */
export function findBaselinesByKind(source: TranscriptSource, kind: string): BaselinesMessage[] {
  const out: BaselinesMessage[] = [];
  for (const b of iterBaselines(source)) {
    const decoded: DecodedBaseline | null = b.decodedBaseline;
    if (decoded?.kind === kind) out.push(b);
  }
  return out;
}

/**
 * Look for the first decoded `PlayerObjectShared` baseline in the transcript.
 * Returns `{ networkId, data }` or `null` if no decoded PlayerObject baseline
 * was observed.
 */
export function extractPlayerObjectBaseline(
  source: TranscriptSource,
): { networkId: NetworkId; data: PlayerObjectSharedBaseline } | null {
  const candidates = findBaselinesByKind(source, PlayerObjectSharedKind);
  const first = candidates[0];
  if (first === undefined) return null;
  if (first.decodedBaseline === null) return null;
  return {
    networkId: first.target,
    data: first.decodedBaseline.data as PlayerObjectSharedBaseline,
  };
}

/**
 * Look for the player character's inventory container.
 *
 * Strategy:
 *   1. Scan `SceneCreateObjectByName` events for the inventory shared template
 *      (`object/tangible/inventory/shared_character_inventory.iff` or the
 *      legacy server path). The earliest match is the most likely; baselines
 *      arrive paired with the create event for the same NetworkId.
 *   2. If no match by template name, return `null`. (For SceneCreateObjectByCrc
 *      we'd need to know the CRC of the inventory template — the server
 *      typically sends inventories ByName since the template is referenced by
 *      path, but if you encounter a ByCrc-only inventory you can add the CRC
 *      to the lookup table.)
 *
 * Note: this finds ANY inventory in the scene flood — for a single-player
 * scene, that's overwhelmingly the player's inventory. For shared scenes
 * with NPCs that also have inventories, the first match wins; constrain via
 * the player's NetworkId if needed (out of scope for the MVP helper).
 */
export function extractInventoryContainerId(source: TranscriptSource): NetworkId | null {
  for (const event of eventsOf(source)) {
    if (event.direction !== 'recv') continue;
    if (event.decoded === null) continue;
    if (!(event.decoded instanceof SceneCreateObjectByName)) continue;
    if (PLAYER_INVENTORY_TEMPLATE_PATTERN.test(event.decoded.templateName)) {
      return event.decoded.networkId;
    }
  }
  return null;
}

/**
 * Find every distinct NetworkId for which we observed any baseline of the
 * specified object-type tag.
 *
 * Returns the unique NetworkIds in insertion order (== first-observed order).
 */
export function networkIdsByObjectType(source: TranscriptSource, typeId: number): NetworkId[] {
  const seen = new Set<NetworkId>();
  const out: NetworkId[] = [];
  for (const b of iterBaselines(source)) {
    if (b.typeId !== typeId) continue;
    if (seen.has(b.target)) continue;
    seen.add(b.target);
    out.push(b.target);
  }
  return out;
}

/** Convenience: `networkIdsByObjectType(source, ObjectTypeTags.TANO)`. */
export function tangibleObjectIds(source: TranscriptSource): NetworkId[] {
  return networkIdsByObjectType(source, ObjectTypeTags.TANO);
}

/** Convenience: `networkIdsByObjectType(source, ObjectTypeTags.PLAY)`. */
export function playerObjectIds(source: TranscriptSource): NetworkId[] {
  return networkIdsByObjectType(source, ObjectTypeTags.PLAY);
}

/** Convenience: `networkIdsByObjectType(source, ObjectTypeTags.CREO)`. */
export function creatureObjectIds(source: TranscriptSource): NetworkId[] {
  return networkIdsByObjectType(source, ObjectTypeTags.CREO);
}
