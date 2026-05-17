/**
 * SurveyCache — live cache of survey results indexed by resource type.
 *
 * Subscribes to the dispatcher's inbound `SurveyMessage` stream and merges
 * each radial result into:
 *   - `lastResults` — the most recent `{ resourceType, points }` pair
 *   - `bestKnown(resourceType)` — the highest-concentration point ever seen
 *     this session for the named resource type.
 *
 * The wire-level `SurveyMessage` does NOT carry the resource type name
 * (the server assumes the client tracks in-flight state from the
 * preceding `requestsurvey` command). We therefore pair each inbound
 * `SurveyMessage` with the resource type from the most recent
 * `recordSurveyRequest(name)` call — which `ctx.survey()` invokes
 * synchronously before sending.
 *
 * Lifecycle:
 *   1. Constructed with a `MessageDispatcher`.
 *   2. `attach()` subscribes to `SurveyMessage`.
 *   3. `detach()` unsubscribes; called at script teardown / logout.
 *
 * The cache is purely reactive — it never sends anything.
 */

import { SurveyMessage, type SurveyPoint } from '../messages/game/survey/index.js';
import type { MessageDispatcher } from './dispatcher.js';

/** One survey-result entry — keyed by `resourceType` in {@link SurveyCache.bestKnown}. */
export interface BestKnownSample {
  /** World X-coordinate of the sample. */
  x: number;
  /** World Z-coordinate of the sample. */
  z: number;
  /** Density / efficiency at this point (0..1). */
  concentration: number;
}

/** Shape of `ctx.survey.lastResults` — the most recent inbound survey radial. */
export interface SurveyLastResults {
  /** Resource type name (e.g. `"Resotine"`) — matches what was passed to `ctx.survey()`. */
  resourceType: string;
  /**
   * The 9 sample points returned by the server, projected into the
   * cache's `{ x, z, concentration }` shape (y is dropped — surveys are
   * 2D over the terrain plane).
   */
  points: BestKnownSample[];
}

/**
 * Public surface exposed as `ctx.survey` (note: the `ctx.survey(toolId, ...)`
 * method is also exposed as a function — both coexist because TypeScript
 * lets a value be both a function and an object with properties).
 */
export interface SurveyCacheView {
  /** Most recent `SurveyMessage` parsed into `{ resourceType, points }`, or `null`. */
  readonly lastResults: SurveyLastResults | null;
  /**
   * Best (highest-concentration) sample ever seen this session for the
   * named resource type, or `null` if no survey for that type has arrived.
   */
  bestKnown(resourceType: string): BestKnownSample | null;
}

/**
 * Internal implementation. Tracks:
 *   - `pendingResourceType` — set by `recordSurveyRequest()`; consumed
 *     (cleared to `null`) when the next `SurveyMessage` arrives. If no
 *     pending type is set at SurveyMessage time, the result is recorded
 *     under the synthetic key `<unknown>` so it isn't lost.
 *   - `lastResults` — the most recent `{ resourceType, points }`.
 *   - `bestByType` — per-resource-type best `BestKnownSample`.
 */
export class SurveyCacheImpl implements SurveyCacheView {
  private _lastResults: SurveyLastResults | null = null;
  private readonly bestByType = new Map<string, BestKnownSample>();
  private pendingResourceType: string | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly dispatcher: MessageDispatcher) {}

  /** Subscribe to inbound `SurveyMessage` events. Idempotent. */
  attach(): void {
    if (this.unsubscribe !== null) return;
    this.unsubscribe = this.dispatcher.onMessage(SurveyMessage, (m) => this.onSurvey(m));
  }

  /** Unsubscribe from the dispatcher. Idempotent. */
  detach(): void {
    if (this.unsubscribe === null) return;
    this.unsubscribe();
    this.unsubscribe = null;
  }

  get lastResults(): SurveyLastResults | null {
    return this._lastResults;
  }

  bestKnown(resourceType: string): BestKnownSample | null {
    return this.bestByType.get(resourceType) ?? null;
  }

  /**
   * Record that `ctx.survey()` is about to issue a `requestsurvey` for
   * `resourceTypeName`. The next inbound `SurveyMessage` will be tagged
   * with this name. Each call overwrites any previously-pending name —
   * the server services surveys sequentially so this is the right model.
   */
  recordSurveyRequest(resourceTypeName: string): void {
    this.pendingResourceType = resourceTypeName;
  }

  private onSurvey(msg: SurveyMessage): void {
    const resourceType = this.pendingResourceType ?? '<unknown>';
    this.pendingResourceType = null;

    const points: BestKnownSample[] = msg.data.map((p: SurveyPoint) => ({
      x: p.location.x,
      z: p.location.z,
      concentration: p.efficiency,
    }));
    this._lastResults = { resourceType, points };

    // Update per-type best.
    let best: BestKnownSample | null = null;
    for (const p of points) {
      if (best === null || p.concentration > best.concentration) {
        best = p;
      }
    }
    if (best === null) return;
    const prior = this.bestByType.get(resourceType);
    if (prior === undefined || best.concentration > prior.concentration) {
      this.bestByType.set(resourceType, best);
    }
  }
}
