/**
 * Stage 2 — ConnectionServer.
 *
 * Opens a fresh UDP socket to the chosen cluster's ConnectionServer, sends
 * `ClientIdMsg(token)`, waits for `ClientPermissionsMessage`, optionally
 * creates a character via `ClientCreateCharacter` if the Stage-1 avatar
 * list is empty, then sends `SelectCharacter` for the chosen character.
 *
 * IMPORTANT (CORRECTED FROM ORIGINAL PLAN):
 *   The client does NOT switch sockets after `SelectCharacter`. The
 *   server-side `handleSelectCharacterMessage` validates with Central; on
 *   success ConnectionServer's internal routing changes (the underlying
 *   GameConnection is re-attached server-side), but the client stays on the
 *   exact same UDP socket. Stage 3 reuses the SoeConnection returned by
 *   this stage.
 *
 *   See: /home/tharper/code/swg-main/src/engine/server/application/ConnectionServer/src/shared/ClientConnection.cpp
 *     `handleSelectCharacterMessage` (line 215) and `sendToGameServer` (1170).
 *
 * IMPORTANT — character list comes from STAGE 1:
 *   LoginServer is the canonical source of the existing-characters list.
 *   It sends EnumerateCharacterId during the login flow
 *   (LoginServer.cpp:1122). The caller passes the pre-resolved list in
 *   via `characters`.
 *
 * ConnectionServer DOES handle ClientCreateCharacter (ClientConnection.cpp:931)
 * — that's how character creation is initiated. On success it sends
 * `ClientCreateCharacterSuccess` back to the client, and re-runs the avatar
 * enumeration cycle (LoginServer pushes a fresh EnumerateCharacterId). For
 * the MVP we don't need to wait for the refreshed list: the success message
 * carries the new NetworkId which is everything `SelectCharacter` needs.
 */
import { ClientCreateCharacterFailed } from '../messages/connection/client-create-character-failed.js';
import { ClientCreateCharacterSuccess } from '../messages/connection/client-create-character-success.js';
import { ClientCreateCharacter } from '../messages/connection/client-create-character.js';
import { ClientIdMsg } from '../messages/connection/client-id-msg.js';
import { ClientPermissionsMessage } from '../messages/connection/client-permissions-message.js';
import { ErrorMessage } from '../messages/connection/error-message.js';
import { SelectCharacter } from '../messages/connection/select-character.js';
import { SoeConnection } from '../soe/connection.js';
import type { RawCaptureOptions } from '../soe/interface.js';
import { type CharacterInfo, CharacterType, type ServerEndpoint } from '../types.js';
import { MessageDispatcher, type TranscriptEvent } from './dispatcher.js';

export interface ConnectionStageOptions {
  /** Where to open the ConnectionServer socket (from LoginClusterStatus). */
  endpoint: ServerEndpoint;
  /** Token from Stage 1's LoginClientToken — replayed via ClientIdMsg. */
  tokenBytes: Uint8Array;
  /** The avatar list from Stage 1 (LoginServer-provided). May be empty. */
  characters: readonly CharacterInfo[];
  /** Pick which character to select. Default: first in the list. */
  pickCharacter?: (chars: readonly CharacterInfo[]) => CharacterInfo | undefined;
  /**
   * If the character list is empty, attempt to create a character with
   * these options. If undefined, an empty list causes an error.
   */
  characterToCreate?: CreateCharacterOptions;
  /** Max retries on ClientCreateCharacterFailed (renames with suffix). Default 3. */
  createRetries?: number;
  /** Max time to wait for ClientPermissionsMessage / creation. Default 15_000ms. */
  timeoutMs?: number;
  /** Hook for streaming transcript events. */
  onTranscript?: (event: TranscriptEvent) => void;
  /**
   * Optional raw-byte SOE capture. The ConnectionServer socket is also the
   * socket used for Stage 3 (GameServer), so this captures both stages.
   */
  rawCapture?: RawCaptureOptions;
}

/** Options for `ClientCreateCharacter` (sent if the avatar list is empty). */
export interface CreateCharacterOptions {
  /** Character name. Retried with a numeric suffix on name collision. */
  name: string;
  /** Object template (default: shared_human_male.iff). */
  templateName?: string;
  /** Starting planet (default: tatooine). */
  startingLocation?: string;
  /** Profession (default: combat_brawler). */
  profession?: string;
  /** Hair template (default: empty). */
  hairTemplateName?: string;
  /** Jedi flag (default: false). */
  jedi?: boolean;
  /** Use newbie tutorial (default: false). */
  useNewbieTutorial?: boolean;
  /** Skill template (default: empty). */
  skillTemplate?: string;
  /** Working skill (default: empty). */
  workingSkill?: string;
}

export interface ConnectionStageResult {
  /** The live SoeConnection, ready to be reused by Stage 3 (game-stage). */
  connection: SoeConnection;
  /** The dispatcher wrapping that connection, with accumulated transcript so far. */
  dispatcher: MessageDispatcher;
  /** Permissions the server reported. */
  permissions: ClientPermissionsMessage;
  /** The character we eventually selected. */
  selectedCharacter: CharacterInfo;
  /** True if we created the character during this stage. */
  characterWasCreated: boolean;
  /** Elapsed time for stage 2 in ms. */
  elapsedMs: number;
}

export async function runConnectionStage(
  opts: ConnectionStageOptions,
): Promise<ConnectionStageResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const createRetries = opts.createRetries ?? 3;

  let dispatcher: MessageDispatcher | null = null;
  const connection = new SoeConnection({
    endpoint: opts.endpoint,
    onAppMessage: (payload) => {
      dispatcher?.handleAppMessage(payload);
    },
    ...(opts.rawCapture !== undefined ? { rawCapture: opts.rawCapture } : {}),
  });
  dispatcher = new MessageDispatcher({ connection, stageLabel: 'connection' });
  if (opts.onTranscript !== undefined) {
    dispatcher.onAny(opts.onTranscript);
  }

  // Listen for ErrorMessage at any point — if one arrives mid-stage, throw.
  let serverError: ErrorMessage | null = null;
  dispatcher.onMessage(ErrorMessage, (msg) => {
    serverError = msg;
  });

  let succeeded = false;
  try {
    await connection.connect();

    // ConnectionServer's response to ClientIdMsg is ClientPermissionsMessage
    // (see ClientConnection.cpp:431).
    const permsP = dispatcher.waitFor(ClientPermissionsMessage, { timeoutMs });

    dispatcher.send(new ClientIdMsg(opts.tokenBytes, 0));

    const perms = await permsP;
    if (!perms.canLogin) {
      throw new Error(
        `ConnectionServer denied login: canLogin=false (canCreateRegularCharacter=${perms.canCreateRegularCharacter}, isAdmin=${perms.isAdmin})`,
      );
    }

    let characters = opts.characters;
    let characterWasCreated = false;
    if (characters.length === 0) {
      if (opts.characterToCreate === undefined) {
        throw new Error(
          'No characters available — Stage 1 returned an empty avatar list and no `characterToCreate` was supplied to ConnectionStage. Either pre-seed a character or provide CreateCharacterOptions.',
        );
      }
      if (!perms.canCreateRegularCharacter) {
        throw new Error(
          'No characters available, and ConnectionServer denied character creation (canCreateRegularCharacter=false).',
        );
      }
      const created = await createCharacterWithRetry(
        dispatcher,
        opts.characterToCreate,
        createRetries,
        timeoutMs,
      );
      characterWasCreated = true;
      characters = [
        {
          networkId: created.networkId,
          name: opts.characterToCreate.name,
          objectTemplateId: 0,
          clusterId: 0,
          characterType: CharacterType.Normal,
        },
      ];
    }

    if (serverError !== null) {
      const err = serverError as ErrorMessage;
      throw new Error(
        `Server sent ErrorMessage during connection stage: ${err.errorName}: ${err.description} (fatal=${err.fatal})`,
      );
    }

    const picker = opts.pickCharacter ?? ((cs) => cs[0]);
    const selected = picker(characters);
    if (selected === undefined) {
      throw new Error('pickCharacter returned undefined');
    }

    // SelectCharacter is fire-and-forget — the server does NOT send back any
    // success message on the client wire. The next thing we expect is
    // CmdStartScene, which Stage 3 will wait for.
    dispatcher.send(new SelectCharacter(selected.networkId));

    const result: ConnectionStageResult = {
      connection,
      dispatcher,
      permissions: perms,
      selectedCharacter: selected,
      characterWasCreated,
      elapsedMs: Date.now() - t0,
    };
    succeeded = true;
    return result;
  } finally {
    if (!succeeded) {
      try {
        await connection.disconnect();
      } catch {
        // ignore
      }
      dispatcher?.cancelAllWaiters('connection stage failed');
    }
    // On success we hand the connection + dispatcher to the caller, who
    // continues into Stage 3. They are responsible for disconnect().
  }
}

async function createCharacterWithRetry(
  dispatcher: MessageDispatcher,
  opts: CreateCharacterOptions,
  retries: number,
  timeoutMs: number,
): Promise<ClientCreateCharacterSuccess> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const name = attempt === 0 ? opts.name : `${opts.name}${attempt}`;
    const successP = dispatcher.waitFor(ClientCreateCharacterSuccess, { timeoutMs });
    const failP = dispatcher.waitFor(ClientCreateCharacterFailed, { timeoutMs });

    dispatcher.send(
      new ClientCreateCharacter({
        characterName: name,
        // SERVER template (object/creature/player/human_male.iff), NOT the
        // shared/client one (object/creature/player/shared_human_male.iff).
        // The server's GameServer::getServerCreatureObjectTemplate looks up
        // the non-shared variant in ObjectTemplateList.
        templateName: opts.templateName ?? 'object/creature/player/human_male.iff',
        // 'starting_location' is a key into starting_locations.iff — NOT a
        // planet name. Valid values for tatooine are mos_eisley, bestine,
        // mos_espa, etc. Default to mos_eisley.
        startingLocation: opts.startingLocation ?? 'mos_eisley',
        profession: opts.profession ?? 'combat_brawler',
        hairTemplateName: opts.hairTemplateName ?? '',
        jedi: opts.jedi ?? false,
        useNewbieTutorial: opts.useNewbieTutorial ?? false,
        skillTemplate: opts.skillTemplate ?? '',
        workingSkill: opts.workingSkill ?? '',
      }),
    );

    const outcome = await Promise.race([
      successP.then((m) => ({ kind: 'success' as const, m })),
      failP.then((m) => ({ kind: 'fail' as const, m })),
    ]).catch((err) => ({ kind: 'error' as const, err }));

    if (outcome.kind === 'success') return outcome.m;
    if (outcome.kind === 'fail') {
      lastErr = new Error(
        `ClientCreateCharacter failed: ${outcome.m.errorMessage.table}:${outcome.m.errorMessage.name} (textIndex=${outcome.m.errorMessage.textIndex}) for name="${outcome.m.name}"`,
      );
    } else {
      lastErr = outcome.err instanceof Error ? outcome.err : new Error(String(outcome.err));
    }
  }
  throw lastErr ?? new Error('createCharacterWithRetry: exhausted retries');
}
