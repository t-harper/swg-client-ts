/**
 * CharacterSheet — live, always-current view of the player's character state.
 *
 * Where `snapshot()` is a post-hoc, hashable summary derived from a finished
 * `LifecycleResult`, `CharacterSheet` is the running view of the same state
 * while a script is in-flight. It absorbs every CREO baseline / delta whose
 * `target === playerNetworkId` and every PLAY baseline / delta in the scene
 * (the player has exactly one PlayerObject), then exposes the most-relevant
 * persona fields as plain getters: `health.current`, `cashBalance`,
 * `skills`, `level`, etc.
 *
 * Lifetime: created in `runGameStage` immediately after `CmdStartScene`
 * arrives (so `playerNetworkId` is pinned), torn down at logout. Subscribes
 * to the dispatcher for `BaselinesMessage` / `BatchBaselinesMessage` /
 * `DeltasMessage` and merges typed-decoded data into the in-memory state.
 *
 * Fields that have a real-time signal (driven by baseline + delta wire
 * traffic the server already pushes) read live. Fields that the server only
 * publishes via per-tick HAM updates surface their current+max from the
 * CREO SHARED_NP `totalAttributes` / `totalMaxAttributes` arrays — those
 * arrive as deltas during combat and after restorative effects. Until the
 * first such delta lands (or until the SHARED_NP baseline arrives) the
 * `.max` half stays at 0; the `CREO p1 (CLIENT_SERVER) maxAttributes`
 * fallback supplies a coarser "max ever observed" view.
 *
 * No periodic polling — every field is wire-driven. If a future field
 * requires an explicit `getAttributesBatch`/etc. poll, route it through a
 * 1s `setInterval` set up in `runGameStage` and cancelled at logout.
 */
import type {
  AutoDeltaMapDelta,
  AutoDeltaSetDelta,
  AutoDeltaVectorDelta,
} from '../messages/game/baselines/auto-delta-delta-codecs.js';
import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import { BatchBaselinesMessage } from '../messages/game/baselines/batch-baselines-message.js';
import type { CreatureObjectClientServerBaseline } from '../messages/game/baselines/creature-object-baseline-1.js';
import { CreatureObjectClientServerKind } from '../messages/game/baselines/creature-object-baseline-1.js';
import type {
  CreatureObjectClientServerNpBaseline,
  SkillModEntry,
} from '../messages/game/baselines/creature-object-baseline-4.js';
import { CreatureObjectClientServerNpKind } from '../messages/game/baselines/creature-object-baseline-4.js';
import type { CreatureObjectSharedBaseline } from '../messages/game/baselines/creature-object-baseline-3.js';
import { CreatureObjectSharedKind } from '../messages/game/baselines/creature-object-baseline-3.js';
import type {
  CreatureObjectEffect,
  CreatureObjectSharedNpBaseline,
  PlayerAndShipPair,
} from '../messages/game/baselines/creature-object-baseline-6.js';
import { CreatureObjectSharedNpKind } from '../messages/game/baselines/creature-object-baseline-6.js';
import { DeltasMessage } from '../messages/game/baselines/deltas-message.js';
import type { PlayerObjectClientServerBaseline } from '../messages/game/baselines/player-object-baseline-1.js';
import { PlayerObjectClientServerKind } from '../messages/game/baselines/player-object-baseline-1.js';
import type { PlayerObjectSharedBaseline } from '../messages/game/baselines/player-object-baseline-3.js';
import { PlayerObjectSharedKind } from '../messages/game/baselines/player-object-baseline-3.js';
import type { PlayerObjectSharedNpBaseline } from '../messages/game/baselines/player-object-baseline-6.js';
import { PlayerObjectSharedNpKind } from '../messages/game/baselines/player-object-baseline-6.js';
import type { PlayerObjectFirstParentClientServerBaseline } from '../messages/game/baselines/player-object-baseline-8.js';
import { PlayerObjectFirstParentClientServerKind } from '../messages/game/baselines/player-object-baseline-8.js';
import type { WeaponObjectSharedBaseline } from '../messages/game/baselines/weapon-object-baseline-3.js';
import type { WeaponObjectSharedNpBaseline } from '../messages/game/baselines/weapon-object-baseline-6.js';
import { BaselinePackageIds, ObjectTypeTags } from '../messages/game/baselines/registry.js';
import { AttributeListMessage } from '../messages/game/attribute-list-message.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import {
  ObjControllerSubtypeIds,
  type PostureChangeData,
  PostureChangeKind,
} from '../messages/game/obj-controller/index.js';
import type { NetworkId, Vector3 } from '../types.js';
import type { MessageDispatcher } from './dispatcher.js';
import type { WorldModel } from './world-model.js';

/** A current/max pair for the HAM (Health/Action/Mind) attribute group. */
export interface HamBar {
  current: number;
  max: number;
}

/**
 * Posture display name. Maps from `Postures::Enumerator` (i8) via the
 * `Postures.cpp` cs_postureNames[] table. Returned by `CharacterSheet.posture`
 * for the postures the engine actually uses; unrecognized values surface as
 * `'unknown'`.
 */
export type PostureName =
  | 'standing'
  | 'crouched'
  | 'prone'
  | 'sneaking'
  | 'blocking'
  | 'climbing'
  | 'flying'
  | 'lyingDown'
  | 'sitting'
  | 'skillAnimating'
  | 'drivingVehicle'
  | 'ridingCreature'
  | 'knockedDown'
  | 'incapacitated'
  | 'dead'
  | 'unknown';

/**
 * Mapping from `Postures::Enumerator` (server-side i8) to the `getPostureName`
 * string the engine uses for display. Sourced from `Postures.cpp:19-36`
 * (the cs_postureNames[] array, indexed by enumerator).
 *
 * NOTE: the engine spells `0` as `"upright"`, but the `ScriptContext.Posture`
 * type used by `changePosture()` calls it `'standing'` — that's the
 * client-side `stand` command name. We surface `'standing'` here for
 * symmetry with the existing `Posture` type so users can do
 * `ctx.character.posture === 'standing'` after `ctx.changePosture('standing')`.
 */
const POSTURE_NAMES: Record<number, PostureName> = {
  0: 'standing', // server engine name is 'upright'; surfaced as 'standing' to match `Posture`
  1: 'crouched',
  2: 'prone',
  3: 'sneaking',
  4: 'blocking',
  5: 'climbing',
  6: 'flying',
  7: 'lyingDown',
  8: 'sitting',
  9: 'skillAnimating',
  10: 'drivingVehicle',
  11: 'ridingCreature',
  12: 'knockedDown',
  13: 'incapacitated',
  14: 'dead',
};

/**
 * Map the server's i8 posture enumerator to its display name. Unknown
 * values (e.g. `-1` = Invalid) return `'unknown'`.
 */
export function postureName(enumerator: number): PostureName {
  return POSTURE_NAMES[enumerator] ?? 'unknown';
}

/**
 * Indices into the CREO SHARED_NP `totalAttributes` / `totalMaxAttributes`
 * arrays. SWG's `Attributes::Enumerator` is `Health=0, Constitution=1,
 * Action=2, Stamina=3, Mind=4, Willpower=5` — see
 * `~/code/swg-main/src/engine/shared/library/sharedGame/src/shared/object/Attributes.h`.
 *
 * Only the three primary pools (Health/Action/Mind) get displayed on the
 * HAM bar; Constitution/Stamina/Willpower are "secondary" attributes that
 * regen the primaries.
 */
const ATTR_INDEX = {
  Health: 0,
  Action: 2,
  Mind: 4,
} as const;

/**
 * Group descriptor surfaced on `CharacterSheet.group`. Members are the
 * NetworkIds of the GroupObject's members; the GroupObject baseline isn't
 * decoded today, so we just surface the groupId (and an empty members[]).
 *
 * If a future GroupObjectShared baseline decoder lands, populate `members`
 * by looking up the GroupObject in the WorldModel and reading its
 * `members: NetworkId[]` field.
 */
export interface CharacterGroup {
  id: NetworkId;
  members: ReadonlyArray<NetworkId>;
}

/**
 * Inviter for a pending group invite. Set when the server pushes a
 * `m_groupInviter` AutoDeltaVariable (PlayerAndShipPair) with non-zero
 * `inviter`. Cleared once the invite resolves (accepted or declined).
 */
export interface CharacterGroupInviter {
  id: NetworkId;
  name: string;
}

/**
 * One active visual/buff effect on the character.
 *
 * Derived from CREO p6 `m_buffs` (an AutoDeltaMap<u32, PackedBuff>) since
 * the TANO p6 `m_effectsMap` is for visual overlay metadata (effectScript +
 * hardpoint + offset + scale) not buff timing data. `m_buffs` carries the
 * real endtime / value / duration the user is asking about.
 *
 * The `name` is a hex-string CRC because we don't currently maintain a
 * buff-CRC → buff-name table. Compute the CRC of the buff name (e.g.
 * `crc32('mind_focus_buff_a')`) to match. The buff name table lives in
 * `dsrc/.../datatables/buff/buff.tab` server-side.
 *
 * `expiresAt` is a wall-clock epoch in seconds (server time at the time
 * the baseline was packed).
 */
export interface CharacterEffect {
  /** Hex string of the buff-name CRC (no `0x` prefix). */
  name: string;
  /** Magnitude (skillmod amount, percent, etc.); buff-specific interpretation. */
  magnitude: number;
  /** Original duration in seconds. */
  durationSec: number;
  /** Server epoch (seconds) when the buff expires. */
  expiresAt: number;
}

/**
 * Live view of the player's currently-equipped weapon. Joins
 * `state.currentWeapon` (from CREO p6 m_currentWeapon) with the weapon
 * object's WEAO baselines tracked in the `WorldModel`, plus any
 * `AttributeListMessage` the script has fetched via
 * `ctx.fetchResourceAttributes([weaponId])` (the only way to surface
 * min/max raw damage and ammo count — those are server-only baselines).
 *
 * `null` until the weapon's WEAO baselines arrive.
 */
export interface CharacterWeapon {
  /** Weapon NetworkId. */
  networkId: NetworkId;
  /** Server template path (e.g. `'object/weapon/melee/sword/sword_curved.iff'`). */
  templateName: string | null;
  /**
   * Minimum raw damage per hit. `null` if no `AttributeListMessage` has
   * landed for this weapon — only the AttributeList path carries `min_dmg`
   * (the WEAO baseline package keeps min/max damage server-only).
   */
  minDamage: number | null;
  /** Maximum raw damage per hit. `null` until an AttributeListMessage lands. */
  maxDamage: number | null;
  /** Seconds between attacks (lower = faster). From WEAO p3 m_attackSpeed. */
  attackSpeed: number;
  /** Maximum effective range in metres. From WEAO p3 m_maxRange. */
  range: number;
  /**
   * Remaining ammo / power-up charges. `null` if no AttributeListMessage
   * has landed OR the weapon has no charge attribute.
   */
  ammoRemaining: number | null;
}

/**
 * Live view of the player's NGE roadmap progress.
 *
 * `currentPhase` and `currentTask` are derived from `m_workingSkill`
 * (PLAY p8) by splitting on the `class_<class>_phaseN_<task>` naming
 * convention used by the NPE roadmap datatables. `tasksRemaining` is
 * computed from the `m_activeQuests` and `m_completedQuests` BitArrays
 * — for now we report 0 (no quest-bit table is loaded). Returns `null`
 * until the first PLAY p8 baseline arrives.
 */
export interface CharacterRoadmap {
  /** Phase string (e.g. `'phase1'`); empty if the workingSkill string is non-standard. */
  currentPhase: string;
  /** Task string (e.g. `'novice'`); empty for non-standard skills. */
  currentTask: string;
  /** Active-quest bit count from PLAY p8 m_activeQuests (proxy for remaining tasks). */
  tasksRemaining: number;
}

/**
 * Live view of the player's faction.
 *
 * `type` mirrors CREO p3 `m_pvpType` (`0 = Neutral`, `1 = Imperial`,
 * `2 = Rebel`). `name` is the canonical lowercase label.
 * `pvpStatus` is CREO p3 `m_pvpType` again (the historical field name —
 * the engine doesn't separate "type" from "status" on the wire; the
 * `pvpType` field IS the active-flag enum). `standing` is the player's
 * primary GCW standing, taken from PLAY p3 `m_currentGcwPoints`.
 */
export interface CharacterFaction {
  /** `0 = neutral`, `1 = imperial`, `2 = rebel`. */
  type: number;
  /** `'neutral'` / `'imperial'` / `'rebel'`; `'unknown'` for unrecognized type values. */
  name: string;
  /** GCW standing (current GCW points; PLAY p3). */
  standing: number;
  /** PvP status enum (same as `type` — kept for callsite symmetry). */
  pvpStatus: number;
}

/**
 * Live view of the character's current performance (song / dance).
 *
 * `performing` is the authoritative "is a performance active" flag —
 * `m_performanceType` (CREO p6) being non-zero. `type` is the song/dance
 * id; `animatingSkillData` is the raw skill-animation string the server set
 * (e.g. `'music_3'`).
 */
export interface CharacterPerformance {
  /** True when a song or dance performance is currently active. */
  performing: boolean;
  /** Performance id from CREO p6 `m_performanceType`; `0` when idle. */
  type: number;
  /** Server epoch (seconds) the performance started; `0` when idle. */
  startTime: number;
  /** Skill-animation data string (e.g. `'music_3'`); `''` when idle. */
  animatingSkillData: string;
  /** Animation mood string (e.g. `'neutral'`). */
  animationMood: string;
}

/**
 * The live character-sheet view. All fields are getters — reading
 * `ctx.character.health.current` returns the latest known value derived
 * from baselines + deltas applied so far.
 */
export interface CharacterSheet {
  /** True once the first CREO baseline for the player has been received. */
  readonly ready: boolean;
  /** Player's NetworkId — always set; pinned at construction. */
  readonly networkId: NetworkId;
  /** Display name (UnicodeString from CREO p3 m_objectName). `null` until first SHARED baseline. */
  readonly name: string | null;
  /** Server template path (e.g. 'object/creature/player/human_male.iff'). `null` until first WorldModel observation. */
  readonly templateName: string | null;
  /** Combat level (CREO p6 m_level). `0` until first SHARED_NP arrives. */
  readonly level: number;
  /** Skill-derived title (PLAY p3 m_skillTitle). `null` until first PLAY SHARED arrives. */
  readonly skillTitle: string | null;
  /**
   * Current posture as a display string. `'standing'` initially because the
   * default i8 enumerator is 0 (Upright); switches to e.g. `'sitting'` /
   * `'crouched'` after a CREO p3 delta lands.
   */
  readonly posture: PostureName;
  /** Mood enum value (CREO p6 m_mood). `0` initially. */
  readonly mood: number;
  /** Faction (CREO p3 m_pvpType — `1=Player`, `2=Imperial`, `3=Rebel`, etc.). `0` initially. */
  readonly faction: number;
  /** Bank balance in credits. `0` until either CREO p1 or PLAY p1 lands. */
  readonly bankBalance: number;
  /** Cash-on-hand balance in credits. `0` until either CREO p1 or PLAY p1 lands. */
  readonly cashBalance: number;
  /** Cumulative seconds played across all sessions (PLAY p3 m_playedTime). `0` initially. */
  readonly playedTime: number;
  /**
   * Trained skill names (CREO p1 m_skills — AutoDeltaSet<SkillObject*>).
   * Empty list until CREO p1 (CLIENT_SERVER, auth-only) lands.
   */
  readonly skills: ReadonlyArray<string>;
  /**
   * Health pool (current + max). `current` is from CREO p6 m_totalAttributes[0];
   * `max` is from CREO p6 m_totalMaxAttributes[0] (preferred — accounts for
   * buffs) or falls back to CREO p1 m_maxAttributes[0] (the unmodified cap).
   * Both halves stay at 0 until the relevant baselines / deltas arrive.
   */
  readonly health: HamBar;
  /** Action pool — same semantics as `health`, but for attribute index 2. */
  readonly action: HamBar;
  /** Mind pool — same semantics as `health`, but for attribute index 4. */
  readonly mind: HamBar;
  /** Currently-equipped weapon NetworkId (CREO p6 m_currentWeapon). `null` if unarmed. */
  readonly currentWeapon: NetworkId | null;
  /** GroupObject NetworkId (CREO p6 m_group). `null` if not in a group. */
  readonly groupId: NetworkId | null;
  /**
   * Numeric guild id (CREO p6 m_guildId). `0` when the player isn't in a
   * guild. (Surfaced as a plain number rather than `number | null`
   * because the wire field is i32 with 0 = "no guild" — see GuildObject
   * usage in GuildObject.cpp:getGuildId.)
   */
  readonly guildId: number;
  /**
   * Name of the city the player is a citizen of (PLAY p6 m_citizenshipCity).
   * `null` when the player is not a citizen of any city. Updated by the
   * server's `city.addCitizen` path — which is what
   * `useAbility('declareresidence')` triggers via `city.setCityResidence`
   * (`~/code/swg-main/dsrc/sku.0/sys.server/compiled/game/script/library/city.java:620`
   * and `player_building.java:2583`). The deterministic typed signal that
   * declare-residence actually took effect server-side.
   */
  readonly cityName: string | null;
  /**
   * Citizenship type enum (PLAY p6 m_citizenshipType — `CityDataCitizenType`).
   * `0` when not a citizen. Useful for distinguishing mayor / militia / etc.
   * from a plain resident; see the `CityDataCitizenType` enum in
   * `~/code/swg-main/src/engine/shared/library/sharedGame/`.
   */
  readonly citizenType: number;
  /**
   * Lightweight group descriptor when in a group. `members[]` is empty until
   * GroupObject baselines get a typed decoder; for now consumers can use
   * `ctx.world.get(groupId)` to inspect the raw GroupObject baseline state.
   */
  readonly group: CharacterGroup | null;
  /** Pending group inviter (CREO p6 m_groupInviter). `null` when no invite is pending. */
  readonly groupInviter: CharacterGroupInviter | null;
  /**
   * Player's current world position. Sourced from the WorldModel — reflects
   * the most-recent transform broadcast for the player's CREO object.
   * Returns `{x:0,y:0,z:0}` until the first transform arrives (the spawn
   * coordinate from `CmdStartScene` is on the orchestrator's pose cursor,
   * not on the WorldModel until the server echoes the position back).
   */
  readonly position: Readonly<Vector3>;
  /**
   * Calculated skill-mods — name → `(base + bonus)` for every entry in
   * CREO p4 `m_modMap`. Empty until the first CREO p4 baseline lands.
   *
   * Keys include things like `'pistol_accuracy'`, `'strength_modified'`,
   * `'slope_movement_percent'`. The total returned here matches the value
   * the server's `CreatureObject::getEnhancedModValue(name)` would return:
   * `base + min(bonus, ConfigSharedGame::getMaxCreatureSkillModBonus())`.
   *
   * Use `ctx.character.skillMods.get('pistol_accuracy')` for quick reads.
   */
  readonly skillMods: ReadonlyMap<string, number>;
  /**
   * Experience-point map — category name → cumulative XP earned. Empty
   * until the first PLAY p8 baseline lands.
   *
   * Categories include `'combat_general'`, `'crafting_artisan'`,
   * `'combat_brawler'`, profession-specific XP buckets, etc. Updated by
   * PLAY p8 deltas as the server grants XP.
   */
  readonly xp: ReadonlyMap<string, number>;
  /**
   * Active buff effects on the character. Derived from CREO p6 `m_buffs`
   * (an AutoDeltaMap<u32, PackedBuff>). Each entry's `expiresAt` is the
   * server epoch (seconds) when the buff drops.
   *
   * Empty until the first CREO p6 baseline lands.
   */
  readonly effects: ReadonlyArray<CharacterEffect>;
  /**
   * Currently-equipped weapon enriched with WEAO baseline data. `null`
   * if unarmed or if the weapon's WEAO baselines haven't arrived yet.
   *
   * `attackSpeed` / `range` come from WEAO p3. `minDamage` / `maxDamage` /
   * `ammoRemaining` come from the most recent `AttributeListMessage` for
   * the weapon (call `ctx.fetchResourceAttributes([weaponId])` to trigger
   * one); they're `null` until that happens.
   */
  readonly weapon: CharacterWeapon | null;
  /**
   * NGE roadmap progress. `null` until the first PLAY p8 baseline arrives.
   *
   * `currentPhase` / `currentTask` are parsed from `m_workingSkill`.
   * `tasksRemaining` is the number of active-quest bits in PLAY p8
   * `m_activeQuests` (proxy for "tasks the player still has to complete").
   */
  readonly roadmap: CharacterRoadmap | null;
  /**
   * Faction details. `type` mirrors CREO p3 `m_pvpType`; `name` is the
   * canonical label; `standing` is PLAY p3 `m_currentGcwPoints`;
   * `pvpStatus` is `pvpType` again (no separate wire field).
   *
   * Always present — defaults to `{ type: 0, name: 'neutral', standing: 0, pvpStatus: 0 }`
   * before any baseline lands.
   */
  readonly factionDetails: CharacterFaction;
  /**
   * Computed heading (radians, atan2-style) derived from the player's most
   * recent two `CM_netUpdateTransform` sends. Defaults to `0` when fewer than
   * two transforms have been sent (idle character) or when the two transforms
   * are at the same x/z (post-walk, character standing still).
   *
   * Sourced from the dispatcher's transcript — looks back at the last two
   * outbound `ObjControllerMessage(CM_netUpdateTransform=113)` sends and
   * computes `atan2(dx, dz)`. The cell-relative variant
   * `CM_netUpdateTransformWithParent=241` is also considered.
   */
  readonly heading: number;
  /**
   * Sugar for `ctx.location.cell !== null` — true when the player is
   * currently parented inside a cell (interior), false outdoors.
   *
   * Wired up via `CharacterSheetOptions.isInCell()`; when no callback is
   * supplied this always reads `false` (the bare CharacterSheet doesn't
   * know about cells on its own).
   */
  readonly inCell: boolean;
  /**
   * Current performance state (song / dance). `performance.performing` is
   * the authoritative "is the character performing" flag — derived from
   * CREO p6 `m_performanceType`. Defaults to `performing: false` before any
   * SHARED_NP baseline lands.
   */
  readonly performance: CharacterPerformance;
  /** Snapshot all readable fields as a plain JSON-safe object. */
  toJSON(): Record<string, unknown>;
}

/**
 * Internal handle used by `runGameStage` to construct the sheet, wire it
 * into the dispatcher, and detach it at logout.
 *
 * Exposed via `createCharacterSheet`; consumer scripts only ever see the
 * `CharacterSheet` interface above (the `_internals` half is for the
 * orchestrator).
 */
export interface CharacterSheetHandle {
  /** The live view scripts hold. */
  readonly view: CharacterSheet;
  /** Unsubscribe from dispatcher events. Call at logout / teardown. */
  detach(): void;
}

/**
 * Options for `createCharacterSheet`. `playerNetworkId` is the only required
 * field; `world` lets the sheet read live position out of the WorldModel.
 */
export interface CharacterSheetOptions {
  dispatcher: MessageDispatcher;
  playerNetworkId: NetworkId;
  /** Optional — used for live `position` lookups. */
  world?: WorldModel;
  /** Optional — captured at construction to seed `templateName`. */
  templateName?: string;
  /**
   * Optional callback consulted by `view.inCell` getter. Provided by the
   * script-context factory so the character sheet can surface a sugar form
   * of `ctx.location.cell !== null` without depending on `LocationView`
   * (which lives in a higher-level module and would create an import cycle).
   *
   * Defaults to `() => false` when not supplied.
   */
  isInCell?: () => boolean;
  /**
   * Optional callback that returns the heading (radians, atan2-style)
   * computed from the player's recent movement. Provided by the script
   * context factory which has the orchestrator's pose history.
   *
   * Defaults to `() => 0` when not supplied (a bare character sheet has no
   * movement history to compute from).
   */
  getHeading?: () => number;
}

/** Mutable backing store; getters on `CharacterSheet` read from this. */
interface SheetState {
  ready: boolean;
  name: string | null;
  templateName: string | null;
  level: number;
  skillTitle: string | null;
  posture: number;
  mood: number;
  faction: number;
  bankBalanceCreo: number | null;
  bankBalancePlay: number | null;
  cashBalanceCreo: number | null;
  cashBalancePlay: number | null;
  playedTime: number;
  skills: string[];
  totalAttributes: number[];
  totalMaxAttributes: number[];
  maxAttributesCreoP1: number[];
  currentWeapon: NetworkId;
  groupId: NetworkId;
  guildId: number;
  /** PLAY p6 m_citizenshipCity (string; `''` when no citizenship). */
  citizenshipCity: string;
  /** PLAY p6 m_citizenshipType (i8 CityDataCitizenType enum; `0` when none). */
  citizenshipType: number;
  groupInviter: PlayerAndShipPair | null;
  /** CREO p4 m_modMap (skill-mod table). Empty until p4 baseline lands. */
  skillMods: Map<string, { base: number; bonus: number }>;
  /** PLAY p8 m_experiencePoints (XP per category). Empty until p8 baseline lands. */
  xp: Map<string, number>;
  /** CREO p6 m_buffs (active effects). Empty until p6 baseline lands. */
  buffs: Map<number, { endtime: number; value: number; duration: number }>;
  /** TANO/CREO p6 m_effectsMap (visual effects metadata). Empty until p6 baseline lands. */
  visualEffects: CreatureObjectEffect[];
  /** PLAY p8 m_workingSkill (NGE roadmap). Null until p8 baseline lands. */
  workingSkill: string | null;
  /** PLAY p8 m_activeQuests bit count (roadmap tasks remaining). */
  activeQuestsBitCount: number;
  /** PLAY p3 m_currentGcwPoints (faction standing). */
  currentGcwPoints: number;
  /** CREO p6 m_performanceType (song/dance id; 0 = not performing). */
  performanceType: number;
  /** CREO p6 m_performanceStartTime (server epoch seconds; 0 = idle). */
  performanceStartTime: number;
  /** CREO p6 m_animatingSkillData (skill-animation string; '' = idle). */
  animatingSkillData: string;
  /** CREO p6 m_animationMood (animation mood string). */
  animationMood: string;
  /**
   * Per-weapon-id cache of the most recent `AttributeListMessage`. Populated
   * by the AttributeListMessage subscription whenever an attribute response
   * arrives for the currently-equipped weapon (or any other object — we
   * cache them all because the player may equip a different weapon later).
   */
  weaponAttributes: Map<NetworkId, Map<string, string>>;
}

function makeState(templateName: string | null): SheetState {
  return {
    ready: false,
    name: null,
    templateName,
    level: 0,
    skillTitle: null,
    posture: 0,
    mood: 0,
    faction: 0,
    bankBalanceCreo: null,
    bankBalancePlay: null,
    cashBalanceCreo: null,
    cashBalancePlay: null,
    playedTime: 0,
    skills: [],
    totalAttributes: [],
    totalMaxAttributes: [],
    maxAttributesCreoP1: [],
    currentWeapon: 0n,
    groupId: 0n,
    guildId: 0,
    citizenshipCity: '',
    citizenshipType: 0,
    groupInviter: null,
    skillMods: new Map(),
    xp: new Map(),
    buffs: new Map(),
    visualEffects: [],
    workingSkill: null,
    activeQuestsBitCount: 0,
    currentGcwPoints: 0,
    performanceType: 0,
    performanceStartTime: 0,
    animatingSkillData: '',
    animationMood: '',
    weaponAttributes: new Map(),
  };
}

/**
 * Construct a live `CharacterSheet` + dispatcher subscriptions. Call
 * `handle.detach()` once at logout to stop listening.
 */
export function createCharacterSheet(opts: CharacterSheetOptions): CharacterSheetHandle {
  const state = makeState(opts.templateName ?? null);
  const playerNetworkId = opts.playerNetworkId;
  const world = opts.world;

  // ── Per-package apply functions ────────────────────────────────────
  // Each accepts a `Partial<T>` (baseline first arrives as the full shape;
  // subsequent deltas arrive as sparse subsets of the same shape).

  function applyCreoShared(data: Partial<CreatureObjectSharedBaseline>): void {
    if (data.objectName !== undefined) state.name = data.objectName === '' ? null : data.objectName;
    if (data.posture !== undefined) state.posture = data.posture;
    if (data.pvpType !== undefined) state.faction = data.pvpType;
  }

  function applyCreoSharedNp(data: Partial<CreatureObjectSharedNpBaseline>): void {
    if (data.level !== undefined) state.level = data.level;
    if (data.mood !== undefined) state.mood = data.mood;
    if (data.currentWeapon !== undefined) state.currentWeapon = data.currentWeapon;
    if (data.group !== undefined) state.groupId = data.group;
    if (data.guildId !== undefined) state.guildId = data.guildId;
    if (data.groupInviter !== undefined) {
      // The server signals "no pending invite" by clearing `inviter` to 0n.
      state.groupInviter = data.groupInviter.inviter === 0n ? null : data.groupInviter;
    }
    // totalAttributes / totalMaxAttributes carry either the full int[] (from a
    // baseline) or a list of AutoDeltaVector commands (from a delta). Detect
    // shape via the first element: a plain number => baseline; an object with
    // a `kind` discriminator => delta-command list.
    if (data.totalAttributes !== undefined) {
      state.totalAttributes = applyVectorI32(state.totalAttributes, data.totalAttributes);
    }
    if (data.totalMaxAttributes !== undefined) {
      state.totalMaxAttributes = applyVectorI32(state.totalMaxAttributes, data.totalMaxAttributes);
    }
    // Buffs (m_buffs: AutoDeltaMap<u32, PackedBuff>) — feeds `ctx.character.effects`.
    if (data.buffs !== undefined) {
      applyBuffsField(state.buffs, data.buffs);
    }
    // Visual effects (m_effectsMap from TANO p6 — inherited into CREO p6).
    if (data.effects !== undefined) {
      state.visualEffects = applyVisualEffects(state.visualEffects, data.effects);
    }
    // Performance state (song / dance) — drives `view.performance`.
    if (data.performanceType !== undefined) state.performanceType = data.performanceType;
    if (data.performanceStartTime !== undefined) {
      state.performanceStartTime = data.performanceStartTime;
    }
    if (data.animatingSkillData !== undefined) {
      state.animatingSkillData = data.animatingSkillData;
    }
    if (data.animationMood !== undefined) state.animationMood = data.animationMood;
  }

  function applyCreoClientServerNp(
    data: Partial<CreatureObjectClientServerNpBaseline>,
  ): void {
    if (data.modMap !== undefined) {
      applyModMapField(state.skillMods, data.modMap);
    }
  }

  function applyPlayFirstParentClientServer(
    data: Partial<PlayerObjectFirstParentClientServerBaseline>,
  ): void {
    if (data.experiencePoints !== undefined) {
      applyXpField(state.xp, data.experiencePoints);
    }
    if (data.workingSkill !== undefined) {
      state.workingSkill = data.workingSkill;
    }
    if (data.activeQuests !== undefined) {
      // BitArray; count populated bits to approximate tasks remaining.
      const ba = data.activeQuests as { numInUseBits?: number; bytes?: Uint8Array };
      if (ba && typeof ba.numInUseBits === 'number' && ba.bytes instanceof Uint8Array) {
        state.activeQuestsBitCount = countSetBits(ba.bytes, ba.numInUseBits);
      }
    }
  }

  function applyCreoClientServer(data: Partial<CreatureObjectClientServerBaseline>): void {
    if (data.bankBalance !== undefined) state.bankBalanceCreo = data.bankBalance;
    if (data.cashBalance !== undefined) state.cashBalanceCreo = data.cashBalance;
    if (data.skills !== undefined) {
      state.skills = applySetString(state.skills, data.skills).filter((s) => s !== '');
    }
    if (data.maxAttributes !== undefined) {
      state.maxAttributesCreoP1 = applyVectorI32(state.maxAttributesCreoP1, data.maxAttributes);
    }
  }

  function applyPlayShared(data: Partial<PlayerObjectSharedBaseline>): void {
    if (data.skillTitle !== undefined) {
      state.skillTitle = data.skillTitle === '' ? null : data.skillTitle;
    }
    if (data.playedTime !== undefined) state.playedTime = data.playedTime;
    if (data.currentGcwPoints !== undefined) {
      state.currentGcwPoints = data.currentGcwPoints;
    }
  }

  function applyPlaySharedNp(data: Partial<PlayerObjectSharedNpBaseline>): void {
    if (data.citizenshipCity !== undefined) state.citizenshipCity = data.citizenshipCity;
    if (data.citizenshipType !== undefined) state.citizenshipType = data.citizenshipType;
  }

  function applyPlayClientServer(data: Partial<PlayerObjectClientServerBaseline>): void {
    if (data.bankBalance !== undefined) state.bankBalancePlay = data.bankBalance;
    if (data.cashBalance !== undefined) state.cashBalancePlay = data.cashBalance;
  }

  // ── Dispatcher hooks ───────────────────────────────────────────────
  // For CREO targeted at the player networkId, route by packageId+kind.
  // For PLAY, every baseline/delta in the scene corresponds to a player —
  // and there's exactly one PlayerObject baseline pushed to us (our own).

  function consumeBaseline(m: BaselinesMessage): void {
    const decoded = m.decodedBaseline;
    if (decoded === null) return;
    const isPlayerCreo = m.typeId === ObjectTypeTags.CREO && m.target === playerNetworkId;
    const isPlayObj = m.typeId === ObjectTypeTags.PLAY;
    if (!isPlayerCreo && !isPlayObj) return;
    switch (decoded.kind) {
      case CreatureObjectSharedKind:
        applyCreoShared(decoded.data as CreatureObjectSharedBaseline);
        state.ready = true;
        break;
      case CreatureObjectSharedNpKind:
        applyCreoSharedNp(decoded.data as CreatureObjectSharedNpBaseline);
        state.ready = true;
        break;
      case CreatureObjectClientServerKind:
        applyCreoClientServer(decoded.data as CreatureObjectClientServerBaseline);
        state.ready = true;
        break;
      case CreatureObjectClientServerNpKind:
        applyCreoClientServerNp(decoded.data as CreatureObjectClientServerNpBaseline);
        state.ready = true;
        break;
      case PlayerObjectSharedKind:
        applyPlayShared(decoded.data as PlayerObjectSharedBaseline);
        break;
      case PlayerObjectSharedNpKind:
        applyPlaySharedNp(decoded.data as PlayerObjectSharedNpBaseline);
        break;
      case PlayerObjectClientServerKind:
        applyPlayClientServer(decoded.data as PlayerObjectClientServerBaseline);
        break;
      case PlayerObjectFirstParentClientServerKind:
        applyPlayFirstParentClientServer(
          decoded.data as PlayerObjectFirstParentClientServerBaseline,
        );
        break;
      default:
        // Unrelated baseline kind — ignore.
        break;
    }
  }

  function consumeDelta(m: DeltasMessage): void {
    const decoded = m.decodedDelta;
    if (decoded === null) return;
    const isPlayerCreo = m.typeId === ObjectTypeTags.CREO && m.target === playerNetworkId;
    const isPlayObj = m.typeId === ObjectTypeTags.PLAY;
    if (!isPlayerCreo && !isPlayObj) return;
    const data = decoded.data as Record<string, unknown>;
    // Delta `kind` strings are e.g. 'CreatureObjectShared', 'CreatureObjectSharedNpDelta'.
    // They differ from the baseline kinds — but the packageId on the envelope
    // pinpoints which package this is. Use packageId for routing.
    if (m.typeId === ObjectTypeTags.CREO && m.target === playerNetworkId) {
      switch (m.packageId) {
        case BaselinePackageIds.SHARED:
          applyCreoShared(data as Partial<CreatureObjectSharedBaseline>);
          break;
        case BaselinePackageIds.SHARED_NP:
          applyCreoSharedNp(data as Partial<CreatureObjectSharedNpBaseline>);
          break;
        case BaselinePackageIds.CLIENT_SERVER:
          applyCreoClientServer(data as Partial<CreatureObjectClientServerBaseline>);
          break;
        case BaselinePackageIds.CLIENT_SERVER_NP:
          applyCreoClientServerNp(data as Partial<CreatureObjectClientServerNpBaseline>);
          break;
        default:
          break;
      }
    } else if (m.typeId === ObjectTypeTags.PLAY) {
      switch (m.packageId) {
        case BaselinePackageIds.SHARED:
          applyPlayShared(data as Partial<PlayerObjectSharedBaseline>);
          break;
        case BaselinePackageIds.SHARED_NP:
          applyPlaySharedNp(data as Partial<PlayerObjectSharedNpBaseline>);
          break;
        case BaselinePackageIds.CLIENT_SERVER:
          applyPlayClientServer(data as Partial<PlayerObjectClientServerBaseline>);
          break;
        case BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER:
          applyPlayFirstParentClientServer(
            data as Partial<PlayerObjectFirstParentClientServerBaseline>,
          );
          break;
        default:
          break;
      }
    }
  }

  // Posture changes for the player commonly arrive as
  // `ObjControllerMessage(CM_setPosture=305)` rather than (or in addition
  // to) a CREO p3 delta. On the live server self-initiated posture changes
  // sometimes don't propagate the AutoDeltaVariable back to the same
  // client — only the `CM_setPosture` ObjController fires reliably. Listen
  // for both so the view stays accurate regardless of which path the server
  // chose.
  function consumeObjController(m: ObjControllerMessage): void {
    if (m.networkId !== playerNetworkId) return;
    if (m.message !== ObjControllerSubtypeIds.CM_setPosture) return;
    if (m.decodedSubtype?.kind !== PostureChangeKind) return;
    const data = m.decodedSubtype.data as PostureChangeData;
    state.posture = data.posture;
  }

  // AttributeListMessage carries (key, localized-value) pairs the server
  // emits in response to `getAttributesBatch`. Cache the most recent table
  // per object id so the `weapon` view can extract min_dmg / max_dmg / ammo
  // when the player equips a weapon (the WEAO baseline package keeps raw
  // damage server-only, so this is the only client-side source).
  function consumeAttributeList(m: AttributeListMessage): void {
    const tbl = new Map<string, string>();
    for (const pair of m.data) tbl.set(pair.key, pair.value);
    state.weaponAttributes.set(m.networkId, tbl);
  }

  const unsubscribers: Array<() => void> = [
    opts.dispatcher.onMessage(BaselinesMessage, consumeBaseline),
    opts.dispatcher.onMessage(BatchBaselinesMessage, (m) => {
      for (const b of m.baselines) consumeBaseline(b);
    }),
    opts.dispatcher.onMessage(DeltasMessage, consumeDelta),
    opts.dispatcher.onMessage(ObjControllerMessage, consumeObjController),
    opts.dispatcher.onMessage(AttributeListMessage, consumeAttributeList),
  ];

  // ── Getter-bound view ──────────────────────────────────────────────
  // `current` from totalAttributes (SHARED_NP, real-time); `max` from
  // totalMaxAttributes (preferred — includes buffs) or maxAttributes (the
  // unbuffed CREO p1 fallback).
  function hamFor(index: number): HamBar {
    const current = state.totalAttributes[index] ?? 0;
    const maxNp = state.totalMaxAttributes[index];
    const maxP1 = state.maxAttributesCreoP1[index];
    const max = (maxNp ?? maxP1 ?? 0) || 0;
    return { current, max };
  }

  function preferPlayElseCreoMoney(play: number | null, creo: number | null): number {
    if (play !== null) return play;
    if (creo !== null) return creo;
    return 0;
  }

  const view: CharacterSheet = {
    get ready(): boolean {
      return state.ready;
    },
    get networkId(): NetworkId {
      return playerNetworkId;
    },
    get name(): string | null {
      return state.name;
    },
    get templateName(): string | null {
      if (state.templateName !== null) return state.templateName;
      const obj = world?.get(playerNetworkId);
      return obj?.templateName ?? null;
    },
    get level(): number {
      return state.level;
    },
    get skillTitle(): string | null {
      return state.skillTitle;
    },
    get posture(): PostureName {
      return postureName(state.posture);
    },
    get mood(): number {
      return state.mood;
    },
    get faction(): number {
      return state.faction;
    },
    get bankBalance(): number {
      return preferPlayElseCreoMoney(state.bankBalancePlay, state.bankBalanceCreo);
    },
    get cashBalance(): number {
      return preferPlayElseCreoMoney(state.cashBalancePlay, state.cashBalanceCreo);
    },
    get playedTime(): number {
      return state.playedTime;
    },
    get skills(): ReadonlyArray<string> {
      return state.skills;
    },
    get health(): HamBar {
      return hamFor(ATTR_INDEX.Health);
    },
    get action(): HamBar {
      return hamFor(ATTR_INDEX.Action);
    },
    get mind(): HamBar {
      return hamFor(ATTR_INDEX.Mind);
    },
    get currentWeapon(): NetworkId | null {
      return state.currentWeapon === 0n ? null : state.currentWeapon;
    },
    get groupId(): NetworkId | null {
      return state.groupId === 0n ? null : state.groupId;
    },
    get guildId(): number {
      return state.guildId;
    },
    get cityName(): string | null {
      return state.citizenshipCity === '' ? null : state.citizenshipCity;
    },
    get citizenType(): number {
      return state.citizenshipType;
    },
    get group(): CharacterGroup | null {
      if (state.groupId === 0n) return null;
      // Members aren't decoded yet — the GroupObject baseline carries them
      // but we don't expose a typed decode here. Surface an empty list so
      // callers can detect "in a group" without needing to inspect raw bytes.
      return { id: state.groupId, members: [] };
    },
    get groupInviter(): CharacterGroupInviter | null {
      const inv = state.groupInviter;
      if (inv === null) return null;
      return { id: inv.inviter, name: inv.inviterName };
    },
    get position(): Readonly<Vector3> {
      const obj = world?.get(playerNetworkId);
      if (obj === undefined) return { x: 0, y: 0, z: 0 };
      return { x: obj.position.x, y: obj.position.y, z: obj.position.z };
    },
    get skillMods(): ReadonlyMap<string, number> {
      // Build a fresh Map on each read — `(base + bonus)`. Cheap (typical
      // modMap is < 100 entries) and keeps the caller from holding stale
      // refs to a mutable internal Map.
      const out = new Map<string, number>();
      for (const [name, pair] of state.skillMods) {
        out.set(name, pair.base + pair.bonus);
      }
      return out;
    },
    get xp(): ReadonlyMap<string, number> {
      // Snapshot copy — same rationale as skillMods.
      return new Map(state.xp);
    },
    get effects(): ReadonlyArray<CharacterEffect> {
      const out: CharacterEffect[] = [];
      for (const [crc, buff] of state.buffs) {
        out.push({
          name: crc.toString(16).padStart(8, '0'),
          magnitude: buff.value,
          durationSec: buff.duration,
          expiresAt: buff.endtime,
        });
      }
      return out;
    },
    get weapon(): CharacterWeapon | null {
      if (state.currentWeapon === 0n) return null;
      if (world === undefined) return null;
      const obj = world.get(state.currentWeapon);
      if (obj === undefined) return null;
      // WEAO p3 baseline (typed). If missing, the weapon is in the world
      // model but its baselines haven't arrived yet — return null.
      const p3 = obj.baselines.get(BaselinePackageIds.SHARED) as
        | Partial<WeaponObjectSharedBaseline>
        | undefined;
      if (p3 === undefined || typeof p3.attackSpeed !== 'number') return null;
      const attrs = state.weaponAttributes.get(state.currentWeapon);
      // Damage keys are server-version-dependent. SWG-NGE servers emit the
      // unified `cat_wpn_damage.damage` value as a "min-max" range string
      // (e.g. "50-200"). Older legacy paths used `wpn_damage_min` /
      // `wpn_damage_max` separately. Check the unified form first; fall
      // back to the legacy form for compatibility.
      const minDamage = attrs ? parseDamageRange(attrs, 'min') : null;
      const maxDamage = attrs ? parseDamageRange(attrs, 'max') : null;
      const ammoRemaining = attrs
        ? parseAttrInt(
            attrs.get('wpn_ammo') ??
              attrs.get('powerup_ammo') ??
              attrs.get('cat_wpn_other.wpn_ammo'),
          )
        : null;
      return {
        networkId: state.currentWeapon,
        templateName: obj.templateName ?? null,
        minDamage,
        maxDamage,
        attackSpeed: p3.attackSpeed ?? 0,
        range: p3.maxRange ?? 0,
        ammoRemaining,
      };
    },
    get roadmap(): CharacterRoadmap | null {
      if (state.workingSkill === null) return null;
      const { phase, task } = parseRoadmapSkill(state.workingSkill);
      return {
        currentPhase: phase,
        currentTask: task,
        tasksRemaining: state.activeQuestsBitCount,
      };
    },
    get factionDetails(): CharacterFaction {
      return {
        type: state.faction,
        name: factionTypeName(state.faction),
        standing: state.currentGcwPoints,
        pvpStatus: state.faction,
      };
    },
    get heading(): number {
      return opts.getHeading?.() ?? 0;
    },
    get inCell(): boolean {
      return opts.isInCell?.() ?? false;
    },
    get performance(): CharacterPerformance {
      return {
        performing: state.performanceType !== 0,
        type: state.performanceType,
        startTime: state.performanceStartTime,
        animatingSkillData: state.animatingSkillData,
        animationMood: state.animationMood,
      };
    },
    toJSON(): Record<string, unknown> {
      const skillModsObj: Record<string, number> = {};
      for (const [name, total] of view.skillMods) skillModsObj[name] = total;
      const xpObj: Record<string, number> = {};
      for (const [cat, amt] of view.xp) xpObj[cat] = amt;
      return {
        ready: view.ready,
        networkId: playerNetworkId.toString(),
        name: view.name,
        templateName: view.templateName,
        level: view.level,
        skillTitle: view.skillTitle,
        posture: view.posture,
        mood: view.mood,
        faction: view.faction,
        bankBalance: view.bankBalance,
        cashBalance: view.cashBalance,
        playedTime: view.playedTime,
        skills: [...view.skills],
        health: { current: view.health.current, max: view.health.max },
        action: { current: view.action.current, max: view.action.max },
        mind: { current: view.mind.current, max: view.mind.max },
        currentWeapon: view.currentWeapon === null ? null : view.currentWeapon.toString(),
        groupId: view.groupId === null ? null : view.groupId.toString(),
        guildId: view.guildId,
        cityName: view.cityName,
        citizenType: view.citizenType,
        groupInviter:
          view.groupInviter === null
            ? null
            : { id: view.groupInviter.id.toString(), name: view.groupInviter.name },
        position: { ...view.position },
        skillMods: skillModsObj,
        xp: xpObj,
        effects: view.effects.map((e) => ({ ...e })),
        weapon:
          view.weapon === null
            ? null
            : {
                networkId: view.weapon.networkId.toString(),
                templateName: view.weapon.templateName,
                minDamage: view.weapon.minDamage,
                maxDamage: view.weapon.maxDamage,
                attackSpeed: view.weapon.attackSpeed,
                range: view.weapon.range,
                ammoRemaining: view.weapon.ammoRemaining,
              },
        roadmap: view.roadmap,
        factionDetails: { ...view.factionDetails },
        heading: view.heading,
        inCell: view.inCell,
        performance: { ...view.performance },
      };
    },
  };

  // Seed from the WorldModel's already-accumulated baselines. A
  // CharacterSheet constructed mid-session — e.g. when the game-stage
  // re-creates the script context for a `reload` — would otherwise have
  // missed the one-time zone-in baseline flood and start blank (`level` 0,
  // no skills). The WorldModel persists across reloads and holds the
  // player's decoded CREO + PlayerObject baselines, so replay them now.
  function seedFromWorld(): void {
    if (world === undefined) return;
    const creo = world.get(playerNetworkId);
    if (creo !== undefined) {
      const p1 = creo.baselines.get(BaselinePackageIds.CLIENT_SERVER);
      const p3 = creo.baselines.get(BaselinePackageIds.SHARED);
      const p4 = creo.baselines.get(BaselinePackageIds.CLIENT_SERVER_NP);
      const p6 = creo.baselines.get(BaselinePackageIds.SHARED_NP);
      if (isDecodedBaseline(p1)) {
        applyCreoClientServer(p1 as Partial<CreatureObjectClientServerBaseline>);
        state.ready = true;
      }
      if (isDecodedBaseline(p3)) {
        applyCreoShared(p3 as Partial<CreatureObjectSharedBaseline>);
        state.ready = true;
      }
      if (isDecodedBaseline(p4)) {
        applyCreoClientServerNp(p4 as Partial<CreatureObjectClientServerNpBaseline>);
        state.ready = true;
      }
      if (isDecodedBaseline(p6)) {
        applyCreoSharedNp(p6 as Partial<CreatureObjectSharedNpBaseline>);
        state.ready = true;
      }
    }
    // The PlayerObject is a separate object — find the (single) PLAY object.
    for (const obj of world.objects()) {
      if (obj.typeId !== ObjectTypeTags.PLAY) continue;
      const p1 = obj.baselines.get(BaselinePackageIds.CLIENT_SERVER);
      const p3 = obj.baselines.get(BaselinePackageIds.SHARED);
      const p6 = obj.baselines.get(BaselinePackageIds.SHARED_NP);
      const p8 = obj.baselines.get(BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER);
      if (isDecodedBaseline(p1)) {
        applyPlayClientServer(p1 as Partial<PlayerObjectClientServerBaseline>);
      }
      if (isDecodedBaseline(p3)) applyPlayShared(p3 as Partial<PlayerObjectSharedBaseline>);
      if (isDecodedBaseline(p6)) applyPlaySharedNp(p6 as Partial<PlayerObjectSharedNpBaseline>);
      if (isDecodedBaseline(p8)) {
        applyPlayFirstParentClientServer(
          p8 as Partial<PlayerObjectFirstParentClientServerBaseline>,
        );
      }
      break;
    }
  }
  seedFromWorld();

  return {
    view,
    detach(): void {
      for (const u of unsubscribers) {
        try {
          u();
        } catch {
          // swallow
        }
      }
      unsubscribers.length = 0;
    },
  };
}

/**
 * Apply a baseline-or-delta payload for an `AutoDeltaVector<i32>` field.
 *
 * If the input is a plain `number[]` (the wire shape for a fresh baseline),
 * replace `current` wholesale. If the input is an array of decoded
 * `AutoDeltaVectorDelta<number>` commands (the wire shape for a
 * `DeltasMessage`), apply each command in order to a copy of `current`.
 *
 * Returns the new array — never mutates `current` in place so the getter
 * cache (which captures `current` by reference) sees consistent reads even
 * if a delta arrives mid-getter-evaluation.
 */
function applyVectorI32(
  current: number[],
  incoming: number[] | AutoDeltaVectorDelta<number>[] | unknown,
): number[] {
  if (!Array.isArray(incoming)) return current;
  if (incoming.length === 0) return [];
  // Detect shape: plain int[] vs command list. Inspect the first element.
  const first = incoming[0];
  if (typeof first === 'number') return [...(incoming as number[])];
  if (first === null || typeof first !== 'object') return current;
  const commands = incoming as AutoDeltaVectorDelta<number>[];
  const next = [...current];
  for (const cmd of commands) {
    switch (cmd.kind) {
      case 'erase':
        next.splice(cmd.index, 1);
        break;
      case 'insert':
        next.splice(cmd.index, 0, cmd.value);
        break;
      case 'set':
        next[cmd.index] = cmd.value;
        break;
      case 'setAll':
        next.length = 0;
        next.push(...cmd.values);
        break;
      case 'clear':
        next.length = 0;
        break;
      default:
        // Unknown command shape — leave `next` alone rather than corrupt it.
        break;
    }
  }
  return next;
}

/**
 * Apply a baseline-or-delta payload for an `AutoDeltaSet<std::string>` field.
 * Same shape-detection trick as `applyVectorI32`: plain `string[]` from a
 * baseline; `AutoDeltaSetDelta<string>[]` from a delta. Returns a new array;
 * preserves order-of-insertion (sets in SWG are not lexicographically sorted
 * on the wire).
 */
function applySetString(
  current: string[],
  incoming: string[] | AutoDeltaSetDelta<string>[] | unknown,
): string[] {
  if (!Array.isArray(incoming)) return current;
  if (incoming.length === 0) return [];
  const first = incoming[0];
  if (typeof first === 'string') return [...(incoming as string[])];
  if (first === null || typeof first !== 'object') return current;
  const commands = incoming as AutoDeltaSetDelta<string>[];
  const next = [...current];
  for (const cmd of commands) {
    switch (cmd.kind) {
      case 'insert':
        if (!next.includes(cmd.value)) next.push(cmd.value);
        break;
      case 'erase': {
        const idx = next.indexOf(cmd.value);
        if (idx >= 0) next.splice(idx, 1);
        break;
      }
      case 'clear':
        next.length = 0;
        break;
      default:
        break;
    }
  }
  return next;
}

/**
 * Apply a baseline-or-delta payload for the CREO p4 `m_modMap` field.
 *
 * Baseline shape: `Array<SkillModEntry>` (decoded by `creature-object-baseline-4.ts`).
 * Delta shape: `Array<AutoDeltaMapDelta<string, {base, bonus}>>` (decoded
 * by `creature-object-delta-4.ts`).
 *
 * Mutates `target` in place — the surrounding state owns the Map so we
 * don't reallocate on every wire update.
 */
function applyModMapField(
  target: Map<string, { base: number; bonus: number }>,
  incoming: SkillModEntry[] | AutoDeltaMapDelta<string, { base: number; bonus: number }>[] | unknown,
): void {
  if (!Array.isArray(incoming)) return;
  if (incoming.length === 0) {
    // Could be either "empty baseline" or "no-op delta". Treat as a baseline
    // replacement: clear the map. If a real delta arrives with 0 commands
    // (which shouldn't happen — the server only sends a DeltasMessage when
    // something changed), the clear is harmless.
    target.clear();
    return;
  }
  const first = incoming[0] as Record<string, unknown>;
  if (typeof first.kind === 'string') {
    // Delta command list.
    const cmds = incoming as AutoDeltaMapDelta<string, { base: number; bonus: number }>[];
    for (const cmd of cmds) {
      switch (cmd.kind) {
        case 'add':
        case 'set':
          target.set(cmd.key, cmd.value);
          break;
        case 'erase':
          target.delete(cmd.key);
          break;
      }
    }
    return;
  }
  // Baseline shape: full replacement.
  target.clear();
  for (const entry of incoming as SkillModEntry[]) {
    target.set(entry.name, { base: entry.base, bonus: entry.bonus });
  }
}

/**
 * Apply a baseline-or-delta payload for the PLAY p8 `m_experiencePoints`
 * field (AutoDeltaMap<string, int>).
 */
function applyXpField(
  target: Map<string, number>,
  incoming: Array<{ category: string; amount: number }> | AutoDeltaMapDelta<string, number>[] | unknown,
): void {
  if (!Array.isArray(incoming)) return;
  if (incoming.length === 0) {
    target.clear();
    return;
  }
  const first = incoming[0] as Record<string, unknown>;
  if (typeof first.kind === 'string') {
    const cmds = incoming as AutoDeltaMapDelta<string, number>[];
    for (const cmd of cmds) {
      switch (cmd.kind) {
        case 'add':
        case 'set':
          target.set(cmd.key, cmd.value);
          break;
        case 'erase':
          target.delete(cmd.key);
          break;
      }
    }
    return;
  }
  target.clear();
  for (const entry of incoming as Array<{ category: string; amount: number }>) {
    target.set(entry.category, entry.amount);
  }
}

/**
 * Apply a baseline-or-delta payload for the CREO p6 `m_buffs` field
 * (AutoDeltaMap<u32 nameCrc, PackedBuff>).
 */
function applyBuffsField(
  target: Map<number, { endtime: number; value: number; duration: number }>,
  incoming:
    | Array<{ buffNameCrc: number; buff: { endtime: number; value: number; duration: number } }>
    | AutoDeltaMapDelta<number, { endtime: number; value: number; duration: number }>[]
    | unknown,
): void {
  if (!Array.isArray(incoming)) return;
  if (incoming.length === 0) {
    target.clear();
    return;
  }
  const first = incoming[0] as Record<string, unknown>;
  if (typeof first.kind === 'string') {
    const cmds = incoming as AutoDeltaMapDelta<
      number,
      { endtime: number; value: number; duration: number }
    >[];
    for (const cmd of cmds) {
      switch (cmd.kind) {
        case 'add':
        case 'set':
          target.set(cmd.key, cmd.value);
          break;
        case 'erase':
          target.delete(cmd.key);
          break;
      }
    }
    return;
  }
  target.clear();
  for (const entry of incoming as Array<{
    buffNameCrc: number;
    buff: { endtime: number; value: number; duration: number };
  }>) {
    target.set(entry.buffNameCrc, entry.buff);
  }
}

/**
 * Apply a baseline-or-delta payload for the CREO p6 / TANO p6 `m_effectsMap`
 * field (visual effect overlays). The baseline form is a `CreatureObjectEffect[]`;
 * the delta form is an `AutoDeltaMapDelta<string, {...}>[]`.
 *
 * Returns a new array — the visual-effects list is small (typical 0-5
 * entries) so re-materializing on each update is cheap.
 */
function applyVisualEffects(
  current: CreatureObjectEffect[],
  incoming:
    | CreatureObjectEffect[]
    | AutoDeltaMapDelta<string, { effectScript: string; hardpoint: string; offset: { x: number; y: number; z: number }; scale: number }>[]
    | unknown,
): CreatureObjectEffect[] {
  if (!Array.isArray(incoming)) return current;
  if (incoming.length === 0) return [];
  const first = incoming[0] as Record<string, unknown>;
  if (typeof first.kind === 'string') {
    // Delta — clone current and apply commands.
    const next = [...current];
    const cmds = incoming as AutoDeltaMapDelta<
      string,
      { effectScript: string; hardpoint: string; offset: { x: number; y: number; z: number }; scale: number }
    >[];
    for (const cmd of cmds) {
      const idx = next.findIndex((e) => e.name === cmd.key);
      switch (cmd.kind) {
        case 'add':
        case 'set': {
          const entry: CreatureObjectEffect = {
            name: cmd.key,
            effectScript: cmd.value.effectScript,
            hardpoint: cmd.value.hardpoint,
            offset: cmd.value.offset,
            scale: cmd.value.scale,
          };
          if (idx >= 0) next[idx] = entry;
          else next.push(entry);
          break;
        }
        case 'erase':
          if (idx >= 0) next.splice(idx, 1);
          break;
      }
    }
    return next;
  }
  return [...(incoming as CreatureObjectEffect[])];
}

/**
 * Count the number of `1` bits in the first `numInUseBits` bits of `bytes`.
 * Used for `PLAY p8 m_activeQuests` (BitArray) → tasks-remaining proxy.
 */
function countSetBits(bytes: Uint8Array, numInUseBits: number): number {
  let count = 0;
  const fullBytes = numInUseBits >> 3;
  const remainBits = numInUseBits & 7;
  for (let i = 0; i < fullBytes && i < bytes.length; i++) {
    let b = bytes[i] ?? 0;
    while (b > 0) {
      count += b & 1;
      b >>= 1;
    }
  }
  if (remainBits > 0 && fullBytes < bytes.length) {
    const mask = (1 << remainBits) - 1;
    let b = (bytes[fullBytes] ?? 0) & mask;
    while (b > 0) {
      count += b & 1;
      b >>= 1;
    }
  }
  return count;
}

/**
 * Parse an attribute-list value cell into an integer.
 *
 * Wire shape: server emits a UnicodeString that's a stringified int or
 * range. For weapon damage the value is typically `"10-50"` (min-max range)
 * — when we want min we take the part before the dash, max takes the part
 * after. For a single int (`"42"`) both parts give 42.
 *
 * The CharacterSheet uses this for `wpn_damage_min` (parses int from "10"
 * or first part of "10-50") and similar straight-int fields.
 */
function parseAttrInt(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  // "@cat_dmg.min:10" style with @ refs are skipped — only handle plain ints.
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // Take the first contiguous digit run (handles "10-50" → "10").
  const m = trimmed.match(/-?\d+/);
  if (m === null) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse weapon damage min OR max from the `AttributeListMessage` table.
 *
 * Server emits weapon damage in two formats depending on era:
 *   - **NGE unified**: `cat_wpn_damage.damage` = `"min-max"` (e.g. `"50-200"`)
 *   - **Legacy split**: `wpn_damage_min` = `"50"` + `wpn_damage_max` = `"200"`
 *
 * Returns `null` if neither form is present.
 */
function parseDamageRange(attrs: Map<string, string>, half: 'min' | 'max'): number | null {
  // Try the legacy split keys first — they're authoritative when present.
  const legacy = half === 'min' ? attrs.get('wpn_damage_min') : attrs.get('wpn_damage_max');
  if (legacy !== undefined) {
    const n = parseAttrInt(legacy);
    if (n !== null) return n;
  }
  // Fall back to the unified `damage` key — typical NGE format "min-max".
  const unified = attrs.get('cat_wpn_damage.damage') ?? attrs.get('damage');
  if (unified === undefined || unified === '') return null;
  const m = unified.match(/(\d+)\s*-\s*(\d+)/);
  if (m !== null) {
    const minStr = m[1];
    const maxStr = m[2];
    if (minStr === undefined || maxStr === undefined) return null;
    const pick = half === 'min' ? minStr : maxStr;
    const n = Number.parseInt(pick, 10);
    return Number.isFinite(n) ? n : null;
  }
  // Single int form (`"42"`) — both halves give the same value.
  return parseAttrInt(unified);
}

/**
 * Parse the NGE `m_workingSkill` string into roadmap phase/task tokens.
 *
 * Standard format: `class_<class>_phase<N>_<task>` — e.g.
 * `class_domestics_phase1_novice` → `{ phase: 'phase1', task: 'novice' }`.
 *
 * Non-standard strings (legacy skill names like `combat_brawler_novice`)
 * fall through to `{ phase: '', task: <whole string> }` so the consumer
 * can still tell whether the workingSkill is set without writing parsing
 * logic.
 */
function parseRoadmapSkill(workingSkill: string): { phase: string; task: string } {
  if (workingSkill === '') return { phase: '', task: '' };
  const m = workingSkill.match(/^class_[a-z_]+_(phase\d+)_(.+)$/);
  if (m === null) {
    return { phase: '', task: workingSkill };
  }
  return { phase: m[1] ?? '', task: m[2] ?? workingSkill };
}

/**
 * Map `m_pvpType` enum (CREO p3) to its canonical label. The values come
 * from `PvpData::PvpType` in `~/code/swg-main/.../object/PvpData.h`:
 *   0 = Neutral, 1 = Imperial, 2 = Rebel.
 */
function factionTypeName(type: number): string {
  switch (type) {
    case 0:
      return 'neutral';
    case 1:
      return 'imperial';
    case 2:
      return 'rebel';
    default:
      return 'unknown';
  }
}

/**
 * True when a `WorldModel` baseline slot holds a typed-decoded object
 * rather than raw `Uint8Array` package bytes (no decoder registered).
 * Used by `seedFromWorld` to skip undecoded baselines.
 */
function isDecodedBaseline(value: unknown): value is Record<string, unknown> {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Uint8Array)
  );
}
