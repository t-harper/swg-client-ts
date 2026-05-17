/**
 * Barrel: importing this module triggers self-registration of every
 * commodities / bazaar / auction-house message into the singleton
 * `messageRegistry`. Source files live alongside this one; each calls
 * `registerMessage(asDecoder(...))` at module-load time.
 *
 * The set of messages mirrors what the real Windows client sends to drive
 * the bazaar UI (`AuctionQueryHeadersMessage` for browse,
 * `BidAuctionMessage` for bid, `CreateAuctionMessage` /
 * `CreateImmediateAuctionMessage` for list, etc.) and the
 * `*ResponseMessage` companions the server replies with.
 *
 * The C++ side of the wire is implemented by the standalone
 * `CommoditiesServer` process; the `GameServer` proxies these messages
 * through `GameServer ↔ CommoditiesServer` over a separate internal
 * channel. From this client's perspective they are normal
 * `GameNetworkMessage`s on the same UDP socket used for all other game
 * traffic.
 *
 * Side-effect-import this barrel from `swg-client.ts` to load all
 * commodity decoders at startup:
 *
 *   import './messages/game/commodities/index.js';
 */

export {
  AuctionFlags,
  AuctionResult,
  type AuctionResultValue,
  VendorOwnerResult,
  type VendorOwnerResultValue,
} from './auction-error-codes.js';
export {
  AcceptAuctionMessage,
  AcceptAuctionMessageDecoder,
} from './accept-auction-message.js';
export {
  AcceptAuctionResponseMessage,
  AcceptAuctionResponseMessageDecoder,
} from './accept-auction-response-message.js';
export {
  AdvancedSearchMatchAllAny,
  AuctionLocationSearch,
  AuctionQueryHeadersMessage,
  AuctionQueryHeadersMessageDecoder,
  type AuctionQueryHeadersFields,
  AuctionSearchType,
  type SearchCondition,
  SearchConditionComparison,
} from './auction-query-headers-message.js';
export {
  type AuctionListing,
  AuctionQueryHeadersResponseMessage,
  AuctionQueryHeadersResponseMessageDecoder,
} from './auction-query-headers-response-message.js';
export {
  BidAuctionMessage,
  BidAuctionMessageDecoder,
} from './bid-auction-message.js';
export {
  BidAuctionResponseMessage,
  BidAuctionResponseMessageDecoder,
} from './bid-auction-response-message.js';
export {
  CancelLiveAuctionMessage,
  CancelLiveAuctionMessageDecoder,
} from './cancel-live-auction-message.js';
export {
  CancelLiveAuctionResponseMessage,
  CancelLiveAuctionResponseMessageDecoder,
} from './cancel-live-auction-response-message.js';
export {
  CreateAuctionMessage,
  CreateAuctionMessageDecoder,
} from './create-auction-message.js';
export {
  CreateAuctionResponseMessage,
  CreateAuctionResponseMessageDecoder,
} from './create-auction-response-message.js';
export {
  CreateImmediateAuctionMessage,
  CreateImmediateAuctionMessageDecoder,
} from './create-immediate-auction-message.js';
export {
  GetAuctionDetails,
  GetAuctionDetailsDecoder,
} from './get-auction-details.js';
export {
  type AuctionItemDetails,
  GetAuctionDetailsResponse,
  GetAuctionDetailsResponseDecoder,
} from './get-auction-details-response.js';
export {
  IsVendorOwnerMessage,
  IsVendorOwnerMessageDecoder,
} from './is-vendor-owner-message.js';
export {
  IsVendorOwnerResponseMessage,
  IsVendorOwnerResponseMessageDecoder,
} from './is-vendor-owner-response-message.js';
export {
  RetrieveAuctionItemMessage,
  RetrieveAuctionItemMessageDecoder,
} from './retrieve-auction-item-message.js';
export {
  RetrieveAuctionItemResponseMessage,
  RetrieveAuctionItemResponseMessageDecoder,
} from './retrieve-auction-item-response-message.js';
