/**
 * SwgClient — the single user-facing class.
 *
 * Orchestrates the four lifecycle stages:
 *
 *   Stage 1: Login         (LoginServer)
 *   Stage 2: Connection    (ConnectionServer)
 *   Stage 3: Game          (ConnectionServer-tunneled GameServer; same socket)
 *   Stage 4: Logout        (LogoutMessage + SOE Terminate; rolled into Stage 3)
 *
 * Usage:
 *   const client = new SwgClient({ loginServer: { host: '10.254.0.253', port: 44453 } });
 *   const result = await client.fullLifecycle({
 *     account: 'ci-test',
 *     characterName: 'TsTest',     // create if not exists
 *     planet: 'tatooine',
 *     holdZonedInMs: 5000,
 *   });
 *
 * The returned `LifecycleResult` is fully JSON-serializable (after a small
 * normalization pass — see `lifecycleResultToJSON`) and is what the CLI
 * prints.
 */

// Side-effect import: every message class self-registers on first load.
// We do this at module load time so the dispatcher's CRC lookups Just Work.
import '../messages/login/index.js';
import '../messages/connection/client-create-character-failed.js';
import '../messages/connection/client-create-character-success.js';
import '../messages/connection/client-create-character.js';
import '../messages/connection/client-id-msg.js';
import '../messages/connection/client-permissions-message.js';
import '../messages/connection/enumerate-character-id.js';
import '../messages/connection/error-message.js';
import '../messages/connection/game-server-for-login.js';
import '../messages/connection/select-character.js';
import '../messages/connection/station-id-has-jedi-slot.js';
import '../messages/game/attribute-list-message.js';
import '../messages/game/baselines/index.js';
import '../messages/game/chat/index.js';
import '../messages/game/client-open-container.js';
import '../messages/game/commodities/index.js';
import '../messages/game/con-generic-message.js';
import '../messages/game/cmd-scene-ready.js';
import '../messages/game/cmd-start-scene.js';
import '../messages/game/heart-beat.js';
import '../messages/game/logout-message.js';
import '../messages/game/obj-controller-message.js';
import '../messages/game/object-menu-select-message.js';
// Sub-import: register the 8 ObjController subtype decoders so the
// ObjControllerMessage trailer dispatch can resolve them.
import '../messages/game/obj-controller/index.js';
// Sub-import: register the crafting-session subtype decoders
// (DraftSchematics, ManufactureSchematic) — they live in their own folder
// for organization but register through the ObjController subtype registry.
import '../messages/game/crafting/index.js';
import '../messages/game/missions/index.js';
import '../messages/game/npc/index.js';
// Sub-import: register the planetary-map-locations decoders so the
// server→client GetMapLocationsResponseMessage (the reply to a
// GetMapLocationsMessage that `ctx.map` sends) can be decoded.
import '../messages/game/planet-map/index.js';
import '../messages/game/scene-create-object-by-crc.js';
import '../messages/game/scene-create-object-by-name.js';
import '../messages/game/scene-destroy-object.js';
import '../messages/game/scene-end-baselines.js';
import '../messages/game/update-containment-message.js';
import '../messages/game/sui/index.js';
import '../messages/game/survey/index.js';
import '../messages/game/trade/index.js';
import '../messages/game/update-transform-message.js';
import '../messages/game/update-transform-with-parent-message.js';

import { Buffer } from 'node:buffer';
import type { LatencyStats } from '../soe/clock-sync.js';
import type { RawCaptureOptions } from '../soe/interface.js';
import {
  type CharacterInfo,
  type ClusterInfo,
  type SceneStart,
  type ServerEndpoint,
  ZoneState,
} from '../types.js';
import { type CreateCharacterOptions, runConnectionStage } from './connection-stage.js';
import {
  type DeleteCharacterOptions,
  type DeleteCharacterReply,
  deleteCharacter,
} from './delete-character.js';
import type { TranscriptEvent } from './dispatcher.js';
import { runGameStage } from './game-stage.js';
import { type Knowledge, defaultKnowledge } from './knowledge.js';
import { runLoginStage } from './login-stage.js';
import type { ScenarioFn, ScriptResult } from './script/context.js';
import type { WorldModel } from './world-model.js';

/**
 * Options for raw-byte SOE capture across a full lifecycle. Because Stage 1
 * and Stages 2-3 use independent SOE sessions (different encryptCodes), each
 * is written to a distinct file derived from `basePath` (or supplied
 * explicitly via `loginPath`/`gamePath`).
 *
 * Recommended: pass `basePath: '/tmp/capture'` to get
 *   `/tmp/capture.login.ndjson` + `/tmp/capture.game.ndjson`.
 */
export interface FullLifecycleRawCaptureOptions {
  /**
   * Base file path. Suffixes `.login.ndjson` and `.game.ndjson` are appended
   * to derive per-stage output paths. Ignored if `loginPath`/`gamePath` are
   * supplied.
   */
  basePath?: string;
  /** Explicit Stage 1 output path. Overrides `basePath`. */
  loginPath?: string;
  /** Explicit Stage 2+3 output path. Overrides `basePath`. */
  gamePath?: string;
}

export interface SwgClientOptions {
  loginServer: ServerEndpoint;
  /**
   * Shared knowledge base — the process-wide cache of lazy-loaded offline
   * data (terrain templates, STF strings, ...). Defaults to the module-level
   * `defaultKnowledge` singleton. Pass an explicit instance only for tests
   * (e.g. a fresh `new KnowledgeImpl()` for isolation) or when you want to
   * pre-warm a private cache that won't leak into other clients.
   */
  knowledge?: Knowledge;
}

export interface FullLifecycleOptions {
  /** Account name sent in LoginClientId. Dev mode: any value works. */
  account: string;
  /** Optional password (dev mode ignores). */
  password?: string;
  /** Cluster name to attach to. Default: the first cluster (typically "swg"). */
  clusterName?: string;
  /**
   * If the cluster has no characters for this account, create one. The name
   * defaults to `swg-ts-${Date.now()}` if not supplied.
   */
  characterName?: string;
  /** Starting planet on creation. Default 'tatooine'. */
  planet?: string;
  /** Profession on creation. Default 'combat_brawler'. */
  profession?: string;
  /**
   * NGE skill-template baked into the character at creation time (e.g.
   * `"officer_1a"`, `"commando_1a"`, `"medic_1a"` — see
   * `dsrc/.../skill_template/skill_template.tab`). Carried on the
   * `ClientCreateCharacterMessage` wire so the player's `m_skillTemplate`
   * PLAY baseline is set before zone-in — bypasses the in-client
   * `ws_professiontemplateselect` picker that fresh characters otherwise
   * get on first login. Pair with `workingSkill` (the starting skill of
   * the template chain, e.g. `"class_officer_phase1_novice"`).
   */
  skillTemplate?: string;
  /**
   * The starting skill of the chosen `skillTemplate` chain (e.g.
   * `"class_officer_phase1_novice"`). Sent in `ClientCreateCharacterMessage`
   * alongside `skillTemplate`. Required for the bypass to fully stick —
   * the server uses this to initialize the player's `m_currentWorkingSkill`
   * PLAY baseline.
   */
  workingSkill?: string;
  /** How long to hold the zoned-in state before logging out. Default 5_000ms. */
  holdZonedInMs?: number;
  /**
   * Optional scripted scenario to run during the zoned-in dwell (walk,
   * open inventory, etc.). Runs in place of the sleep; any remaining
   * `holdZonedInMs` after the script returns is still awaited.
   */
  script?: ScenarioFn;
  /**
   * If true, only run Stages 1 + 2 (login + select), skip zone-in + logout.
   * Used by `live-connection.test.ts`.
   */
  skipGameStage?: boolean;
  /** Stream every transcript event to this hook. */
  onTranscript?: (event: TranscriptEvent) => void;
  /** Stream every state transition to this hook. */
  onStateChange?: (state: ZoneState) => void;
  /**
   * If set, every UDP datagram on the LoginServer and ConnectionServer
   * sockets is teed to per-stage NDJSON files. See
   * `FullLifecycleRawCaptureOptions` for details.
   *
   * The decoder CLI (`pnpm cli decode-raw`) replays the byte stream offline,
   * verifying CRC and emitting the same message decodes the live client saw.
   */
  rawCapture?: FullLifecycleRawCaptureOptions;
}

/**
 * Latency histogram surfaced from the connection-stage SOE socket (the same
 * one that gets re-routed into game-stage). Login-stage's socket closes
 * before its first ClockSync interval elapses, so any samples there would
 * be discarded — only the connection/game socket's samples make it here.
 */
export interface LifecycleLatency {
  /** Number of ClockReflect samples observed. */
  samples: number;
  /** 50th percentile RTT (ms), nearest-rank. */
  p50: number;
  /** 95th percentile RTT (ms), nearest-rank. */
  p95: number;
  /** 99th percentile RTT (ms), nearest-rank. */
  p99: number;
  /** Arithmetic mean RTT (ms). */
  mean: number;
}

export interface LifecycleResult {
  /** Per-stage wall-clock elapsed in ms. */
  stages: {
    login: number;
    connection: number;
    game: number | null;
    logout: number | null;
  };
  /** Clusters seen during login. */
  clusters: ClusterInfo[];
  /** The cluster we picked. */
  chosenCluster: ClusterInfo;
  /** The character we played as. */
  character: CharacterInfo;
  /** True if we created this character (vs. picking an existing one). */
  characterWasCreated: boolean;
  /** CmdStartScene payload — only present if we ran Stage 3. */
  sceneStart?: SceneStart;
  /** Count of baseline objects accumulated during zone-in. */
  baselineObjectCount: number;
  /** When we received SceneEndBaselines (== logically "zoned in"). null if we skipped Stage 3. */
  zonedInAt: Date | null;
  /** When we sent LogoutMessage. null if we skipped Stage 3. */
  logoutAt: Date | null;
  /** The full transcript across all stages. */
  transcript: TranscriptEvent[];
  /** Token returned by the LoginServer (useful for debugging). */
  stationId: number;
  /** Whether we ever observed a server-side ErrorMessage. */
  receivedErrorMessage: boolean;
  /** Set if a script ran during the dwell. */
  scriptResult?: ScriptResult;
  /**
   * Round-trip-time histogram from ClockSync/ClockReflect exchanges. Null if
   * no samples were collected (short-lived lifecycles may not span an
   * interval, default 45s).
   */
  latency: LifecycleLatency | null;
  /**
   * Live world view that absorbed the baseline flood + any deltas/transforms
   * that arrived during the dwell. `null` if the game stage was skipped
   * (`skipGameStage: true`). Detached from the dispatcher by the time this
   * is returned — no further mutation, but all snapshots are queryable.
   */
  world: WorldModel | null;
}

export class SwgClient {
  private readonly loginServer: ServerEndpoint;
  private readonly knowledge: Knowledge;

  constructor(opts: SwgClientOptions) {
    this.loginServer = opts.loginServer;
    this.knowledge = opts.knowledge ?? defaultKnowledge;
  }

  /**
   * Delete a character via the LoginServer wire path (same flow the Windows
   * client's "Delete Character" button on the character-select screen uses).
   *
   * Returns the server's `DeleteCharacterReplyMessage` result code. Note:
   * `OK` means the delete was queued, not that the character is gone —
   * see {@link deleteCharacter} for caveats.
   *
   * @example
   * await client.deleteCharacter({ account: 'tslive11', characterId: 591551177n });
   */
  async deleteCharacter(
    opts: Omit<DeleteCharacterOptions, 'loginServer'>,
  ): Promise<DeleteCharacterReply> {
    return deleteCharacter({ ...opts, loginServer: this.loginServer });
  }

  /**
   * Run the full Stage 1 → 2 → 3 → 4 lifecycle. Returns once we've sent the
   * LogoutMessage + Terminate and closed the sockets.
   */
  async fullLifecycle(opts: FullLifecycleOptions): Promise<LifecycleResult> {
    const transcript: TranscriptEvent[] = [];
    const onTranscript = (event: TranscriptEvent): void => {
      transcript.push(event);
      opts.onTranscript?.(event);
    };

    opts.onStateChange?.(ZoneState.LoginHandshake);

    const loginRawCapture = resolveRawCapture(opts.rawCapture, 'login');
    const gameRawCapture = resolveRawCapture(opts.rawCapture, 'game');

    // ── STAGE 1 ──────────────────────────────────────────────────────────
    const login = await runLoginStage({
      endpoint: this.loginServer,
      username: opts.account,
      password: opts.password,
      onTranscript,
      ...(loginRawCapture !== undefined ? { rawCapture: loginRawCapture } : {}),
    });
    opts.onStateChange?.(ZoneState.LoginAuthed);

    // Pick the requested cluster (default: first).
    const clusterName = opts.clusterName ?? login.clusters[0]?.name;
    if (clusterName === undefined) {
      throw new Error('LoginServer returned 0 clusters — server may be misconfigured');
    }
    const chosenCluster = login.clusters.find((c) => c.name === clusterName);
    if (chosenCluster === undefined) {
      throw new Error(
        `Cluster "${clusterName}" not found in LoginEnumCluster (available: ${login.clusters.map((c) => c.name).join(', ')})`,
      );
    }
    if (
      chosenCluster.connectionServerAddress === undefined ||
      chosenCluster.connectionServerPort === undefined
    ) {
      throw new Error(
        `Cluster "${clusterName}" has no LoginClusterStatus entry (status=${chosenCluster.status})`,
      );
    }

    opts.onStateChange?.(ZoneState.ConnectionHandshake);

    // ── STAGE 2 ──────────────────────────────────────────────────────────
    // The LoginServer already returned the avatar list in Stage 1.
    // ConnectionServer handles character creation if the list is empty.
    //
    // Note: `planet` here is a starting_locations.iff KEY (a city), not a
    // planet name. Defaults to mos_eisley on tatooine. The user's `planet`
    // flag is interpreted as a city key on the assumption they know what
    // they're doing; pass through unchanged.
    const characterToCreate: CreateCharacterOptions | undefined =
      opts.characterName !== undefined
        ? {
            name: opts.characterName,
            startingLocation: opts.planet ?? 'mos_eisley',
            profession: opts.profession ?? 'combat_brawler',
            ...(opts.skillTemplate !== undefined ? { skillTemplate: opts.skillTemplate } : {}),
            ...(opts.workingSkill !== undefined ? { workingSkill: opts.workingSkill } : {}),
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
      tokenBytes: login.token.bytes,
      characters: login.characters,
      ...(characterToCreate !== undefined ? { characterToCreate } : {}),
      ...(picker !== undefined ? { pickCharacter: picker } : {}),
      onTranscript,
      ...(gameRawCapture !== undefined ? { rawCapture: gameRawCapture } : {}),
    });
    opts.onStateChange?.(ZoneState.CharacterSelected);

    let game: Awaited<ReturnType<typeof runGameStage>> | null = null;
    let receivedErrorMessage = false;
    try {
      if (!opts.skipGameStage) {
        // ── STAGE 3 ──────────────────────────────────────────────────────
        game = await runGameStage({
          dispatcher: connectionStage.dispatcher,
          holdZonedInMs: opts.holdZonedInMs ?? 5_000,
          ...(opts.script !== undefined ? { script: opts.script } : {}),
          onStateChange: opts.onStateChange,
          onTranscript: undefined, // already wired via Stage 2's dispatcher
          knowledge: this.knowledge,
        });
      }
    } finally {
      // ── STAGE 4 (rolled into Stage 3): send SOE Terminate + close ─────
      try {
        await connectionStage.connection.disconnect();
      } catch {
        // ignore
      }
      opts.onStateChange?.(ZoneState.Disconnected);
    }

    // Did we see any ErrorMessage anywhere in the transcript?
    receivedErrorMessage = transcript.some(
      (e) => e.direction === 'recv' && e.messageName === 'ErrorMessage',
    );

    // Query latency stats from the connection-stage socket — the same socket
    // is reused for game-stage, so all RTT samples observed across stages 2
    // through 4 land here. (Login-stage uses a separate socket that closes
    // before any ClockSync interval elapses, so its samples are discarded.)
    // disconnect() above only clears timers + closes the socket; the
    // latencySamples array survives.
    const rawLatency = connectionStage.connection.getLatencyStats();
    const latency: LifecycleLatency | null = rawLatency
      ? {
          samples: rawLatency.count,
          p50: rawLatency.p50,
          p95: rawLatency.p95,
          p99: rawLatency.p99,
          mean: rawLatency.mean,
        }
      : null;

    const result: LifecycleResult = {
      stages: {
        login: login.elapsedMs,
        connection: connectionStage.elapsedMs,
        game: game?.elapsedMs ?? null,
        logout: game !== null ? Math.max(0, Date.now() - game.logoutAt.getTime()) : null,
      },
      clusters: login.clusters,
      chosenCluster,
      character: connectionStage.selectedCharacter,
      characterWasCreated: connectionStage.characterWasCreated,
      ...(game?.sceneStart !== undefined ? { sceneStart: game.sceneStart } : {}),
      baselineObjectCount: game?.baseline.objectIds.length ?? 0,
      zonedInAt: game?.zonedInAt ?? null,
      logoutAt: game?.logoutAt ?? null,
      transcript,
      stationId: login.token.stationId,
      receivedErrorMessage,
      ...(game?.scriptResult !== undefined ? { scriptResult: game.scriptResult } : {}),
      latency,
      world: game?.world ?? null,
    };
    return result;
  }
}

/**
 * Normalize a LifecycleResult so it can be safely JSON.stringify'd:
 *   - BigInts → string
 *   - Uint8Array → hex string
 *   - Date → ISO string
 */
export function lifecycleResultToJSON(result: LifecycleResult): unknown {
  // `world` is a live class instance with a Map of WorldObjects (each
  // holding back-references through the dispatcher's transcript) — recursive
  // normalization would walk thousands of nodes and risk cycles. Strip it
  // from the JSON view; callers wanting a serialized world should use a
  // future `WorldModel.toJSON()` snapshot helper.
  const { world: _world, ...rest } = result;
  return normalize(rest);
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

/**
 * Resolve `FullLifecycleRawCaptureOptions` → per-stage `RawCaptureOptions`.
 * Returns undefined if no capture was requested for this stage.
 *
 * Stages: `'login'` for Stage 1, `'game'` for Stages 2+3 (same SOE session).
 */
function resolveRawCapture(
  opts: FullLifecycleRawCaptureOptions | undefined,
  stage: 'login' | 'game',
): RawCaptureOptions | undefined {
  if (opts === undefined) return undefined;
  const explicit = stage === 'login' ? opts.loginPath : opts.gamePath;
  if (explicit !== undefined) {
    return { writePath: explicit, stage };
  }
  if (opts.basePath !== undefined) {
    return { writePath: `${opts.basePath}.${stage}.ndjson`, stage };
  }
  return undefined;
}
