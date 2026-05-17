/**
 * AuctionResult — enum returned by every commodity *Response message.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/AuctionErrorCodes.h
 */

export const AuctionResult = {
  OK: 0,
  INVALID_AUCTIONER: 1,
  INVALID_ITEM_ID: 2,
  INVALID_CONTAINER_ID: 3,
  INVALID_MINIMUM_BID: 4,
  INVALID_AUCTION_LENGTH: 5,
  ITEM_ALREADY_AUCTIONED: 6,
  ITEM_NOT_IN_CONTAINER: 7,
  NOT_ITEM_OWNER: 8,
  NOT_ENOUGH_MONEY: 9,
  INVALID_BID: 10,
  BID_REJECTED: 11,
  INVENTORY_FULL: 12,
  TOO_MANY_AUCTIONS: 13,
  BID_TOO_HIGH: 14,
  AUCTION_ALREADY_COMPLETED: 15,
  VENDOR_DEACTIVATED: 16,
  ITEM_NOLONGER_EXISTS: 17,
  INVALID_ITEM_REIMBURSAL: 18,
  IN_TRADE: 19,
  IN_CRATE: 20,
  NOT_ALLOWED: 21,
  NOT_EMPTY: 22,
  BID_OUTBID: 23,
  TOO_MANY_VENDORS: 24,
  TOO_MANY_VENDOR_ITEMS: 25,
  IS_BIOLINKED: 26,
  ITEM_EQUIPPED: 27,
  ITEM_RESTRICTED: 28,
  PRICE_TOO_HIGH: 29,
} as const;

export type AuctionResultValue = (typeof AuctionResult)[keyof typeof AuctionResult];

/**
 * Auction flags from AuctionData.h (bit-flags stored in `flags` field of
 * `Auction::ItemDataHeader`).
 */
export const AuctionFlags = {
  PREMIUM_AUCTION: 1 << 10,
  ACTIVE: 1 << 11,
  VENDOR_TRANSFER: 1 << 12,
  MAGIC_ITEM: 1 << 13,
  OFFERED_ITEM: 1 << 14,
} as const;

/**
 * VendorOwnerResult — enum returned by `IsVendorOwnerResponseMessage`.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/IsVendorOwnerResponseMessage.h:25-30
 */
export const VendorOwnerResult = {
  IsOwner: 0,
  IsNotOwner: 1,
  HasNoOwner: 2,
} as const;

export type VendorOwnerResultValue = (typeof VendorOwnerResult)[keyof typeof VendorOwnerResult];
