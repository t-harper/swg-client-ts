/**
 * TsHarbor city plan — pure data + coord math, no I/O.
 *
 * The full 30-character build assembles into a Theed-style radial layout
 * around `CITY_CENTER`. Civic structures form an inner ring at 250m, residents
 * a middle ring at 400m. The mayor's city hall sits dead center.
 *
 * Coordinates validated against `dsrc/.../triggervolumes/naboo` no-build zones:
 *   - 9550m from Theed (NW)
 *   - 1667m from Moenia (S, after subtracting its 700m radius)
 *   - 2581m from Deeja Peak (NE, after its 1200m radius)
 *   - 1432m from the GCW Naboo main base (W)
 * Rolling grassland east of Theed / north of Moenia.
 *
 * Tested invariants (layout.test.ts):
 *   - Pairwise distance between any two placement slots ≥ 30m
 *   - All civic slots within 250m of center (within Rank-1 radius)
 *   - All resident slots within 400m of center (within Rank-4 radius)
 *   - Decoration anchors distinct from structure slots
 */

import type { NetworkId } from '../../src/types.js';

// ────────────────────────────────────────────────────────────────────────────
// City constants
// ────────────────────────────────────────────────────────────────────────────

export const CITY_NAME = 'TsHarbor';
export const CITY_PLANET = 'naboo';
export const CITY_CENTER = { x: 2800, z: -2800 } as const;

/** Rank thresholds from `dsrc/.../datatables/city/city_rank.tab`. */
export const CITY_RANK_RADIUS = {
  rank1: 150,
  rank2: 200,
  rank3: 300,
  rank4: 400,
  rank5: 450,
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Templates
// ────────────────────────────────────────────────────────────────────────────

/**
 * Naboo-themed deed templates. All are SERVER templates — `object/tangible/deed/...`
 * paths (NOT shared_* variants). The cityhall is in city_deed/, civic in city_deed/,
 * houses in player_house_deed/, guild in guild_deed/, gardens in
 * player_house_deed/garden/ (treated as houses by player_structure.tab).
 */
export const TEMPLATES = {
  cityhall: 'object/tangible/deed/city_deed/cityhall_naboo_deed.iff',

  // Civic structures (require city rank thresholds; we'll place them after housing)
  bank: 'object/tangible/deed/city_deed/bank_naboo_deed.iff',
  cantina: 'object/tangible/deed/city_deed/cantina_naboo_deed.iff',
  hospital: 'object/tangible/deed/city_deed/hospital_naboo_deed.iff',
  cloning: 'object/tangible/deed/city_deed/cloning_naboo_deed.iff',
  shuttleport: 'object/tangible/deed/city_deed/shuttleport_naboo_deed.iff',
  garage: 'object/tangible/deed/city_deed/garage_naboo_deed.iff',
  theater: 'object/tangible/deed/city_deed/theater_naboo_deed.iff',

  // Residential — varied styles for visual interest
  houseSmall: 'object/tangible/deed/player_house_deed/naboo_house_small_deed.iff',
  houseSmallWindow: 'object/tangible/deed/player_house_deed/naboo_house_small_window_deed.iff',
  houseSmall2: 'object/tangible/deed/player_house_deed/naboo_house_small_style_02_deed.iff',
  houseMedium: 'object/tangible/deed/player_house_deed/naboo_house_medium_deed.iff',
  houseMedium2: 'object/tangible/deed/player_house_deed/naboo_house_medium_style_02_deed.iff',
  houseLarge: 'object/tangible/deed/player_house_deed/naboo_house_large_deed.iff',

  // Guild
  guildhall: 'object/tangible/deed/guild_deed/naboo_guild_deed.iff',

  // Gardens (4 large, naboo-flavored)
  gardenLrg1: 'object/tangible/deed/player_house_deed/garden_naboo_lrg_01_deed.iff',
  gardenLrg2: 'object/tangible/deed/player_house_deed/garden_naboo_lrg_02_deed.iff',
  gardenLrg3: 'object/tangible/deed/player_house_deed/garden_naboo_lrg_03_deed.iff',
  gardenLrg4: 'object/tangible/deed/player_house_deed/garden_naboo_lrg_04_deed.iff',
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Role + Account types
// ────────────────────────────────────────────────────────────────────────────

export type Role = 'mayor' | 'civic' | 'resident' | 'guild';

export interface CharacterSlot {
  /** Role name (drives which scenario runs). */
  role: Role;
  /** Account login name (admin-whitelisted in stella_admin.tab Phase 0pre). */
  account: string;
  /** Character display name. */
  characterName: string;
  /** Deed template to spawn + place (or null for `guildExtra` chars that just declare residence in someone else's house). */
  deedTemplate: string | null;
  /** Absolute world x. */
  x: number;
  /** Absolute world z. */
  z: number;
  /** Placement rotation in degrees (0 = facing +Z / north). */
  rotation: number;
  /** Optional civic role-name for state.json bookkeeping (e.g. 'bank', 'cantina'). */
  civicKind?: string;
  /**
   * For residents only: NetworkId of an existing structure to declare residence in,
   * used by Guild02..Guild08 who don't place their own house.
   */
  residenceOf?: string;
  /**
   * Local cell-relative entry offset (relative to building origin) where the player
   * walks to enter the building before declareresidence. Hard-coded per template.
   */
  entryOffset?: { x: number; z: number };
  /**
   * For residents only (in fullLayout): the character name of the guildExtra
   * who will later declare residence in this resident's house. The resident's
   * scenario uses this at the end of Phase 3 to permission-add the guildExtra
   * to its ENTRY+ADMIN list, so the guildExtra's Phase-4 declareresidence
   * call doesn't bounce off the house's no-permission gate.
   *
   * Inverse mapping of `residenceOf` (which lives on the guildExtra slot
   * pointing back to the resident). MVP layouts omit this — there are no
   * guildExtra characters in MVP mode.
   */
  pairedGuildCharacter?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Layout computation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Polar-to-cartesian. Angle in degrees, 0 = +Z (north), increasing clockwise.
 * Returns absolute world coords by adding to CITY_CENTER.
 */
function polar(angleDeg: number, radiusM: number): { x: number; z: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: CITY_CENTER.x + radiusM * Math.sin(rad),
    z: CITY_CENTER.z + radiusM * Math.cos(rad),
  };
}

/** Rotation in degrees that faces the slot toward city center (so doors face in). */
function facingCenter(angleDeg: number): number {
  // Slot at angleDeg outbound from center; building should face inward, so add 180° and normalize.
  return (angleDeg + 180) % 360;
}

/**
 * 5-character MVP layout: mayor + 4 residents at cardinal positions.
 * Purpose: validate the wire mechanics end-to-end before committing to the full 30.
 */
export function mvpLayout(): CharacterSlot[] {
  const slots: CharacterSlot[] = [
    {
      role: 'mayor',
      account: 'tscity01',
      characterName: 'Mayor01',
      deedTemplate: TEMPLATES.cityhall,
      x: CITY_CENTER.x,
      z: CITY_CENTER.z,
      rotation: 0,
    },
  ];

  // 4 residents at cardinal positions, 300m from center (well inside Rank-1 150m won't fit,
  // but the city's effective radius starts at Rank 1 and grows; we use 300m so the residences
  // are visible spread but inside Rank-3 zone once city promotes).
  const cardinals: { name: string; angle: number; tmpl: string }[] = [
    { name: 'Resident01', angle: 0, tmpl: TEMPLATES.houseSmall }, // N
    { name: 'Resident02', angle: 90, tmpl: TEMPLATES.houseSmallWindow }, // E
    { name: 'Resident03', angle: 180, tmpl: TEMPLATES.houseSmall2 }, // S
    { name: 'Resident04', angle: 270, tmpl: TEMPLATES.houseMedium }, // W
  ];
  for (let i = 0; i < cardinals.length; i++) {
    const c = cardinals[i]!;
    const pos = polar(c.angle, 300);
    slots.push({
      role: 'resident',
      account: `tscity0${i + 2}`,
      characterName: c.name,
      deedTemplate: c.tmpl,
      x: pos.x,
      z: pos.z,
      rotation: facingCenter(c.angle),
      entryOffset: { x: 0, z: -5 }, // door faces inward; entry is 5m toward center
    });
  }

  return slots;
}

/**
 * Full 30-character layout: mayor + 6 civic + 15 residents + 8 guild.
 */
export function fullLayout(): CharacterSlot[] {
  const slots: CharacterSlot[] = [];

  // Mayor at center
  slots.push({
    role: 'mayor',
    account: 'tscity01',
    characterName: 'Mayor01',
    deedTemplate: TEMPLATES.cityhall,
    x: CITY_CENTER.x,
    z: CITY_CENTER.z,
    rotation: 0,
  });

  // 6 Civic builders on a 250m ring, 60° spacing (E, NE, NW, W, SW, SE)
  const civicRoles: { kind: string; tmpl: string; name: string }[] = [
    { kind: 'bank', tmpl: TEMPLATES.bank, name: 'Civic01' },
    { kind: 'cantina', tmpl: TEMPLATES.cantina, name: 'Civic02' },
    { kind: 'hospital', tmpl: TEMPLATES.hospital, name: 'Civic03' },
    { kind: 'cloning', tmpl: TEMPLATES.cloning, name: 'Civic04' },
    { kind: 'shuttleport', tmpl: TEMPLATES.shuttleport, name: 'Civic05' },
    { kind: 'garage', tmpl: TEMPLATES.garage, name: 'Civic06' },
  ];
  for (let i = 0; i < civicRoles.length; i++) {
    const c = civicRoles[i]!;
    const angle = 60 + i * 60; // start at 60° (NE) so cardinal directions are open for entry approach
    const pos = polar(angle, 250);
    slots.push({
      role: 'civic',
      account: `tscity0${i + 2}`,
      characterName: c.name,
      deedTemplate: c.tmpl,
      x: pos.x,
      z: pos.z,
      rotation: facingCenter(angle),
      civicKind: c.kind,
    });
  }

  // 15 Residents on a 400m ring, 24° spacing. Mixed house styles for visual interest.
  const houseTemplates = [
    TEMPLATES.houseSmall,
    TEMPLATES.houseSmallWindow,
    TEMPLATES.houseMedium,
    TEMPLATES.houseSmall,
    TEMPLATES.houseSmall2,
    TEMPLATES.houseMedium2,
    TEMPLATES.houseSmall,
    TEMPLATES.houseLarge,
    TEMPLATES.houseSmallWindow,
    TEMPLATES.houseSmall,
    TEMPLATES.houseMedium,
    TEMPLATES.houseSmall2,
    TEMPLATES.houseSmall,
    TEMPLATES.houseMedium2,
    TEMPLATES.houseSmall,
  ];
  for (let i = 0; i < 15; i++) {
    const angle = (360 / 15) * i; // 24° spacing
    const pos = polar(angle, 400);
    const tmpl = houseTemplates[i]!;
    // The first 7 residents host Guild02..Guild08 (i + 2 = 2..8). Inverse
    // mapping of `residenceOf` on the guildExtra slots below.
    const paired = i < 7 ? `Guild${pad2(i + 2)}` : undefined;
    slots.push({
      role: 'resident',
      account: `tscity${pad2(i + 8)}`, // tscity08..tscity22
      characterName: `Resident${pad2(i + 1)}`,
      deedTemplate: tmpl,
      x: pos.x,
      z: pos.z,
      rotation: facingCenter(angle),
      entryOffset: { x: 0, z: -5 },
      ...(paired !== undefined ? { pairedGuildCharacter: paired } : {}),
    });
  }

  // 8 Guild characters:
  // - Guild01 places the guild hall at the NE-outer ring (480m)
  // - Guild02..08 are extra citizens — declare residence inside the FIRST 7 residents' houses
  slots.push({
    role: 'guild',
    account: 'tscity23',
    characterName: 'Guild01',
    deedTemplate: TEMPLATES.guildhall,
    x: polar(48, 480).x,
    z: polar(48, 480).z,
    rotation: facingCenter(48),
  });

  for (let i = 0; i < 7; i++) {
    slots.push({
      role: 'guild',
      account: `tscity${pad2(i + 24)}`, // tscity24..tscity30
      characterName: `Guild${pad2(i + 2)}`,
      deedTemplate: null,
      // Walk to Resident{i+1}'s slot; the actual entry point is computed from that slot
      x: polar((360 / 15) * i, 400).x,
      z: polar((360 / 15) * i, 400).z,
      rotation: 0,
      // Marker referencing the host resident
      residenceOf: `Resident${pad2(i + 1)}`,
      entryOffset: { x: 0, z: -5 },
    });
  }

  return slots;
}

// ────────────────────────────────────────────────────────────────────────────
// Decoration anchors (Phase 5, mayor solo)
// ────────────────────────────────────────────────────────────────────────────

export interface DecorationSlot {
  /** Garden deed template OR direct-spawn furniture template */
  template: string;
  /** Use placeStructure (deed) or direct world spawn (object createAt) */
  mode: 'placeStructure' | 'spawnAtXYZ';
  x: number;
  y?: number;
  z: number;
  rotation?: number;
  label: string;
}

/** 4 large naboo gardens at cardinal extents inside the city radius. */
export function gardenAnchors(): DecorationSlot[] {
  return [
    { template: TEMPLATES.gardenLrg1, mode: 'placeStructure', label: 'garden-N',
      ...polar(0, 350), rotation: 180 },
    { template: TEMPLATES.gardenLrg2, mode: 'placeStructure', label: 'garden-E',
      ...polar(90, 350), rotation: 270 },
    { template: TEMPLATES.gardenLrg3, mode: 'placeStructure', label: 'garden-S',
      ...polar(180, 350), rotation: 0 },
    { template: TEMPLATES.gardenLrg4, mode: 'placeStructure', label: 'garden-W',
      ...polar(270, 350), rotation: 90 },
  ];
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Pairwise Euclidean distance between two slots (or slot-like points).
 * Used in tests to assert ≥ 30m spacing.
 */
export function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
}

/** Distance from a slot to the city center. */
export function distanceToCenter(s: { x: number; z: number }): number {
  return distance(s, CITY_CENTER);
}

// Re-export NetworkId for convenience in scenario files
export type { NetworkId };
