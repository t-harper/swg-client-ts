/**
 * Barrel: importing this module triggers self-registration of every
 * login-stage message into the singleton MessageRegistry.
 *
 * Stream C / the client orchestrator should `import './messages/login/index.js'`
 * (side-effect import) before calling decodeMessage() so the CRCs are known.
 */

export { LoginClientId, LoginClientIdDecoder } from './login-client-id.js';
export { LoginEnumCluster, LoginEnumClusterDecoder } from './login-enum-cluster.js';
export type { LoginEnumClusterData } from './login-enum-cluster.js';
export { LoginClusterStatus, LoginClusterStatusDecoder } from './login-cluster-status.js';
export type { LoginClusterStatusData } from './login-cluster-status.js';
export { LoginClusterStatusEx, LoginClusterStatusExDecoder } from './login-cluster-status-ex.js';
export type { LoginClusterStatusExData } from './login-cluster-status-ex.js';
export { LoginClientToken, LoginClientTokenDecoder } from './login-client-token.js';
export {
  LoginIncorrectClientId,
  LoginIncorrectClientIdDecoder,
} from './login-incorrect-client-id.js';
export { ServerNowEpochTime, ServerNowEpochTimeDecoder } from './server-now-epoch-time.js';
export {
  CharacterCreationDisabled,
  CharacterCreationDisabledDecoder,
} from './character-creation-disabled.js';
export {
  DeleteCharacterMessage,
  DeleteCharacterMessageDecoder,
} from './delete-character-message.js';
export {
  DeleteCharacterReplyMessage,
  DeleteCharacterReplyMessageDecoder,
  DeleteCharacterResult,
} from './delete-character-reply-message.js';
