/**
 * StartDance / ChangeDance (CM_setPerformanceType = 352) — bidirectional.
 *
 * The wire-level mechanism behind both `/startDance` and `/changeDance`.
 * Both server-side script functions ultimately call
 * `creature->setPerformanceType(performanceIndex)`, which appends a
 * `CM_setPerformanceType` controller message carrying a single `int`:
 *   - non-zero  = "set performance type to this index (start dancing)"
 *   - 0         = "stop performing"
 *
 * The `performanceIndex` is an entry from `datatables/performance/performance.iff`
 * — there's no separate per-dance enum, the index *is* the wire identifier.
 *
 * On the wire it's registered via the generic `packInt` / `unpackInt` helpers
 * (see SetupServerNetworkMessages.cpp:1338) so the trailer is literally a
 * 4-byte LE signed integer.
 *
 * Wire layout (trailer only):
 *   [i32]   performanceType        (0 = stop; non-zero = start the dance at that index)
 *
 * NOTE: there is no separate `ChangeDance` subtype on the wire — changing
 * from one dance to another is just another `CM_setPerformanceType` with
 * the new index. Server-side script logic enforces the "must be already
 * performing" precondition for `/changeDance`.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverNetworkMessages/src/shared/core/SetupServerNetworkMessages.cpp:115-128  (packInt/unpackInt)
 *   /home/tharper/code/swg-main/src/engine/server/library/serverNetworkMessages/src/shared/core/SetupServerNetworkMessages.cpp:1338
 *   /home/tharper/code/swg-main/dsrc/sku.0/sys.server/compiled/game/script/library/performance.java:1401-1565  (startDance / changeDance)
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface StartDanceData {
  /**
   * Performance-table index; 0 means "stop the current performance".
   * For a dance, this is the row id in `datatables/performance/performance.iff`.
   */
  performanceType: number;
}

export const StartDanceKind = 'StartDance' as const;

export const StartDanceDecoder = registerObjControllerSubtype<StartDanceData>({
  kind: StartDanceKind,
  subtypeId: ObjControllerSubtypeIds.CM_setPerformanceType,
  encode(stream: IByteStream, data: StartDanceData): void {
    stream.writeI32(data.performanceType);
  },
  decode(iter: IReadIterator): StartDanceData {
    return { performanceType: iter.readI32() };
  },
});
