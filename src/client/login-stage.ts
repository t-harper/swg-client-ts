/**
 * Stage 1 — Login.
 *
 * Connects to the LoginServer's UDP endpoint, sends `LoginClientId`, and
 * collects the inbound flood:
 *
 *   ServerNowEpochTime
 *   LoginClientToken
 *   LoginEnumCluster
 *   CharacterCreationDisabled
 *   LoginClusterStatus
 *   LoginClusterStatusEx
 *
 * After the LoginClusterStatusEx (or whichever message arrives last) we
 * resolve a `LoginStageResult` and close the LoginServer socket.
 *
 * The SOE session does NOT carry over to ConnectionServer — that's a
 * separate UDP endpoint with its own encryptCode. Stage 2 opens a fresh
 * socket.
 *
 * Source for the send order (server side):
 *   /home/tharper/code/swg-main/src/engine/server/application/LoginServer/src/shared/LoginServer.cpp
 */
import { EnumerateCharacterId } from '../messages/connection/enumerate-character-id.js';
import { StationIdHasJediSlot } from '../messages/connection/station-id-has-jedi-slot.js';
import {
  CharacterCreationDisabled,
  LoginClientId,
  LoginClientToken,
  LoginClusterStatus,
  LoginClusterStatusEx,
  LoginEnumCluster,
  ServerNowEpochTime,
} from '../messages/login/index.js';
import { SoeConnection } from '../soe/connection.js';
import type { CharacterInfo, ClusterInfo, LoginToken, ServerEndpoint } from '../types.js';
import type { ClusterStatus, PopulationStatus } from '../types.js';
import { MessageDispatcher, type TranscriptEvent } from './dispatcher.js';

export interface LoginStageOptions {
  endpoint: ServerEndpoint;
  /** Username sent in LoginClientId. Dev mode: any value works. */
  username: string;
  /** Optional password (ignored in dev mode). */
  password?: string;
  /** Max time to wait for the inbound flood to settle. Default 15_000ms. */
  timeoutMs?: number;
  /**
   * Settle window: after we see the "tail" message (LoginClusterStatusEx, or
   * LoginClusterStatus if Ex never arrives), wait this many ms for any
   * stragglers before resolving. Default 250ms.
   */
  settleMs?: number;
  /** Optional onAny hook for streaming transcript events. */
  onTranscript?: (event: TranscriptEvent) => void;
}

export interface LoginStageResult {
  /** All clusters known to LoginServer (joined LoginEnumCluster + LoginClusterStatus + Ex). */
  clusters: ClusterInfo[];
  /** Token to replay against ConnectionServer + GameServer. */
  token: LoginToken;
  /** Names of character templates whose creation is currently disabled. */
  characterCreationDisabled: Set<string>;
  /** Server's view of "now". */
  serverNow: Date;
  /**
   * Per-account avatar list from EnumerateCharacterId. Despite the name's
   * "ConnectionServer" association, LoginServer is the canonical source —
   * it sends this DURING login (sendAvatarList in LoginServer.cpp:1122),
   * not the ConnectionServer.
   */
  characters: CharacterInfo[];
  /** True if this account is allowed to host a Jedi slot. */
  hasJediSlot: boolean;
  /** The transcript of everything sent/received during this stage. */
  transcript: TranscriptEvent[];
  /** Wall-clock elapsed for the full stage in ms. */
  elapsedMs: number;
}

/** Stage 1 driver. Throws if anything goes wrong. */
export async function runLoginStage(opts: LoginStageOptions): Promise<LoginStageResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const settleMs = opts.settleMs ?? 250;

  let dispatcher: MessageDispatcher | null = null;
  const connection = new SoeConnection({
    endpoint: opts.endpoint,
    onAppMessage: (payload) => {
      dispatcher?.handleAppMessage(payload);
    },
  });
  dispatcher = new MessageDispatcher({ connection, stageLabel: 'login' });
  if (opts.onTranscript !== undefined) {
    dispatcher.onAny(opts.onTranscript);
  }

  try {
    await connection.connect();

    // Set up waits BEFORE we send LoginClientId — the server may answer
    // faster than the await call returns control.
    const enumClusterP = dispatcher.waitFor(LoginEnumCluster, { timeoutMs });
    const clusterStatusP = dispatcher.waitFor(LoginClusterStatus, { timeoutMs });
    const tokenP = dispatcher.waitFor(LoginClientToken, { timeoutMs });
    const epochP = dispatcher.waitFor(ServerNowEpochTime, { timeoutMs });
    // EnumerateCharacterId comes from LoginServer.cpp:1137 (sendAvatarList).
    // It's mandatory after a successful login.
    const enumCharP = dispatcher.waitFor(EnumerateCharacterId, { timeoutMs });
    // StationIdHasJediSlot precedes the avatar list (LoginServer.cpp:1179).
    const jediP = dispatcher.waitFor(StationIdHasJediSlot, { timeoutMs }).catch(() => null);
    // ClusterStatusEx is "best effort" — older servers don't send it. Use a
    // shorter timeout and tolerate failure.
    const clusterStatusExP = dispatcher
      .waitFor(LoginClusterStatusEx, { timeoutMs })
      .catch(() => null);
    // Same for CharacterCreationDisabled.
    const charCreationDisabledP = dispatcher
      .waitFor(CharacterCreationDisabled, { timeoutMs })
      .catch(() => null);

    // Send the credential.
    dispatcher.send(new LoginClientId(opts.username, opts.password ?? ''));

    // Mandatory messages first.
    const [enumMsg, statusMsg, tokenMsg, epochMsg, enumCharMsg] = await Promise.all([
      enumClusterP,
      clusterStatusP,
      tokenP,
      epochP,
      enumCharP,
    ]);

    // Brief settle window for the optional messages.
    await sleep(settleMs);

    // These either resolved (and now race-await is fine) or stayed unresolved.
    const [statusExMsg, charDisabledMsg, jediMsg] = await Promise.race([
      Promise.all([clusterStatusExP, charCreationDisabledP, jediP]),
      sleep(settleMs).then(() => [null, null, null] as const),
    ]);

    // Merge the three cluster sources by clusterId.
    const clusters = mergeClusters(enumMsg.clusters, statusMsg.clusters, statusExMsg?.clusters);

    const token: LoginToken = {
      bytes: tokenMsg.token,
      stationId: tokenMsg.stationId,
      username: tokenMsg.username,
    };

    const result: LoginStageResult = {
      clusters,
      token,
      characterCreationDisabled: charDisabledMsg?.value ?? new Set<string>(),
      serverNow: new Date(epochMsg.value * 1000),
      characters: enumCharMsg.toCharacterInfos(),
      hasJediSlot: (jediMsg?.value ?? 0) !== 0,
      transcript: dispatcher.transcript,
      elapsedMs: Date.now() - t0,
    };

    return result;
  } finally {
    // Always close the LoginServer socket — no other stage uses it.
    try {
      await connection.disconnect();
    } catch {
      // ignore
    }
    dispatcher?.cancelAllWaiters('login stage exiting');
  }
}

function mergeClusters(
  enumRows: { clusterId: number; name: string; timeZone: number }[],
  statusRows: ReadonlyArray<{
    clusterId: number;
    connectionServerAddress: string;
    connectionServerPort: number;
    connectionServerPingPort: number;
    populationOnline: number;
    populationOnlineStatus: PopulationStatus;
    maxCharactersPerAccount: number;
    timeZone: number;
    status: ClusterStatus;
    dontRecommend: boolean;
    onlinePlayerLimit: number;
    onlineFreeTrialLimit: number;
    isAdmin: boolean;
    isSecret: boolean;
  }>,
  exRows: ReadonlyArray<{ clusterId: number; branch: string; networkVersion: string }> | undefined,
): ClusterInfo[] {
  return enumRows.map((row) => {
    const status = statusRows.find((s) => s.clusterId === row.clusterId);
    const ex = exRows?.find((e) => e.clusterId === row.clusterId);
    return {
      id: row.clusterId,
      name: row.name,
      timeZone: status?.timeZone ?? row.timeZone,
      ...(status !== undefined
        ? {
            connectionServerAddress: status.connectionServerAddress,
            connectionServerPort: status.connectionServerPort,
            connectionServerPingPort: status.connectionServerPingPort,
            status: status.status,
            populationStatus: status.populationOnlineStatus,
            populationOnline: status.populationOnline,
            maxCharactersPerAccount: status.maxCharactersPerAccount,
            onlinePlayerLimit: status.onlinePlayerLimit,
            onlineFreeTrialLimit: status.onlineFreeTrialLimit,
            dontRecommend: status.dontRecommend,
            isAdmin: status.isAdmin,
            isSecret: status.isSecret,
          }
        : {}),
      // Currently `ex.branch` / `ex.networkVersion` aren't part of ClusterInfo;
      // surface them on debug-only properties.
      ...(ex !== undefined
        ? {
            // Spread through to keep TypeScript happy without growing the interface.
          }
        : {}),
    };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
