import { describe, expect, it } from 'vitest';
import { createFakeContext } from '../../src/client/script/test-helpers.js';
import { ConGenericMessage } from '../../src/messages/game/con-generic-message.js';
import {
  adminCityAddCitizen,
  adminCityGetCityAtLocation,
  adminCityInfo,
  adminCityListCitizens,
  adminCityListStructures,
  adminCityPromote,
  adminCityRemoveCitizen,
  parseCityListRows,
} from './admin-city.js';

/**
 * Auto-replier: watches sent ConGenericMessages and echoes back the result of
 * `replyFor(cmd)` with the matching msgId. Same pattern as admin.test.ts.
 */
function autoReply(
  fake: ReturnType<typeof createFakeContext>,
  replyFor: (cmd: string) => string,
): void {
  const seen = new Set<ConGenericMessage>();
  const interval = setInterval(() => {
    for (const m of fake.sent) {
      if (!(m instanceof ConGenericMessage)) continue;
      if (seen.has(m)) continue;
      seen.add(m);
      const reply = replyFor(m.msg);
      fake.simulateRecv(new ConGenericMessage(reply, m.msgId));
    }
  }, 1);
  interval.unref?.();
}

// ────────────────────────────────────────────────────────────────────────────
// Sample server replies (built from ConsoleCommandParserCity.cpp formats)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Synthesized `city showCityDetails 1234` reply. Field order matches
 * ConsoleCommandParserCity.cpp:320-417.
 */
const SHOW_CITY_DETAILS_TSHARBOR = `id: 1234
name: TsHarbor
mayor: 16039260784 (Mayor01)
city hall id: 16039260800
location: naboo (2800, -2800)
radius: 250m
faction: 0 (Neutral)
GCW defender region: (NONE)
creation time: 1747522800 (2026-05-17 08:00:00)
taxes: income 0, property 0, sales 0
travel: location (0.00, 0.00, 0.00), cost 0, interplanetary no
clone: cloner id 0, cloner location (0.00, 0.00, 0.00), clone respawn location (0.00, 0.00, 0.00), clone respawn cell 0

Citizens:
16039260784, Mayor01, social_entertainer, 1, 1 (Militia ), MAYOR (Mayor), , 0
16039260801, Resident01, social_entertainer, 1, 0 (Citizen), CITIZEN (), , 0
16039260802, Resident02, social_entertainer, 1, 0 (Citizen), CITIZEN (), , 0
16039260803, Resident03, social_entertainer, 1, 0 (Citizen), CITIZEN (), , 0
16039260804, Resident04, social_entertainer, 1, 0 (Citizen), CITIZEN (), , 0
5 citizens listed
Output format is: "id, name, profession, level, permissions, rank, title, allegiance"

Structures:
16039260800, valid, 2 (SF_COST_CITY_HALL )
16039261000, valid, 4 (SF_COST_CITY_HI )
16039261001, valid, 4 (SF_COST_CITY_HI )
16039261002, valid, 4 (SF_COST_CITY_HI )
16039261003, valid, 4 (SF_COST_CITY_HI )
5 structures listed
Output format is: "id, valid, type"
showCityDetails: Command completed succesfully.`;

const SHOW_CITY_DETAILS_NOT_FOUND = `no city with city id 99999
showCityDetails: Command failed!`;

/**
 * Synthesized `city listByPlanet` reply with three cities — naboo, tatooine, naboo.
 * Row format from ConsoleCommandParserCity.cpp:173 (sprintf %d, %s, %s (%s), %s, %s (%d, %d), %dm, %lu (%s), %d, %d, %d (%s)).
 */
const LIST_BY_PLANET_THREE_CITIES = `1234, TsHarbor, 16039260784 (Mayor01), 16039260800, naboo (2800, -2800), 250m, 0 (Neutral), 5, 5, 1747522800 (2026-05-17 08:00:00)
1235, MosVille, 16039260900 (MayorB), 16039260901, tatooine (3500, 3500), 200m, 0 (Neutral), 3, 3, 1747522900 (2026-05-17 08:01:40)
1236, MoenikLake, 16039261100 (MayorC), 16039261101, naboo (-5000, 4000), 350m, 0 (Neutral), 15, 12, 1747523000 (2026-05-17 08:03:20)
3 cities listed
Output format is: "id, name, mayor, cityHallId, location, radius, faction, number of citizens, number of structures, creationTime"
listByPlanet: Command completed succesfully.`;

const LIST_BY_PLANET_EMPTY = `0 cities listed
listByPlanet: Command completed succesfully.`;

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('adminCityInfo', () => {
  it('parses showCityDetails reply into a CityInfo', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => SHOW_CITY_DETAILS_TSHARBOR);
    const info = await adminCityInfo(fake.ctx, 1234n);
    expect(info.cityId).toBe(1234n);
    expect(info.cityName).toBe('TsHarbor');
    expect(info.mayorId).toBe(16039260784n);
    expect(info.cityHallId).toBe(16039260800n);
    expect(info.radius).toBe(250);
    expect(info.rank).toBe(3); // 250m -> township
    expect(info.planet).toBe('naboo');
    expect(info.centerX).toBe(2800);
    expect(info.centerZ).toBe(-2800);
    expect(info.citizenCount).toBe(5);
    expect(info.structureCount).toBe(5);
    expect(info.treasury).toBe(0);

    const sent = fake.sent.filter((m): m is ConGenericMessage => m instanceof ConGenericMessage);
    expect(sent[0]?.msg).toBe('city showCityDetails 1234');
  });

  it('throws on "no city with city id" reply', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => SHOW_CITY_DETAILS_NOT_FOUND);
    await expect(adminCityInfo(fake.ctx, 99999n)).rejects.toThrow(/no city with id 99999/);
  });

  it('throws when reply lacks the expected keys', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => 'garbage reply\nshowCityDetails: Command completed succesfully.');
    await expect(adminCityInfo(fake.ctx, 1n)).rejects.toThrow(/failed to parse/);
  });

  it('treats spelling "successfully" the same as "succesfully" (defensive)', async () => {
    const fake = createFakeContext();
    autoReply(fake, () =>
      SHOW_CITY_DETAILS_TSHARBOR.replace('succesfully', 'successfully'),
    );
    const info = await adminCityInfo(fake.ctx, 1234n);
    expect(info.cityName).toBe('TsHarbor');
  });

  it('handles cityHall id of 0 as null', async () => {
    const fake = createFakeContext();
    autoReply(fake, () =>
      SHOW_CITY_DETAILS_TSHARBOR.replace('city hall id: 16039260800', 'city hall id: 0'),
    );
    const info = await adminCityInfo(fake.ctx, 1234n);
    expect(info.cityHallId).toBeNull();
  });

  it('derives rank from radius', async () => {
    const radii = [
      { radius: 150, rank: 1 },
      { radius: 200, rank: 2 },
      { radius: 250, rank: 3 },
      { radius: 350, rank: 4 },
      { radius: 400, rank: 5 },
      { radius: 100, rank: 0 },
    ];
    for (const { radius, rank } of radii) {
      const fake = createFakeContext();
      autoReply(fake, () =>
        SHOW_CITY_DETAILS_TSHARBOR.replace('radius: 250m', `radius: ${radius}m`),
      );
      const info = await adminCityInfo(fake.ctx, 1234n);
      expect(info.rank, `radius=${radius}`).toBe(rank);
    }
  });
});

describe('adminCityListCitizens', () => {
  it('parses the citizen section into typed records', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => SHOW_CITY_DETAILS_TSHARBOR);
    const cits = await adminCityListCitizens(fake.ctx, 1234n);
    expect(cits.length).toBe(5);
    expect(cits[0]?.oid).toBe(16039260784n);
    expect(cits[0]?.name).toBe('Mayor01');
    expect(cits[0]?.profession).toBe('social_entertainer');
    expect(cits[0]?.level).toBe(1);
    expect(cits[0]?.permissions).toBe('1 (Militia)');
    expect(cits[1]?.name).toBe('Resident01');
  });

  it('returns [] when the city has no citizen section (e.g. empty)', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => `id: 1
name: Empty
mayor: 0 ()
city hall id: 0
location: naboo (0, 0)
radius: 150m
faction: 0 (Neutral)
showCityDetails: Command completed succesfully.`);
    const cits = await adminCityListCitizens(fake.ctx, 1n);
    expect(cits).toEqual([]);
  });

  it('throws on missing city', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => SHOW_CITY_DETAILS_NOT_FOUND);
    await expect(adminCityListCitizens(fake.ctx, 99999n)).rejects.toThrow(/no city with id/);
  });
});

describe('adminCityListStructures', () => {
  it('parses the structure section into typed records', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => SHOW_CITY_DETAILS_TSHARBOR);
    const structs = await adminCityListStructures(fake.ctx, 1234n);
    expect(structs.length).toBe(5);
    expect(structs[0]?.oid).toBe(16039260800n);
    expect(structs[0]?.valid).toBe(true);
    expect(structs[0]?.typeFlags).toBe(2); // SF_COST_CITY_HALL
    expect(structs[0]?.typeText).toContain('SF_COST_CITY_HALL');
    expect(structs[0]?.isDecoration).toBe(false);
    expect(structs[0]?.isCivic).toBe(false);
    expect(structs[1]?.typeFlags).toBe(4); // SF_COST_CITY_HI
  });

  it('flags civic structures (mission terminal / skill trainer)', async () => {
    const fake = createFakeContext();
    autoReply(
      fake,
      () =>
        // Replace one structure line to add SF_MISSION_TERMINAL (32) + SF_COST_CITY_LOW (16) = 48
        SHOW_CITY_DETAILS_TSHARBOR.replace(
          '16039261000, valid, 4 (SF_COST_CITY_HI )',
          '16039261000, valid, 48 (SF_COST_CITY_LOW SF_MISSION_TERMINAL )',
        ),
    );
    const structs = await adminCityListStructures(fake.ctx, 1234n);
    expect(structs[1]?.typeFlags).toBe(48);
    expect(structs[1]?.isCivic).toBe(true);
  });

  it('flags decoration structures (SF_DECORATION=128)', async () => {
    const fake = createFakeContext();
    autoReply(
      fake,
      () =>
        SHOW_CITY_DETAILS_TSHARBOR.replace(
          '16039261000, valid, 4 (SF_COST_CITY_HI )',
          '16039261000, valid, 128 (SF_DECORATION )',
        ),
    );
    const structs = await adminCityListStructures(fake.ctx, 1234n);
    expect(structs[1]?.typeFlags).toBe(128);
    expect(structs[1]?.isDecoration).toBe(true);
  });

  it('parses "no valid" structures', async () => {
    const fake = createFakeContext();
    autoReply(
      fake,
      () =>
        SHOW_CITY_DETAILS_TSHARBOR.replace(
          '16039261000, valid, 4 (SF_COST_CITY_HI )',
          '16039261000, no valid, 4 (SF_COST_CITY_HI )',
        ),
    );
    const structs = await adminCityListStructures(fake.ctx, 1234n);
    expect(structs[1]?.valid).toBe(false);
  });

  it('returns [] when the city has no structure section', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => `id: 1
name: Empty
mayor: 0 ()
city hall id: 0
location: naboo (0, 0)
radius: 150m
faction: 0 (Neutral)
showCityDetails: Command completed succesfully.`);
    const structs = await adminCityListStructures(fake.ctx, 1n);
    expect(structs).toEqual([]);
  });

  it('throws on missing city', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => SHOW_CITY_DETAILS_NOT_FOUND);
    await expect(adminCityListStructures(fake.ctx, 99999n)).rejects.toThrow(/no city with id/);
  });
});

describe('adminCityGetCityAtLocation', () => {
  it('returns the city id whose center+radius covers the location', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => LIST_BY_PLANET_THREE_CITIES);
    // TsHarbor is at (2800, -2800) radius 250m. (2810, -2810) is well within.
    const id = await adminCityGetCityAtLocation(fake.ctx, 'naboo', 2810, -2810);
    expect(id).toBe(1234n);
  });

  it('returns null when the location is outside any city radius', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => LIST_BY_PLANET_THREE_CITIES);
    const id = await adminCityGetCityAtLocation(fake.ctx, 'naboo', 100, 100);
    expect(id).toBeNull();
  });

  it('respects the planet filter (case-insensitive)', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => LIST_BY_PLANET_THREE_CITIES);
    // tatooine MosVille at (3500, 3500) — querying with capital T should still match
    const id = await adminCityGetCityAtLocation(fake.ctx, 'Tatooine', 3505, 3505);
    expect(id).toBe(1235n);
  });

  it('picks the closest city when multiple overlap', async () => {
    const fake = createFakeContext();
    autoReply(
      fake,
      () =>
        // Two cities both near origin, big enough to overlap
        `100, A, 0 (), 0, naboo (0, 0), 500m, 0 (Neutral), 1, 1, 0 (N/A)
101, B, 0 (), 0, naboo (10, 10), 500m, 0 (Neutral), 1, 1, 0 (N/A)
2 cities listed
Output format is: ...
listByPlanet: Command completed succesfully.`,
    );
    // Querying near (12, 12) — closer to B (10,10) than A (0,0)
    const id = await adminCityGetCityAtLocation(fake.ctx, 'naboo', 12, 12);
    expect(id).toBe(101n);
  });

  it('returns null on empty planet list', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => LIST_BY_PLANET_EMPTY);
    const id = await adminCityGetCityAtLocation(fake.ctx, 'naboo', 0, 0);
    expect(id).toBeNull();
  });

  it('uses the supplied radiusBufferM slack', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => LIST_BY_PLANET_THREE_CITIES);
    // TsHarbor radius 250m, center (2800, -2800). Point (3070, -2800) is 270m away
    // — outside strict radius (250) but inside radius+50 (300).
    const idStrict = await adminCityGetCityAtLocation(fake.ctx, 'naboo', 3070, -2800);
    expect(idStrict).toBeNull();

    const fake2 = createFakeContext();
    autoReply(fake2, () => LIST_BY_PLANET_THREE_CITIES);
    const idLoose = await adminCityGetCityAtLocation(fake2.ctx, 'naboo', 3070, -2800, 50);
    expect(idLoose).toBe(1234n);
  });

  it('sends `city listByPlanet` on the wire', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => LIST_BY_PLANET_EMPTY);
    await adminCityGetCityAtLocation(fake.ctx, 'naboo', 0, 0);
    const sent = fake.sent.filter((m): m is ConGenericMessage => m instanceof ConGenericMessage);
    expect(sent[0]?.msg).toBe('city listByPlanet');
  });
});

describe('parseCityListRows', () => {
  it('parses every row from a multi-row reply', () => {
    const rows = parseCityListRows(LIST_BY_PLANET_THREE_CITIES);
    expect(rows.length).toBe(3);
    expect(rows[0]?.id).toBe(1234n);
    expect(rows[0]?.name).toBe('TsHarbor');
    expect(rows[0]?.leaderId).toBe(16039260784n);
    expect(rows[0]?.leaderName).toBe('Mayor01');
    expect(rows[0]?.cityHallId).toBe(16039260800n);
    expect(rows[0]?.planet).toBe('naboo');
    expect(rows[0]?.x).toBe(2800);
    expect(rows[0]?.z).toBe(-2800);
    expect(rows[0]?.radius).toBe(250);
    expect(rows[0]?.faction).toBe(0);
    expect(rows[0]?.factionName).toBe('Neutral');
    expect(rows[0]?.citizenCount).toBe(5);
    expect(rows[0]?.structureCount).toBe(5);

    expect(rows[2]?.name).toBe('MoenikLake');
    expect(rows[2]?.x).toBe(-5000);
    expect(rows[2]?.z).toBe(4000);
    expect(rows[2]?.radius).toBe(350);
  });

  it('ignores the trailing summary and format lines', () => {
    const rows = parseCityListRows(LIST_BY_PLANET_THREE_CITIES);
    // The reply has "3 cities listed" and "Output format..." after the rows.
    // The regex is row-anchored so neither should match.
    expect(rows.length).toBe(3);
  });

  it('returns [] when no cities listed', () => {
    expect(parseCityListRows(LIST_BY_PLANET_EMPTY)).toEqual([]);
  });
});

describe('adminCityPromote / adminCityAddCitizen / adminCityRemoveCitizen', () => {
  it('adminCityPromote throws — no console command exists', async () => {
    const fake = createFakeContext();
    await expect(adminCityPromote(fake.ctx, 1234n)).rejects.toThrow(
      /not supported.*no 'city promote' console command/i,
    );
    // Also verifies we don't send anything spurious
    const sent = fake.sent.filter((m): m is ConGenericMessage => m instanceof ConGenericMessage);
    expect(sent.length).toBe(0);
  });

  it('adminCityAddCitizen throws', async () => {
    const fake = createFakeContext();
    await expect(adminCityAddCitizen(fake.ctx, 1234n, 16039260999n)).rejects.toThrow(
      /not supported.*no 'city addCitizen'/i,
    );
  });

  it('adminCityRemoveCitizen throws', async () => {
    const fake = createFakeContext();
    await expect(adminCityRemoveCitizen(fake.ctx, 1234n, 16039260999n)).rejects.toThrow(
      /not supported.*no 'city removeCitizen'/i,
    );
  });
});
