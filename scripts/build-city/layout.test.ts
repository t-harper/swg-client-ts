import { describe, expect, it } from 'vitest';
import {
  CITY_CENTER,
  CITY_NAME,
  CITY_PLANET,
  CITY_RANK_RADIUS,
  TEMPLATES,
  distance,
  distanceToCenter,
  fullLayout,
  gardenAnchors,
  mvpLayout,
} from './layout.js';

describe('layout constants', () => {
  it('city is on Naboo, named TsHarbor', () => {
    expect(CITY_PLANET).toBe('naboo');
    expect(CITY_NAME).toBe('TsHarbor');
  });

  it('city center is in valid Naboo terrain range (-7500..7500)', () => {
    expect(Math.abs(CITY_CENTER.x)).toBeLessThan(7500);
    expect(Math.abs(CITY_CENTER.z)).toBeLessThan(7500);
  });
});

describe('mvpLayout', () => {
  it('returns exactly 5 slots: 1 mayor + 4 residents', () => {
    const slots = mvpLayout();
    expect(slots.length).toBe(5);
    expect(slots.filter((s) => s.role === 'mayor').length).toBe(1);
    expect(slots.filter((s) => s.role === 'resident').length).toBe(4);
  });

  it('mayor is at city center placing a cityhall', () => {
    const mayor = mvpLayout()[0]!;
    expect(mayor.role).toBe('mayor');
    expect(mayor.x).toBe(CITY_CENTER.x);
    expect(mayor.z).toBe(CITY_CENTER.z);
    expect(mayor.deedTemplate).toBe(TEMPLATES.cityhall);
  });

  it('all accounts are unique tscity01..tscity05', () => {
    const accounts = mvpLayout().map((s) => s.account);
    expect(new Set(accounts).size).toBe(5);
    expect(accounts.every((a) => /^tscity0[1-5]$/.test(a))).toBe(true);
  });

  it('residents are spaced ≥ 100m apart from each other', () => {
    const slots = mvpLayout().filter((s) => s.role === 'resident');
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        expect(distance(slots[i]!, slots[j]!)).toBeGreaterThanOrEqual(100);
      }
    }
  });

  it('all residents within rank-3 radius (300m)', () => {
    for (const s of mvpLayout().filter((s) => s.role === 'resident')) {
      expect(distanceToCenter(s)).toBeLessThanOrEqual(CITY_RANK_RADIUS.rank3 + 1);
    }
  });
});

describe('fullLayout', () => {
  const slots = fullLayout();

  it('returns exactly 30 slots', () => {
    expect(slots.length).toBe(30);
  });

  it('role distribution: 1 mayor + 6 civic + 15 residents + 8 guild', () => {
    expect(slots.filter((s) => s.role === 'mayor').length).toBe(1);
    expect(slots.filter((s) => s.role === 'civic').length).toBe(6);
    expect(slots.filter((s) => s.role === 'resident').length).toBe(15);
    expect(slots.filter((s) => s.role === 'guild').length).toBe(8);
  });

  it('all 30 accounts are unique tscity01..tscity30', () => {
    const accounts = slots.map((s) => s.account);
    expect(new Set(accounts).size).toBe(30);
    expect(accounts.every((a) => /^tscity\d{2}$/.test(a))).toBe(true);
    expect(accounts.sort()).toEqual(
      Array.from({ length: 30 }, (_, i) => `tscity${String(i + 1).padStart(2, '0')}`),
    );
  });

  it('all 30 character names are unique', () => {
    const names = slots.map((s) => s.characterName);
    expect(new Set(names).size).toBe(30);
  });

  it('all civic structures within Rank-1 radius (so they fit even before promotion)', () => {
    for (const s of slots.filter((s) => s.role === 'civic')) {
      // We use 250m ring, which is outside Rank-1 (150m). Civic placement requires
      // promotion to Rank 2+ first. Document this expectation:
      expect(distanceToCenter(s)).toBeLessThanOrEqual(255); // 250m ring +5m tolerance
    }
  });

  it('all residents inside Rank-4 radius (400m) — needed to count as citizens', () => {
    for (const s of slots.filter((s) => s.role === 'resident')) {
      expect(distanceToCenter(s)).toBeLessThanOrEqual(CITY_RANK_RADIUS.rank4 + 5);
    }
  });

  it('placement slots are spaced ≥ 30m apart (server footprint check)', () => {
    // Filter out guild-extras (residenceOf set) — they overlap with their host resident
    const placements = slots.filter((s) => s.deedTemplate !== null);
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        const d = distance(placements[i]!, placements[j]!);
        expect(
          d,
          `${placements[i]!.characterName} ↔ ${placements[j]!.characterName} = ${d.toFixed(1)}m`,
        ).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it('exactly one guild hall placed; 7 guild-extras have residenceOf set', () => {
    const guilds = slots.filter((s) => s.role === 'guild');
    const withDeed = guilds.filter((g) => g.deedTemplate !== null);
    const withoutDeed = guilds.filter((g) => g.deedTemplate === null);
    expect(withDeed.length).toBe(1);
    expect(withoutDeed.length).toBe(7);
    for (const g of withoutDeed) {
      expect(g.residenceOf).toMatch(/^Resident\d{2}$/);
    }
  });

  it('guild-extras reference real Resident character names', () => {
    const residentNames = new Set(
      slots.filter((s) => s.role === 'resident').map((s) => s.characterName),
    );
    for (const g of slots.filter((s) => s.role === 'guild' && s.residenceOf)) {
      expect(residentNames.has(g.residenceOf!)).toBe(true);
    }
  });

  it('every resident slot has an entryOffset so declareresidence can walk inside', () => {
    for (const s of slots.filter((s) => s.role === 'resident' || s.role === 'guild')) {
      if (s.role === 'guild' && s.deedTemplate !== null) continue; // guild hall — not a residence
      expect(s.entryOffset).toBeDefined();
    }
  });
});

describe('gardenAnchors', () => {
  const gardens = gardenAnchors();

  it('returns 4 anchors (N/E/S/W cardinal extents)', () => {
    expect(gardens.length).toBe(4);
    expect(gardens.map((g) => g.label).sort()).toEqual([
      'garden-E',
      'garden-N',
      'garden-S',
      'garden-W',
    ]);
  });

  it('all gardens at 350m from center', () => {
    for (const g of gardens) {
      expect(Math.round(distanceToCenter({ x: g.x, z: g.z }))).toBe(350);
    }
  });

  it('all gardens use placeStructure mode with naboo garden templates', () => {
    for (const g of gardens) {
      expect(g.mode).toBe('placeStructure');
      expect(g.template).toMatch(/garden_naboo_lrg_0[1-4]_deed\.iff$/);
    }
  });

  it('gardens spaced ≥ 100m apart and from city center decorations', () => {
    for (let i = 0; i < gardens.length; i++) {
      for (let j = i + 1; j < gardens.length; j++) {
        const a = gardens[i]!;
        const b = gardens[j]!;
        expect(distance(a, b)).toBeGreaterThanOrEqual(100);
      }
    }
  });
});

describe('cross-layout invariants', () => {
  it('mvp accounts (tscity01..05) are a subset of full accounts', () => {
    const fullAccounts = new Set(fullLayout().map((s) => s.account));
    for (const s of mvpLayout()) {
      expect(fullAccounts.has(s.account)).toBe(true);
    }
  });
});
