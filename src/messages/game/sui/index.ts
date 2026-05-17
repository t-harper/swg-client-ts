// Barrel: importing this module triggers self-registration of every SUI
// message into the top-level GameNetworkMessage registry.
//
// SUI (Server-driven User Interface) is the family of server→client messages
// that open / update / close dialog pages on the client — banking, vendor,
// quest dialog, list pickers, etc. The client responds via
// `SuiEventNotification`, identifying which page and which subscribed event
// fired, plus the values of any subscribed widget properties.
//
// Side-effect-import this barrel from places that want the SUI decoders
// loaded (e.g. `swg-client.ts`):
//
//   import './messages/game/sui/index.js';

export { SuiCreatePageMessage, SuiCreatePageMessageDecoder } from './sui-create-page-message.js';
export {
  SuiEventNotification,
  SuiEventNotificationDecoder,
} from './sui-event-notification.js';
export { SuiForceClosePage, SuiForceClosePageDecoder } from './sui-force-close-page.js';
export {
  type SuiCommand,
  type SuiCommandTypeValue,
  type SuiPageData,
  type SuiWidgetPropertySubscription,
  SuiCommandType,
  decodeSuiPageData,
  encodeSuiPageData,
  peekSuiPageId,
  readSuiCommand,
  readSuiPageData,
  writeSuiCommand,
  writeSuiPageData,
} from './sui-page-data.js';
export { SuiUpdatePageMessage, SuiUpdatePageMessageDecoder } from './sui-update-page-message.js';
