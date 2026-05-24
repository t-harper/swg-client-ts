import { describe, expect, it } from 'vitest';

import type { CombatTargetEntry, CombatView } from '../../combat-helpers.js';
import type { CombatHitInfo, CombatTimerView } from '../../timing.js';
import { type EngageWatcherTransition, createEngageWatcher } from './engage-watcher.js';

class FakeClock {
  current = 0;
  now = (): number => this.current;
  advance(ms: number): void {
    this.current += ms;
  }
}

interface FakeScheduler {
  intervals: Array<{ cb: () => void; ms: number }>;
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

function fakeScheduler(): FakeScheduler {
  const intervals: Array<{ cb: () => void; ms: number }> = [];
  return {
    intervals,
    setInterval(cb: () => void, ms: number): unknown {
      const entry = { cb, ms };
      intervals.push(entry);
      return entry;
    },
    clearInterval(handle: unknown): void {
      const idx = intervals.indexOf(handle as { cb: () => void; ms: number });
      if (idx >= 0) intervals.splice(idx, 1);
    },
  };
}

interface FakeState {
  targets: CombatTargetEntry[];
  hitTimerEngaged: boolean;
}

function fakeViews(state: FakeState): { combat: CombatView; hitTimer: CombatTimerView } {
  const combat = {
    targets: (): CombatTargetEntry[] => state.targets,
    engaged: false,
    autoLoot: false,
    timeSinceLastHitMs: null,
    attackingNearest: () => Promise.resolve(),
    damagedSet: () => new Set<bigint>(),
  } as CombatView;
  const hitTimer = {
    get engaged(): boolean {
      return state.hitTimerEngaged;
    },
    timeSinceLastHitMs: 0,
    lastHit: (): CombatHitInfo | null => null,
  } as CombatTimerView;
  return { combat, hitTimer };
}

function setup() {
  const state: FakeState = { targets: [], hitTimerEngaged: false };
  const transitions: EngageWatcherTransition[] = [];
  const clock = new FakeClock();
  const scheduler = fakeScheduler();
  const { combat, hitTimer } = fakeViews(state);
  const scriptController = new AbortController();
  const watcher = createEngageWatcher({
    combat,
    hitTimer,
    scriptSignal: scriptController.signal,
    pollMs: 100,
    disengageAfterMs: 500,
    now: clock.now,
    schedule: scheduler,
    onTransition: (e) => transitions.push(e),
  });
  return { state, transitions, clock, scheduler, watcher, scriptController };
}

describe('createEngageWatcher', () => {
  it('starts disengaged', () => {
    const { watcher } = setup();
    expect(watcher.engaged).toBe(false);
  });

  it('emits engage when sample sees targets', () => {
    const { state, transitions, clock, watcher } = setup();
    state.targets = [{ id: 5n, distance: 10, ham: null }];
    clock.advance(100);
    watcher.sample();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.kind).toBe('engage');
    expect(transitions[0]?.targetIds).toEqual([5n]);
    expect(watcher.engaged).toBe(true);
  });

  it('does not double-fire engage on consecutive engaged samples', () => {
    const { state, transitions, clock, watcher } = setup();
    state.targets = [{ id: 5n, distance: 10, ham: null }];
    clock.advance(100);
    watcher.sample();
    clock.advance(100);
    watcher.sample();
    expect(transitions).toHaveLength(1);
  });

  it('emits engage when hitTimer.engaged becomes true', () => {
    const { state, transitions, watcher } = setup();
    state.hitTimerEngaged = true;
    watcher.sample();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.kind).toBe('engage');
    expect(transitions[0]?.targetIds).toEqual([]);
  });

  it('debounces disengage until quiet window elapses', () => {
    const { state, transitions, clock, watcher } = setup();
    state.targets = [{ id: 1n, distance: 10, ham: null }];
    watcher.sample();
    expect(transitions).toHaveLength(1);
    state.targets = [];
    // Sample 400ms later — still inside the 500ms quiet window.
    clock.advance(400);
    watcher.sample();
    expect(transitions).toHaveLength(1);
    // Sample 200ms later — total 600ms quiet → disengage fires.
    clock.advance(200);
    watcher.sample();
    expect(transitions).toHaveLength(2);
    expect(transitions[1]?.kind).toBe('disengage');
    expect(watcher.engaged).toBe(false);
  });

  it('resets the quiet window if re-engaged during the debounce', () => {
    const { state, transitions, clock, watcher } = setup();
    state.targets = [{ id: 1n, distance: 10, ham: null }];
    watcher.sample();
    state.targets = [];
    clock.advance(300);
    watcher.sample();
    // Re-engaged briefly.
    state.targets = [{ id: 1n, distance: 10, ham: null }];
    clock.advance(50);
    watcher.sample();
    // Back to quiet.
    state.targets = [];
    clock.advance(300);
    watcher.sample();
    // 350ms quiet since re-engage — should NOT disengage yet.
    expect(transitions).toHaveLength(1);
  });

  it('forceEngage emits engage when currently disengaged', () => {
    const { transitions, watcher } = setup();
    watcher.forceEngage([99n]);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.kind).toBe('engage');
    expect(transitions[0]?.targetIds).toEqual([99n]);
    expect(watcher.engaged).toBe(true);
  });

  it('forceEngage is a no-op when already engaged', () => {
    const { state, transitions, watcher } = setup();
    state.targets = [{ id: 1n, distance: 10, ham: null }];
    watcher.sample();
    watcher.forceEngage([42n]);
    expect(transitions).toHaveLength(1);
  });

  it('forceDisengage emits disengage when currently engaged', () => {
    const { state, transitions, watcher } = setup();
    state.targets = [{ id: 1n, distance: 10, ham: null }];
    watcher.sample();
    watcher.forceDisengage();
    expect(transitions).toHaveLength(2);
    expect(transitions[1]?.kind).toBe('disengage');
    expect(watcher.engaged).toBe(false);
  });

  it('schedule.setInterval is called with pollMs', () => {
    const { scheduler } = setup();
    expect(scheduler.intervals).toHaveLength(1);
    expect(scheduler.intervals[0]?.ms).toBe(100);
  });

  it('detach clears the interval and stops responding to samples', () => {
    const { state, scheduler, transitions, watcher } = setup();
    watcher.detach();
    expect(scheduler.intervals).toHaveLength(0);
    state.targets = [{ id: 1n, distance: 10, ham: null }];
    watcher.sample();
    expect(transitions).toHaveLength(0);
    expect(watcher.detached).toBe(true);
  });

  it('detaches when script signal aborts', () => {
    const { scheduler, scriptController, watcher } = setup();
    scriptController.abort();
    expect(watcher.detached).toBe(true);
    expect(scheduler.intervals).toHaveLength(0);
  });

  it('starts detached if scriptSignal is already aborted', () => {
    const scriptController = new AbortController();
    scriptController.abort();
    const scheduler = fakeScheduler();
    const watcher = createEngageWatcher({
      combat: fakeViews({ targets: [], hitTimerEngaged: false }).combat,
      hitTimer: fakeViews({ targets: [], hitTimerEngaged: false }).hitTimer,
      scriptSignal: scriptController.signal,
      schedule: scheduler,
      onTransition: () => {},
    });
    expect(watcher.detached).toBe(true);
    expect(scheduler.intervals).toHaveLength(0);
  });

  it('swallows errors thrown by onTransition', () => {
    const state: FakeState = {
      targets: [{ id: 1n, distance: 10, ham: null }],
      hitTimerEngaged: false,
    };
    const clock = new FakeClock();
    const scheduler = fakeScheduler();
    const { combat, hitTimer } = fakeViews(state);
    const scriptController = new AbortController();
    const watcher = createEngageWatcher({
      combat,
      hitTimer,
      scriptSignal: scriptController.signal,
      pollMs: 100,
      now: clock.now,
      schedule: scheduler,
      onTransition: () => {
        throw new Error('boom');
      },
    });
    expect(() => watcher.sample()).not.toThrow();
  });
});
