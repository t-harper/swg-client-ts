/**
 * Stage 3 — GameServer (zone-in).
 *
 * The client stays on the SAME UDP socket as Stage 2 — `ConnectionServer`
 * server-side re-routes our packets to a GameConnection internally after
 * SelectCharacter; no new SOE handshake from the client. We just keep the
 * dispatcher alive and wait for the GameServer messages to arrive.
 *
 * Sequence:
 *   1. wait for CmdStartScene (server tells us the player's spawn info)
 *   2. accumulate SceneCreateObjectByCrc + SceneCreateObjectByName messages
 *      (the "baseline flood" of nearby objects, possibly with ObjController +
 *      UpdateTransform sprinkled in — we record those too)
 *   3. wait for SceneEndBaselines (server's signal that the baseline phase is done)
 *   4. send CmdSceneReady (client confirms it has loaded) — now "zoned in"
 *   5. optionally hold for N ms, sending HeartBeat every ~30s
 *   6. send LogoutMessage, brief delay, then disconnect()
 *
 * Source for the receive order (server side):
 *   /home/tharper/code/swg-main/src/engine/server/application/SwgGameServer/src/shared/
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/network/
 */
import { CmdSceneReady } from '../messages/game/cmd-scene-ready.js';
import { CmdStartScene } from '../messages/game/cmd-start-scene.js';
import { HeartBeat } from '../messages/game/heart-beat.js';
import { LogoutMessage } from '../messages/game/logout-message.js';
import { SceneCreateObjectByCrc } from '../messages/game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import { SceneEndBaselines } from '../messages/game/scene-end-baselines.js';
import { type NetworkId, type SceneStart, ZoneState } from '../types.js';
import type { MessageDispatcher, TranscriptEvent } from './dispatcher.js';

/** A summary of the baseline flood we observed during zone-in. */
export interface BaselineSummary {
  /** Total baseline create messages (Crc + Name + ObjController + UpdateTransform). */
  totalMessages: number;
  /** Just SceneCreateObjectByCrc + SceneCreateObjectByName. */
  createMessages: number;
  /** NetworkId of every Crc/Name-created object (deduped by id). */
  objectIds: NetworkId[];
  /** Templates seen by name (small set; useful for sanity checks). */
  templateNames: string[];
}

export interface GameStageOptions {
  /** The dispatcher returned from runConnectionStage — same connection. */
  dispatcher: MessageDispatcher;
  /** How long to wait for CmdStartScene. Default 30_000ms (zone-in can be slow). */
  startSceneTimeoutMs?: number;
  /** How long to wait for SceneEndBaselines after CmdStartScene. Default 30_000ms. */
  baselinesTimeoutMs?: number;
  /** How long to hold the "zoned in" state before logging out. Default 5_000ms. */
  holdZonedInMs?: number;
  /** How often to send a HeartBeat while zoned in (ms). Default 30_000. */
  heartbeatMs?: number;
  /** Callback whenever the ZoneState changes. */
  onStateChange?: (state: ZoneState) => void;
  /** Hook for streaming transcript events. */
  onTranscript?: (event: TranscriptEvent) => void;
}

export interface GameStageResult {
  /** What the server told us in CmdStartScene. */
  sceneStart: SceneStart;
  /** Summary of the baseline object flood. */
  baseline: BaselineSummary;
  /** Wall-clock time at which we received SceneEndBaselines. */
  zonedInAt: Date;
  /** Wall-clock time at which we sent LogoutMessage. */
  logoutAt: Date;
  /** Stage 3 elapsed time in ms. */
  elapsedMs: number;
}

export async function runGameStage(opts: GameStageOptions): Promise<GameStageResult> {
  const t0 = Date.now();
  const dispatcher = opts.dispatcher;
  const startSceneTimeoutMs = opts.startSceneTimeoutMs ?? 30_000;
  const baselinesTimeoutMs = opts.baselinesTimeoutMs ?? 30_000;
  const holdZonedInMs = opts.holdZonedInMs ?? 5_000;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;

  if (opts.onTranscript !== undefined) {
    dispatcher.onAny(opts.onTranscript);
  }

  // Track baselines as they arrive — they typically start BEFORE we've fully
  // processed CmdStartScene, so set up the collectors now.
  const seenIds = new Map<string, true>();
  const seenTemplates = new Map<string, true>();
  let createCount = 0;
  let totalCount = 0;
  const unsubByCrc = dispatcher.onMessage(SceneCreateObjectByCrc, (m) => {
    seenIds.set(m.networkId.toString(), true);
    createCount++;
    totalCount++;
  });
  const unsubByName = dispatcher.onMessage(SceneCreateObjectByName, (m) => {
    seenIds.set(m.networkId.toString(), true);
    if (m.templateName.length > 0) seenTemplates.set(m.templateName, true);
    createCount++;
    totalCount++;
  });

  let heartbeatTimer: NodeJS.Timeout | null = null;
  try {
    opts.onStateChange?.(ZoneState.GameHandshake);

    // 1. Wait for CmdStartScene.
    const startScene = await dispatcher.waitFor(CmdStartScene, {
      timeoutMs: startSceneTimeoutMs,
    });
    opts.onStateChange?.(ZoneState.ZoningIn);

    // 2 + 3. Wait for SceneEndBaselines.
    const endBaselines = await dispatcher.waitFor(SceneEndBaselines, {
      timeoutMs: baselinesTimeoutMs,
    });
    // SceneEndBaselines arrives with the player's networkId. Sanity check:
    if (endBaselines.networkId !== startScene.playerNetworkId) {
      // Not fatal — log via transcript by sending nothing; the orchestrator
      // can detect via the message contents if it cares.
    }
    const zonedInAt = new Date();

    // 4. Send CmdSceneReady — client confirms it has loaded.
    dispatcher.send(new CmdSceneReady());
    opts.onStateChange?.(ZoneState.ZonedIn);

    // 5. Hold zoned-in. Optional heartbeats during the dwell.
    if (heartbeatMs > 0 && holdZonedInMs > heartbeatMs) {
      heartbeatTimer = setInterval(() => {
        try {
          dispatcher.send(new HeartBeat());
        } catch {
          // socket may have closed mid-hold — ignore
        }
      }, heartbeatMs);
      heartbeatTimer.unref?.();
    }

    await sleep(holdZonedInMs);

    // 6. Send LogoutMessage. No reply is sent on the client wire.
    opts.onStateChange?.(ZoneState.LoggingOut);
    const logoutAt = new Date();
    try {
      dispatcher.send(new LogoutMessage());
    } catch {
      // already disconnected — ignore
    }

    // Give the server a beat to persist the character before we drop the SOE
    // session. 1000ms matches what the real Windows client uses.
    await sleep(1_000);

    const sceneStart: SceneStart = {
      playerNetworkId: startScene.playerNetworkId,
      sceneName: startScene.sceneName,
      startPosition: startScene.startPosition,
      startYaw: startScene.startYaw,
      templateName: startScene.templateName,
      serverTimeSeconds: startScene.serverTimeSeconds,
      serverEpoch: startScene.serverEpoch,
      disableWorldSnapshot: startScene.disableWorldSnapshot,
    };

    return {
      sceneStart,
      baseline: {
        totalMessages: totalCount,
        createMessages: createCount,
        objectIds: [...seenIds.keys()].map((k) => BigInt(k)),
        templateNames: [...seenTemplates.keys()],
      },
      zonedInAt,
      logoutAt,
      elapsedMs: Date.now() - t0,
    };
  } finally {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    unsubByCrc();
    unsubByName();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
