/**
 * GuildView — live, always-fresh view of the player's guild state.
 *
 * Guild data on a single-server cluster lives almost entirely in the
 * universe-level `GuildObject`. The client side gets:
 *
 *   1. The local player's `guildId` (i32) on their CREO SHARED baseline.
 *   2. Optionally, the GuildObject baselines themselves (SHARED package
 *      only — most fields are persisted/SERVER and not pushed to clients).
 *      The SHARED baseline carries `m_abbrevs` (AutoDeltaSet<std::string>)
 *      which is ALL guild abbreviations, not just ours; the SHARED_NP
 *      baseline carries the GCW score percentile maps and nothing useful
 *      for "what guild am I in".
 *
 * For a typical script the most actionable signal is `guildId !== 0`.
 * `name` / `abbrev` / `rank` / `members` are populated if/when the
 * GuildObject's baselines arrive and contain decodeable data. **On a
 * single-server cluster the GuildObject baseline is NOT broadcast to
 * regular clients** (per `GuildObject::isVisibleOnClient` it's universe
 * scope) — these fields will typically remain `null`/empty. We surface
 * what we can see and let consumers decide what's actionable.
 */

import type { NetworkId } from '../types.js';
import type { CharacterSheet } from './character-sheet.js';
import type { WorldModel } from './world-model.js';
import { ObjectTypeTags, BaselinePackageIds } from '../messages/game/baselines/registry.js';

export interface GuildMemberInfo {
  /** Member's NetworkId. */
  id: NetworkId;
  /** Display name. */
  name: string;
  /** Rank title (e.g. "Master", "Leader", "Member"). `null` if unknown. */
  rank: string | null;
}

export interface GuildView {
  /** Numeric guild id from the local player's CREO baseline. `0` when no guild. */
  readonly id: number;
  /** Full guild name; `null` if the GuildObject baseline isn't visible. */
  readonly name: string | null;
  /** Guild abbreviation (`<XYZ>` shown in front of names). `null` when unknown. */
  readonly abbrev: string | null;
  /** Local player's rank string. `null` when unknown. */
  readonly rank: string | null;
  /** Known guild members. May be empty if the GuildObject isn't visible. */
  readonly members: GuildMemberInfo[];
}

export interface CreateGuildViewOptions {
  world: WorldModel;
  character: CharacterSheet;
}

export interface GuildViewHandle {
  readonly view: GuildView;
  detach(): void;
}

export function createGuildView(opts: CreateGuildViewOptions): GuildViewHandle {
  const { world, character } = opts;

  /**
   * Find the GuildObject in the world, if any. There's at most one
   * GuildObject per server (universe-scope singleton).
   */
  function findGuildObject(): ReturnType<WorldModel['get']> {
    const guios = world.byType(ObjectTypeTags.GILD);
    if (guios.length === 0) return undefined;
    return guios[0];
  }

  function readSharedBaseline(): {
    abbrevs?: string[];
  } | undefined {
    const obj = findGuildObject();
    if (obj === undefined) return undefined;
    const b = obj.baselines.get(BaselinePackageIds.SHARED);
    if (b === undefined || b instanceof Uint8Array) return undefined;
    return b as { abbrevs?: string[] };
  }

  const view: GuildView = {
    get id(): number {
      return character.guildId ?? 0;
    },
    get name(): string | null {
      // Without a typed GuildObject SHARED baseline decoder that exposes
      // m_names indexed by guildId, we can't reliably resolve "our" name
      // from the SHARED package alone (it's an AutoDeltaSet<std::string>
      // of every guild's name, not a map). Future work — for now return
      // null when the GuildObject isn't pushing per-guild detail to us.
      return null;
    },
    get abbrev(): string | null {
      // Same caveat as `name`: m_abbrevs is the FULL set across all
      // guilds, not just ours, and there's no client-visible index
      // mapping guildId → abbrev (the parallel m_*Info maps are SERVER
      // package only). We surface `null` when we can't pick out our own.
      // If the SHARED baseline becomes available AND there's exactly one
      // abbrev (e.g. a single-guild test server), use it.
      const shared = readSharedBaseline();
      if (shared === undefined) return null;
      const abbrevs = shared.abbrevs;
      if (!Array.isArray(abbrevs)) return null;
      if (abbrevs.length === 1) return abbrevs[0] ?? null;
      return null;
    },
    get rank(): string | null {
      // Rank lookup would require the SERVER-only m_membersInfo map. The
      // CREO baseline doesn't carry rank; we can't surface it from
      // wire-visible data alone.
      return null;
    },
    get members(): GuildMemberInfo[] {
      // Without a decoder for GuildObject SERVER-package data we can't
      // enumerate per-guild members. Surface an empty list rather than
      // a misleading "everyone we've ever seen" guess.
      return [];
    },
  };

  return {
    view,
    // No subscriptions to clean up — GuildView is pure read-through over
    // WorldModel + CharacterSheet.
    detach(): void {
      // intentionally empty
    },
  };
}
