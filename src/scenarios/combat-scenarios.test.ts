/**
 * Unit tests for the combat-related bundled scenarios. Movement scenarios
 * (`walk-line`, `walk-circle`, `open-inventory`, `dwell`) have their own
 * coverage via the existing context.test.ts paths.
 */

import { describe, expect, it } from 'vitest';
import { ReadIterator } from '../archive/read-iterator.js';
import { runScript } from '../client/script/context.js';
import { createFakeContext } from '../client/script/test-helpers.js';
import {
  CM_COMMAND_QUEUE_ENQUEUE,
  CommandQueueEnqueue,
  hashCommand,
} from '../messages/game/command-queue/index.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import { scenarios } from './index.js';

describe('combat-attack scenario', () => {
  it('throws if targetId is missing', () => {
    const factory = scenarios['combat-attack'];
    if (!factory) throw new Error('combat-attack not registered');
    expect(() => factory({})).toThrow(/targetId/);
  });

  it('throws if targetId is unparseable', () => {
    const factory = scenarios['combat-attack'];
    if (!factory) throw new Error('combat-attack not registered');
    expect(() => factory({ targetId: 'not-a-number' })).toThrow(/NetworkId/);
  });

  it('accepts a hex NetworkId', () => {
    const factory = scenarios['combat-attack'];
    if (!factory) throw new Error('combat-attack not registered');
    expect(() => factory({ targetId: '0x42' })).not.toThrow();
  });

  it('accepts a decimal NetworkId', () => {
    const factory = scenarios['combat-attack'];
    if (!factory) throw new Error('combat-attack not registered');
    expect(() => factory({ targetId: '12345' })).not.toThrow();
  });

  it('sends ~one attack per tick (~2 attacks over durationMs=2000, tickMs=1000)', async () => {
    const factory = scenarios['combat-attack'];
    if (!factory) throw new Error('combat-attack not registered');
    const fn = factory({ targetId: '0x42', durationMs: '2000', tickMs: '1000' });
    const { ctx, sent } = createFakeContext();
    const result = await runScript(fn, ctx);
    expect(result.error).toBeUndefined();
    // Pattern: immediate enqueue, then wait(1000), enqueue. The third enqueue
    // would need wait(1000) more (deadline already past), so we get exactly 2.
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.length).toBeLessThanOrEqual(3);
    // Every send is an ObjControllerMessage wrapping a CommandQueueEnqueue
    // with commandHash == hashCommand('attack') and targetId == 0x42n.
    for (const m of sent) {
      expect(m).toBeInstanceOf(ObjControllerMessage);
      const obj = m as ObjControllerMessage;
      expect(obj.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
      const inner = CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
      expect(inner.commandHash).toBe(hashCommand('attack'));
      expect(inner.targetId).toBe(0x42n);
    }
  });

  it('uses monotonically-increasing sequence ids across the attack stream', async () => {
    const factory = scenarios['combat-attack'];
    if (!factory) throw new Error('combat-attack not registered');
    const fn = factory({ targetId: '7', durationMs: '2000', tickMs: '500' });
    const { ctx, sent } = createFakeContext();
    await runScript(fn, ctx);
    const seqs = sent.map((m) => {
      const inner = CommandQueueEnqueue.unpack(new ReadIterator((m as ObjControllerMessage).data));
      return inner.sequenceId;
    });
    for (let i = 1; i < seqs.length; i++) {
      const prev = seqs[i - 1];
      const cur = seqs[i];
      if (prev === undefined || cur === undefined) throw new Error('seq undefined');
      expect(cur).toBeGreaterThan(prev);
    }
  });

  it('rejects tickMs <= 0', () => {
    const factory = scenarios['combat-attack'];
    if (!factory) throw new Error('combat-attack not registered');
    expect(() => factory({ targetId: '1', tickMs: '0' })).toThrow(/tickMs/);
    expect(() => factory({ targetId: '1', tickMs: '-100' })).toThrow(/tickMs/);
  });
});

describe('posture-cycle scenario', () => {
  it('is registered with the expected name', () => {
    expect(scenarios['posture-cycle']).toBeDefined();
  });

  it('cycles standing → crouched → prone → standing', async () => {
    const factory = scenarios['posture-cycle'];
    if (!factory) throw new Error('posture-cycle not registered');
    const fn = factory({ durationMs: '3000', tickMs: '1000' });
    const { ctx, sent } = createFakeContext();
    const result = await runScript(fn, ctx);
    expect(result.error).toBeUndefined();
    // Immediate posture + 3 waits — bumps deadline-check; expect 3 or 4 sends.
    expect(sent.length).toBeGreaterThanOrEqual(3);
    const commandsInOrder = sent.map((m) => {
      const inner = CommandQueueEnqueue.unpack(new ReadIterator((m as ObjControllerMessage).data));
      return inner.commandHash;
    });
    // First three should be stand, crouch, prone (in that order).
    expect(commandsInOrder[0]).toBe(hashCommand('stand'));
    expect(commandsInOrder[1]).toBe(hashCommand('crouch'));
    expect(commandsInOrder[2]).toBe(hashCommand('prone'));
  });

  it('rejects tickMs <= 0', () => {
    const factory = scenarios['posture-cycle'];
    if (!factory) throw new Error('posture-cycle not registered');
    expect(() => factory({ tickMs: '0' })).toThrow(/tickMs/);
  });
});

describe('survey scenario', () => {
  it('is registered under the name "survey"', () => {
    expect(scenarios.survey).toBeDefined();
  });

  it('defaults to resourceClass="mineral" and emits one ObjController wrapping requestSurvey', async () => {
    const factory = scenarios.survey;
    if (!factory) throw new Error('survey not registered');
    // Tiny waitMs so the test doesn't actually idle.
    const fn = factory({ waitMs: '0' });
    const { ctx, sent } = createFakeContext();
    const result = await runScript(fn, ctx);
    expect(result.error).toBeUndefined();
    expect(sent.length).toBe(1);
    const obj = sent[0] as ObjControllerMessage;
    expect(obj).toBeInstanceOf(ObjControllerMessage);
    expect(obj.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    const inner = CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
    expect(inner.commandHash).toBe(hashCommand('requestSurvey'));
    expect(inner.params).toBe('mineral');
  });

  it('respects an explicit resourceClass arg', async () => {
    const factory = scenarios.survey;
    if (!factory) throw new Error('survey not registered');
    const fn = factory({ resourceClass: 'flora', waitMs: '0' });
    const { ctx, sent } = createFakeContext();
    await runScript(fn, ctx);
    const inner = CommandQueueEnqueue.unpack(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    expect(inner.params).toBe('flora');
  });
});
