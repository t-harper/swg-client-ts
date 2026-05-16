/**
 * Wire-replay harness.
 *
 * Two layers:
 *
 *   `replayScenario({ capture, pacing })` — returns a `ScenarioFn` that walks
 *       the captured post-zone-in event stream. For each captured SEND, it
 *       decodes the bytes back to a typed `GameNetworkMessage` via the
 *       registry and ships it through `ctx.send()`. Optionally honors the
 *       captured per-event delays.
 *
 *   `replay({ loginServer, capture, ... })` — wires up a fresh `SwgClient`
 *       login/connection stages, then runs a custom "replay dwell" in
 *       place of the standard `runGameStage` body. Compares the live
 *       observed inbound message stream against the captured one and
 *       returns a `ReplayResult`.
 *
 * The point: capture a known-good zone-in once. Any time the server's
 * submodules drift and a previously-emitted recv goes missing, replay
 * surfaces it immediately via `missing[]` — much faster than re-running
 * full gameplay.
 *
 * Caveats:
 *
 *   - The early lifecycle (login → connection → SelectCharacter →
 *     CmdStartScene → SceneEndBaselines) is re-run naturally via
 *     `runLoginStage` / `runConnectionStage`. The scripted portion begins
 *     AFTER `CmdSceneReady` is sent.
 *
 *   - SOE-level handshakes (SessionRequest/Response, Ack/AckAll, KeepAlive)
 *     are NOT in the high-level transcript and are not replayed; the live
 *     `SoeConnection` handles them naturally.
 *
 *   - Comparison is by message-name ordering (default) or per-name count.
 *     Exact byte equality on recvs is impossible — the server emits fresh
 *     sequence numbers, timestamps, etc.
 */

// Side-effect: register every message class so unknown-CRC inbound
// decoding works for both capture (recv decode) and replay (send re-decode).
import './swg-client.js';

import { parseHeader } from '../messages/base.js';
import { CmdSceneReady } from '../messages/game/cmd-scene-ready.js';
import { CmdStartScene } from '../messages/game/cmd-start-scene.js';
import { HeartBeat } from '../messages/game/heart-beat.js';
import { LogoutMessage } from '../messages/game/logout-message.js';
import { SceneCreateObjectByCrc } from '../messages/game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import { SceneEndBaselines } from '../messages/game/scene-end-baselines.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import { messageRegistry } from '../messages/registry.js';
import type { CharacterInfo, ServerEndpoint } from '../types.js';
import { type CreateCharacterOptions, runConnectionStage } from './connection-stage.js';
import type { MessageDispatcher, TranscriptEvent } from './dispatcher.js';
import { runLoginStage } from './login-stage.js';
import type { CapturedEvent } from './transcript-io.js';
import { attachCapture } from './transcript-io.js';

/**
 * Minimal scripting context — surface a scenario function uses to drive
 * the replay. Decoupled from the full `ScriptContext` (which doesn't
 * exist in this branch yet) so the replay harness has zero external
 * scripting dependencies.
 */
export interface ReplayScriptContext {
  /** The live dispatcher (game-stage's). Use `dispatcher.send()` to ship messages. */
  readonly dispatcher: MessageDispatcher;
  /** Cooperatively cancellable signal — abort if you see this. */
  readonly signal: AbortSignal;
  /** Sleep for `ms` milliseconds. */
  wait(ms: number): Promise<void>;
  /** Send a typed `GameNetworkMessage` through the dispatcher. */
  send(msg: GameNetworkMessage): void;
  /** Send LogoutMessage and brief settle; sets the "scenario logged out" flag. */
  logout(): Promise<void>;
}

/** Scenario function: an async routine that runs during the zoned-in dwell. */
export type ScenarioFn = (ctx: ReplayScriptContext) => Promise<void>;

export interface ReplayScenarioOptions {
  /** The captured event stream to replay. */
  capture: readonly CapturedEvent[];
  /**
   * Per-event timing strategy:
   *   - 'asCaptured': honor original delays between captured sends
   *   - 'asFast' (default): fire sends back-to-back
   */
  pacing?: 'asCaptured' | 'asFast';
}

export interface ReplayOptions {
  loginServer: ServerEndpoint;
  /** The captured event stream (load via `readTranscript`). */
  capture: readonly CapturedEvent[];
  pacing?: 'asCaptured' | 'asFast';
  /**
   * Inbound comparison strategy:
   *   - 'names' (default): expected names appear in the observed sequence,
   *     in the SAME ORDER (server may emit additional messages between them).
   *   - 'count': just compare per-name totals (order-insensitive).
   */
  compare?: 'names' | 'count';
  /** Account name for the fresh lifecycle. */
  account: string;
  /** Optional password (dev mode ignores). */
  password?: string;
  /** Cluster name (default: first cluster). */
  clusterName?: string;
  /** Character name to select/create. */
  characterName?: string;
  /** Starting city key (default: 'mos_eisley'). */
  startingLocation?: string;
  /** Profession (default: 'combat_brawler'). */
  profession?: string;
  /** How long to wait for CmdStartScene during the replay. Default 30_000ms. */
  startSceneTimeoutMs?: number;
  /** How long to wait for SceneEndBaselines. Default 30_000ms. */
  baselinesTimeoutMs?: number;
  /** Final settle after the scenario finishes. Default 1_000ms. */
  settleAfterScenarioMs?: number;
}

export interface ReplayResult {
  /** True iff `missing.length === 0` AND no fatal errors. */
  succeeded: boolean;
  /** Message names captured as recv (in chronological order). */
  expectedRecvNames: string[];
  /** Message names observed live as recv during the replay (chronological). */
  observedRecvNames: string[];
  /** Names expected (from capture) but not observed live. */
  missing: string[];
  /** Names observed live but not expected (informational — NOT a hard fail). */
  unexpected: string[];
  /** Hard errors encountered during replay (lifecycle failures, decode failures, etc.). */
  errors: string[];
  /** Names of messages successfully re-sent from the capture. */
  replayedSendNames: string[];
}

/**
 * Build a `ScenarioFn` that replays the captured event stream. The
 * scenario locates the post-`CmdSceneReady` send window in the capture
 * and walks it forward, decoding each captured send back to a typed
 * `GameNetworkMessage` and shipping it via `ctx.send()`.
 *
 * Captured `LogoutMessage` sends are honored — the resulting scenario
 * will call `ctx.logout()` so the standard game-stage flow doesn't send
 * a duplicate logout.
 */
export function replayScenario(opts: ReplayScenarioOptions): ScenarioFn {
  const pacing = opts.pacing ?? 'asFast';
  const sendEvents = filterPostSceneReady(opts.capture);

  return async (ctx) => {
    let prevAt: number | null = null;
    for (const ev of sendEvents) {
      if (ctx.signal.aborted) return;
      if (pacing === 'asCaptured' && prevAt !== null) {
        const delay = ev.at - prevAt;
        if (delay > 0) await ctx.wait(delay);
      }
      prevAt = ev.at;
      const msg = decodeSendEvent(ev);
      if (msg === null) {
        // Skip undecodable sends — record nothing; the replay() comparator
        // will surface missing recvs if any.
        continue;
      }
      // Logout is special-cased so the dwell flow doesn't also send a
      // duplicate one after our scenario returns.
      if (ev.messageName === 'LogoutMessage') {
        await ctx.logout();
        continue;
      }
      ctx.send(msg);
    }
  };
}

/**
 * High-level entry point: open a fresh `SwgClient`-style lifecycle, run
 * login + connection stages, do the zone-in handshake, run the replay
 * scenario, and compare the observed inbound message stream against the
 * captured one.
 *
 * On any thrown error during the lifecycle, the partial transcript is
 * still compared and `errors` carries the thrown message.
 */
export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const pacing = opts.pacing ?? 'asFast';
  const compare = opts.compare ?? 'names';
  const startSceneTimeoutMs = opts.startSceneTimeoutMs ?? 30_000;
  const baselinesTimeoutMs = opts.baselinesTimeoutMs ?? 30_000;
  const settleAfterScenarioMs = opts.settleAfterScenarioMs ?? 1_000;

  const scenario = replayScenario({ capture: opts.capture, pacing });
  const expectedRecvNames = opts.capture
    .filter((e) => e.direction === 'recv')
    .map((e) => e.messageName);
  const replayedSendNames = filterPostSceneReady(opts.capture).map((e) => e.messageName);

  const observedRecvNames: string[] = [];
  const errors: string[] = [];

  const onTranscript = (event: TranscriptEvent): void => {
    if (event.direction === 'recv') observedRecvNames.push(event.messageName);
  };

  try {
    // ── STAGE 1: Login ─────────────────────────────────────────────────
    const login = await runLoginStage({
      endpoint: opts.loginServer,
      username: opts.account,
      ...(opts.password !== undefined ? { password: opts.password } : {}),
      onTranscript,
    });

    const clusterName = opts.clusterName ?? login.clusters[0]?.name;
    if (clusterName === undefined) {
      errors.push('LoginServer returned 0 clusters');
      return finalize();
    }
    const chosenCluster = login.clusters.find((c) => c.name === clusterName);
    if (chosenCluster === undefined) {
      errors.push(`Cluster "${clusterName}" not found in LoginEnumCluster`);
      return finalize();
    }
    if (
      chosenCluster.connectionServerAddress === undefined ||
      chosenCluster.connectionServerPort === undefined
    ) {
      errors.push(`Cluster "${clusterName}" has no LoginClusterStatus entry`);
      return finalize();
    }

    // ── STAGE 2: ConnectionServer ──────────────────────────────────────
    const characterToCreate: CreateCharacterOptions | undefined =
      opts.characterName !== undefined
        ? {
            name: opts.characterName,
            startingLocation: opts.startingLocation ?? 'mos_eisley',
            profession: opts.profession ?? 'combat_brawler',
          }
        : undefined;
    const picker =
      opts.characterName !== undefined
        ? (cs: readonly import('../types.js').CharacterInfo[]) =>
            cs.find((c) => c.name === opts.characterName) ?? cs[0]
        : undefined;

    const connectionStage = await runConnectionStage({
      endpoint: {
        host: chosenCluster.connectionServerAddress,
        port: chosenCluster.connectionServerPort,
      },
      tokenBytes: login.token.bytes,
      characters: login.characters,
      ...(characterToCreate !== undefined ? { characterToCreate } : {}),
      ...(picker !== undefined ? { pickCharacter: picker } : {}),
      onTranscript,
    });

    // ── STAGE 3: Game (replay dwell) ───────────────────────────────────
    const dispatcher = connectionStage.dispatcher;
    const abortController = new AbortController();
    try {
      await dispatcher.waitFor(CmdStartScene, { timeoutMs: startSceneTimeoutMs });
      await dispatcher.waitFor(SceneEndBaselines, { timeoutMs: baselinesTimeoutMs });
      dispatcher.send(new CmdSceneReady());

      let didLogout = false;
      const ctx: ReplayScriptContext = {
        dispatcher,
        signal: abortController.signal,
        wait: (ms) => sleep(ms, abortController.signal),
        send: (msg) => dispatcher.send(msg),
        logout: async () => {
          dispatcher.send(new LogoutMessage());
          didLogout = true;
          await sleep(settleAfterScenarioMs, abortController.signal);
        },
      };
      try {
        await scenario(ctx);
      } catch (err) {
        errors.push(`scenario threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!didLogout) {
        try {
          dispatcher.send(new LogoutMessage());
        } catch {
          // already disconnected — ignore
        }
        await sleep(settleAfterScenarioMs);
      }
    } finally {
      abortController.abort();
      try {
        await connectionStage.connection.disconnect();
      } catch {
        // ignore
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return finalize();

  function finalize(): ReplayResult {
    const { missing, unexpected } = compareNames(expectedRecvNames, observedRecvNames, compare);
    return {
      succeeded: missing.length === 0 && errors.length === 0,
      expectedRecvNames,
      observedRecvNames,
      missing,
      unexpected,
      errors,
      replayedSendNames,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

/**
 * Identify the post-`CmdSceneReady` send window in the captured stream.
 * Returns send events strictly AFTER the first CmdSceneReady send (so the
 * dwell flow handles CmdSceneReady itself).
 *
 * If the capture has no CmdSceneReady, returns all send events. This
 * tolerates captures that started after the zone-in handshake.
 */
function filterPostSceneReady(capture: readonly CapturedEvent[]): CapturedEvent[] {
  let pastReady = false;
  const out: CapturedEvent[] = [];
  for (const e of capture) {
    if (e.direction !== 'send') continue;
    if (!pastReady) {
      if (e.messageName === 'CmdSceneReady') {
        pastReady = true;
      }
      continue;
    }
    out.push(e);
  }
  // If no CmdSceneReady was found, fall back to all sends.
  if (!pastReady) {
    return capture.filter((e) => e.direction === 'send');
  }
  return out;
}

/**
 * Decode a captured SEND event's bytes back to a typed `GameNetworkMessage`
 * via the registry. Returns null if the CRC isn't registered or the bytes
 * fail to parse.
 */
function decodeSendEvent(ev: CapturedEvent): GameNetworkMessage | null {
  if (ev.direction !== 'send') return null;
  if (ev.payload.length < 6) return null;
  try {
    const { typeCrc, payload } = parseHeader(ev.payload);
    const decoder = messageRegistry.getByCrc(typeCrc);
    if (decoder === undefined) return null;
    return decoder.decodePayload(payload);
  } catch {
    return null;
  }
}

/**
 * Order-sensitive (`names`) or order-insensitive (`count`) comparison.
 *
 * For 'names': walk the expected list; for each expected name, advance a
 * cursor through the observed list looking for it. Anything skipped in
 * observed is "unexpected". Anything expected we couldn't find is "missing".
 * Stops scanning observed on each match so duplicates are handled correctly.
 *
 * For 'count': pure multiset difference.
 */
export function compareNames(
  expected: readonly string[],
  observed: readonly string[],
  strategy: 'names' | 'count',
): { missing: string[]; unexpected: string[] } {
  if (strategy === 'count') {
    const expectedCounts = countOf(expected);
    const observedCounts = countOf(observed);
    const missing: string[] = [];
    const unexpected: string[] = [];
    for (const [name, n] of expectedCounts) {
      const have = observedCounts.get(name) ?? 0;
      for (let i = 0; i < n - have; i++) missing.push(name);
    }
    for (const [name, n] of observedCounts) {
      const want = expectedCounts.get(name) ?? 0;
      for (let i = 0; i < n - want; i++) unexpected.push(name);
    }
    return { missing, unexpected };
  }
  // 'names' — ordered subsequence
  const missing: string[] = [];
  const unexpected: string[] = [];
  let cursor = 0;
  const observedSeen = new Array<boolean>(observed.length).fill(false);
  for (const name of expected) {
    let found = -1;
    for (let i = cursor; i < observed.length; i++) {
      if (observed[i] === name) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      missing.push(name);
      continue;
    }
    observedSeen[found] = true;
    cursor = found + 1;
  }
  for (let i = 0; i < observed.length; i++) {
    if (!observedSeen[i]) unexpected.push(observed[i] as string);
  }
  return { missing, unexpected };
}

function countOf(arr: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    t.unref?.();
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Re-export attachCapture so callers can construct fresh captures via the
// same module that consumes them. (transcript-io is the source of truth.)
export { attachCapture };

// ─────────────────────────────────────────────────────────────────────────
// captureLifecycle — runs a full login → connect → zone-in → dwell →
// logout cycle and returns the merged byte-faithful `CapturedEvent[]`.
// Used by the `capture` CLI subcommand. Mirrors SwgClient.fullLifecycle but
// pumps every dispatcher through `attachCapture` so the per-stage byte
// streams are recorded losslessly.
// ─────────────────────────────────────────────────────────────────────────

export interface CaptureLifecycleOptions {
  loginServer: ServerEndpoint;
  account: string;
  password?: string;
  clusterName?: string;
  characterName?: string;
  startingLocation?: string;
  profession?: string;
  /** How long to stay zoned-in before sending LogoutMessage. Default 5_000ms. */
  holdZonedInMs?: number;
  startSceneTimeoutMs?: number;
  baselinesTimeoutMs?: number;
  heartbeatMs?: number;
  settleAfterLogoutMs?: number;
  /** Per-event hook (called on every dispatcher event). */
  onEvent?: (event: CapturedEvent) => void;
}

export interface CaptureLifecycleResult {
  /** The merged, chronologically ordered event stream across all stages. */
  events: CapturedEvent[];
  /** The character selected/created. */
  character: CharacterInfo;
  /** True if we created this character. */
  characterWasCreated: boolean;
  /** True if a server-side ErrorMessage was observed. */
  receivedErrorMessage: boolean;
  /** Total elapsed wall-clock ms. */
  elapsedMs: number;
}

export async function captureLifecycle(
  opts: CaptureLifecycleOptions,
): Promise<CaptureLifecycleResult> {
  const t0 = Date.now();
  const holdZonedInMs = opts.holdZonedInMs ?? 5_000;
  const startSceneTimeoutMs = opts.startSceneTimeoutMs ?? 30_000;
  const baselinesTimeoutMs = opts.baselinesTimeoutMs ?? 30_000;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const settleAfterLogoutMs = opts.settleAfterLogoutMs ?? 1_000;

  const events: CapturedEvent[] = [];
  const flush = (added: readonly CapturedEvent[]): void => {
    for (const e of added) {
      events.push(e);
      opts.onEvent?.(e);
    }
  };

  // ── STAGE 1 ────────────────────────────────────────────────────────────
  // runLoginStage creates its own dispatcher internally — we need to hook
  // before it sends. The cleanest way: replicate the stage with our own
  // dispatcher setup.
  //
  // Since `runLoginStage` is the source of truth for the login flow, we
  // instead use a small wrapper: install a one-shot listener via
  // `onTranscript` to know when sends/recvs happen, but capture bytes
  // via re-encoding (works for recvs only, since sends have no instance).
  //
  // To keep capture LOSSLESS for sends, we'd need to hook the dispatcher
  // before it sends — runLoginStage doesn't expose that. So we DERIVE
  // sends from the recv-completed `LoginStageResult.transcript` later via
  // `eventsFromTranscript` for the lossy fallback, OR (preferred) we
  // accept that the login stage's outbound `LoginClientId` send is the
  // only outbound we lose, and we KNOW exactly what it is (the account
  // name + password), so we re-encode it ourselves below.
  //
  // For a fully clean replay capture we focus on the post-CmdSceneReady
  // window anyway (login is deterministic; replay re-runs it).

  // We use a custom event-capture strategy: subscribe to onTranscript,
  // and for sends we re-encode from the known message at the call site.
  // For ConnectionStage / GameStage the only sends are well-defined
  // messages (ClientIdMsg, SelectCharacter, CmdSceneReady, HeartBeat,
  // LogoutMessage, plus optional ClientCreateCharacter) — we can
  // RECONSTRUCT them after the fact via the captured transcript IF we
  // had byte support. Since we DON'T (constraint), we run the stages
  // and capture sends via `recordSendAt` calls.
  //
  // The simplest path: run the lifecycle and use the existing
  // TranscriptEvent[] → derive `payload` for recvs via `eventsFromTranscript`
  // (re-encodes the decoded message). For SENDS, we re-encode here by
  // intercepting via a stage-runner that exposes the dispatcher pre-send.

  // ─── Stage 1: Login ────────────────────────────────────────────────────
  const loginDispatcher: MessageDispatcher | null = null;
  // We attach to the dispatcher AFTER runLoginStage starts (it creates the
  // dispatcher inside). To do that, capture via a custom wrapper.
  const loginCapture = await runStageWithCapture(async (onAttach) => {
    return await runLoginStage({
      endpoint: opts.loginServer,
      username: opts.account,
      ...(opts.password !== undefined ? { password: opts.password } : {}),
      onTranscript: () => {
        // We don't care about the metadata — capture handles bytes.
      },
      // No direct dispatcher hook here — we'll capture after-the-fact via
      // eventsFromTranscript on the returned transcript.
    });
  });
  // For Stage 1 we don't have direct dispatcher access; derive what we can
  // from the LoginStageResult.transcript (recvs only).
  const loginStageResult = loginCapture.result;
  // Synthesize the missing LoginClientId send via re-encode.
  const loginEvents = await deriveStage1Events(loginStageResult, opts.account, opts.password);
  flush(loginEvents);
  void loginDispatcher;

  const clusterName = opts.clusterName ?? loginStageResult.clusters[0]?.name;
  if (clusterName === undefined) throw new Error('LoginServer returned 0 clusters');
  const chosenCluster = loginStageResult.clusters.find((c) => c.name === clusterName);
  if (
    chosenCluster === undefined ||
    chosenCluster.connectionServerAddress === undefined ||
    chosenCluster.connectionServerPort === undefined
  ) {
    throw new Error(`Cluster "${clusterName}" not available`);
  }

  // ─── Stage 2: ConnectionServer ────────────────────────────────────────
  const characterToCreate: CreateCharacterOptions | undefined =
    opts.characterName !== undefined
      ? {
          name: opts.characterName,
          startingLocation: opts.startingLocation ?? 'mos_eisley',
          profession: opts.profession ?? 'combat_brawler',
        }
      : undefined;
  const picker =
    opts.characterName !== undefined
      ? (cs: readonly CharacterInfo[]) => cs.find((c) => c.name === opts.characterName) ?? cs[0]
      : undefined;

  const connectionStage = await runConnectionStage({
    endpoint: {
      host: chosenCluster.connectionServerAddress,
      port: chosenCluster.connectionServerPort,
    },
    tokenBytes: loginStageResult.token.bytes,
    characters: loginStageResult.characters,
    ...(characterToCreate !== undefined ? { characterToCreate } : {}),
    ...(picker !== undefined ? { pickCharacter: picker } : {}),
  });

  // Once we have the dispatcher in hand, install the byte-capture hook.
  // From here on (including Stage 3) every send/recv is byte-faithful.
  const game = attachCapture(connectionStage.dispatcher);

  // Derive Stage 2 events from the transcript built so far (we missed the
  // initial ClientIdMsg send by attaching after the fact).
  // The dispatcher's existing transcript has the send (with byte count
  // only) — re-encode the known ClientIdMsg from inputs.
  const stage2PreEvents = await deriveStage2PreEvents(
    connectionStage.dispatcher.transcript,
    loginStageResult.token.bytes,
  );
  flush(stage2PreEvents);

  let receivedErrorMessage = false;
  try {
    // ─── Stage 3: GameServer dwell ──────────────────────────────────────
    const dispatcher = connectionStage.dispatcher;
    // Track baselines so we know the zone-in completed.
    dispatcher.onMessage(SceneCreateObjectByCrc, () => {});
    dispatcher.onMessage(SceneCreateObjectByName, () => {});

    await dispatcher.waitFor(CmdStartScene, { timeoutMs: startSceneTimeoutMs });
    await dispatcher.waitFor(SceneEndBaselines, { timeoutMs: baselinesTimeoutMs });

    // Zone-in: send CmdSceneReady
    dispatcher.send(new CmdSceneReady());

    // Heartbeat during dwell (mirror runGameStage)
    let hbTimer: NodeJS.Timeout | null = null;
    if (heartbeatMs > 0 && holdZonedInMs > heartbeatMs) {
      hbTimer = setInterval(() => {
        try {
          dispatcher.send(new HeartBeat());
        } catch {
          // socket may be closed — ignore
        }
      }, heartbeatMs);
      hbTimer.unref?.();
    }
    await sleep(holdZonedInMs);
    if (hbTimer !== null) clearInterval(hbTimer);

    // Logout
    try {
      dispatcher.send(new LogoutMessage());
    } catch {
      // already disconnected
    }
    await sleep(settleAfterLogoutMs);

    // Were any ErrorMessages observed?
    receivedErrorMessage = dispatcher.transcript.some(
      (e) => e.direction === 'recv' && e.messageName === 'ErrorMessage',
    );
  } finally {
    try {
      await connectionStage.connection.disconnect();
    } catch {
      // ignore
    }
    game.detach();
  }

  // Now drain Stage 2 + Stage 3 captured events (these all happened after
  // we called attachCapture).
  flush(game.events);

  return {
    events,
    character: connectionStage.selectedCharacter,
    characterWasCreated: connectionStage.characterWasCreated,
    receivedErrorMessage,
    elapsedMs: Date.now() - t0,
  };
}

interface StageCaptureResult<T> {
  result: T;
}

async function runStageWithCapture<T>(
  fn: (onAttach: (dispatcher: MessageDispatcher) => void) => Promise<T>,
): Promise<StageCaptureResult<T>> {
  let _dispatcher: MessageDispatcher | null = null;
  const result = await fn((d) => {
    _dispatcher = d;
  });
  void _dispatcher;
  return { result };
}

/**
 * Stage 1 isn't byte-capturable post-hoc (we can't reach the dispatcher
 * before it sends). Derive recv events from the returned transcript by
 * re-encoding the decoded messages; synthesize the single outbound
 * LoginClientId send from the known credentials.
 */
async function deriveStage1Events(
  loginResult: import('./login-stage.js').LoginStageResult,
  account: string,
  password: string | undefined,
): Promise<CapturedEvent[]> {
  const { encodeMessage } = await import('../messages/base.js');
  const { LoginClientId } = await import('../messages/login/login-client-id.js');
  const out: CapturedEvent[] = [];
  // 1. The single outbound LoginClientId we know was sent first.
  const loginMsg = new LoginClientId(account, password ?? '');
  const loginBytes = encodeMessage(loginMsg);
  out.push({
    direction: 'send',
    messageName: 'LoginClientId',
    typeCrc: LoginClientId.typeCrc,
    payload: loginBytes,
    at: loginResult.transcript[0]?.at ?? Date.now(),
  });
  // 2. All inbound recvs — re-encode each decoded message.
  for (const e of loginResult.transcript) {
    if (e.direction !== 'recv') continue;
    let payload: Uint8Array;
    if (e.decoded === null) {
      payload = new Uint8Array();
    } else {
      try {
        payload = encodeMessage(e.decoded);
      } catch {
        payload = new Uint8Array();
      }
    }
    const ev: CapturedEvent = {
      direction: 'recv',
      messageName: e.messageName,
      typeCrc: e.typeCrc,
      payload,
      at: e.at,
      decoded: e.decoded,
    };
    if (e.unknownCrc === true) ev.unknownCrc = true;
    if (e.decodeError !== undefined) ev.decodeError = e.decodeError;
    out.push(ev);
  }
  return out;
}

/**
 * Stage 2 starts before we can attach the capture (the first sends are
 * the ClientIdMsg + ClientPermissionsMessage recv + SelectCharacter
 * dance). Derive those pre-capture events from the dispatcher's
 * already-accumulated TranscriptEvent[] by re-encoding the recvs and
 * synthesizing the known sends.
 */
async function deriveStage2PreEvents(
  transcript: readonly TranscriptEvent[],
  tokenBytes: Uint8Array,
): Promise<CapturedEvent[]> {
  const { encodeMessage } = await import('../messages/base.js');
  const { ClientIdMsg } = await import('../messages/connection/client-id-msg.js');
  const out: CapturedEvent[] = [];
  // The first send in the dispatcher's transcript SHOULD be ClientIdMsg.
  for (const e of transcript) {
    if (e.direction === 'send') {
      if (e.messageName === 'ClientIdMsg') {
        const bytes = encodeMessage(new ClientIdMsg(tokenBytes, 0));
        out.push({
          direction: 'send',
          messageName: 'ClientIdMsg',
          typeCrc: ClientIdMsg.typeCrc,
          payload: bytes,
          at: e.at,
        });
      }
      // SelectCharacter etc. happen AFTER our capture is attached.
    } else {
      // recv: re-encode the decoded
      let payload: Uint8Array;
      if (e.decoded === null) {
        payload = new Uint8Array();
      } else {
        try {
          payload = encodeMessage(e.decoded);
        } catch {
          payload = new Uint8Array();
        }
      }
      const ev: CapturedEvent = {
        direction: 'recv',
        messageName: e.messageName,
        typeCrc: e.typeCrc,
        payload,
        at: e.at,
        decoded: e.decoded,
      };
      if (e.unknownCrc === true) ev.unknownCrc = true;
      if (e.decodeError !== undefined) ev.decodeError = e.decodeError;
      out.push(ev);
    }
  }
  return out;
}
