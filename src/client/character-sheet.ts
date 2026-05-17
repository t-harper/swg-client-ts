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
  AutoDeltaSetDelta,
  AutoDeltaVectorDelta,
} from '../messages/game/baselines/auto-delta-delta-codecs.js';
import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import { BatchBaselinesMessage } from '../messages/game/baselines/batch-baselines-message.js';
import type { CreatureObjectClientServerBaseline } from '../messages/game/baselines/creature-object-baseline-1.js';
import { CreatureObjectClientServerKind } from '../messages/game/baselines/creature-object-baseline-1.js';
import type { CreatureObjectSharedBaseline } from '../messages/game/baselines/creature-object-baseline-3.js';
import { CreatureObjectSharedKind } from '../messages/game/baselines/creature-object-baseline-3.js';
import type {
  CreatureObjectSharedNpBaseline,
  PlayerAndShipPair,
} from '../messages/game/baselines/creature-object-baseline-6.js';
import { CreatureObjectSharedNpKind } from '../messages/game/baselines/creature-object-baseline-6.js';
import { DeltasMessage } from '../messages/game/baselines/deltas-message.js';
import type { PlayerObjectClientServerBaseline } from '../messages/game/baselines/player-object-baseline-1.js';
import { PlayerObjectClientServerKind } from '../messages/game/baselines/player-object-baseline-1.js';
import type { PlayerObjectSharedBaseline } from '../messages/game/baselines/player-object-baseline-3.js';
import { PlayerObjectSharedKind } from '../messages/game/baselines/player-object-baseline-3.js';
import { BaselinePackageIds, ObjectTypeTags } from '../messages/game/baselines/registry.js';
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
  groupInviter: PlayerAndShipPair | null;
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
    groupInviter: null,
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
      case PlayerObjectSharedKind:
        applyPlayShared(decoded.data as PlayerObjectSharedBaseline);
        break;
      case PlayerObjectClientServerKind:
        applyPlayClientServer(decoded.data as PlayerObjectClientServerBaseline);
        break;
      default:
        // Unrelated baseline (e.g. PLAY SHARED_NP) — ignore for now.
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
        default:
          break;
      }
    } else if (m.typeId === ObjectTypeTags.PLAY) {
      switch (m.packageId) {
        case BaselinePackageIds.SHARED:
          applyPlayShared(data as Partial<PlayerObjectSharedBaseline>);
          break;
        case BaselinePackageIds.CLIENT_SERVER:
          applyPlayClientServer(data as Partial<PlayerObjectClientServerBaseline>);
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

  const unsubscribers: Array<() => void> = [
    opts.dispatcher.onMessage(BaselinesMessage, consumeBaseline),
    opts.dispatcher.onMessage(BatchBaselinesMessage, (m) => {
      for (const b of m.baselines) consumeBaseline(b);
    }),
    opts.dispatcher.onMessage(DeltasMessage, consumeDelta),
    opts.dispatcher.onMessage(ObjControllerMessage, consumeObjController),
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
    toJSON(): Record<string, unknown> {
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
        groupInviter:
          view.groupInviter === null
            ? null
            : { id: view.groupInviter.id.toString(), name: view.groupInviter.name },
        position: { ...view.position },
      };
    },
  };

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
