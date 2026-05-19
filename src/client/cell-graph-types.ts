/**
 * Temporary type stubs for Track C (cell-graph BFS pathfinder), shipped
 * because Track A (`src/iff/portal-layout-reader.ts`) has not yet landed
 * in this isolated worktree.
 *
 * # Track D MERGE INSTRUCTIONS (delete this file)
 *
 * When Track A has merged and `src/iff/portal-layout-reader.ts` exports
 * `PortalLayout`, `Cell`, `CellPortal`, `PortalGeometry`:
 *   1. Delete this file.
 *   2. In `cell-graph.ts`, change:
 *        import type { ... } from './cell-graph-types.js';
 *      to:
 *        import type { ... } from '../iff/portal-layout-reader.js';
 *   3. In `cell-graph.test.ts`, do the same swap.
 *
 * Shapes here mirror the plan spec at
 * `~/.claude/plans/gentle-questing-cascade.md` → "Track A — public types"
 * verbatim. If Track A diverges, that's a plan-vs-implementation
 * disagreement to resolve before merge — not something this file should
 * paper over.
 */

import type { Vector3 } from '../types.js';

export interface PortalGeometry {
  readonly vertices: readonly [Vector3, Vector3, Vector3, Vector3];
  readonly center: Vector3;
}

export interface CellPortal {
  readonly geometryIndex: number;
  readonly geometry: PortalGeometry;
  readonly targetCellIndex: number;
  readonly passable: boolean;
  readonly disabled: boolean;
  readonly doorStyle: string;
  readonly doorPosition: Vector3;
  /** Real type is `Mat3x4 | null` — Track A defines `Mat3x4`. Stub as unknown. */
  readonly doorTransform: unknown;
}

export interface Cell {
  readonly index: number;
  readonly name: string;
  readonly portals: readonly CellPortal[];
}

export interface PortalLayout {
  readonly sourceName: string;
  readonly version: string;
  readonly geometries: readonly PortalGeometry[];
  readonly cells: readonly Cell[];
}
