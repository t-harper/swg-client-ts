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
import { ClientOpenContainerMessage } from '../messages/game/client-open-container.js';
import { CmdSceneReady } from '../messages/game/cmd-scene-ready.js';
import { CmdStartScene } from '../messages/game/cmd-start-scene.js';
import { HeartBeat } from '../messages/game/heart-beat.js';
import { LogoutMessage } from '../messages/game/logout-message.js';
import { SceneCreateObjectByCrc } from '../messages/game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import { SceneEndBaselines } from '../messages/game/scene-end-baselines.js';
import { type NetworkId, type SceneStart, ZoneState } from '../types.js';
import type { MessageDispatcher, TranscriptEvent } from './dispatcher.js';
import { InventoryViewImpl } from './inventory-view.js';
import {
  type ScenarioFn,
  type ScriptResult,
  createScriptContext,
  didScriptLogout,
  runScript,
} from './script/context.js';
import { WorldModel } from './world-model.js';

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
  /**
   * Optional scenario function to run during the zoned-in hold. If set, runs
   * in place of the sleep; any remaining `holdZonedInMs` after the script
   * returns is still awaited. If the script calls `ctx.logout()`, the stage
   * will skip the implicit LogoutMessage send.
   */
  script?: ScenarioFn;
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
  /** Set if a script ran during the dwell. */
  scriptResult?: ScriptResult;
  /**
   * Live world view that absorbed the baseline flood + any deltas/transforms
   * that arrived during the dwell. Detached from the dispatcher by the time
   * this is returned (no further mutation), but the data is queryable.
   */
  world: WorldModel;
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

  // Construct the WorldModel BEFORE waiting for CmdStartScene so it captures
  // every Scene*/Baseline*/Delta* message from the moment we start listening.
  // playerId is pinned once CmdStartScene arrives.
  const world = new WorldModel({ dispatcher });

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
  let inventoryView: InventoryViewImpl | null = null;
  try {
    opts.onStateChange?.(ZoneState.GameHandshake);

    // 1. Wait for CmdStartScene.
    const startScene = await dispatcher.waitFor(CmdStartScene, {
      timeoutMs: startSceneTimeoutMs,
    });
    world.setPlayerId(startScene.playerNetworkId);
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

    // 4a. Auto-open the player's inventory and instantiate an
    // InventoryView over the WorldModel. The view discovers the
    // inventory container's NetworkId from the inbound
    // SceneCreateObjectByName / baseline traffic — the same logic
    // `extractInventoryContainerId` runs in batch, just applied
    // incrementally. Scripts read `ctx.inventory.items` to see live
    // contents without manually calling `openPlayerInventory()`.
    inventoryView = new InventoryViewImpl(world, startScene.playerNetworkId);
    inventoryView.attach();
    try {
      dispatcher.send(
        new ClientOpenContainerMessage(startScene.playerNetworkId, 'inventory'),
      );
    } catch {
      // socket may already be closed (unexpected this early but possible if
      // an external observer aborted) — log via the transcript catch-all.
    }

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

    // 5a. Optional script — runs in place of the sleep, then any remaining
    // hold time is awaited.
    const scriptT0 = Date.now();
    let scriptResult: ScriptResult | undefined;
    let scriptLoggedOut = false;
    if (opts.script !== undefined) {
      const abortController = new AbortController();
      const scriptCtx = createScriptContext({
        dispatcher,
        sceneStart: startScene,
        signal: abortController.signal,
        world,
        // Hand the already-attached view into the context so it gets shared
        // (vs. having the context construct & attach its own).
        inventory: inventoryView,
      });
      scriptResult = await runScript(opts.script, scriptCtx);
      scriptLoggedOut = didScriptLogout(scriptCtx);
    }
    const remainingHoldMs = Math.max(0, holdZonedInMs - (Date.now() - scriptT0));
    if (remainingHoldMs > 0) await sleep(remainingHoldMs);

    // 6. Send LogoutMessage. No reply is sent on the client wire.
    // (Skip if the script already sent one via ctx.logout().)
    opts.onStateChange?.(ZoneState.LoggingOut);
    const logoutAt = new Date();
    if (!scriptLoggedOut) {
      try {
        dispatcher.send(new LogoutMessage());
      } catch {
        // already disconnected — ignore
      }
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
      ...(scriptResult !== undefined ? { scriptResult } : {}),
      world,
    };
  } finally {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    if (inventoryView !== null) inventoryView.detach();
    unsubByCrc();
    unsubByName();
    world.detach();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
