/**
 * Unit tests for the `ctx.map` resolver — category resolution, nearest-by-
 * distance, filtering, and the `goTo` → `navigate` hop. Plus the
 * category-index golden test that pins `MAP_CATEGORY_INDEX` against
 * `planet_map_cat.tab`.
 */

import { describe, expect, it } from 'vitest';

import type { MapLocation } from '../../messages/game/planet-map/map-location.js';
import type { Vector3 } from '../../types.js';
import type { OutdoorTarget } from '../navigate.js';
import type { PlanetMapData } from '../planet-map-cache.js';
import {
  MAP_CATEGORY_ALIASES,
  MAP_CATEGORY_INDEX,
  type MapHostContext,
  createMapView,
  resolveCategory,
} from './map.js';

/** Build a `MapLocation` with sensible defaults. */
function loc(over: Partial<MapLocation>): MapLocation {
  return {
    locationId: 0n,
    locationName: '',
    x: 0,
    z: 0,
    category: 15,
    subCategory: 0,
    flags: 0,
    ...over,
  };
}

/** Build a `PlanetMapData` from a flat list of static locations. */
function makeData(planet: string, locations: MapLocation[]): PlanetMapData {
  return {
    planet,
    locations,
    staticLocations: locations,
    dynamicLocations: [],
    persistLocations: [],
    versionStatic: 0,
    versionDynamic: 0,
    versionPersist: 0,
  };
}

/**
 * A fake `MapHostContext` whose `mapCache.load()` returns `data` and whose
 * `navigate` records every call.
 */
function fakeHost(
  data: PlanetMapData,
  here: Vector3 = { x: 0, y: 0, z: 0 },
): MapHostContext & { navigateCalls: { target: OutdoorTarget }[] } {
  const navigateCalls: { target: OutdoorTarget }[] = [];
  return {
    navigateCalls,
    mapCache: {
      load: async () => data,
      invalidate: () => {},
    },
    position: () => here,
    navigate: async (target: OutdoorTarget) => {
      navigateCalls.push({ target });
    },
  };
}

describe('resolveCategory', () => {
  it('resolves canonical category names', () => {
    expect(resolveCategory('starport')).toBe(15);
    expect(resolveCategory('cantina')).toBe(3);
    expect(resolveCategory('bank')).toBe(2);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(resolveCategory('  StarPort ')).toBe(15);
  });

  it('resolves aliases to their canonical category', () => {
    expect(resolveCategory('spaceport')).toBe(MAP_CATEGORY_INDEX.starport);
    expect(resolveCategory('hospital')).toBe(MAP_CATEGORY_INDEX.medicalcenter);
    expect(resolveCategory('medcenter')).toBe(MAP_CATEGORY_INDEX.medicalcenter);
    expect(resolveCategory('shuttle')).toBe(MAP_CATEGORY_INDEX.shuttleport);
    expect(resolveCategory('cloning')).toBe(MAP_CATEGORY_INDEX.cloningfacility);
  });

  it('throws on an unknown category, listing valid names', () => {
    expect(() => resolveCategory('spaceelevator')).toThrow(/unknown category "spaceelevator"/);
    expect(() => resolveCategory('spaceelevator')).toThrow(/starport/);
  });
});

describe('MAP_CATEGORY_INDEX golden — pins planet_map_cat.tab', () => {
  it('matches the verified uint8 indices from the server datatable', () => {
    // These values are read straight from
    //   ~/code/swg-main/dsrc/sku.0/sys.shared/compiled/game/datatables/
    //     player/planet_map_cat.tab
    // (the `name` / `index` columns). A server datatable bump that
    // renumbers a category must update both the .tab and this test.
    expect(MAP_CATEGORY_INDEX).toEqual({
      bank: 2,
      cantina: 3,
      capitol: 4,
      cloningfacility: 5,
      garage: 6,
      guild: 7,
      hotel: 12,
      medicalcenter: 13,
      shuttleport: 14,
      starport: 15,
      themepark: 16,
      city: 17,
    });
  });

  it('every alias target is a real category', () => {
    for (const target of Object.values(MAP_CATEGORY_ALIASES)) {
      expect(MAP_CATEGORY_INDEX[target]).toBeDefined();
    }
  });
});

describe('MapView.nearest', () => {
  it('returns the nearest matching location by 2D distance', async () => {
    const near = loc({ locationId: 1n, category: 15, x: 30, z: 40 }); // dist 50
    const far = loc({ locationId: 2n, category: 15, x: 300, z: 400 }); // dist 500
    const host = fakeHost(makeData('tatooine', [far, near]));
    const view = createMapView(host);
    const result = await view.nearest('starport');
    expect(result?.locationId).toBe(1n);
    expect(result?.distanceM).toBeCloseTo(50, 5);
    expect(result?.category).toBe('starport');
  });

  it('filters by category — a cantina query ignores starports', async () => {
    const starport = loc({ locationId: 1n, category: 15, x: 1, z: 1 });
    const cantina = loc({ locationId: 2n, category: 3, x: 100, z: 0 });
    const host = fakeHost(makeData('tatooine', [starport, cantina]));
    const view = createMapView(host);
    const result = await view.nearest('cantina');
    expect(result?.locationId).toBe(2n);
    expect(result?.category).toBe('cantina');
  });

  it('returns undefined when no location of the category exists', async () => {
    const host = fakeHost(makeData('tatooine', [loc({ category: 15 })]));
    const view = createMapView(host);
    expect(await view.nearest('bank')).toBeUndefined();
  });

  it('excludes inactive locations by default', async () => {
    const inactive = loc({ locationId: 1n, category: 2, x: 1, z: 0, flags: 0x01 });
    const active = loc({ locationId: 2n, category: 2, x: 500, z: 0, flags: 0x02 });
    const host = fakeHost(makeData('tatooine', [inactive, active]));
    const view = createMapView(host);
    // The closer one is inactive — should be skipped, returning the active one.
    const result = await view.nearest('bank');
    expect(result?.locationId).toBe(2n);
    expect(result?.active).toBe(true);
  });

  it('includes inactive locations when includeInactive is set', async () => {
    const inactive = loc({ locationId: 1n, category: 2, x: 1, z: 0, flags: 0x01 });
    const host = fakeHost(makeData('tatooine', [inactive]));
    const view = createMapView(host);
    const result = await view.nearest('bank', { includeInactive: true });
    expect(result?.locationId).toBe(1n);
    expect(result?.active).toBe(false);
  });

  it('honors maxRadiusM', async () => {
    const far = loc({ locationId: 1n, category: 15, x: 1000, z: 0 });
    const host = fakeHost(makeData('tatooine', [far]));
    const view = createMapView(host);
    expect(await view.nearest('starport', { maxRadiusM: 500 })).toBeUndefined();
    expect(await view.nearest('starport', { maxRadiusM: 2000 })).toBeDefined();
  });

  it('maps the wire Vector2d.y onto MapPlace.z', async () => {
    const l = loc({ locationId: 1n, category: 15, x: 12.5, z: -34.75 });
    const host = fakeHost(makeData('tatooine', [l]));
    const view = createMapView(host);
    const result = await view.nearest('starport');
    expect(result?.x).toBe(12.5);
    expect(result?.z).toBe(-34.75);
  });

  it('throws on an unknown category', async () => {
    const host = fakeHost(makeData('tatooine', []));
    const view = createMapView(host);
    await expect(view.nearest('teleporter')).rejects.toThrow(/unknown category "teleporter"/);
  });
});

describe('MapView.list', () => {
  it('returns matching locations sorted nearest-first', async () => {
    const a = loc({ locationId: 1n, category: 2, x: 300, z: 0 }); // 300
    const b = loc({ locationId: 2n, category: 2, x: 50, z: 0 }); // 50
    const c = loc({ locationId: 3n, category: 2, x: 150, z: 0 }); // 150
    const host = fakeHost(makeData('tatooine', [a, b, c]));
    const view = createMapView(host);
    const list = await view.list('bank');
    expect(list.map((p) => p.locationId)).toEqual([2n, 3n, 1n]);
  });

  it('lists every location on the planet when no category is given', async () => {
    const host = fakeHost(
      makeData('tatooine', [loc({ category: 15 }), loc({ category: 3 }), loc({ category: 2 })]),
    );
    const view = createMapView(host);
    const list = await view.list();
    expect(list).toHaveLength(3);
  });

  it('throws when a category is given but invalid', async () => {
    const host = fakeHost(makeData('tatooine', []));
    const view = createMapView(host);
    await expect(view.list('notacategory')).rejects.toThrow(/unknown category/);
  });
});

describe('MapView.goTo', () => {
  it('navigates to the nearest matching location with an OutdoorTarget', async () => {
    const near = loc({ locationId: 1n, category: 3, x: 60, z: 80 });
    const host = fakeHost(makeData('tatooine', [near]));
    const view = createMapView(host);
    const place = await view.goTo('cantina');
    expect(place.locationId).toBe(1n);
    expect(host.navigateCalls).toHaveLength(1);
    expect(host.navigateCalls[0]?.target).toEqual({ x: 60, z: 80 });
  });

  it('throws (and does not navigate) when no matching location exists', async () => {
    const host = fakeHost(makeData('tatooine', [loc({ category: 15 })]));
    const view = createMapView(host);
    await expect(view.goTo('bank')).rejects.toThrow(/no "bank" location found/);
    expect(host.navigateCalls).toHaveLength(0);
  });

  it('throws on an unknown category before touching the cache', async () => {
    const host = fakeHost(makeData('tatooine', []));
    const view = createMapView(host);
    await expect(view.goTo('warpgate')).rejects.toThrow(/unknown category "warpgate"/);
  });
});
