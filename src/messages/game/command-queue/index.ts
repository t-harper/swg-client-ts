/**
 * Command-queue payload codecs and helpers.
 *
 * These types are MessageQueue subtypes carried as the `data` trailer of
 * an `ObjControllerMessage` — the wire-level wrapper. See each module for
 * field definitions.
 *
 * Side-effect import this barrel from places that want all command-queue
 * helpers loaded (e.g. swg-client.ts) — the `hashCommand` helper itself
 * has no module-level effects but the import keeps dead-code-elimination
 * from dropping these modules from `pnpm cli`.
 */

export { hashCommand } from './command-hash.js';
export {
  CLIENT_TO_AUTH_SERVER_FLAGS,
  CM_COMMAND_QUEUE_ENQUEUE,
  CommandQueueEnqueue,
  NO_TARGET,
  wrapAsObjControllerMessage,
} from './command-queue-enqueue.js';
export { CM_COMMAND_QUEUE_REMOVE, CommandErrorCode, CommandQueueRemove } from './command-queue-remove.js';
export {
  CM_COMMAND_TIMER,
  COMMAND_TIMER_FLAG_COUNT,
  CommandTimerData,
  CommandTimerFlag,
  NULL_COOLDOWN_GROUP,
} from './command-timer-data.js';
export type { CommandTimerEntries, CommandTimerEntry } from './command-timer-data.js';
