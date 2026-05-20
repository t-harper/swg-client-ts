/**
 * Sanity check that all connection + game + chat message classes load cleanly
 * and register unique constcrcs. Catches collisions early — they'd indicate
 * either a typo in messageName or a bug in our constcrc port.
 *
 * Complements `registry.test.ts` (which exercises the lookup API on login
 * messages only) by enumerating every connection + game class and asserting
 * that every one of them self-registered.
 */

import { describe, expect, it } from 'vitest';
import { ClientCreateCharacterFailed } from './connection/client-create-character-failed.js';
import { ClientCreateCharacterSuccess } from './connection/client-create-character-success.js';
import { ClientCreateCharacter } from './connection/client-create-character.js';
import { ClientIdMsg } from './connection/client-id-msg.js';
import { ClientPermissionsMessage } from './connection/client-permissions-message.js';
import { EnumerateCharacterId } from './connection/enumerate-character-id.js';
import { ErrorMessage } from './connection/error-message.js';
import { GameServerForLoginMessage } from './connection/game-server-for-login.js';
import { SelectCharacter } from './connection/select-character.js';
import { StationIdHasJediSlot } from './connection/station-id-has-jedi-slot.js';
import { AttributeListMessage } from './game/attribute-list-message.js';
import { BaselinesMessage } from './game/baselines/baselines-message.js';
import { BatchBaselinesMessage } from './game/baselines/batch-baselines-message.js';
import { DeltasMessage } from './game/baselines/deltas-message.js';
import { ChatInstantMessageToCharacter } from './game/chat/chat-instant-message-to-character.js';
import { ChatInstantMessageToClient } from './game/chat/chat-instant-message-to-client.js';
import { ChatPersistentMessageToServer } from './game/chat/chat-persistent-message-to-server.js';
import { ChatRequestRoomList } from './game/chat/chat-request-room-list.js';
import { ChatRoomList } from './game/chat/chat-room-list.js';
import { ChatSendToRoom } from './game/chat/chat-send-to-room.js';
import { CmdSceneReady } from './game/cmd-scene-ready.js';
import { CmdStartScene } from './game/cmd-start-scene.js';
import { AcceptAuctionMessage } from './game/commodities/accept-auction-message.js';
import { AcceptAuctionResponseMessage } from './game/commodities/accept-auction-response-message.js';
import { AuctionQueryHeadersMessage } from './game/commodities/auction-query-headers-message.js';
import { AuctionQueryHeadersResponseMessage } from './game/commodities/auction-query-headers-response-message.js';
import { BidAuctionMessage } from './game/commodities/bid-auction-message.js';
import { BidAuctionResponseMessage } from './game/commodities/bid-auction-response-message.js';
import { CancelLiveAuctionMessage } from './game/commodities/cancel-live-auction-message.js';
import { CancelLiveAuctionResponseMessage } from './game/commodities/cancel-live-auction-response-message.js';
import { CreateAuctionMessage } from './game/commodities/create-auction-message.js';
import { CreateAuctionResponseMessage } from './game/commodities/create-auction-response-message.js';
import { CreateImmediateAuctionMessage } from './game/commodities/create-immediate-auction-message.js';
import { GetAuctionDetailsResponse } from './game/commodities/get-auction-details-response.js';
import { GetAuctionDetails } from './game/commodities/get-auction-details.js';
import { IsVendorOwnerMessage } from './game/commodities/is-vendor-owner-message.js';
import { IsVendorOwnerResponseMessage } from './game/commodities/is-vendor-owner-response-message.js';
import { RetrieveAuctionItemMessage } from './game/commodities/retrieve-auction-item-message.js';
import { RetrieveAuctionItemResponseMessage } from './game/commodities/retrieve-auction-item-response-message.js';
import { ConGenericMessage } from './game/con-generic-message.js';
import { HeartBeat } from './game/heart-beat.js';
import { LogoutMessage } from './game/logout-message.js';
import { PopulateMissionBrowserMessage } from './game/missions/populate-mission-browser-message.js';
import { ObjControllerMessage } from './game/obj-controller-message.js';
import { GetMapLocationsMessage } from './game/planet-map/get-map-locations-message.js';
import { GetMapLocationsResponseMessage } from './game/planet-map/get-map-locations-response-message.js';
import { SceneCreateObjectByCrc } from './game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from './game/scene-create-object-by-name.js';
import { SceneDestroyObject } from './game/scene-destroy-object.js';
import { SceneEndBaselines } from './game/scene-end-baselines.js';
import { SuiCreatePageMessage } from './game/sui/sui-create-page-message.js';
import { SuiEventNotification } from './game/sui/sui-event-notification.js';
import { SuiForceClosePage } from './game/sui/sui-force-close-page.js';
import { SuiUpdatePageMessage } from './game/sui/sui-update-page-message.js';
import { ResourceListForSurveyMessage } from './game/survey/resource-list-for-survey-message.js';
import { SurveyMessage } from './game/survey/survey-message.js';
import { AbortTradeMessage } from './game/trade/abort-trade-message.js';
import { AcceptTransactionMessage } from './game/trade/accept-transaction-message.js';
import { AddItemMessage } from './game/trade/add-item-message.js';
import { BeginTradeMessage } from './game/trade/begin-trade-message.js';
import { BeginVerificationMessage } from './game/trade/begin-verification-message.js';
import { GiveMoneyMessage } from './game/trade/give-money-message.js';
import { RemoveItemMessage } from './game/trade/remove-item-message.js';
import { TradeCompleteMessage } from './game/trade/trade-complete-message.js';
import { UnAcceptTransactionMessage } from './game/trade/unaccept-transaction-message.js';
import { VerifyTradeMessage } from './game/trade/verify-trade-message.js';
import { UpdateContainmentMessage } from './game/update-containment-message.js';
import { UpdateTransformMessage } from './game/update-transform-message.js';
import { UpdateTransformWithParentMessage } from './game/update-transform-with-parent-message.js';
import { messageRegistry } from './registry.js';

const ALL_DECODERS = [
  ClientIdMsg,
  ClientPermissionsMessage,
  StationIdHasJediSlot,
  EnumerateCharacterId,
  ClientCreateCharacter,
  ClientCreateCharacterSuccess,
  ClientCreateCharacterFailed,
  SelectCharacter,
  GameServerForLoginMessage,
  ErrorMessage,
  CmdStartScene,
  SceneCreateObjectByCrc,
  SceneCreateObjectByName,
  SceneDestroyObject,
  SceneEndBaselines,
  CmdSceneReady,
  HeartBeat,
  LogoutMessage,
  ObjControllerMessage,
  UpdateContainmentMessage,
  UpdateTransformMessage,
  UpdateTransformWithParentMessage,
  AttributeListMessage,
  BaselinesMessage,
  BatchBaselinesMessage,
  DeltasMessage,
  ChatInstantMessageToCharacter,
  ChatInstantMessageToClient,
  ChatRequestRoomList,
  ChatRoomList,
  ChatSendToRoom,
  ChatPersistentMessageToServer,
  ConGenericMessage,
  SurveyMessage,
  ResourceListForSurveyMessage,
  PopulateMissionBrowserMessage,
  SuiCreatePageMessage,
  SuiUpdatePageMessage,
  SuiForceClosePage,
  SuiEventNotification,
  BeginTradeMessage,
  BeginVerificationMessage,
  AddItemMessage,
  RemoveItemMessage,
  GiveMoneyMessage,
  AcceptTransactionMessage,
  UnAcceptTransactionMessage,
  VerifyTradeMessage,
  TradeCompleteMessage,
  AbortTradeMessage,
  AcceptAuctionMessage,
  AcceptAuctionResponseMessage,
  AuctionQueryHeadersMessage,
  AuctionQueryHeadersResponseMessage,
  BidAuctionMessage,
  BidAuctionResponseMessage,
  CancelLiveAuctionMessage,
  CancelLiveAuctionResponseMessage,
  CreateAuctionMessage,
  CreateAuctionResponseMessage,
  CreateImmediateAuctionMessage,
  GetAuctionDetails,
  GetAuctionDetailsResponse,
  IsVendorOwnerMessage,
  IsVendorOwnerResponseMessage,
  RetrieveAuctionItemMessage,
  RetrieveAuctionItemResponseMessage,
  GetMapLocationsMessage,
  GetMapLocationsResponseMessage,
];

describe('message registration', () => {
  it('exports 69 message classes', () => {
    expect(ALL_DECODERS.length).toBe(69);
  });

  it('every class has a non-empty messageName', () => {
    for (const d of ALL_DECODERS) {
      expect(d.messageName).toBeTruthy();
      expect(d.messageName.length).toBeGreaterThan(2);
    }
  });

  it('every class has a non-zero constcrc', () => {
    for (const d of ALL_DECODERS) {
      expect(d.typeCrc).toBeGreaterThan(0);
    }
  });

  it('typeCrcs are unique across all messages', () => {
    const seen = new Set<number>();
    for (const d of ALL_DECODERS) {
      expect(seen.has(d.typeCrc)).toBe(false);
      seen.add(d.typeCrc);
    }
  });

  it('all classes self-registered with the singleton registry', () => {
    for (const d of ALL_DECODERS) {
      const found = messageRegistry.getByCrc(d.typeCrc);
      expect(found, `${d.messageName} not registered`).toBeDefined();
      expect(found?.messageName).toBe(d.messageName);
    }
  });

  it('every class declares a varCount >= 1', () => {
    for (const d of ALL_DECODERS) {
      expect(d.varCount, `${d.messageName} varCount`).toBeGreaterThanOrEqual(1);
    }
  });
});
