import { describe, expect, it } from 'vitest';
import { CountdownLatch, Gate, Semaphore } from './coordination.js';
import {
  type CityState,
  type StructureRecord,
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

describe('StructureRecord persistence', () => {
  it('round-trips a cityhall StructureRecord through JSON.stringify/parse', () => {
    const s = createScratchState();
    const cityhall: StructureRecord = {
      ownerAccount: 'tscity01',
      kind: 'cityhall',
      subKind: 'cityhall',
      deedOid: '16039260784',
      structureOid: '16039260999',
      x: 2800,
      z: -2800,
      rotation: 0,
    };
    s.structures.tscity01 = cityhall;

    // Serialize and parse to simulate save/load via state.json
    const serialized = JSON.stringify(s);
    const restored = JSON.parse(serialized) as CityState;

    expect(restored.structures.tscity01).toEqual(cityhall);
    // NetworkIds round-trip via the dedicated helper
    expect(networkIdFromString(restored.structures.tscity01!.structureOid)).toBe(16039260999n);
    expect(networkIdFromString(restored.structures.tscity01!.deedOid)).toBe(16039260784n);
  });

  it('supports a heterogeneous mix of kinds keyed by owner account', () => {
    const s = createScratchState();
    s.structures.tscity01 = {
      ownerAccount: 'tscity01',
      kind: 'cityhall',
      deedOid: '100',
      structureOid: '101',
      x: 2800,
      z: -2800,
      rotation: 0,
    };
    s.structures.tscity02 = {
      ownerAccount: 'tscity02',
      kind: 'civic',
      subKind: 'bank',
      deedOid: '200',
      structureOid: '201',
      x: 2900,
      z: -2800,
      rotation: 270,
    };
    s.structures.tscity03 = {
      ownerAccount: 'tscity03',
      kind: 'house',
      deedOid: '300',
      structureOid: '301',
      x: 3000,
      z: -2800,
      rotation: 270,
      isResidence: true,
    };
    s.structures['tscity01:garden-N'] = {
      ownerAccount: 'tscity01',
      kind: 'garden',
      subKind: 'garden-N',
      deedOid: '400',
      structureOid: '401',
      x: 2800,
      z: -2450,
      rotation: 180,
    };

    const restored = JSON.parse(JSON.stringify(s)) as CityState;
    expect(Object.keys(restored.structures).sort()).toEqual([
      'tscity01',
      'tscity01:garden-N',
      'tscity02',
      'tscity03',
    ]);
    expect(restored.structures.tscity02!.kind).toBe('civic');
    expect(restored.structures.tscity02!.subKind).toBe('bank');
    expect(restored.structures.tscity03!.isResidence).toBe(true);
    expect(restored.structures['tscity01:garden-N']!.kind).toBe('garden');
  });

  it('preserves structureOid=null for placements that did not observe a scene event', () => {
    const s = createScratchState();
    s.structures.tscity05 = {
      ownerAccount: 'tscity05',
      kind: 'house',
      deedOid: '500',
      structureOid: null, // placement happened but SceneCreateObjectByName wasn't captured
      x: 3100,
      z: -2700,
      rotation: 90,
    };

    const restored = JSON.parse(JSON.stringify(s)) as CityState;
    expect(restored.structures.tscity05!.structureOid).toBeNull();
    expect(networkIdFromString(restored.structures.tscity05!.structureOid)).toBeNull();
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
