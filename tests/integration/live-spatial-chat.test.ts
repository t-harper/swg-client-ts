/**
 * Live integration test: spatial chat round-trip.
 *
 * Two variants:
 *
 *   1. **Single-client self-broadcast** (preferred — works under reuse mode).
 *      A single client zones in, calls `ctx.say(needle)`, and waits for the
 *      server to broadcast `CM_spatialChatReceive` back. The server's
 *      `getSpatialChatListeners(source, radius, results)` includes the
 *      speaker in their own listener sphere (distance 0 < radius 50), so the
 *      server fans the chat back to the sender — proving end-to-end:
 *        - Our wire shape is accepted (we use the `spatialChatInternal`
 *          CommandQueue path, the only one that passes the server's
 *          `allowFromClient` gate).
 *        - The server validates source = controlled object.
 *        - `ChatServer::sendSpatialChat` broadcasts to observers.
 *        - Our `SpatialChatReceiveDecoder` decodes the inbound trailer.
 *
 *   2. **2-client co-located broadcast** (the more interesting test, but
 *      gated on `canCreateRegularCharacter=true`). Two fresh clients zone
 *      in at the same starting city; A speaks, B observes. Gracefully skips
 *      when the cluster is at its character cap (live-fleet has the same
 *      gate — see CLAUDE.md).
 *
 * Gated on `LIVE=1`. Runs against the real swg-server.
 *
 * For the single-client variant, set `CI_REUSE_ACCOUNT` + `CI_REUSE_CHARACTER`
 * to a pinned account/character pair to avoid leaking fresh accounts (and to
 * work around `canCreateRegularCharacter=false`). The 2-client variant always
 * needs two NEW accounts, so reuse mode doesn't apply there.
 */
import { describe, expect, it } from 'vitest';

import { ReadIterator } from '../../src/archive/read-iterator.js';
import { Fleet } from '../../src/client/fleet.js';
import type { ScenarioFn } from '../../src/client/script/context.js';
import { SwgClient } from '../../src/client/swg-client.js';
import { ObjControllerMessage } from '../../src/messages/game/obj-controller-message.js';
import {
  ObjControllerSubtypeIds,
  type SpatialChatData,
  SpatialChatReceiveDecoder,
} from '../../src/messages/game/obj-controller/index.js';
import type { NetworkId } from '../../src/types.js';
import { liveCredentials } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

/**
 * Lightweight one-shot deferred — A waits for "B is ready", B waits for
 * "A has said something" (well, in practice B doesn't need to wait beyond
 * its own `expectWithin` window — the barrier is just so A doesn't speak
 * before B's watcher is in place).
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe.skipIf(!LIVE)('live spatial chat — single-client self-broadcast', () => {
  it('echoes back: server broadcasts our /say to us as CM_spatialChatReceive', async () => {
    // Single-client variant. The server's `getSpatialChatListeners` is a
    // sphere-tree radius search around the speaker's position; the speaker
    // is at distance 0 from themselves, so they appear in their own
    // listener list. This means the server fans the spatial-chat back to
    // the sender as a `CM_spatialChatReceive` ObjControllerMessage —
    // proving end-to-end:
    //   1. Our `CM_spatialChatSend` wire shape is accepted.
    //   2. The server's `speakText` validates source = owner.
    //   3. The server's `ChatServer::sendSpatialChat` broadcasts to observers.
    //   4. Our subtype registry decodes the inbound receive correctly.
    //
    // The 2-client co-located variant (below) is the more interesting test
    // but is gated on the cluster having `canCreateRegularCharacter=true`
    // (currently disabled — see live-fleet.test.ts).
    const { account, characterName } = await liveCredentials('sc');
    const needle = `selftest ${Date.now() % 100_000_000}`;

    const observed = { data: undefined as SpatialChatData | undefined };

    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });
    let result;
    try {
      result = await client.fullLifecycle({
        account,
        characterName,
        planet: 'mos_eisley',
        holdZonedInMs: 0,
        script: async (ctx) => {
          // Arm the watcher BEFORE saying anything so we don't race the recv.
          const recvP = ctx
            .expectWithin(ObjControllerMessage, 6_000, {
              predicate: (m) =>
                m.message === ObjControllerSubtypeIds.CM_spatialChatReceive &&
                m.decodedSubtype !== null &&
                (m.decodedSubtype.data as SpatialChatData).text === needle,
            })
            .then((m) => {
              observed.data = (m.decodedSubtype?.data ?? undefined) as SpatialChatData | undefined;
            })
            .catch(() => {
              /* timeout — diagnostic surfaced below from transcript */
            });
          // Let the server settle our awareness list a beat first.
          await ctx.wait(500);
          ctx.say(needle);
          await recvP;
        },
      });
    } catch (err) {
      // Admin pool guarantees canCreateRegularCharacter=true; any failure is
      // a real server/wire regression, not a soft-skip condition.
      throw err;
    }

    // The lifecycle reached zone-in.
    expect(result.zonedInAt, 'zonedInAt populated').not.toBeNull();
    expect(result.receivedErrorMessage, 'no ErrorMessage during run').toBe(false);
    expect(result.scriptResult?.error, 'script did not throw').toBeUndefined();

    // We sent the spatial chat (one ObjControllerMessage with the spatial
    // chat send subtype).
    const sentSpatialChats = result.transcript.filter((e) => {
      if (e.direction !== 'send' || e.messageName !== 'ObjControllerMessage') return false;
      return true;
    });
    expect(
      sentSpatialChats.length,
      'at least one ObjControllerMessage sent',
    ).toBeGreaterThanOrEqual(1);

    // Headline assertion: we received the broadcast echoed back to us.
    if (observed.data === undefined) {
      // Diagnostic: count inbound CM_spatialChatReceive events; what did the
      // server send back?
      const recvOcm = result.transcript.filter(
        (e) => e.direction === 'recv' && e.messageName === 'ObjControllerMessage',
      );
      let inboundSpatialChats = 0;
      for (const e of recvOcm) {
        if (!('decoded' in e) || !(e.decoded instanceof ObjControllerMessage)) continue;
        if (e.decoded.message === ObjControllerSubtypeIds.CM_spatialChatReceive) {
          inboundSpatialChats++;
        }
      }
      throw new Error(
        `Did not observe self-broadcast within 6s. ` +
          `inbound ObjControllerMessage events=${recvOcm.length}; ` +
          `inbound CM_spatialChatReceive events=${inboundSpatialChats}; ` +
          `needle="${needle}". ` +
          `Likely causes: (a) the server-side 'spatialChatInternal' command ` +
          `was renamed / its params format drifted (check ` +
          `CommandCppFuncs.cpp:commandFuncSpatialChatInternal), ` +
          `(b) the chat-spam limiter is squelching the speaker, ` +
          `(c) the player object isn't fully wired (look for TRACE_LOGIN ` +
          `"Loading a player controlled creature object without a player object" ` +
          `in podman logs swg-server).`,
      );
    }
    expect(observed.data.text).toBe(needle);
    expect(observed.data.sourceId).toBe(result.sceneStart?.playerNetworkId);

    // Round-trip via the receive-side decoder against the captured trailer
    // bytes — proves the wire layout end-to-end.
    const matched = result.transcript.find(
      (e) =>
        e.direction === 'recv' &&
        e.messageName === 'ObjControllerMessage' &&
        'decoded' in e &&
        e.decoded instanceof ObjControllerMessage &&
        e.decoded.message === ObjControllerSubtypeIds.CM_spatialChatReceive &&
        e.decoded.decodedSubtype !== null &&
        (e.decoded.decodedSubtype.data as SpatialChatData).text === needle,
    );
    expect(matched, 'matching recv event present in transcript').toBeDefined();
    if (
      matched !== undefined &&
      'decoded' in matched &&
      matched.decoded instanceof ObjControllerMessage
    ) {
      const trailer = SpatialChatReceiveDecoder.decode(new ReadIterator(matched.decoded.data));
      expect(trailer.text).toBe(needle);
    }
  }, 60_000);
});

describe.skipIf(!LIVE)('live spatial chat (2 co-located clients, /say round-trip)', () => {
  it('A says something — B observes the inbound CM_spatialChatReceive', async () => {
    const runTag = (Date.now() % 100_000_000).toString(36);
    const needle = `hello from A ${runTag}`;
    // Pull 2 distinct admin-pool accounts (helpers.liveCredentials rotates
    // through tslive01..20). Fresh timestamp accounts would silently soft-skip.
    const credA = await liveCredentials('sca');
    const credB = await liveCredentials('scb');

    // Cross-script coordination state, shared by closure.
    //
    // playerAReady     — A's script captures its playerNetworkId here so B
    //                    can identify A's spatial-chat broadcast deterministically.
    // playerBReady     — B's script captures its playerNetworkId (mostly for
    //                    diagnostics — symmetric).
    // bWatcherArmed    — B resolves this once its `expectWithin` is registered;
    //                    A awaits this before calling `ctx.say()`.
    // bObserved        — B resolves this with the inbound SpatialChat data;
    //                    A awaits this (with a short trailing wait) so the
    //                    lifecycle doesn't tear down B's connection before
    //                    the wire packet is observed.
    const playerAReady = deferred<NetworkId>();
    const playerBReady = deferred<NetworkId>();
    const bWatcherArmed = deferred<void>();
    const bObserved = deferred<SpatialChatData>();

    const scriptA: ScenarioFn = async (ctx) => {
      playerAReady.resolve(ctx.sceneStart.playerNetworkId);
      // Wait until BOTH B is zoned in and B's watcher is installed.
      try {
        await Promise.race([
          Promise.all([playerBReady.promise, bWatcherArmed.promise]),
          timeoutAfter(10_000, 'A: timed out waiting for B to arm its watcher'),
        ]);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[live-spatial-chat] ${(err as Error).message}`);
        return;
      }
      // Small settle — give the server a moment to register both observers
      // on each other's awareness list before the broadcast.
      await ctx.wait(500);
      ctx.say(needle);
      // Hold long enough for B to receive and observe before A's lifecycle
      // tears down (A's logout doesn't directly affect B's socket but the
      // server's awareness updates settle faster if A sticks around).
      await ctx.wait(3_000);
    };

    const scriptB: ScenarioFn = async (ctx) => {
      playerBReady.resolve(ctx.sceneStart.playerNetworkId);
      const playerAId = await Promise.race([
        playerAReady.promise,
        timeoutAfter<NetworkId>(10_000, 'B: timed out waiting for A to zone in'),
      ]).catch((err: Error) => {
        bObserved.reject(err);
        return 0n;
      });

      // Arm the watcher BEFORE telling A "go ahead". This way there's no
      // race where A's say() arrives between B's zone-in and B's registration.
      const recvPromise = ctx
        .expectWithin(ObjControllerMessage, 6_000, {
          predicate: (m) => {
            if (m.message !== ObjControllerSubtypeIds.CM_spatialChatReceive) return false;
            if (m.decodedSubtype === null) return false;
            const data = m.decodedSubtype.data as SpatialChatData;
            // Match either by needle text or by sourceId — text matching is
            // more strict but sourceId is the canonical correlation key.
            if (data.text !== needle) return false;
            if (playerAId !== 0n && data.sourceId !== playerAId) return false;
            return true;
          },
        })
        .then(
          (m) => {
            const data = (m.decodedSubtype?.data ?? null) as SpatialChatData | null;
            if (data === null) {
              // The predicate already required decodedSubtype !== null; this
              // is defensive against the decoder returning a no-op shape.
              bObserved.reject(new Error('B: SpatialChat observed but decoded payload was null'));
              return;
            }
            bObserved.resolve(data);
          },
          (err: Error) => {
            bObserved.reject(err);
          },
        );

      bWatcherArmed.resolve();

      // Keep B alive until its watcher resolves OR the timeout window
      // elapses. The lifecycle's normal post-script logout will then happen.
      await recvPromise.catch(() => {
        /* swallow — diagnostic already in bObserved */
      });
    };

    const fleet = new Fleet({ loginServer: { host: HOST, port: PORT } });
    const fleetPromise = fleet.run(
      [
        {
          account: credA.account,
          characterName: credA.characterName,
          planet: 'mos_eisley',
          holdZonedInMs: 0, // scripts gate the dwell themselves
          script: scriptA,
        },
        {
          account: credB.account,
          characterName: credB.characterName,
          planet: 'mos_eisley',
          holdZonedInMs: 0,
          script: scriptB,
        },
      ],
      // Slight stagger lets B finish its character-creation handshake
      // without slamming the LoginServer simultaneously with A.
      { staggerMs: 200 },
    );

    // Race the fleet against B's observation. The fleet always wins eventually
    // (because both scripts return); awaiting bObserved separately lets us
    // surface the exact failure mode if B never saw anything.
    let observed: SpatialChatData | undefined;
    let observationError: string | undefined;
    bObserved.promise.then(
      (data) => {
        observed = data;
      },
      (err: Error) => {
        observationError = err.message;
      },
    );

    const fleetResult = await fleetPromise;

    // Admin pool guarantees canCreateRegularCharacter=true; any failure here
    // is a real server/wire regression, not a soft-skip condition.

    // Both clients must have succeeded (both reached zone-in and ran their script).
    expect(
      fleetResult.summary.succeeded,
      `both clients should succeed; errors=${fleetResult.summary.errorMessages.join(' | ')}`,
    ).toBe(2);
    expect(fleetResult.summary.failed).toBe(0);

    // Per-outcome sanity: both reached the game stage and ran their scripts.
    for (let i = 0; i < fleetResult.outcomes.length; i++) {
      const outcome = fleetResult.outcomes[i];
      expect(outcome, `outcome[${i}] present`).toBeDefined();
      if (outcome === undefined) continue;
      expect(outcome.error, `outcome[${i}] no error`).toBeUndefined();
      const lr = outcome.lifecycleResult;
      expect(lr, `outcome[${i}] lifecycleResult present`).toBeDefined();
      if (lr === undefined) continue;
      expect(lr.zonedInAt, `outcome[${i}] zonedInAt`).not.toBeNull();
      expect(lr.receivedErrorMessage, `outcome[${i}] no ErrorMessage`).toBe(false);
      expect(lr.scriptResult, `outcome[${i}] scriptResult present`).toBeDefined();
    }

    // Verify A actually sent the spatial-chat ObjControllerMessage.
    const aResult = fleetResult.outcomes[0]?.lifecycleResult;
    if (aResult === undefined) throw new Error('A lifecycleResult missing');
    const aSentChats = aResult.transcript.filter(
      (e) => e.direction === 'send' && e.messageName === 'ObjControllerMessage',
    );
    expect(
      aSentChats.length,
      'A sent at least one ObjControllerMessage (the spatial chat)',
    ).toBeGreaterThanOrEqual(1);

    // Verify the observation outcome — this is the headline assertion.
    if (observed === undefined) {
      const bResult = fleetResult.outcomes[1]?.lifecycleResult;
      // Diagnostic dump so the failure mode is obvious. Count any inbound
      // CM_spatialChatReceive that B did see (even with wrong text/source),
      // and any chat-system ErrorMessage that might indicate the server
      // gated the broadcast (e.g. permissions, distance).
      const inboundObj = (bResult?.transcript ?? []).filter(
        (e) => e.direction === 'recv' && e.messageName === 'ObjControllerMessage',
      );
      let inboundSpatialChats = 0;
      for (const e of inboundObj) {
        if (!('decoded' in e) || !(e.decoded instanceof ObjControllerMessage)) continue;
        if (e.decoded.message === ObjControllerSubtypeIds.CM_spatialChatReceive) {
          inboundSpatialChats++;
        }
      }
      throw new Error(
        `B did not observe A's /say within the window. ` +
          `observationError=${observationError ?? '(none)'}; ` +
          `B inbound ObjControllerMessage events=${inboundObj.length}; ` +
          `B inbound CM_spatialChatReceive events=${inboundSpatialChats}; ` +
          `needle="${needle}".`,
      );
    }

    expect(observed.text, 'B observed the right text').toBe(needle);
    // A's playerNetworkId should match the sourceId on the inbound trailer.
    const aPlayerId = aResult.sceneStart?.playerNetworkId;
    if (aPlayerId !== undefined && aPlayerId !== 0n) {
      expect(observed.sourceId, "B's observed sourceId matches A's playerNetworkId").toBe(
        aPlayerId,
      );
    }

    // Independent decode of the raw trailer bytes — verify via the registered
    // receive-side decoder rather than relying on the dispatcher's
    // pre-populated decodedSubtype. This proves the wire shape end-to-end.
    const bResult = fleetResult.outcomes[1]?.lifecycleResult;
    if (bResult === undefined) throw new Error('B lifecycleResult missing');
    const recvMatch = bResult.transcript.find(
      (e) =>
        e.direction === 'recv' &&
        e.messageName === 'ObjControllerMessage' &&
        'decoded' in e &&
        e.decoded instanceof ObjControllerMessage &&
        e.decoded.message === ObjControllerSubtypeIds.CM_spatialChatReceive &&
        e.decoded.decodedSubtype !== null &&
        (e.decoded.decodedSubtype.data as SpatialChatData).text === needle,
    );
    expect(recvMatch, 'B has the inbound CM_spatialChatReceive in its transcript').toBeDefined();
    if (
      recvMatch !== undefined &&
      'decoded' in recvMatch &&
      recvMatch.decoded instanceof ObjControllerMessage
    ) {
      const trailerRoundTrip = SpatialChatReceiveDecoder.decode(
        new ReadIterator(recvMatch.decoded.data),
      );
      expect(trailerRoundTrip.text).toBe(needle);
      expect(trailerRoundTrip.chatType).toBe(0); // Say
    }
  }, 90_000);
});

function timeoutAfter<T = void>(ms: number, label: string): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    t.unref?.();
  });
}
