/**
 * Unit tests for SurveyCacheImpl + the `ctx.survey.*` hybrid surface.
 */
import { describe, expect, it } from 'vitest';

import { SurveyMessage } from '../messages/game/survey/index.js';
import { createFakeContext } from './script/test-helpers.js';
import { SurveyCacheImpl } from './survey-cache.js';

describe('SurveyCacheImpl', () => {
  it('captures the most recent SurveyMessage as lastResults', () => {
    const { ctx, simulateRecv } = createFakeContext();
    // Tag the next inbound with a resource name (mirrors what ctx.survey does).
    ctx.survey(0x123n, 'Resotine');
    simulateRecv(
      new SurveyMessage([
        { location: { x: 1, y: 0, z: 2 }, efficiency: 0.5 },
        { location: { x: 3, y: 0, z: 4 }, efficiency: 0.9 },
      ]),
    );
    expect(ctx.survey.lastResults).not.toBeNull();
    expect(ctx.survey.lastResults?.resourceType).toBe('Resotine');
    expect(ctx.survey.lastResults?.points).toHaveLength(2);
    expect(ctx.survey.lastResults?.points[0]).toEqual({ x: 1, z: 2, concentration: 0.5 });
  });

  it('bestKnown returns the highest-concentration sample per resource type', () => {
    const { ctx, simulateRecv } = createFakeContext();
    ctx.survey(0x123n, 'Resotine');
    simulateRecv(
      new SurveyMessage([
        { location: { x: 10, y: 0, z: 20 }, efficiency: 0.3 },
        { location: { x: 30, y: 0, z: 40 }, efficiency: 0.7 },
      ]),
    );
    const best = ctx.survey.bestKnown('Resotine');
    expect(best).not.toBeNull();
    expect(best?.concentration).toBeCloseTo(0.7, 5);
    expect(best?.x).toBe(30);
    expect(best?.z).toBe(40);
  });

  it('bestKnown remembers the best across multiple surveys of the same type', () => {
    const { ctx, simulateRecv } = createFakeContext();
    // First survey — peak 0.6
    ctx.survey(0x123n, 'Yponaco');
    simulateRecv(
      new SurveyMessage([
        { location: { x: 1, y: 0, z: 1 }, efficiency: 0.6 },
        { location: { x: 2, y: 0, z: 2 }, efficiency: 0.5 },
      ]),
    );
    // Second survey — peak 0.4 (lower); should NOT replace.
    ctx.survey(0x123n, 'Yponaco');
    simulateRecv(
      new SurveyMessage([
        { location: { x: 10, y: 0, z: 10 }, efficiency: 0.4 },
      ]),
    );
    const best = ctx.survey.bestKnown('Yponaco');
    expect(best?.concentration).toBeCloseTo(0.6, 5);
    expect(best?.x).toBe(1);

    // Third survey — peak 0.9; SHOULD replace.
    ctx.survey(0x123n, 'Yponaco');
    simulateRecv(
      new SurveyMessage([
        { location: { x: 100, y: 0, z: 100 }, efficiency: 0.9 },
      ]),
    );
    const best2 = ctx.survey.bestKnown('Yponaco');
    expect(best2?.concentration).toBeCloseTo(0.9, 5);
    expect(best2?.x).toBe(100);
  });

  it('bestKnown returns null for unknown resource types', () => {
    const { ctx } = createFakeContext();
    expect(ctx.survey.bestKnown('NeverHeardOfIt')).toBeNull();
  });

  it('lastResults is null before any SurveyMessage arrives', () => {
    const { ctx } = createFakeContext();
    expect(ctx.survey.lastResults).toBeNull();
  });

  it('survey() still returns a command-queue sequence id (legacy behavior preserved)', () => {
    const { ctx } = createFakeContext();
    const seq = ctx.survey(0x456n, 'Mustafarian_Inert_Iron');
    expect(typeof seq).toBe('number');
    expect(seq).toBeGreaterThanOrEqual(1);
  });

  it('SurveyCacheImpl detaches cleanly', () => {
    // Use the direct class (not via ctx) so we can call detach/attach explicitly.
    const { ctx, simulateRecv } = createFakeContext();
    const cache = new SurveyCacheImpl(ctx.dispatcher);
    cache.attach();
    cache.recordSurveyRequest('Iron');
    simulateRecv(
      new SurveyMessage([{ location: { x: 5, y: 0, z: 5 }, efficiency: 0.8 }]),
    );
    expect(cache.lastResults?.resourceType).toBe('Iron');
    cache.detach();
    // After detach, new inbound messages should NOT update the cache.
    simulateRecv(
      new SurveyMessage([{ location: { x: 99, y: 0, z: 99 }, efficiency: 0.99 }]),
    );
    expect(cache.lastResults?.points[0]?.x).toBe(5); // unchanged from pre-detach
  });

  it('records resource name "<unknown>" when no preceding ctx.survey() tag is set', () => {
    const { ctx, simulateRecv } = createFakeContext();
    // Don't call ctx.survey() — simulate an unsolicited SurveyMessage.
    simulateRecv(
      new SurveyMessage([{ location: { x: 0, y: 0, z: 0 }, efficiency: 1.0 }]),
    );
    expect(ctx.survey.lastResults?.resourceType).toBe('<unknown>');
  });
});
