import { describe, expect, it } from 'vitest';
import { CountdownLatch, Gate, Semaphore } from './coordination.js';
import {
  createScratchState,
  isPhaseComplete,
  markPhaseFinished,
  markPhaseStarted,
  networkIdFromString,
  networkIdToString,
} from './state.js';

describe('CityState helpers', () => {
  it('createScratchState initializes empty', () => {
    const s = createScratchState();
    expect(s.cityName).toBe('TsHarbor');
    expect(s.cityPlanet).toBe('naboo');
    expect(s.cityCenter).toEqual({ x: 2800, z: -2800 });
    expect(s.characters).toEqual({});
    expect(s.structures).toEqual({});
    expect(s.phaseLog).toEqual([]);
    expect(s.cityOid).toBeNull();
  });

  it('phase lifecycle: started → finished (ok=true)', () => {
    const s = createScratchState();
    markPhaseStarted(s, 'phase0pre', 'staging allowlist');
    expect(s.phaseLog.length).toBe(1);
    expect(s.phaseLog[0]!.phase).toBe('phase0pre');
    expect(s.phaseLog[0]!.finishedAt).toBeNull();
    expect(s.phaseLog[0]!.notes).toBe('staging allowlist');

    expect(isPhaseComplete(s, 'phase0pre')).toBe(false);
    markPhaseFinished(s, 'phase0pre', true);
    expect(isPhaseComplete(s, 'phase0pre')).toBe(true);
    expect(s.phaseLog[0]!.finishedAt).not.toBeNull();
    expect(s.phaseLog[0]!.ok).toBe(true);
  });

  it('phase failed records assertionFailures', () => {
    const s = createScratchState();
    markPhaseStarted(s, 'phase3-mvp');
    markPhaseFinished(s, 'phase3-mvp', false, {
      assertionFailures: ['Resident01 deed spawn failed', 'Resident03 walked out of city'],
    });
    expect(isPhaseComplete(s, 'phase3-mvp')).toBe(false); // not ok
    expect(s.phaseLog[0]!.assertionFailures).toEqual([
      'Resident01 deed spawn failed',
      'Resident03 walked out of city',
    ]);
  });

  it('markPhaseFinished is robust when no matching start entry exists', () => {
    const s = createScratchState();
    markPhaseFinished(s, 'phase6-verify', true, { notes: 'orphan finish' });
    expect(s.phaseLog.length).toBe(1);
    expect(s.phaseLog[0]!.notes).toBe('orphan finish');
    expect(s.phaseLog[0]!.ok).toBe(true);
  });

  it('networkIdToString / networkIdFromString round-trip', () => {
    const id = 16039260784n;
    const s = networkIdToString(id);
    expect(s).toBe('16039260784');
    expect(networkIdFromString(s)).toBe(id);
    expect(networkIdFromString(null)).toBeNull();
    expect(networkIdFromString('')).toBeNull();
  });
});

describe('CountdownLatch', () => {
  it('signal decrements; wait resolves when count hits zero', async () => {
    const latch = new CountdownLatch(3);
    expect(latch.count).toBe(3);
    latch.signal();
    expect(latch.count).toBe(2);

    let resolved = false;
    const wait = latch.wait().then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    latch.signal();
    latch.signal();
    await wait;
    expect(resolved).toBe(true);
    expect(latch.count).toBe(0);
  });

  it('wait resolves immediately if already at zero', async () => {
    const latch = new CountdownLatch(0);
    await latch.wait(); // should not hang
  });

  it('release force-resolves immediately', async () => {
    const latch = new CountdownLatch(100);
    const waiterP = latch.wait();
    latch.release();
    await waiterP;
    expect(latch.count).toBe(0);
  });

  it('wait rejects on timeout', async () => {
    const latch = new CountdownLatch(5);
    await expect(latch.wait(50)).rejects.toThrow(/timed out/);
  });

  it('signal past zero is a no-op', () => {
    const latch = new CountdownLatch(1);
    latch.signal();
    latch.signal();
    expect(latch.count).toBe(0);
  });
});

describe('Gate', () => {
  it('open() resolves all waiters; subsequent waiters resolve immediately', async () => {
    const gate = new Gate();
    expect(gate.isOpen).toBe(false);

    const w1 = gate.wait();
    const w2 = gate.wait();
    gate.open();
    await Promise.all([w1, w2]);
    expect(gate.isOpen).toBe(true);

    // post-open wait resolves immediately
    await gate.wait();
  });

  it('fail() rejects all waiters', async () => {
    const gate = new Gate();
    const w1 = gate.wait();
    gate.fail(new Error('boom'));
    await expect(w1).rejects.toThrow('boom');
  });

  it('wait rejects on timeout if never opened', async () => {
    const gate = new Gate();
    await expect(gate.wait(50)).rejects.toThrow(/timed out/);
  });
});

describe('Semaphore', () => {
  it('limits concurrent operations', async () => {
    const sem = new Semaphore(2);
    let concurrent = 0;
    let peak = 0;
    const fn = async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
    };
    await Promise.all(Array.from({ length: 6 }, () => sem.run(fn)));
    expect(peak).toBe(2);
  });

  it('propagates fn return values', async () => {
    const sem = new Semaphore(3);
    const r = await sem.run(async () => 42);
    expect(r).toBe(42);
  });

  it('releases slot even if fn throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('x'); })).rejects.toThrow('x');
    // Slot should be free for next op
    const r = await sem.run(async () => 'ok');
    expect(r).toBe('ok');
  });
});
