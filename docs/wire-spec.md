# SWG wire-format spec (the byte-level cheat sheet)

This document is the byte-level reference for everything `@swg/ts-client`
puts on the wire. Every fact is cross-referenced to the C++ source at
`~/code/swg-main/` — the C++ is the ground truth.

There are three layers, bottom to top:

1. **SOE UDP transport** — `node:dgram`, opcode-tagged packets, two-pass
   encryption + CRC trailer
2. **Archive serialization** — little-endian primitives, length-prefixed
   strings, containers
3. **GameNetworkMessage framing** — variable-count prefix + constcrc + payload

---

## 1. SOE UDP transport

### 1.1 Packet types

Every UDP datagram starts with `[00 OPCODE]` where OPCODE is one byte
identifying the packet type. The full enum is declared sequentially (no
explicit numbers) in `UdpLibrary.hpp:1387-1395`:

| Opcode | Name | Direction | Notes |
|--------|------|-----------|-------|
| 0 | ZeroEscape | — | An app payload that starts with 0x00 has to be escaped so it doesn't look like an SOE control packet. Unused by SWG. |
| 1 | Connect | C→S | SessionRequest, 14 bytes, unencrypted, no CRC |
| 2 | Confirm | S→C | SessionResponse, 17 bytes, unencrypted, no CRC |
| 3 | Multi | both | One datagram contains [len-byte][sub1][len-byte][sub2]... |
| 4 | Big | unused | Logical big-packet escape (not used by SWG) |
| 5 | Terminate | both | Clean close. Body: `[connectCode BE u32][reason BE u16]` |
| 6 | KeepAlive | both | 2 bytes — just the opcode pair, encrypted+CRCd |
| 7 | ClockSync | server | Latency probe (40B, BE, encrypted+CRC'd). Layout: `[00 07][u16 timeStamp][i32 masterPing][i32 avgPing][i32 lowPing][i32 highPing][i32 lastPing][i64 ourSent][i64 ourReceived]`. See `src/soe/clock-sync.ts`. |
| 8 | ClockReflect | client | Reply to ClockSync (40B, BE, encrypted+CRC'd). Layout: `[00 08][u16 timeStamp(echoed)][u32 serverSyncStampLong][i64 yourSent(echoed)][i64 yourReceived(echoed)][i64 ourSent][i64 ourReceived]`. SoeConnection auto-replies on every inbound ClockSync; client also initiates periodic ClockSync (default 45s, `clockSyncIntervalMs`). RTT samples accumulate in `getLatencyStats()` and `LifecycleResult.latency`. |
| 9 | Reliable1 | both | Reliable channel 0, the only channel SWG uses |
| 10–12 | Reliable2..4 | both | Channels 1, 2, 3 |
| 13 | Fragment1 | both | First fragment of a multi-datagram message |
| 14–16 | Fragment2..4 | both | Channels 1, 2, 3 |
| 17 | Ack1 | both | Single-seq ack on channel 0 |
| 18–20 | Ack2..4 | both | Channels 1, 2, 3 |
| 21 | AckAll1 | both | Cumulative ack ≤ seq, channel 0 |
| 22–24 | AckAll2..4 | both | Channels 1, 2, 3 |
| 25 | Group | both | App-level coalescer — like Multi but each sub is a complete GameNetworkMessage |
| 26–27 | Ordered, Ordered2 | both | We don't model |
| 28–30 | PortAlive, UnreachableConnection, RequestRemap | both | We don't model |

Reference: `src/soe/packet-types.ts:13-44`.

### 1.2 SessionRequest (opcode 1)

Total 14 bytes, all big-endian after the opcode pair:

```
[00 01][protocolVersion BE u32][connectionCode BE u32][maxRawPacketSize BE u32]
```

- `protocolVersion` always 2 for SWG
- `connectionCode` is a random uint32 we pick; server echoes it in SessionResponse
- `maxRawPacketSize` typically 496

Reference: `UdpLibrary.cpp:1832` (server-side receive), `UdpLibrary.hpp:1402`
(struct definition). Our build: `src/soe/session.ts:59`.

### 1.3 SessionResponse (opcode 2)

Total 17 bytes (since SWG uses 2 encryption passes), all big-endian after
the opcode pair:

```
[00 02][connectionCode BE u32][encryptCode BE u32][crcBytes u8]
       [encryptMethod[0] u8][encryptMethod[1] u8][maxRawPacketSize BE u32]
```

- `encryptCode` is the seed for both XOR encryption AND the CRC trailer.
- `crcBytes` is typically 2 in SWG (server config knob).
- `encryptMethods` is two bytes (`EncryptMethod` enum: 0=None, 1=UserSupplied,
  3=XorBuffer, 4=Xor). SWG's pair is `[UserSupplied, Xor]` — apply in this
  order on send, reverse on receive.

Reference: `UdpLibrary.cpp:1881`, `UdpLibrary.hpp:1411`. Our parser:
`src/soe/session.ts:81`.

### 1.4 The encrypt + CRC pipeline

```
SEND: app payload
   → UserSupplied (zlib compress, append 0x01 if shrunk else raw + 0x00)
   → Xor (rolling 4-byte feedback)
   → CRC32 (zlib polynomial, seeded with encryptCode-mixed value)
   → datagram

RECV: datagram
   → verify last `crcBytes` against CRC32(rest, encryptCode); strip them
   → Xor-decrypt
   → UserSupplied-decrypt (strip trailing flag byte; if 0x01, zlib inflate; if 0x00, raw)
   → app payload
```

**Special rule (PhysicalSend lines 2480-2495, ProcessRawPacket 1761-1771):**
If `buf[0] == 0`, the encryption pass starts at offset 2, leaving the
`[00 OPCODE]` header in the clear. All SOE control packets have buf[0]=0,
which is why opcodes are visible without decryption.

#### 1.4.1 Xor (`EncryptMethod` = 4, `EncryptXor` lines 2758-2779)

Rolling-feedback 4-byte XOR. `prev` is initialized to `encryptCode`.
For each 4-byte block:

```
encrypted = input XOR prev
output = encrypted
prev = encrypted   // send-side
// or
prev = input       // receive-side (feedback = encrypted input, not decrypted output)
```

Tail bytes (1-3 trailing): each is XORed with `prev & 0xff`. C++ does NOT
shift between tail bytes — every leftover byte uses the same LSB.

Reference: `UdpLibrary.cpp:2758-2779`. Our impl: `src/soe/encrypt.ts:30-78`.

#### 1.4.2 UserSupplied (`EncryptMethod` = 1, `ManagerHandler.cpp:145-181`)

```
encrypt(src):
   compressed = zlib_deflate(src)    // standard zlib header 78 9c, not raw
   if 0 < compressed.length < src.length:
       return [compressed][0x01]
   else:
       return [src][0x00]            // fallback: not worth compressing
```

```
decrypt(packet):
   flag = packet[-1]                  // last byte
   body = packet[:-1]
   if flag == 0x01:
       return zlib_inflate(body)
   if flag == 0x00:
       return body
   throw "bad flag"
```

Reference: `ManagerHandler.cpp:145-181`. Our impl: `src/soe/encrypt.ts:89-160`.

#### 1.4.3 CRC32 (`UdpMisc::Crc32`, `UdpLibrary.cpp:4146-4209`)

- Standard zlib polynomial 0xEDB88320, 256-entry table.
- Seed is 0xFFFFFFFF mixed with the 4 LE bytes of `encryptCode` (table
  lookups, line 4194-4197) before consuming the actual buffer.
- Appended **big-endian** as `crcBytes` bytes (typically the high 2 bytes).

Reference: `UdpLibrary.cpp:4146-4209`. Our impl: `src/crc/crc32.ts`.

### 1.5 Reliable channel 0 framing

Every app-level send goes through reliable channel 0:

```
[00 09][seq BE u16][payload bytes]
```

`seq` is a per-channel monotonically increasing 16-bit counter (wrap at 0xFFFF).
Server acks by sending `[00 21][seq BE u16]` (AckAll), meaning "I have
received everything up to and including this seq."

Reference: `UdpLibrary.cpp:1610-1696` (ReliableSendRoutine), `1928-1994`
(ReliableReceive). Our impl: `src/soe/reliable.ts`.

### 1.6 Multipacket coalescer (opcode 3 / Multi)

```
[00 03][len byte][sub1 bytes][len byte][sub2 bytes]...
```

Each sub-packet starts with a length byte. If the length is 0xFF, a 16-bit
big-endian length follows; if that's 0xFFFF, a 32-bit big-endian length
follows. (We've never seen anything but 1-byte lengths in practice.)

After unwrapping, each sub is itself a complete cooked SOE packet — could
be Reliable, KeepAlive, Ack, etc. Recursively dispatch.

Reference: `UdpLibrary.cpp:2009-2046`. Our impl: `src/soe/multipacket.ts`.

### 1.7 Fragment (opcodes 13-16)

Fragments split a single logical reliable payload across multiple
datagrams:

```
First fragment:    [00 0D][seq BE u16][totalLength BE u32][chunk bytes]
Subsequent:        [00 0D][seq BE u16][chunk bytes]
```

Every fragment on channel 0 uses the same `Fragment1` opcode (`0x0D`); the
opcode does NOT change per-fragment. Each fragment is its own reliable
packet that gets its own monotonically-increasing seq from
`OutgoingSequence` and is independently encrypted + CRCd
(UdpLibrary.cpp:3347-3351 builds the packet, then `PhysicalSend` line 2455
applies the encryption pipeline). Fragmentation thus happens BEFORE
encryption — the payload-data-per-fragment is sized so that the cooked
datagram (with worst-case zlib expansion) still fits in `maxRawPacketSize`.

`mMaxDataBytes` cap per-packet (UdpLibrary.cpp:2938):
```
maxDataBytes = maxRawPacketSize - 4 (reliable hdr) - crcBytes - encryptExpansionBytes
```
For SWG defaults (`maxRawPacketSize=496`, `crcBytes=2`, UserSupplied+Xor
expansion=1) this is 489 bytes. The first fragment's data block is
`maxDataBytes - 4` actual payload bytes (the 4-byte totalLength header eats
the rest); subsequent fragments carry up to `maxDataBytes` payload bytes
each.

The receiver allocates a buffer of `totalLength` bytes, accumulates chunks
in seq order, and delivers a single app payload once `totalLength` bytes
have been received.

Reference: `UdpLibrary.cpp:1697-1719` (receive), `3173-3220` + `3347-3351`
(send). Our impl: `src/soe/fragment.ts` (`FragmentBuffer` for receive,
`buildFragmentPackets` for send). Wired into `SoeConnection.sendApp` —
small sends take the single-packet fast path, anything bigger than
`maxDataBytes` is auto-split.

### 1.8 Group (opcode 25)

App-level bundler that wraps multiple complete GameNetworkMessages in one
reliable payload:

```
[00 19][len byte][gnm1 bytes][len byte][gnm2 bytes]...
```

Same length-encoding as Multi (1, 3, or 5 bytes). Each sub is delivered
straight to the message-decode pipeline (no further SOE unwrap).

Reference: `UdpLibrary.cpp:2047-2087`. Our impl: `src/soe/multipacket.ts:unpackGroup`.

---

## 2. Archive serialization

All primitives are **little-endian**. The C++ Archive layer is in
`~/code/swg-main/src/external/ours/library/archive/src/shared/`.

### 2.1 Primitives

| Type | Wire bytes | TS type |
|------|------------|---------|
| `bool` | 1 byte (0 = false, anything else = true) | `boolean` |
| `u8` / `i8` | 1 byte | `number` |
| `u16` / `i16` | 2 bytes LE | `number` |
| `u32` / `i32` | 4 bytes LE | `number` |
| `u64` / `i64` | 8 bytes LE | `bigint` |
| `f32` | 4 bytes LE IEEE 754 | `number` |
| `f64` | 8 bytes LE IEEE 754 | `number` |

Reference: `Archive.h` line 89-310 (primitives). Our impl: `src/archive/primitives.ts`,
`src/archive/byte-stream.ts`, `src/archive/read-iterator.ts`.

### 2.2 `std::string`

Encoded as a length-prefixed byte sequence:

```
[length u16 LE][bytes (length bytes)]            ; if length < 65535
[0xFFFF u16 LE][length u32 LE][bytes]            ; escape for ≥ 65535 bytes
```

The C++ side treats `std::string` as a raw byte container, so the wire is
just the bytes. We use UTF-8 on the JS side; that's compatible with the
ASCII inputs everywhere in SWG.

Reference: `Archive.h:89-101` (get), `295-310` (put). Our impl: `src/archive/string.ts`.

### 2.3 `Unicode::String`

```
[code-unit count u32 LE][UTF-16 LE bytes (count * 2)]
```

The prefix is the **code-unit count** (not byte count, not codepoint count).
SWG uses fixed 16-bit code-units (UCS-2 / UTF-16 with no surrogate
handling); every name and chat string in the codebase fits in the BMP.

Reference: `UnicodeArchive.cpp`. Our impl: `src/archive/unicode-string.ts`.

### 2.4 `NetworkId`

```
[int64 LE] (8 bytes)
```

High 32 bits identify the cluster, low 32 bits identify the object.
Exposed as JS `bigint`.

Reference: `NetworkIdArchive.cpp`. Our impl: `src/archive/network-id.ts`.

### 2.5 `Transform` (Quaternion + Vector)

28 bytes total:

```
[Quaternion: x f32 LE, y f32 LE, z f32 LE, w f32 LE]
[Vector3:    x f32 LE, y f32 LE, z f32 LE]
```

The C++ side does a NaN sanity reset on the quaternion components; we
replicate (helps fuzz robustness).

Reference: `TransformArchive.h`, `QuaternionArchive.h`, `VectorArchive.h`.
Our impl: `src/archive/transform.ts`.

### 2.6 Containers

| Container | Wire layout | Notes |
|-----------|-------------|-------|
| `AutoArray<T>` | `[u32 LE count][T item]*count` | Wire-identical to vector for counts < 2^31 |
| `std::vector<T>` | `[i32 LE count][T item]*count` | C++ writes the size as signed int |
| `std::set<T>` | `[i32 LE count][T item]*count` (iter order) | Pre-sorted by caller; we don't re-sort |
| `std::pair<A,B>` | A then B | No separator |
| `std::map<K,V>` | `[u32 LE count][K, V]*count` | size_t is 4 bytes on the server's 32-bit build |
| `AutoVariable<T>` | Just T's bytes | No framing; pure passthrough |

Reference: `Archive.h:130-203`, `AutoByteStream.h:459-504`. Our impl:
`src/archive/containers.ts`.

---

## 3. GameNetworkMessage framing

After SOE stripping (decrypt + CRC + reliable + fragment + multi/group),
the remaining "app payload" bytes are a single GameNetworkMessage:

```
[varCount u16 LE][typeCrc u32 LE][payload]
```

- `varCount` is `1 + (number of payload AutoVariables)`. The leading `1`
  accounts for `cmd` (the typeCrc), which the C++ ctor adds as the first
  AutoVariable. Empty messages like `HeartBeat` / `LogoutMessage` /
  `CmdSceneReady` have `varCount = 1`.
- `typeCrc` is `constcrc(messageName)` — see Section 3.1.
- `payload` is the Archive-serialized AutoVariables in addVariable() order.

Reference: `GameNetworkMessage.{h,cpp}` and `AutoByteStream.cpp:96`. Our
encoder: `src/messages/base.ts:encodeMessage`. Decoder dispatch:
`src/messages/registry.ts:decodeMessage`.

### 3.1 constcrc — the custom message-name CRC

Not standard CRC32. Custom 256-entry forward table + different shift
schedule. The C++ has identical algorithms in `CrcConstexpr.hpp`
(constexpr at compile time) and `Crc.cpp` (runtime).

```
crc = 0xFFFFFFFF
for each byte b in name:
    crc = TABLE[(crc >>> 24 ^ b) & 0xFF] ^ ((crc << 8) & 0xFFFFFFFF)
return crc ^ 0xFFFFFFFF
```

Empty/null string → 0 (init ^ init).

The 256-entry table is copied verbatim from `CrcConstexpr.hpp:17-51` in
`src/crc/constcrc.ts:30-63`. Do NOT substitute a polynomial-derived table;
this one is SOE-specific.

Used in two places:
1. Computing the `typeCrc` for outbound messages.
2. The server's `switch` statement at `ClientConnection.cpp:88-144` dispatches
   on this CRC.

### 3.2 GenericValueTypeMessage

A C++ template used for single-field messages. The wire layout is:

```
[varCount = 2 u16 LE][typeCrc u32 LE][value]
```

Where `value` is whatever codec the template was instantiated with (e.g.
`GenericValueTypeMessage<int>` → 4 bytes LE i32). Used by `ServerNowEpochTime`
(`int32`), `StationIdHasJediSlot` (`int`), `CharacterCreationDisabled`
(`std::set<std::string>`).

Reference: `GenericValueTypeMessage.h`. Our impl: `src/messages/base.ts:defineGenericValueTypeMessage`.

---

## 4. Quick reference: known message CRCs

(All in little-endian on the wire. Listed here as JS hex.)

### Login-stage (LoginServer ↔ client)

| Message | constcrc | varCount |
|---------|----------|----------|
| `LoginClientId` | 0x41131f96 | 4 |
| `LoginClientToken` | 0xaab296c6 | 4 |
| `LoginEnumCluster` | 0xc11c63b9 | 3 |
| `LoginClusterStatus` | 0x3436aeb6 | 2 |
| `LoginClusterStatusEx` | 0xfa5b4b5a | 2 |
| `LoginIncorrectClientId` | 0x20e7e510 | 3 |
| `ServerNowEpochTime` | 0x24b73893 | 2 |
| `CharacterCreationDisabled` | 0xf41a5265 | 2 |

### Connection-stage (ConnectionServer ↔ client)

| Message | constcrc | varCount |
|---------|----------|----------|
| `ClientIdMsg` | 0xd5899226 | 4 |
| `ClientPermissionsMessage` | 0xe00730e5 | 6 |
| `StationIdHasJediSlot` | 0xcca6efb8 | 2 |
| `EnumerateCharacterId` | 0x65eafb34 | 2 |
| `ClientCreateCharacter` | 0xb5293b6a | 14 |
| `ClientCreateCharacterSuccess` | 0xa1f5a0f1 | 2 |
| `ClientCreateCharacterFailed` | 0xdf2bbe6e | 3 |
| `SelectCharacter` | 0xb5378e60 | 2 |
| `GameServerForLoginMessage` | 0x4907263d | 4 |
| `ErrorMessage` | 0xb5abf91a | 4 |

### Game-stage (GameServer-via-ConnectionServer ↔ client)

| Message | constcrc | varCount | Notes |
|---------|----------|----------|-------|
| `CmdStartScene` | 0x6dfdcb13 | 9 | Server → client zone-in trigger |
| `SceneCreateObjectByCrc` | 0x5e91d4d6 | 5 | Baselines flood |
| `SceneCreateObjectByName` | 0x88e15bba | 5 | Baselines flood |
| `SceneEndBaselines` | 0x9eaaa28f | 2 | End of zone-in flood |
| `CmdSceneReady` | 0x18c5a13e | 1 | Client → server: "I'm ready" |
| `HeartBeat` | 0xa1668faf | 1 | Periodic keepalive |
| `LogoutMessage` | 0x42f5b965 | 1 | Client → server logout |
| `ObjControllerMessage` | 0x80ce5e46 | 5 (+trailer) | The fat workhorse; trailer dispatched by `message` int. See subtype table below. |
| `UpdateTransformMessage` | varies | 10 | **Server → client broadcast only.** Client→server movement uses `ObjControllerMessage(CM_netUpdateTransform=113)` — see below. |
| `UpdateTransformWithParentMessage` | varies | 11 | Server → client cell-relative broadcast |
| `AttributeListMessage` | varies | 5 | Item / resource stats (`{key, value}` pairs) |
| `ObjectMenuSelectMessage` | constcrc of `"ObjectMenuSelectMessage::MESSAGE_TYPE"` | 3 | Client → server: trigger an OnObjectMenuSelect on a target. Trailer: `[NetworkId target][u16 itemId]`. itemId values from `RadialMenuTypes` (ITEM_USE=21, EXAMINE=7, plus vehicle/pet: `PET_CALL=45`, `PET_STORE=60`, `VEHICLE_GENERATE=61`, `VEHICLE_STORE=62`, pet commands `PET_COMMAND=224`, `PET_FOLLOW=225`, `PET_STAY=226`, `PET_GUARD=227`, `PET_FRIEND=228`, `PET_ATTACK=229`, `PET_PATROL=230`, plus `SERVER_PET_MOUNT=288`/`SERVER_PET_DISMOUNT=289`). |
| `SurveyMessage` | 0x877f79ac | varies | Server → client survey response with sample points |
| `ResourceListForSurveyMessage` | 0x8a64b1d5 | 4 | Server → client list of resource types currently spawned for a tool's class |
| `ChatSystemMessage` | 0x6d2a6413 | 4 | Server → client system-message prose. Trailer: `[u8 flags][UnicodeString message][UnicodeString outOfBand]`. The `outOfBand` field is a packed-bytes binary (each `u16` codepoint holds 2 wire bytes in LE order) carrying STF references like `survey/sample_located` — see `decodeSampleOob()` for unpacking. |
| `SuiCreatePageMessage` | 0xd44b7259 | 2 | Server → client. Opens a SUI dialog page. Payload is `AutoDeltaVariable<SuiPageData>` decoded to typed `SuiPageData = { pageId: i32, pageName: stdString, commands: SuiCommand[], associatedObjectId: NetworkId, associatedLocation: Vector3, maxRangeFromObject: f32 }`. Each `SuiCommand` is `[u8 type][AutoArray<UnicodeString> parametersWide][AutoArray<stdString> parametersNarrow]` decoded into one of 9 typed variants (`createWidget` / `setProperty` / `subscribeToEvent` / `addChildWidget` / `clearDataSource` / `addDataItem` / `addDataSourceContainer` / `clearDataSourceContainer` / `addDataSource`) or `{ type: 'unknown', commandType, parametersWide, parametersNarrow }` for forward-compat. Raw bytes still available via `msg.pageDataBytes`. |
| `SuiUpdatePageMessage` | 0x5f3342f6 | 2 | Server → client. Same wire shape as `SuiCreatePageMessage`; in-place widget updates. Same typed decoder. |
| `SuiForceClosePage` | 0x990b5de0 | 2 | Server → client. Close a SUI page. Payload: `[i32 clientPageId]`. |
| `SuiEventNotification` | 0x092d3564 | 4 | Client → server. Reply to a SUI page: `[i32 pageId][i32 subscribedEventIndex][u32 returnList.length][u32 baselineCommandCount=0][UnicodeString]*length`. |
| `BeginTradeMessage` | 0x325932d8 | 2 | Server → client. Trailer: `[NetworkId player]` (the OTHER party). |
| `AddItemMessage` | 0x1e8d1356 | 2 | Bidirectional. Trailer: `[NetworkId object]`. |
| `RemoveItemMessage` | 0x4417af8b | 2 | Bidirectional. Trailer: `[NetworkId object]`. |
| `GiveMoneyMessage` | 0xd1527ee8 | 2 | Bidirectional. Trailer: `[i32 amount]`. |
| `AcceptTransactionMessage` | 0xb131ca17 | 1 | Bidirectional, empty body. |
| `UnAcceptTransactionMessage` | 0xe81e4382 | 1 | Bidirectional, empty body. |
| `VerifyTradeMessage` | 0x9ae247ee | 1 | Bidirectional, empty body. Final commit confirmation. |
| `TradeCompleteMessage` | 0xc542038b | 1 | Server → client, empty body. |
| `AbortTradeMessage` | 0x9ca80f98 | 1 | Bidirectional, empty body. |
| `AuctionQueryHeadersMessage` | constcrc | 17 | C→S: bazaar browse. Trailer fields (in `addVariable` order): `locationSearchType, requestId, searchType, itemType, itemTypeExactMatch, itemTemplateId, textFilterAll(UString), textFilterAny(UString), priceFilterMin, priceFilterMax, priceFilterIncludesFee, advancedSearch(vector<SearchCondition>), advancedSearchMatchAllAny(i8), container(NetworkId), myVendorsOnly, queryOffset(u16)`. |
| `AuctionQueryHeadersResponseMessage` | constcrc | 8 | S→C: page of bazaar headers. Server palettizes shared strings: `[i32 requestId][i32 typeFlag][AutoArray<std::string> stringPalette][AutoArray<Unicode::String> widePalette][AutoArray<PalettizedItemDataHeader>][u16 queryOffset][bool hasMorePages]`. Decoder depalettizes back to `AuctionListing[]`. |
| `BidAuctionMessage` / `BidAuctionResponseMessage` | constcrc | 4 / 3 | C→S `[NetworkId itemId][i32 bid][i32 maxProxyBid]`; S→C `[NetworkId itemId][i32 result]` |
| `AcceptAuctionMessage` / `AcceptAuctionResponseMessage` | constcrc | 2 / 3 | Instant-buy on a buy-now auction. |
| `CreateAuctionMessage` | constcrc | 8 | C→S list (bidding-style): `[NetworkId itemId][UString name][NetworkId containerId][i32 minBid][i32 lengthSeconds][UString description][bool premium]` |
| `CreateImmediateAuctionMessage` | constcrc | 9 | C→S list (instant-buy): same as CreateAuctionMessage with `price` replacing `minBid` plus trailing `[bool vendorTransfer]` |
| `CreateAuctionResponseMessage` | constcrc | 4 | S→C `[NetworkId itemId][i32 result][std::string rejectionMessage]` |
| `CancelLiveAuctionMessage` / `CancelLiveAuctionResponseMessage` | constcrc | 2 / 4 | C→S `[NetworkId itemId]`; S→C `[NetworkId itemId][i32 result][bool vendorRefusal]` |
| `RetrieveAuctionItemMessage` / `RetrieveAuctionItemResponseMessage` | constcrc | 3 / 3 | C→S `[NetworkId itemId][NetworkId containerId]`; S→C `[NetworkId itemId][i32 result]` |
| `GetAuctionDetails` / `GetAuctionDetailsResponse` | constcrc | 2 / 2 | C→S `[NetworkId itemId]`; S→C single `Auction::ItemDataDetails` struct. |
| `IsVendorOwnerMessage` / `IsVendorOwnerResponseMessage` | constcrc | 2 / 6 | C→S `[NetworkId containerId]`; S→C `[i32 ownerResult][i32 result][NetworkId containerId][std::string marketName][u16 maxPageSize]`. |

### ObjController subtypes

`ObjControllerMessage` is wire-framed as the 20-byte header `[u32 flags][i32 message][NetworkId][f32 value]` plus a subtype-specific trailer. The `message` int is a `CM_*` enum value from `~/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/GameControllerMessage.def`. Subtypes we decode (see `src/messages/game/obj-controller/`):

| `message` | Name | Direction | Trailer / notes |
|---|---|---|---|
| 113 | `CM_netUpdateTransform` | both | World-coord movement. Trailer = `MessageQueueDataTransform` (45 bytes): `[u32 syncStamp][i32 seq][Quat 4×f32][Vec3 3×f32][f32 speed=0][f32 lookAtYaw=0][u8 useLookAtYaw=0]`. NEGATIVE `seq` from server is the teleport-lockout signal — see `CM_teleportAck`. |
| 204 | `CM_combatAction` | server | Combat-action broadcast: who attacked whom with what action |
| 241 | `CM_netUpdateTransformWithParent` | both | Cell-relative variant: same as 113 prefixed with `[NetworkId parentCell]` |
| 243/244 | `CM_spatialChatSend` / `CM_spatialChatReceive` | C/S | Chat — `allowFromClient=false` for send-from-client; use the `say` CommandQueue path instead |
| 221 | `CM_npcConversationStart` | client* | Open NPC conversation. Trailer = `MessageQueueStartNpcConversation`: `[NetworkId npc][u8 starter][stdString conversationName][u32 appearanceOverrideTemplateCrc]`. *`allowFromClient=false` server-side; use `useAbility('npcConversationStart', npcId, '<starter> <name>')` via command queue instead. |
| 222 | `CM_npcConversationStop` | both | End conversation. Trailer = `[NetworkId npc][StringId finalMessageId (table+textIndex+text)][UnicodeString finalMessageProse][UnicodeString finalResponse]`. Client send is `allowFromClient=false`; use `useAbility('npcConversationStop', 0n, '')`. |
| 223 | `CM_npcConversationMessage` | server | NPC's current prompt text. Trailer = `[UnicodeString npcMessage]`. Paired with CM=224. |
| 224 | `CM_npcConversationResponses` | server | Menu of option strings. Trailer = `MessageQueueStringList`: `[u8 count][UnicodeString]*count`. |
| 225 | `CM_npcConversationSelect` | client* | Pick option. Response index is in parent `value` (f32 cast). Trailer is EMPTY. *`allowFromClient=false`; use `useAbility('npcConversationSelect', 0n, String(index))`. |
| 245/249/251/256 | `CM_mission*Request` / `*Response` | both | Mission list, accept, remove, create |
| 258/259/262/263/264/266/268/270/271 | `CM_*` (crafting) | both | Crafting session: draft schematics, slot assign/empty, experiment, finish, result |
| 278 | `CM_commandQueueEnqueue` | client | Wraps a `CommandQueueEnqueue { sequenceId, commandHash, targetId, params }` — the path `useAbility` / `survey` / `say` / etc. all go through |
| 305 | `CM_setPosture` | server | Posture change broadcast |
| 308 | `CM_combatSpam` | server | Combat text spam |
| 315 | `CM_sitOnObject` | server | Sit-on-chair-object broadcast |
| 319 | `CM_teleportAck` | client | ACK for a teleport-lockout signal. Trailer: `[i32 sequenceId]` matching the negative seq the server sent via CM=113. |
| 322 | `CM_missionAbort` | both | Player-initiated mission abort |
| 326/327 | `CM_objectMenuRequest` / `Response` | both | Radial menu fetch / populate |
| 351/421 | `CM_setGroupInviter` / `setGroup` | server | Group formation broadcasts |
| 422 | `CM_setMood` | server | Mood change |
| 403/404 | `CM_addAllowed` / `CM_removeAllowed` | server↔server | Building/cell ENTRY-list permission grant/revoke. Trailer: `[stdString playerName]`. Cross-auth signal — not a client→server path; client drives the user-facing change via `useAbility('permissionListModify', ...)`. See `scripts/build-city/admin-permissions.ts`. |
| 405/406 | `CM_addBanned` / `CM_removeBanned` | server↔server | Building/cell BANNED-list grant/revoke. Same `[stdString playerName]` trailer. |
| 540 | `CM_emergencyDismountForRider` | server↔server | Rider-emergency-dismount cross-auth signal. Empty trailer. Modeled for transcript inspection — not a client→server path. |
| 541 | `CM_detachRiderForMount` | server↔server | Detach a specific rider (non-auth → auth). Trailer: `[NetworkId riderId]` (8 bytes). |
| 1205 | `CM_detachAllRidersForMount` | server↔server | Detach every rider on a mount in one shot (non-auth → auth). Empty trailer. |

Other CM IDs flow as opaque bytes with a diagnostic `subtypeCrcHex` field for log inspection.

Confirm any of these by running:

```bash
pnpm cli zone --verbose --host=10.254.0.253 --user=test --skip-game 2>&1 \
  | grep -E '(messageName|typeCrc)'
```

---

## 5. Worked example: decoding a captured 223-byte LoginEnumCluster packet

The captured fixture at `tests/fixtures/login-enum-cluster-223b.hex` is a
real reliable packet from a live login. Pipeline:

1. **Strip & verify CRC**: last 2 bytes are `crc32(rest, encryptCode=0xfe7b4873) & 0xffff`,
   big-endian.
2. **Xor-decrypt** (offset 2 onward, since buf[0]=0).
3. **Verify reliable framing**: `[00 09][seq BE u16][rest]`. seq=1.
4. **UserSupplied-decrypt** the `[rest]`: last byte is `0x01` (zlib), strip
   it and inflate.
5. Inflated payload starts with `[00 19]` → Group. Walk
   `[len][submsg][len][submsg]...`.
6. For each `submsg`: parse `[varCount u16 LE][typeCrc u32 LE][payload]`.
7. Dispatch by typeCrc through `messageRegistry`. Get
   `ServerNowEpochTime`, `LoginClientToken`, `LoginEnumCluster`,
   `CharacterCreationDisabled`, `LoginClusterStatus`,
   `LoginClusterStatusEx`, `StationIdHasJediSlot`, `EnumerateCharacterId`.

This full round-trip is exercised by `tests/integration/wire-parse.test.ts`
which decodes the captured fixture and asserts the cluster name "swg",
address "10.254.0.253", port 44463 come back out cleanly.
