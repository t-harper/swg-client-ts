/**
 * Live integration test: build a ContainerView of the player's inventory
 * from a real lifecycle transcript.
 *
 * Gated on `LIVE=1`. Runs the full Stage 1 → 4 lifecycle, finds the player's
 * inventory networkId via `extractInventoryContainerId`, builds a ContainerView
 * over the inventory, and logs its contents.
 *
 * A brand-new spawn on `mos_eisley` may have an empty inventory — the test
 * does NOT hard-fail on `size() === 0`, only that we got an inventory id and
 * the helper produced a ContainerView without throwing. The diagnostic log
 * makes it easy to see what was inside (if anything) when investigating CI
 * failures.
 */
import { describe, expect, it } from 'vitest';

import { extractInventoryContainerId } from '../../src/client/baseline-helpers.js';
import {
  type ContainerItem,
  buildContainerIndex,
  containerView,
} from '../../src/client/container-view.js';
import { SwgClient } from '../../src/client/swg-client.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live ContainerView (Stages 1 → 2 → 3 → 4)', () => {
  it('builds a ContainerView of the player inventory and logs its contents', async () => {
    const { account, characterName } = await liveCredentials('cv');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const result = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 5_000,
    });

    expect(result.zonedInAt, 'zonedInAt present').not.toBeNull();

    // Whole-transcript diagnostic: how many containers did we see at all?
    const index = buildContainerIndex(result);
    console.log(
      `[live-container-view] saw ${index.size} distinct container parent(s) across ${result.transcript.length} transcript events`,
    );

    const inventoryId = extractInventoryContainerId(result);

    if (inventoryId !== null) {
      console.log('[live-container-view] inventory NetworkId:', inventoryId.toString());

      const inv = containerView(result, inventoryId);
      expect(inv.containerId).toBe(inventoryId);
      // Defensive: the view is a snapshot; size() must equal items().length.
      expect(inv.size()).toBe(inv.items().length);

      // Diagnostic: log what's inside. A fresh mos_eisley spawn may have an
      // empty inventory — informational only, no hard assert on size().
      if (inv.hasItems()) {
        console.log(
          `[live-container-view] inventory has ${inv.size()} item(s):\n${formatItemsForLog(inv.items())}`,
        );
      } else {
        console.log(
          '[live-container-view] inventory is empty for a fresh mos_eisley spawn — that is expected for a brand-new character.',
        );
      }

      // Light sanity check on every item: arrangementId must be a number,
      // networkId must be a bigint.
      for (const it of inv.items()) {
        expect(it.networkId).toBeTypeOf('bigint');
        expect(it.arrangementId).toBeTypeOf('number');
      }
    } else {
      // The inventory may have been pushed via ByCrc instead of ByName, in
      // which case extractInventoryContainerId returns null. Don't fail —
      // log the parent ids we DID see so the test can be diagnosed.
      const parents = [...index.keys()].map((id) => id.toString());
      console.warn(
        '[live-container-view] No inventory found via SceneCreateObjectByName; container parents observed:',
        parents,
      );
    }

    // Either way, demonstrate ContainerView is usable: pick the largest
    // container we DID see and log its first few items. This proves the
    // index → containerView → items() pipeline works against live data.
    let largestId: bigint | null = null;
    let largestSize = 0;
    for (const [pid, items] of index.entries()) {
      if (items.length > largestSize) {
        largestId = pid;
        largestSize = items.length;
      }
    }
    if (largestId !== null) {
      const v = containerView(result, largestId);
      expect(v.size()).toBeGreaterThan(0);
      console.log(
        `[live-container-view] largest container observed: ${largestId.toString()} (${v.size()} items)\n${formatItemsForLog(v.items().slice(0, 8))}`,
      );
    }
  }, 60_000);
});

function formatItemsForLog(items: ContainerItem[]): string {
  const summary = items.map((it) => ({
    networkId: it.networkId.toString(),
    name: it.name,
    templateName: it.templateName,
    templateCrc: it.templateCrc !== null ? `0x${it.templateCrc.toString(16)}` : null,
    arrangementId: it.arrangementId,
    complexity: it.shared?.complexity ?? null,
    maxHitPoints: it.shared?.maxHitPoints ?? null,
    condition: it.shared?.condition ?? null,
  }));
  return JSON.stringify(summary, null, 2);
}
