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

/** SOE UDP packet types from UdpLibrary.hpp lines 1387-1395 */
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
  Reliable1 = 10,
  Reliable2 = 11,
  Reliable3 = 12,
  Reliable4 = 13,
  Fragment1 = 14,
  Fragment2 = 15,
  Fragment3 = 16,
  Fragment4 = 17,
  Ack1 = 18,
  Ack2 = 19,
  Ack3 = 20,
  Ack4 = 21,
  AckAll1 = 22,
  AckAll2 = 23,
  AckAll3 = 24,
  AckAll4 = 25,
  Group = 26,
  Ordered = 27,
  Ordered2 = 28,
  PortAlive = 29,
  UnreachableConnection = 30,
  RequestRemap = 31,
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
