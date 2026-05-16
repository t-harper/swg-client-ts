/**
 * CharacterSnapshot — a deterministic, hashable summary of a player
 * character's persistent state, extracted from a completed `LifecycleResult`.
 *
 * Purpose: the only end-to-end check that the DB save/load pipeline still
 * works. Run two `fullLifecycle()`s back-to-back, snapshot each, compare:
 * if the persisted fields (skill title, played time monotonic, bank/cash,
 * etc.) survive the round-trip, the save path is healthy. If a field comes
 * back null or differs, persistence is broken somewhere between
 * `LogoutMessage` → DB write → second login's baseline replay.
 *
 * Hash is SHA-256 of a JSON canonicalization of every field except `hash`
 * and `takenAt`. BigInts are stringified; inventory is sorted by templateCrc
 * then networkId so re-ordering doesn't perturb the digest.
 *
 * Optional fields (anything that requires a specific baseline package to
 * have flowed) gracefully degrade to `null` — most often this happens for
 * PLAY p1 (CLIENT_SERVER bank/cash), which the server only sends to the
 * auth client and which sometimes arrives after our zoned-in window. The
 * snapshot is still useful even when partially populated; the diff makes
 * clear what survived vs. what didn't.
 */

import { createHash } from 'node:crypto';

import type {
  CreatureObjectClientServerBaseline,
  CreatureObjectSharedBaseline,
  PlayerObjectClientServerBaseline,
  PlayerObjectSharedBaseline,
} from '../messages/game/baselines/index.js';
import {
  CreatureObjectClientServerKind,
  CreatureObjectSharedKind,
  PlayerObjectClientServerKind,
  PlayerObjectSharedKind,
} from '../messages/game/baselines/index.js';
import type { NetworkId } from '../types.js';
import { extractBaselinesForObject, findBaselinesByKind } from './baseline-helpers.js';
import { type ContainerItem, containerView } from './container-view.js';
import type { LifecycleResult } from './swg-client.js';

/** A single equipment / inventory child of the player's container view. */
export interface SnapshotInventoryItem {
  /** NetworkId as a decimal string (bigints don't survive JSON). */
  networkId: string;
  templateCrc: number | null;
  templateName: string | null;
  name: string | null;
}

export interface CharacterSnapshot {
  /** SHA-256 (hex) hash of the canonical snapshot — for fast equality. */
  hash: string;
  /** Wall-clock when the snapshot was taken. */
  takenAt: Date;
  /** Player networkId (always present). */
  playerNetworkId: NetworkId;
  /** Character name as the server returned it on Stage 2's EnumerateCharacterId. */
  characterName: string;
  /** From CREO p3 if available. */
  posture: number | null;
  scaleFactor: number | null;
  /** u64 from CREO p3 (states bitmap). */
  states: bigint | null;
  /** Display name on the creature (UnicodeString). */
  objectName: string | null;
  /** From PLAY p1 if owner-only baselines flowed. */
  bankBalance: number | null;
  cashBalance: number | null;
  /** From PLAY p3 if available. */
  skillTitle: string | null;
  playedTime: number | null;
  /**
   * Inventory contents: { networkId, templateCrc, templateName, name }
   * tuples from `containerView(result, playerNetworkId).items()`. Sorted by
   * templateCrc (ascending, nulls last) then by networkId for deterministic
   * hashing.
   */
  inventory: SnapshotInventoryItem[];
  /** Spawn coordinates from CmdStartScene. */
  spawnPosition: { x: number; y: number; z: number };
  spawnYaw: number;
  sceneName: string;
}

export interface SnapshotDiff {
  identical: boolean;
  differences: Array<{ field: string; before: unknown; after: unknown }>;
}

/**
 * Find the first CREO p3 (Shared) baseline for the given player NetworkId.
 * The CREO baselines for "our" character carry posture, scale, states,
 * objectName, etc. We could pick *any* CREO p3 in the transcript, but the
 * one for the player is the only one whose persistence we actually care
 * about — every other CREO is a nearby NPC/creature.
 */
function findPlayerCreatureShared(
  result: LifecycleResult,
  playerId: NetworkId,
): CreatureObjectSharedBaseline | null {
  for (const b of extractBaselinesForObject(result, playerId)) {
    if (b.decodedBaseline?.kind === CreatureObjectSharedKind) {
      return b.decodedBaseline.data as CreatureObjectSharedBaseline;
    }
  }
  return null;
}

/**
 * Find the first CREO p1 (ClientServer, auth-only) baseline for the player.
 * Carries bank/cash + max attributes + skill list. Often arrives during
 * zone-in but not guaranteed — if the server delayed the auth-client
 * package past our dwell window, this returns null.
 *
 * Note: bank/cash also appear on PLAY p1 (same ServerObject auth-client
 * fields). We prefer CREO p1 because the CREO is the *player character*
 * itself and is reliably present; PLAY (the IntangibleObject inside CREO)
 * is sometimes elided from the visible flood.
 */
function findPlayerCreatureAuth(
  result: LifecycleResult,
  playerId: NetworkId,
): CreatureObjectClientServerBaseline | null {
  for (const b of extractBaselinesForObject(result, playerId)) {
    if (b.decodedBaseline?.kind === CreatureObjectClientServerKind) {
      return b.decodedBaseline.data as CreatureObjectClientServerBaseline;
    }
  }
  return null;
}

/**
 * Find the first PLAY p3 (Shared) baseline in the transcript. The PlayerObject
 * is the persona half — skillTitle, playedTime, bornDate, etc. Only one
 * PlayerObject is the player's own; we pick the first one observed. If the
 * server's pushing multiple PlayerObjects (group members?), this could pick
 * up the wrong one — but for the zone-in flood from a single character that
 * doesn't happen.
 */
function findPlayerObjectShared(result: LifecycleResult): PlayerObjectSharedBaseline | null {
  const matches = findBaselinesByKind(result, PlayerObjectSharedKind);
  const first = matches[0];
  if (first?.decodedBaseline === null || first?.decodedBaseline === undefined) return null;
  return first.decodedBaseline.data as PlayerObjectSharedBaseline;
}

/**
 * Find the first PLAY p1 (ClientServer) baseline. Source of bank/cash on
 * the auth side. If the server didn't push it (sometimes the case in
 * truncated zone-in windows), returns null and `bankBalance` / `cashBalance`
 * fall through to whatever the CREO p1 surfaces (if any).
 */
function findPlayerObjectAuth(result: LifecycleResult): PlayerObjectClientServerBaseline | null {
  const matches = findBaselinesByKind(result, PlayerObjectClientServerKind);
  const first = matches[0];
  if (first?.decodedBaseline === null || first?.decodedBaseline === undefined) return null;
  return first.decodedBaseline.data as PlayerObjectClientServerBaseline;
}

/**
 * Project a ContainerView item into the snapshot's stable, JSON-serializable
 * form. `networkId` becomes a decimal string; everything else passes through.
 */
function toSnapshotItem(it: ContainerItem): SnapshotInventoryItem {
  return {
    networkId: it.networkId.toString(),
    templateCrc: it.templateCrc,
    templateName: it.templateName,
    name: it.name,
  };
}

/**
 * Order inventory items by (templateCrc asc, networkId asc) for deterministic
 * hashing. Items with `templateCrc === null` sort last so they don't perturb
 * the relative order of typed items if one ByName entry slips in. Comparing
 * networkIds as bigints keeps lexicographic-vs-numeric edge cases sane.
 */
function sortInventory(items: SnapshotInventoryItem[]): SnapshotInventoryItem[] {
  const copy = [...items];
  copy.sort((a, b) => {
    const ac = a.templateCrc;
    const bc = b.templateCrc;
    if (ac !== bc) {
      if (ac === null) return 1;
      if (bc === null) return -1;
      return ac - bc;
    }
    const an = BigInt(a.networkId);
    const bn = BigInt(b.networkId);
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });
  return copy;
}

/**
 * Canonical JSON serialization for hashing. Sorts object keys, stringifies
 * bigints, expands inventory items. Order of object keys matters here —
 * `JSON.stringify` honors insertion order, so we use the alphabetical key
 * sort to guarantee determinism even if a future field-addition changes the
 * struct's declared order.
 */
function canonicalize(snap: CharacterSnapshot): string {
  // Build the canonical object explicitly with sorted keys so future field
  // additions can't silently shuffle the hash. We exclude `hash` (chicken/egg)
  // and `takenAt` (wall-clock, would change every run).
  const stable = {
    bankBalance: snap.bankBalance,
    cashBalance: snap.cashBalance,
    characterName: snap.characterName,
    inventory: snap.inventory,
    objectName: snap.objectName,
    playedTime: snap.playedTime,
    playerNetworkId: snap.playerNetworkId.toString(),
    posture: snap.posture,
    scaleFactor: snap.scaleFactor,
    sceneName: snap.sceneName,
    skillTitle: snap.skillTitle,
    spawnPosition: snap.spawnPosition,
    spawnYaw: snap.spawnYaw,
    states: snap.states === null ? null : snap.states.toString(),
  };
  return JSON.stringify(stable);
}

/**
 * Build a deterministic snapshot from a `LifecycleResult`.
 *
 * The function never throws on missing data: every optional field becomes
 * `null` if its underlying baseline (or scene event) didn't flow. The
 * required fields (`playerNetworkId`, `characterName`, `spawnPosition`,
 * `spawnYaw`, `sceneName`) come from Stages 2 + 3, which by virtue of
 * having a `LifecycleResult` at all must have completed successfully —
 * but if `sceneStart` is somehow undefined (truncated lifecycle), we'll
 * fall through to defaults rather than crash.
 */
export function snapshot(result: LifecycleResult): CharacterSnapshot {
  const playerId = result.sceneStart?.playerNetworkId ?? 0n;
  const characterName = result.character.name;

  // CREO p3: posture / scale / states / objectName (display name override).
  const creShared = findPlayerCreatureShared(result, playerId);
  const posture = creShared?.posture ?? null;
  const scaleFactor = creShared?.scaleFactor ?? null;
  const states = creShared?.states ?? null;
  // Don't promote an empty objectName to "" — server uses "" to mean "no
  // override" (consumer should fall back to nameStringId). For the snapshot
  // we treat empty as null so a re-login that gets no override doesn't
  // diff as `"" → ""`.
  const objectName =
    creShared !== null && creShared.objectName !== '' ? creShared.objectName : null;

  // PLAY p1: bank / cash. Fall back to CREO p1 if PLAY p1 didn't flow.
  const playAuth = findPlayerObjectAuth(result);
  const creAuth = findPlayerCreatureAuth(result, playerId);
  const bankBalance = playAuth?.bankBalance ?? creAuth?.bankBalance ?? null;
  const cashBalance = playAuth?.cashBalance ?? creAuth?.cashBalance ?? null;

  // PLAY p3: skillTitle / playedTime.
  const playShared = findPlayerObjectShared(result);
  const skillTitle = playShared?.skillTitle ?? null;
  const playedTime = playShared?.playedTime ?? null;

  // Inventory: walk the container view rooted at the player networkId.
  // The player's *own* container hosts their equipment slots (and a child
  // `character_inventory.iff` for backpack contents). We snapshot the
  // direct children of the player — that's equipment + the inventory
  // container itself — because the spec says: "the player is the root
  // container for equipment slots". If a caller wants nested inventory
  // contents they can build another ContainerView.
  const view = containerView(result, playerId);
  const inventory = sortInventory(view.items().map(toSnapshotItem));

  const spawnPosition = result.sceneStart?.startPosition ?? { x: 0, y: 0, z: 0 };
  const spawnYaw = result.sceneStart?.startYaw ?? 0;
  const sceneName = result.sceneStart?.sceneName ?? '';

  // Build the snapshot without the hash, then compute the hash from a
  // canonical serialization, then attach it. The takenAt is set last so
  // it doesn't influence the digest.
  const partial: CharacterSnapshot = {
    hash: '',
    takenAt: new Date(),
    playerNetworkId: playerId,
    characterName,
    posture,
    scaleFactor,
    states,
    objectName,
    bankBalance,
    cashBalance,
    skillTitle,
    playedTime,
    inventory,
    spawnPosition,
    spawnYaw,
    sceneName,
  };
  const hash = createHash('sha256').update(canonicalize(partial)).digest('hex');
  return { ...partial, hash };
}

/**
 * Diff two snapshots field-by-field. The `hash` and `takenAt` fields are
 * never reported as differences — they're metadata. Inventory comparison
 * is item-by-item: if any item's `networkId` set changes, or any item's
 * fields shift, the inventory is flagged as different (one entry per
 * differing field, not one entry per item).
 *
 * `identical` is `true` iff `differences.length === 0`. This matches what
 * a hash equality check would say — so if you only need the boolean, just
 * compare `before.hash === after.hash`.
 */
export function diffSnapshots(before: CharacterSnapshot, after: CharacterSnapshot): SnapshotDiff {
  const differences: SnapshotDiff['differences'] = [];

  // Scalar fields — direct equality (including bigint).
  const scalarFields: Array<keyof CharacterSnapshot> = [
    'characterName',
    'posture',
    'scaleFactor',
    'objectName',
    'bankBalance',
    'cashBalance',
    'skillTitle',
    'playedTime',
    'spawnYaw',
    'sceneName',
  ];
  for (const f of scalarFields) {
    const a = before[f];
    const b = after[f];
    if (a !== b) differences.push({ field: f, before: a, after: b });
  }
  // BigInt fields — compare via toString() to keep `before`/`after` JSON-safe.
  if (before.playerNetworkId !== after.playerNetworkId) {
    differences.push({
      field: 'playerNetworkId',
      before: before.playerNetworkId.toString(),
      after: after.playerNetworkId.toString(),
    });
  }
  if (before.states !== after.states) {
    differences.push({
      field: 'states',
      before: before.states === null ? null : before.states.toString(),
      after: after.states === null ? null : after.states.toString(),
    });
  }
  // Nested objects: compare by canonical-JSON to catch x/y/z shifts.
  if (JSON.stringify(before.spawnPosition) !== JSON.stringify(after.spawnPosition)) {
    differences.push({
      field: 'spawnPosition',
      before: before.spawnPosition,
      after: after.spawnPosition,
    });
  }
  // Inventory: compare the sorted lists; report once if any difference.
  if (JSON.stringify(before.inventory) !== JSON.stringify(after.inventory)) {
    differences.push({
      field: 'inventory',
      before: before.inventory,
      after: after.inventory,
    });
  }

  return {
    identical: differences.length === 0,
    differences,
  };
}
