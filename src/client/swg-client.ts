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
import '../messages/game/scene-create-object-by-crc.js';
import '../messages/game/scene-create-object-by-name.js';
import '../messages/game/scene-end-baselines.js';
import '../messages/game/sui/index.js';
import '../messages/game/survey/index.js';
import '../messages/game/trade/index.js';
import '../messages/game/update-transform-message.js';
import '../messages/game/update-transform-with-parent-message.js';

import { Buffer } from 'node:buffer';
import {
  type CharacterInfo,
  type ClusterInfo,
  type SceneStart,
  type ServerEndpoint,
  ZoneState,
} from '../types.js';
import { type CreateCharacterOptions, runConnectionStage } from './connection-stage.js';
import type { TranscriptEvent } from './dispatcher.js';
import { runGameStage } from './game-stage.js';
import { runLoginStage } from './login-stage.js';
import type { ScenarioFn, ScriptResult } from './script/context.js';

export interface SwgClientOptions {
  loginServer: ServerEndpoint;
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
}

export class SwgClient {
  private readonly loginServer: ServerEndpoint;

  constructor(opts: SwgClientOptions) {
    this.loginServer = opts.loginServer;
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

    // ── STAGE 1 ──────────────────────────────────────────────────────────
    const login = await runLoginStage({
      endpoint: this.loginServer,
      username: opts.account,
      password: opts.password,
      onTranscript,
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
  return normalize(result);
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
