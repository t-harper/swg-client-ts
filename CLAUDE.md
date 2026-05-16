# CLAUDE.md — swg-ts-client

What this is, how to navigate, and the wire-format gotchas worth remembering. Quick-scan style; deep references live in `docs/`.

## What this is

A headless TypeScript SWG wire-compatible client at `~/code/swg-ts-client/`. Built for CI smoke tests, load testing, fuzzing, and protocol documentation — **not** for actually playing the game. Drives a full **login → ConnectionServer auth → character create → SelectCharacter → zone-in → 5s dwell → clean logout** lifecycle against a real `swg-server` in ~5 seconds.

Its raison d'être is catching wire-format regressions like the **bug-7 Admin Account Routing Refactor** mismatch (documented in `~/code/swg-main/CLAUDE.md`) — server `src` submodule pinned older than the client `LoginClusterStatus_ClusterData` struct → silent `Archive::ReadException` crash at title-screen frame 600. With this client, that becomes a `pnpm test` failure within seconds.

The server side lives at `~/code/swg-main/`. **Read `~/code/swg-main/CLAUDE.md` first** for context on the running server, the 8 bring-up failure modes, the Oracle XE setup, etc.

## Quickstart

```bash
cd ~/code/swg-ts-client
nvm use                # Node 24 (LTS as of 2026-05)
pnpm install
pnpm test              # 234 unit tests — no server needed
LIVE=1 pnpm test       # 234 unit + 4 integration tests against 10.254.0.253
pnpm cli zone --host=10.254.0.253 --user=ci-test --character=TsTest
```

`pnpm cli zone` exits 0 and emits a JSON `LifecycleResult` whose `baselineObjectCount > 0` and `zonedInAt != null` mean the cluster is healthy end-to-end.

## Architecture

```
                   src/index.ts        ← public exports
                        ↑
                src/client/             ← Promise-based orchestrator
                  swg-client.ts         ← SwgClient.fullLifecycle()
                  dispatcher.ts         ← waitFor / onMessage helpers
                  login-stage.ts        ← Stage 1: LoginServer
                  connection-stage.ts   ← Stage 2: ConnectionServer
                  game-stage.ts         ← Stage 3+4: zone-in + logout
                        ↑
                src/messages/           ← 28 GameNetworkMessage classes
                  login/   (8)          ← LoginClientId, LoginEnumCluster, ...
                  connection/ (10)      ← ClientIdMsg, EnumerateCharacterId, ...
                  game/    (10)         ← CmdStartScene, LogoutMessage, ...
                  base.ts + registry.ts ← framing + CRC dispatch
                        ↑
                src/soe/                ← UDP transport
                  connection.ts         ← SoeConnection class (one per UDP socket)
                  session/encrypt/reliable/fragment/multipacket
                        ↑
                src/archive/            ← wire serialization
                  byte-stream + read-iterator + primitives
                  string / unicode-string / network-id / transform / containers
                        ↑
                src/crc/
                  crc32.ts              ← UdpMisc::Crc32 with seed scramble
                  constcrc.ts           ← CrcConstexpr.hpp custom CRC, NOT standard CRC32
```

50 test files, 234 unit tests, 4 LIVE-gated integration tests, all currently green.

## Five wire-format gotchas (memorize)

These cost hours during the initial build. Don't relearn them.

### 1. `constcrc()` is NOT standard CRC32
Custom 256-entry table at `src/crc/constcrc.ts`. Lifted byte-for-byte from `CrcConstexpr.hpp` lines 17-51. Standard CRC32 tables will produce wrong values and the server will silently drop your messages with no error log entry.

### 2. The wire format prepends a `[u16 LE varCount]` BEFORE the `[u32 LE typeCrc]`
Every `GameNetworkMessage` is on the wire as:
```
[u16 LE varCount]  ← AutoByteStream::pack member count (always >= 1)
[u32 LE typeCrc]   ← constcrc(messageName); first AutoVariable
[N bytes payload]
```
`varCount` = 1 (for `cmd`) plus the number of payload `addVariable()` calls in the C++ ctor. Every message class declares `static readonly varCount: number` — verified against the C++ source. `src/messages/base.ts::encodeMessage` and `parseHeader` handle this; subclasses just declare the count.

### 3. SOE UDP packet enum values are SEQUENTIAL from 0
`UdpLibrary.hpp` lines 1387-1395 declare the enum with NO explicit numbers, so they auto-number from `cUdpPacketZeroEscape=0`. The exploration agent originally documented `Reliable1=10` (wrong); the captured wire packet starts with `00 09` confirming `Reliable1=9`. Both `src/types.ts` and `src/soe/packet-types.ts` now use the correct sequential values.

### 4. Two encryption passes, applied in this order on send
- **Pass 0**: `UserSupplied` — try zlib compress, then append flag byte (`0x01` = compressed, `0x00` = raw). Decode: check LAST byte → decompress or strip → return.
- **Pass 1**: `Xor` — 4-byte chained XOR feedback. `prev = encryptCode` initially; on decrypt `prev` updates to each *encrypted* int read; on encrypt `prev` updates to each *output* int.

Receive order is reverse: strip CRC → XOR-decrypt → UserSupplied-decompress.

The trailing flag byte is what trips zlib if you forget it ("incorrect data check" error — it's the trailing byte being parsed as part of Adler32). Always strip it before `zlib.inflateSync`.

### 5. Captured packets use cUdpPacketGroup (opcode 25), NOT cUdpPacketMulti (3)
`Multi` is the SOE-internal low-level coalescer; `Group` is the app-message bundler that `sharedNetwork`'s send path uses. Both are implemented in `src/soe/multipacket.ts`. Group's sub-message length prefix is variable-length (1, 3, or 7 bytes) — `unpackGroup` handles it.

## Architecture corrections from the implementation

Two facts from the plan were wrong; reality (verified against C++ source) is:

### Only 2 UDP sockets, not 3
The plan said the client opens a third socket to "GameServer". Wrong. `GameServerForLoginMessage` is internal CentralServer→ConnectionServer routing. After `SelectCharacter` the existing ConnectionServer UDP socket gets re-routed server-side to a GameConnection. The client never opens a new socket. Same encryptCode, same connectionCode, same sequence numbers.

### Avatar list comes from LoginServer, not ConnectionServer
`EnumerateCharacterId` arrives during Stage 1 (LoginServer.cpp:1122 sends it before `LoginClientToken`). ConnectionServer also has access to it but doesn't push it on its own. Our `login-stage.ts` collects it.

### Character creation arg traps
- `startingLocation` is a city key from `starting_locations.iff` (e.g. `"mos_eisley"`), NOT a planet name (`"tatooine"` won't work).
- `templateName` is the server template: `object/creature/player/human_male.iff`. Don't use the `shared_*` variant.
- Account names cap at 15 chars (`MAX_ACCOUNT_NAME_LENGTH` in `CommonAPI.cpp:6`). Use ``ts-test-${(Date.now()/1000)|0}`` not the full ms.

All three are documented in `docs/lifecycle.md` and inline in `src/client/connection-stage.ts`.

## Adding a new message

Recipe in `docs/adding-a-message.md`. Short version:

1. Find the C++ class in `~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/...`.
2. Count `addVariable()` calls in its ctor → that's `varCount - 1` (the `-1` because `cmd` is always added by the base).
3. Create `src/messages/{login,connection,game}/<kebab-name>.ts`:
   ```ts
   export class MyMessage extends GameNetworkMessage {
     static readonly messageName = 'MyMessage';
     static readonly typeCrc = constcrc(MyMessage.messageName);
     static readonly varCount = 3;  // 1 + 2 payload fields
     constructor(public foo: number, public bar: string) { super(); }
     encodePayload(stream: IByteStream): void {
       stream.writeU32(this.foo);
       writeStdString(stream, this.bar);
     }
     static decodePayload(iter: IReadIterator): MyMessage {
       return new MyMessage(iter.readU32(), readStdString(iter));
     }
   }
   export const MyMessageDecoder = registerMessage(asDecoder(MyMessage));
   ```
4. Add golden-byte test at `<name>.test.ts` — round-trip encode/decode + literal byte check.

## Running against the live server

The `swg-server` container at `10.254.0.253:44453/udp` is the canonical test target (managed by `~/code/swg-main/`). Verify before integration tests:

```bash
nc -uvw 1 10.254.0.253 44453 < /dev/null   # should report open (UDP probe is approximate)
podman ps | grep swg-server                # should be Up
```

If LIVE tests fail, the issue is almost always one of:
- Server's wire protocol drifted from what we encode → check `~/code/swg-main`'s submodule pin (bug #7)
- The `swg-server` cluster isn't reporting "ready for players" → check `podman logs swg-server | grep 'ready'`
- Firewall — the host's `firewalld` must have 44453/UDP, 44463/UDP open (see `~/code/swg-main/CLAUDE.md` bug #4)

Run a single live test for fast diagnosis:
```bash
LIVE=1 pnpm test tests/integration/live-login.test.ts
```

If THAT passes but `live-zone-in-and-logout.test.ts` fails, the issue is in Stage 2/3 (character creation, GameServer routing) — start by inspecting the JSON `transcript` field in `LifecycleResult`.

## Public API surface

`src/index.ts` exports:
- Types: `ClusterInfo`, `CharacterInfo`, `LoginToken`, `EncryptionParams`, `ServerEndpoint`, `Vector3`, `NetworkId` (bigint), `SceneStart`
- Enums: `EncryptMethod`, `UdpPacketType`, `ClusterStatus`, `PopulationStatus`, `CharacterType`, `ZoneState`
- Client: `SwgClient`, `lifecycleResultToJSON`
- Result types: `LifecycleResult`, `FullLifecycleOptions`, `SwgClientOptions`, `TranscriptEvent`, `LoginStageResult`, `ConnectionStageResult`, `GameStageResult`, `BaselineSummary`

Individual stage drivers and the `dispatcher` are also exported as types — use them if you want to do something more granular than `fullLifecycle()` (e.g. login but skip zone-in).

## File map for quick navigation

| Need to... | Look at |
|---|---|
| Add a new message | `docs/adding-a-message.md` + any file in `src/messages/login/` as template |
| Understand wire bytes | `docs/wire-spec.md` (distilled spec) |
| Trace the 4-stage lifecycle | `docs/lifecycle.md` (state diagram + per-stage tables) |
| Debug a live test failure | `src/client/swg-client.ts` — `transcript` field captures every send/recv |
| Add a new live test | `tests/integration/live-*.test.ts` as template (LIVE=1 gated) |
| Inspect captured wire | `tests/fixtures/{session-response-17b,login-enum-cluster-223b}.hex` |
| Wire decryption sanity check | `src/soe/connection.test.ts` — feeds captured bytes through full pipeline |
| Verify a constcrc value | `src/crc/constcrc.test.ts` — golden values from the C++ table |

## Known limitations (out of MVP scope)

- 2 server-internal CRCs (`0x0e20d7e9 = DescribeConnection`, `0x58c07f21 = SystemAssignedProcessId`) arrive but aren't modeled — logged as `unknownCrc` in transcript; harmless.
- Live integration tests leak timestamp-suffixed characters in the DB; no cleanup pass. Names are unique per run.
- `ObjControllerMessage` trailer is captured opaquely. Per-subtype decoding (movement, combat, attribute updates) is the next ~80 messages of work — out of MVP.
- Send-path fragmentation isn't plumbed into `SoeConnection.sendApp`. Client→server messages are all small (< 200 bytes typical, max ~1KB for ClientCreateCharacter). If you ever need to send something > ~480 bytes, this will need fixing.
- AckAll uses raw 16-bit wire seq rather than reconstructed 64-bit ID. Fine until we accumulate > 65k outstanding reliables (never happens).
- ClockSync/ClockReflect are received and silently dropped. No ping stats. Not needed for any current test.

## When you next sit down

1. `cd ~/code/swg-ts-client && nvm use && pnpm test` — confirm baseline (should be 234 green).
2. If anything's red, check `git log --oneline` — most recent change is probably the culprit; revert it locally and retry.
3. If you bumped `~/code/swg-main` submodules, the wire-format may have drifted. Run `LIVE=1 pnpm test tests/integration/live-login.test.ts` — if it fails with a `LoginIncorrectClientId` or `Archive::ReadException`-style error, you're seeing bug-7 manifest in the test client. Either update the message struct here to match (find the C++ commit that added/removed fields, update `varCount` + encode/decode), or roll the server's submodule back.
4. To do "more SWG protocol work" — read `docs/adding-a-message.md` and pick a message from `~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/`. The mechanical pattern handles itself.

## Don't

- Don't add `~/code/swg-main` as a TypeScript dependency. This repo READS the C++ source for spec but never builds against it.
- Don't replace `constcrc.ts`'s 256-entry table with a "cleaner" standard CRC32. It's intentionally weird; the table is the spec.
- Don't switch from `node:dgram` to a UDP wrapper library. The bare API is fine and the dependency hygiene matters.
- Don't add `_stub-*.ts` files back — those were Phase 1 development scaffolding and are gone.
- Don't commit `tests/fixtures/*.hex` with anything new without verifying it via a real tcpdump capture against the live server. Hand-crafted fixtures will silently drift from reality.
