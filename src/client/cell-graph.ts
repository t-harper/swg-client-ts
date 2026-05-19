/**
 * `findCellPath` — BFS pathfinder over a `PortalLayout`'s cell-connectivity
 * graph.
 *
 * # Why
 *
 * A building's `.pob` declares N cells (cell 0 = exterior, the rest interior)
 * and the portals that connect them. To walk a player from the outside into a
 * deep interior room (e.g. Tatooine cantina cell 7 = back bar) we need the
 * *sequence* of portals to cross — one `walkToCell` per hop. The portal
 * layout already encodes the adjacency; this module produces the traversal
 * sequence.
 *
 * # Algorithm
 *
 * Plain BFS over cell indices. The adjacency for cell `i` is
 *   `layout.cells[i].portals.filter(p => p.passable && !p.disabled)`.
 * Parent-tracking lets us reconstruct the path. For each hop, the outgoing
 * `CellPortal` lives on the source cell directly; the *destination*'s door
 * position (the mirror entry in the target cell) is looked up by matching
 * `geometryIndex` — every physical door appears twice in the .pob, once per
 * endpoint cell.
 *
 * # Tie-breaking
 *
 * When two shortest paths exist, the one whose first divergent hop has the
 * lowest **source-cell portal-array index** wins. This is the natural BFS
 * insertion order: we iterate `cells[i].portals` from `[0]` upward and only
 * enqueue a cell on its first visit. The rule is fully deterministic and
 * data-driven (the order portals are listed in the `.pob`).
 *
 */

import type { Vector3 } from '../types.js';
import type { Cell, CellPortal, PortalLayout } from '../iff/portal-layout-reader.js';

/** One hop in a multi-cell traversal — see {@link findCellPath}. */
export interface CellPathHop {
  /** Index of the cell we are LEAVING. */
  readonly fromCellIndex: number;
  /** Index of the cell we are ENTERING. */
  readonly toCellIndex: number;
  /** The outbound portal on the source cell — its `targetCellIndex === toCellIndex`. */
  readonly portal: CellPortal;
  /** Door position in `fromCell`'s local coordinate frame. */
  readonly fromCellLocalDoor: Vector3;
  /**
   * Door position in `toCell`'s local frame. Looked up from the mirror
   * portal entry on the destination cell (same `geometryIndex`). When no
   * mirror is found (malformed .pob), falls back to `fromCellLocalDoor` and
   * a `console.warn` is emitted — the caller will likely produce a slightly
   * off-position `walkToCell` but the cell ID is still correct.
   */
  readonly toCellLocalDoor: Vector3;
}

/**
 * Shortest portal-by-portal route from `fromCellIndex` to `toCellIndex`
 * across `layout`'s cells.
 *
 * Returns:
 *   - `[]` when `fromCellIndex === toCellIndex` (already there)
 *   - `null` when the destination is unreachable, when either index is
 *     out-of-bounds (`< 0` or `>= layout.cells.length`), or when the
 *     source cell index is missing from the layout
 *   - otherwise, an array of {@link CellPathHop}s such that
 *     `result[0].fromCellIndex === fromCellIndex` and
 *     `result[result.length - 1].toCellIndex === toCellIndex`, with
 *     `result[i].toCellIndex === result[i+1].fromCellIndex` for adjacent
 *     hops.
 *
 * Portals where `passable === false` or `disabled === true` are skipped —
 * the BFS will route around them if any other path exists.
 */
export function findCellPath(
  layout: PortalLayout,
  fromCellIndex: number,
  toCellIndex: number,
): CellPathHop[] | null {
  const cellCount = layout.cells.length;

  if (
    !Number.isInteger(fromCellIndex) ||
    !Number.isInteger(toCellIndex) ||
    fromCellIndex < 0 ||
    toCellIndex < 0 ||
    fromCellIndex >= cellCount ||
    toCellIndex >= cellCount
  ) {
    return null;
  }

  if (fromCellIndex === toCellIndex) {
    return [];
  }

  // Index cells by their `index` field — the array position is normally the
  // same, but `Cell.index` is the wire-CELL_NUMBER and is the authoritative key.
  const byIndex = new Map<number, Cell>();
  for (const cell of layout.cells) {
    byIndex.set(cell.index, cell);
  }

  if (!byIndex.has(fromCellIndex) || !byIndex.has(toCellIndex)) {
    return null;
  }

  // BFS: queue of cell indices; parent map captures (childCell -> outgoingPortalFromParent).
  const parentPortal = new Map<number, { parentCell: number; portal: CellPortal }>();
  const visited = new Set<number>([fromCellIndex]);
  const queue: number[] = [fromCellIndex];

  let head = 0;
  outer: while (head < queue.length) {
    const current = queue[head];
    head += 1;
    if (current === undefined) continue;
    const cell = byIndex.get(current);
    if (!cell) continue;

    for (const portal of cell.portals) {
      if (!portal.passable || portal.disabled) continue;
      const next = portal.targetCellIndex;
      if (next === current) continue; // self-loop
      if (!byIndex.has(next)) continue; // dangling target
      if (visited.has(next)) continue;
      visited.add(next);
      parentPortal.set(next, { parentCell: current, portal });
      if (next === toCellIndex) {
        break outer;
      }
      queue.push(next);
    }
  }

  if (!parentPortal.has(toCellIndex)) {
    return null;
  }

  // Reconstruct reverse chain: toCell <- ... <- fromCell
  const reverseChain: Array<{ parentCell: number; childCell: number; portal: CellPortal }> = [];
  let cursor = toCellIndex;
  while (cursor !== fromCellIndex) {
    const link = parentPortal.get(cursor);
    if (!link) {
      // Should be unreachable given the visited/parent invariants above.
      return null;
    }
    reverseChain.push({ parentCell: link.parentCell, childCell: cursor, portal: link.portal });
    cursor = link.parentCell;
  }

  // Forward-order hops, each enriched with mirror-door lookup.
  const hops: CellPathHop[] = [];
  for (let i = reverseChain.length - 1; i >= 0; --i) {
    const link = reverseChain[i];
    if (!link) continue; // unreachable: index in [0, length)
    const destCell = byIndex.get(link.childCell);
    const toCellLocalDoor = findMirrorDoor(destCell, link.parentCell, link.portal);
    hops.push({
      fromCellIndex: link.parentCell,
      toCellIndex: link.childCell,
      portal: link.portal,
      fromCellLocalDoor: link.portal.doorPosition,
      toCellLocalDoor,
    });
  }
  return hops;
}

/**
 * On the destination cell, find the portal entry that mirrors the outgoing
 * portal (same physical door — same `geometryIndex`, pointing back at the
 * source cell). Returns its `doorPosition` in the destination cell's local
 * frame. Falls back to the source-cell door position with a `console.warn`
 * if no mirror is registered (malformed `.pob` or asymmetric portal graph).
 */
function findMirrorDoor(
  destCell: Cell | undefined,
  sourceCellIndex: number,
  outgoingPortal: CellPortal,
): Vector3 {
  if (!destCell) {
    return outgoingPortal.doorPosition;
  }
  for (const candidate of destCell.portals) {
    if (
      candidate.geometryIndex === outgoingPortal.geometryIndex &&
      candidate.targetCellIndex === sourceCellIndex
    ) {
      return candidate.doorPosition;
    }
  }
  // Fall back: same geometryIndex regardless of targetCellIndex.
  for (const candidate of destCell.portals) {
    if (candidate.geometryIndex === outgoingPortal.geometryIndex) {
      return candidate.doorPosition;
    }
  }
  console.warn(
    `findCellPath: no mirror portal in cell ${destCell.index} for geometryIndex=${outgoingPortal.geometryIndex} (source cell ${sourceCellIndex}); using source-cell door position`,
  );
  return outgoingPortal.doorPosition;
}
