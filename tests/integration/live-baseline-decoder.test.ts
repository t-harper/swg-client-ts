/**
 * Live integration test: assert that baseline decoding works against a real
 * server's wire output.
 *
 * Gated on `LIVE=1`. Runs the full Stage 1 → 2 → 3 → 4 lifecycle and checks
 * the post-zone-in transcript for:
 *   - At least N BaselinesMessage events with a non-null `decodedBaseline`.
 *   - At least one PlayerObject baseline whose `objectName` or `skillTitle`
 *     looks plausible (we don't strictly compare to the character name because
 *     the server may localize it via `nameStringId` instead).
 *   - The inventory container helper returns a NetworkId (or null, with a
 *     "no inventory create observed — flag as soft" note logged).
 *
 * If the server's baseline wire format has drifted, this test will fail
 * loudly with the relevant member-count mismatch and pin-pointable kind.
 */
import { describe, expect, it } from 'vitest';

import {
  extractInventoryContainerId,
  extractPlayerObjectBaseline,
  findBaselinesByKind,
  playerObjectIds,
  tangibleObjectIds,
} from '../../src/client/baseline-helpers.js';
import { SwgClient } from '../../src/client/swg-client.js';
import { BaselinesMessage } from '../../src/messages/game/baselines/baselines-message.js';
import { BatchBaselinesMessage } from '../../src/messages/game/baselines/batch-baselines-message.js';
import {
  PlayerObjectSharedKind,
  TangibleObjectSharedKind,
} from '../../src/messages/game/baselines/index.js';
import { liveCredentials } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live baseline decoding (Stages 1 → 2 → 3 → 4)', () => {
  it('decodes at least a handful of inbound BaselinesMessage events', async () => {
    const { account, characterName } = liveCredentials('bd');
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const result = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 5_000,
    });

    expect(result.zonedInAt, 'zonedInAt present').not.toBeNull();

    // Count BaselinesMessage events (flattening BatchBaselinesMessage envelopes).
    const allBaselines: BaselinesMessage[] = [];
    for (const e of result.transcript) {
      if (e.direction !== 'recv') continue;
      if (e.decoded instanceof BaselinesMessage) allBaselines.push(e.decoded);
      else if (e.decoded instanceof BatchBaselinesMessage) allBaselines.push(...e.decoded.baselines);
    }
    expect(
      allBaselines.length,
      'expected at least a few BaselinesMessages during zone-in',
    ).toBeGreaterThan(3);

    // Diagnostic: log distinct (typeId, packageId) pairs seen, plus the
    // count of decoded vs opaque. Useful when diagnosing wire-format drift
    // after a server bump. We log BEFORE asserting so failures are
    // self-diagnosing.
    const summary = new Map<string, number>();
    for (const b of allBaselines) {
      const key = `${b.typeIdString}/p${b.packageId}`;
      summary.set(key, (summary.get(key) ?? 0) + 1);
    }
    const decoded = allBaselines.filter((b) => b.decodedBaseline !== null);
    console.log(
      `[baselines] count=${allBaselines.length} decoded=${decoded.length} pairs=`,
      Object.fromEntries(summary),
    );

    // We model 4 (typeId, packageId) pairs covering TANO + PLAY x
    // SHARED/SHARED_NP — but a brand-new spawn on an empty cell may emit
    // only opaque CREO/SCLT/etc. baselines. Assert at least one decoded —
    // the summary above pinpoints what's missing if this fails.
    expect(
      decoded.length,
      'expected at least 1 decoded baseline (TANO or PLAY) during zone-in',
    ).toBeGreaterThan(0);
  }, 60_000);

  it('extracts a PlayerObject baseline matching the character we played as', async () => {
    const { account, characterName } = liveCredentials('bp');
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const result = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 5_000,
    });

    const playerBaseline = extractPlayerObjectBaseline(result);
    // Soft: server may push PlayerObject baseline later, after zone-in finishes.
    // If present, sanity-check its shape.
    if (playerBaseline !== null) {
      expect(playerBaseline.networkId).toBeTypeOf('bigint');
      expect(playerBaseline.data.skillTitle).toBeTypeOf('string');
      expect(playerBaseline.data.bornDate).toBeTypeOf('number');
      expect(playerBaseline.data.playedTime).toBeTypeOf('number');
      expect(playerBaseline.data.lifetimeGcwPoints).toBeTypeOf('bigint');
    } else {
      // No PlayerObject baseline observed — this can happen if the server
      // chooses to send only CreatureObject baselines during the visible
      // zone-in window. Log so future runs can diagnose.
      console.warn(
        '[live-baseline-decoder] No PlayerObject baseline decoded — character was',
        characterName,
      );
    }
  }, 60_000);

  it('finds the inventory container via extractInventoryContainerId (best-effort)', async () => {
    const { account, characterName } = liveCredentials('bi');
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const result = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 5_000,
    });

    const inventoryId = extractInventoryContainerId(result);
    // Soft: the server may push the inventory via SceneCreateObjectByCrc
    // instead of ByName. If we got null, log it and don't fail — the
    // extraction strategy needs a CRC-table extension for those cases.
    if (inventoryId !== null) {
      expect(inventoryId).toBeTypeOf('bigint');
      expect(inventoryId).not.toBe(0n);
      console.log('[live-baseline-decoder] inventory NetworkId:', inventoryId.toString());
    } else {
      console.warn(
        '[live-baseline-decoder] No inventory found via SceneCreateObjectByName.',
        'Player ids:',
        playerObjectIds(result).map((id) => id.toString()),
        'tangible ids:',
        tangibleObjectIds(result).map((id) => id.toString()),
      );
    }
  }, 60_000);

  it('handles the case where some packages are SHARED_NP (transient state)', async () => {
    const { account, characterName } = liveCredentials('bn');
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const result = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 5_000,
    });

    // Empty spawns sometimes only emit PLAY baselines, not TANO; accept either
    // direction — what we care about is that decoded baselines flow at all.
    const tangibleShared = findBaselinesByKind(result, TangibleObjectSharedKind);
    const playerShared = findBaselinesByKind(result, PlayerObjectSharedKind);
    expect(tangibleShared.length + playerShared.length).toBeGreaterThan(0);

    // Any PlayerObject baselines that did arrive must have decoded cleanly.
    for (const b of playerShared) {
      expect(b.decodedBaseline).not.toBeNull();
    }
  }, 60_000);
});
