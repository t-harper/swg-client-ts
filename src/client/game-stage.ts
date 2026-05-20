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
 *   4a. send NewbieTutorialResponse("clientReady") — triggers
 *       onLoadingScreenComplete server-side, resetting the 120-second
 *       invulnerability timer to 1s so client walks can be accepted
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
import { NewbieTutorialResponse } from '../messages/game/newbie-tutorial-response.js';
import { SceneCreateObjectByCrc } from '../messages/game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import { SceneEndBaselines } from '../messages/game/scene-end-baselines.js';
import { type NetworkId, type SceneStart, ZoneState } from '../types.js';
import type { ControlServer } from './control/control-server.js';
import { type SessionControl, createSessionControl } from './control/session-control.js';
import { buildSessionHandle } from './control/session-handle.js';
import type { MessageDispatcher, TranscriptEvent } from './dispatcher.js';
import { InventoryViewImpl } from './inventory-view.js';
import type { Knowledge } from './knowledge.js';
import {
  type ScenarioFn,
  type ScriptContextSequences,
  type ScriptResult,
  createScriptContext,
  didScriptLogout,
  readScriptContextSequences,
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
  /**
   * Shared knowledge base — forwarded to `createScriptContext` so the
   * scenario's `ctx.terrain` / `ctx.strings` views read from the same
   * process-wide cache as every other client. Defaults to `defaultKnowledge`
   * inside `createScriptContext` when omitted.
   */
  knowledge?: Knowledge;
  /**
   * Re-importable scenario source. When set, the game-stage runs an inner
   * loop: a `reload` directive on `sessionControl` re-invokes this provider
   * and re-runs the freshly imported scenario against the SAME connection.
   * Used for iteration 1 when `script` is not set, and for every iteration
   * after a `reload`.
   */
  scriptProvider?: () => Promise<ScenarioFn>;
  /**
   * Directive state machine shared with a control socket / supervisor. A
   * non-`run`/`paused` directive aborts the running scenario; `reload`
   * re-runs it. The game-stage creates a private one when omitted.
   */
  sessionControl?: SessionControl;
  /**
   * Control socket whose attached session handle the game-stage swaps on
   * every script run, so external clients can query and steer the live
   * session.
   */
  controlServer?: ControlServer;
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

    // 4a. Send NewbieTutorialResponse("clientReady"). The Windows client
    // sends this immediately after CmdSceneReady, and it's THE message that
    // triggers `CreatureObject::onLoadingScreenComplete` server-side. That
    // resets `m_invulnerabilityTimer` from 120s (set by `onClientAboutToLoad`
    // when the client first connected) down to 1s. Without this message,
    // `PlayerCreatureController::handleMove` returns false for the full 120s
    // because the gate `getInvulnerabilityTimer() > 0.f` has NO god short-
    // circuit — even an authenticated admin god is blocked. Admin warps work
    // because `planetwarp` routes through `teleport()` directly (not
    // handleMove), but any client-driven `CM_netUpdateTransform` walk is
    // silently dropped during the lockout window. See
    // `/home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CreatureObject.cpp:7620`
    // and Client.cpp:1735-1748 for the server-side handler.
    dispatcher.send(new NewbieTutorialResponse('clientReady'));

    opts.onStateChange?.(ZoneState.ZonedIn);

    // 4a. Auto-open the player's inventory + datapad so the server pushes
    // baselines for everything inside them. This populates ctx.inventory
    // and ctx.datapad for the script's dwell — no manual openContainer
    // needed. The InventoryView reads from the WorldModel, with discovery
    // via template-name / SHARED-baseline nameStringId / player-child
    // heuristic (the live server sends scene-creates as ByCrc, not ByName).
    inventoryView = new InventoryViewImpl(world, startScene.playerNetworkId);
    inventoryView.attach();
    try {
      dispatcher.send(new ClientOpenContainerMessage(startScene.playerNetworkId, 'inventory'));
    } catch {
      // socket may already be closed (unexpected this early but possible if
      // an external observer aborted) — log via the transcript catch-all.
    }
    try {
      dispatcher.send(new ClientOpenContainerMessage(startScene.playerNetworkId, 'datapad'));
    } catch {
      // socket may have closed mid-zone-in — ignore
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

    // 5a. Optional script — runs in place of the sleep. With a
    // `scriptProvider` set, the game-stage runs an inner loop so a `reload`
    // directive re-runs freshly imported scenario code against THIS same
    // connection (dispatcher / world / inventory view all persist).
    const scriptT0 = Date.now();
    let scriptResult: ScriptResult | undefined;
    let scriptLoggedOut = false;
    let sessionControl: SessionControl | undefined;
    const hasScript = opts.script !== undefined || opts.scriptProvider !== undefined;
    if (hasScript) {
      const sc = opts.sessionControl ?? createSessionControl();
      sessionControl = sc;
      const controlServer = opts.controlServer;
      // Wire-sequence high-water marks, forwarded across reload iterations
      // so a re-run doesn't reset the sequences the server keys command-
      // queue / chat / crafting / mission flows on.
      let seqs: ScriptContextSequences | null = null;
      let iteration = 0;

      while (true) {
        iteration += 1;

        // Resolve the scenario function for this iteration.
        let fn: ScenarioFn;
        if (iteration === 1 && opts.script !== undefined) {
          fn = opts.script;
        } else if (opts.scriptProvider !== undefined) {
          try {
            fn = await opts.scriptProvider();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (iteration === 1) {
              // No prior session to keep — give up on the script, log out.
              scriptResult = {
                elapsedMs: 0,
                sendsCount: 0,
                didLogout: false,
                assertionFailures: [],
                error: `scriptProvider failed: ${message}`,
              };
              break;
            }
            // A reload of edited code failed to import. Keep the live
            // connection and wait for another `reload` (fixed code) or a
            // terminal directive — `ctl reload` / `ctl stop` stay usable
            // via a ctx-less session handle.
            process.stderr.write(`[game-stage] reload failed: ${message}\n`);
            if (controlServer === undefined) break;
            sc.resetToRun();
            controlServer.attachSession(
              buildSessionHandle({
                ctx: null,
                sessionControl: sc,
                serverInfo: controlServer.serverInfo,
                reloadCapable: true,
                scriptStartedAt: Date.now(),
                lastReloadError: message,
              }),
            );
            const next = await sc.waitForChange();
            controlServer.detachSession();
            if (next === 'reload') {
              sc.resetToRun();
              continue;
            }
            break;
          }
        } else {
          break; // iteration > 1 with no provider — cannot reload.
        }

        // A non-run/non-paused directive (reload/restart/stop/logout) ends
        // the running scenario by aborting its signal — a universal stop
        // even for scenarios that don't cooperatively watch SessionControl.
        const abortController = new AbortController();
        const offChange = sc.onChange(() => {
          if (!sc.shouldKeepRunning()) abortController.abort();
        });
        if (!sc.shouldKeepRunning()) abortController.abort();

        const scriptCtx = createScriptContext({
          dispatcher,
          sceneStart: startScene,
          signal: abortController.signal,
          world,
          // Share the inventory view constructed once for this stage.
          inventory: inventoryView,
          ...(opts.knowledge !== undefined ? { knowledge: opts.knowledge } : {}),
          ...(seqs !== null
            ? {
                initialSequenceNumber: seqs.sequenceNumber,
                initialCommandSequence: seqs.commandSequence,
                initialChatSequence: seqs.chatSequence,
                initialCraftSequence: seqs.craftSequence,
                initialMissionSequence: seqs.missionSequence,
                initialBazaarRequestId: seqs.bazaarRequestId,
              }
            : {}),
        });
        if (controlServer !== undefined) {
          controlServer.attachSession(
            buildSessionHandle({
              ctx: scriptCtx,
              sessionControl: sc,
              serverInfo: controlServer.serverInfo,
              reloadCapable: opts.scriptProvider !== undefined,
              scriptStartedAt: Date.now(),
            }),
          );
        }

        try {
          scriptResult = await runScript(fn, scriptCtx);
          scriptLoggedOut = didScriptLogout(scriptCtx);
          seqs = readScriptContextSequences(scriptCtx);
        } finally {
          controlServer?.detachSession();
          offChange();
          // Ensure the prior signal is dead before the next iteration.
          abortController.abort();
          // Drop the scenario's trigger actions so a reload re-registers a
          // clean set — a re-imported scenario must not inherit stale
          // actions (which would hold a dead context) from the prior run.
          sc.clearActions();
        }

        // `reload` re-runs against this connection; everything else ends it.
        if (sc.directive === 'reload' && opts.scriptProvider !== undefined) {
          sc.resetToRun();
          continue;
        }
        break;
      }
    }
    const remainingHoldMs = Math.max(0, holdZonedInMs - (Date.now() - scriptT0));
    // Skip the leftover dwell when a control directive ended the run early.
    if (
      remainingHoldMs > 0 &&
      (sessionControl === undefined || sessionControl.shouldKeepRunning())
    ) {
      await sleep(remainingHoldMs);
    }

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
