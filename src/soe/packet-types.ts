/**
 * SOE UDP packet-type enum, mirroring UdpLibrary.hpp lines 1387-1395.
 *
 * NOTE: We define our own enum here (with names matching this codebase's TS
 * convention, no `cUdpPacket` prefix) rather than depending on the one in
 * `src/types.ts`. The values are SEQUENTIAL from 0, matching the C++
 * declaration which has no explicit values.
 *
 * Sanity-check: the captured packet `tests/fixtures/login-enum-cluster-223b.hex`
 * starts with `00 09`, which is `cUdpPacketReliable1 = 9` in this scheme.
 * See the count in the hex fixture header comment.
 */
export enum SoePacketType {
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

/** Channel 0..3 → corresponding Reliable opcode */
export function reliableTypeFor(channel: 0 | 1 | 2 | 3): SoePacketType {
  return (SoePacketType.Reliable1 + channel) as SoePacketType;
}
/** Channel 0..3 → corresponding Fragment opcode */
export function fragmentTypeFor(channel: 0 | 1 | 2 | 3): SoePacketType {
  return (SoePacketType.Fragment1 + channel) as SoePacketType;
}
/** Channel 0..3 → corresponding Ack opcode */
export function ackTypeFor(channel: 0 | 1 | 2 | 3): SoePacketType {
  return (SoePacketType.Ack1 + channel) as SoePacketType;
}
/** Channel 0..3 → corresponding AckAll opcode */
export function ackAllTypeFor(channel: 0 | 1 | 2 | 3): SoePacketType {
  return (SoePacketType.AckAll1 + channel) as SoePacketType;
}

/** True if `type` is one of Reliable1..4 */
export function isReliable(type: number): boolean {
  return type >= SoePacketType.Reliable1 && type <= SoePacketType.Reliable4;
}
/** True if `type` is one of Fragment1..4 */
export function isFragment(type: number): boolean {
  return type >= SoePacketType.Fragment1 && type <= SoePacketType.Fragment4;
}
/** True if `type` is one of Ack1..4 */
export function isAck(type: number): boolean {
  return type >= SoePacketType.Ack1 && type <= SoePacketType.Ack4;
}
/** True if `type` is one of AckAll1..4 */
export function isAckAll(type: number): boolean {
  return type >= SoePacketType.AckAll1 && type <= SoePacketType.AckAll4;
}

/** Get the channel number 0..3 from a Reliable/Fragment/Ack/AckAll opcode */
export function channelOf(type: number): 0 | 1 | 2 | 3 {
  if (isReliable(type)) return (type - SoePacketType.Reliable1) as 0 | 1 | 2 | 3;
  if (isFragment(type)) return (type - SoePacketType.Fragment1) as 0 | 1 | 2 | 3;
  if (isAck(type)) return (type - SoePacketType.Ack1) as 0 | 1 | 2 | 3;
  if (isAckAll(type)) return (type - SoePacketType.AckAll1) as 0 | 1 | 2 | 3;
  throw new RangeError(`type ${type} has no channel`);
}
