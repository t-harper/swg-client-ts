/**
 * Shared types used across the SOE transport, Archive, and message layers.
 * All three streams import from here so they can compile-check independently.
 */

/** A network endpoint we'll open a UDP socket to. */
export interface ServerEndpoint {
  host: string;
  port: number;
}

/** Negotiated SOE session parameters (from SessionResponse). */
export interface EncryptionParams {
  /** Server-chosen 32-bit value used as seed for both XOR and CRC */
  encryptCode: number;
  /** Connection identifier echoed in subsequent packets (the same we sent in SessionRequest) */
  connectionCode: number;
  /** Number of CRC bytes appended to every encrypted packet (typically 2) */
  crcBytes: number;
  /** Up to 2 encryption passes, applied in order on send (reverse on receive) */
  encryptMethods: [EncryptMethod, EncryptMethod];
  /** Max raw UDP packet size negotiated (typically 496) */
  maxRawPacketSize: number;
}

export enum EncryptMethod {
  None = 0,
  UserSupplied = 1,
  UserSupplied2 = 2,
  XorBuffer = 3,
  Xor = 4,
}

/**
 * SOE UDP packet types from UdpLibrary.hpp lines 1387-1395.
 *
 * The C++ enum declares values WITHOUT explicit numbers, so they're sequential
 * from 0. Confirmed against captured wire fixtures: Reliable1 = 9 (NOT 10).
 *
 * The authoritative implementation in src/soe/packet-types.ts uses these same
 * values via a local enum (intentionally — Stream A discovered this discrepancy
 * during the build and wrote its own to avoid the bug).
 */
export enum UdpPacketType {
  ZeroEscape = 0,
  Connect = 1,
  Confirm = 2,
  Multi = 3,
  Big = 4,
  Terminate = 5,
  KeepAlive = 6,
  ClockSync = 7,
  ClockReflect = 8,
  Reliable1 = 9,
  Reliable2 = 10,
  Reliable3 = 11,
  Reliable4 = 12,
  Fragment1 = 13,
  Fragment2 = 14,
  Fragment3 = 15,
  Fragment4 = 16,
  Ack1 = 17,
  Ack2 = 18,
  Ack3 = 19,
  Ack4 = 20,
  AckAll1 = 21,
  AckAll2 = 22,
  AckAll3 = 23,
  AckAll4 = 24,
  Group = 25,
  Ordered = 26,
  Ordered2 = 27,
  PortAlive = 28,
  UnreachableConnection = 29,
  RequestRemap = 30,
}

/** A cluster row as advertised by LoginEnumCluster + LoginClusterStatus */
export interface ClusterInfo {
  id: number;
  name: string;
  timeZone: number;
  /** Public-facing ConnectionServer address from LoginClusterStatus */
  connectionServerAddress?: string;
  connectionServerPort?: number;
  connectionServerPingPort?: number;
  status?: ClusterStatus;
  populationStatus?: PopulationStatus;
  populationOnline?: number;
  maxCharactersPerAccount?: number;
  onlinePlayerLimit?: number;
  onlineFreeTrialLimit?: number;
  dontRecommend?: boolean;
  /** Added Aug 2021 Admin Account Routing Refactor */
  isAdmin?: boolean;
  isSecret?: boolean;
}

export enum ClusterStatus {
  Down = 0,
  Loading = 1,
  Up = 2,
  Locked = 3,
  Restricted = 4,
  Full = 5,
}

export enum PopulationStatus {
  VeryLight = 0,
  Light = 1,
  Medium = 2,
  Heavy = 3,
  VeryHeavy = 4,
  ExtremelyHeavy = 5,
  Full = 6,
}

/** Per-character record from EnumerateCharacterId */
export interface CharacterInfo {
  /** Persistent 8-byte DB id — high 4 bytes cluster, low 4 bytes object */
  networkId: NetworkId;
  /** Unicode display name (UTF-16 on the wire) */
  name: string;
  /** CRC of the object template path (e.g. shared_human_male.iff) */
  objectTemplateId: number;
  clusterId: number;
  characterType: CharacterType;
}

export enum CharacterType {
  Normal = 1,
  Jedi = 2,
  Spectral = 3,
}

/**
 * 8-byte SWG NetworkId. JavaScript bigint to avoid 32-bit truncation.
 * Wire format: 8 bytes little-endian uint64.
 */
export type NetworkId = bigint;

/** Token issued by LoginServer for re-auth at ConnectionServer + GameServer */
export interface LoginToken {
  /** Raw encrypted token bytes (~78 bytes typical) */
  bytes: Uint8Array;
  /** Station account ID derived from hashing the username (dev mode) */
  stationId: number;
  /** Username that was sent in LoginClientId */
  username: string;
}

/** Permissions response from ConnectionServer (ClientPermissionsMessage) */
export interface ClientPermissions {
  canLogin: boolean;
  canCreateRegularCharacter: boolean;
  canCreateJediCharacter: boolean;
  canSkipTutorial: boolean;
  isAdmin: boolean;
}

/** Scene-init params received from CmdStartScene */
export interface SceneStart {
  playerNetworkId: NetworkId;
  sceneName: string;
  startPosition: Vector3;
  startYaw: number;
  templateName: string;
  serverTimeSeconds: bigint;
  serverEpoch: number;
  disableWorldSnapshot: boolean;
}

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/** Full lifecycle state machine */
export enum ZoneState {
  NotConnected = 'not_connected',
  LoginHandshake = 'login_handshake',
  LoginAuthed = 'login_authed',
  ConnectionHandshake = 'connection_handshake',
  ConnectionAuthed = 'connection_authed',
  CharacterSelected = 'character_selected',
  GameHandshake = 'game_handshake',
  ZoningIn = 'zoning_in',
  ZonedIn = 'zoned_in',
  LoggingOut = 'logging_out',
  Disconnected = 'disconnected',
}
