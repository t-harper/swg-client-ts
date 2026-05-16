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
                   src/index.ts                ← public exports
                        ↑
                src/client/                    ← Promise-based orchestrator
                  swg-client.ts                ← SwgClient.fullLifecycle()
                  dispatcher.ts                ← waitFor / onMessage helpers
                  login-stage.ts               ← Stage 1: LoginServer
                  connection-stage.ts          ← Stage 2: ConnectionServer
                  game-stage.ts                ← Stage 3+4: zone-in (+ script hook) + logout
                  fleet.ts                     ← N parallel SwgClients (multi-client load)
                  transcript-io.ts             ← NDJSON capture I/O
                  replay.ts                    ← capture + replay harness
                  script/
                    context.ts                 ← ScriptContext (walk/chat/combat/inventory/logout)
                    movement.ts                ← walkTo / walkCircle implementations
                src/scenarios/                 ← bundled CLI-loadable scenarios
                                                  (walk-line, walk-circle, open-inventory,
                                                   combat-attack, posture-cycle, dwell)
                        ↑
                src/messages/                  ← 32 top-level + 8 ObjController subtypes
                  login/         (8)           ← LoginClientId, LoginEnumCluster, ...
                  connection/    (10)          ← ClientIdMsg, EnumerateCharacterId, ...
                  game/          (10)          ← CmdStartScene, LogoutMessage, ...
                  game/chat/     (6)           ← Tell, channel post, mail, room list
                  game/command-queue/ (3)      ← Enqueue + Remove + TimerData (combat backbone)
                  game/obj-controller/ (8)     ← CombatAction, PostureChange, AttributeChanged, ...
                                                  (subtype dispatch inside ObjControllerMessage)
                  base.ts + registry.ts        ← framing + CRC dispatch
                        ↑
                src/soe/                       ← UDP transport
                  connection.ts                ← SoeConnection class (one per UDP socket)
                  session/encrypt/reliable/fragment/multipacket
                        ↑
                src/archive/                   ← wire serialization
                  byte-stream + read-iterator + primitives
                  string / unicode-string / network-id / transform / containers
                        ↑
                src/crc/
                  crc32.ts                     ← UdpMisc::Crc32 with seed scramble
                  constcrc.ts                  ← CrcConstexpr.hpp custom CRC, NOT standard CRC32
```

81 test files, **419 tests (413 unit + 6 LIVE)**, all currently green. (Real count is higher in latest worktrees as new features land — `pnpm test` to confirm.)

## High-level features

The client started as just `SwgClient.fullLifecycle()` and is now a small toolkit:

| Feature | Where | What |
|---|---|---|
| **Full lifecycle** | `SwgClient.fullLifecycle(opts)` | Login → connect → select → zone-in → dwell → logout in ~5s |
| **Scripting engine** | `opts.script: ScenarioFn` | Async function gets a `ScriptContext` during the dwell; primitives for movement, container ops, combat, chat, logout. See `docs/scripting.md`. |
| **Bundled scenarios** | `src/scenarios/` + CLI `--script=<name>` | `walk-line`, `walk-circle`, `open-inventory`, `combat-attack`, `posture-cycle`, `dwell` |
| **Fleet (multi-client)** | `Fleet.run([cfgs], opts)` + CLI `swarm` | Run N independent clients in parallel with staggered launches + concurrency caps |
| **Capture + replay** | `captureLifecycle()` / `replay()` + CLI `capture`/`replay` | Record a session as NDJSON; replay it to detect server-side wire-format drift |
| **ObjController subtype decoder** | `src/messages/game/obj-controller/` | Decode the variable-length trailer based on `controllerType` — 8 most common subtypes covered |
| **Character pool** | `CharacterPool` + CLI `pool` + `poolCredentials()` in `tests/integration/helpers.ts` | Persistent check-out database (JSON-backed, lockfile-coordinated) for pre-created characters. Pre-stock the cluster's character quota once via `pool stock`; tests `CI_USE_POOL=1` opt-in to lease from the pool instead of leaking new chars per run. |

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

**Core types & enums** — `ServerEndpoint`, `EncryptionParams`, `ClusterInfo`, `CharacterInfo`, `NetworkId` (bigint), `LoginToken`, `ClientPermissions`, `SceneStart`, `Vector3`, plus enums `EncryptMethod`, `UdpPacketType`, `ClusterStatus`, `PopulationStatus`, `CharacterType`, `ZoneState`.

**Client** — `SwgClient`, `lifecycleResultToJSON`, plus `LifecycleResult`, `FullLifecycleOptions`, `SwgClientOptions`, `TranscriptEvent`, and the per-stage `LoginStageResult` / `ConnectionStageResult` / `GameStageResult` / `BaselineSummary`.

**Scripting** — `ScenarioFn`, `ScriptContext`, `ScriptResult`, `WalkToOptions`, `CircleOptions`, `scenarios` (registry), `ScenarioFactory`.

**Fleet** — `Fleet`, `FleetClientConfig`, `FleetOptions`, `FleetRunOptions`, `FleetOutcome`, `FleetResult`, `FleetSummary`, `FleetMessageCount`.

**Character pool** — `CharacterPool`, `PooledCharacter`, `PoolOptions`, `CheckoutOptions`, `CheckoutResult`, `CheckoutManyResult`.

**Capture + replay** — `captureLifecycle`, `replay`, `replayScenario`, `attachCapture`, `transcriptToNdjson`, `transcriptFromNdjson`, `readTranscript`, `writeTranscript`, `eventsFromTranscript`, plus `CapturedEvent`, `CaptureLifecycleOptions`, `CaptureLifecycleResult`, `ReplayOptions`, `ReplayResult`, `ReplayScenarioOptions`, `ReplayScriptContext`.

**Chat message classes** — `ChatInstantMessageToCharacter`, `ChatInstantMessageToClient`, `ChatRequestRoomList`, `ChatRoomList`, `ChatSendToRoom`, `ChatPersistentMessageToServer`, plus `chatAvatarId` factory, `ChatRoomType`, `PERSISTENT_MESSAGE_MAX_SIZE`, and types `ChatAvatarId`, `ChatRoomData`.

Individual stage drivers and the `dispatcher` are also exported as types — use them if you want to do something more granular than `fullLifecycle()` (e.g. login but skip zone-in).

## File map for quick navigation

| Need to... | Look at |
|---|---|
| Add a new message | `docs/adding-a-message.md` + any file in `src/messages/login/` as template |
| Add a new ObjController subtype | `docs/adding-a-message.md` → "ObjController subtypes" section |
| Write a scenario script | `docs/scripting.md` + `src/scenarios/index.ts` as template |
| Understand wire bytes | `docs/wire-spec.md` (distilled spec) |
| Trace the 4-stage lifecycle | `docs/lifecycle.md` (state diagram + per-stage tables + script hook) |
| Run N clients in parallel (load test) | `docs/scripting.md` → "Fleet" section + `src/client/fleet.ts` |
| Capture a wire transcript / replay it | `docs/scripting.md` → "Capture and replay" + `src/client/replay.ts` |
| Debug a live test failure | `src/client/swg-client.ts` — `transcript` field captures every send/recv |
| Add a new live test | `tests/integration/live-*.test.ts` as template (LIVE=1 gated) |
| Reuse a character across CI runs | Set `CI_REUSE_ACCOUNT` + `CI_REUSE_CHARACTER` (`tests/integration/helpers.ts`) |
| Use a check-out pool (multi-account tests) | `swg-ts-cli pool stock --count=N` once → set `CI_USE_POOL=1` → tests call `poolCredentials(prefix, count)`. See `src/client/character-pool.ts`. |
| Inspect captured wire | `tests/fixtures/{session-response-17b,login-enum-cluster-223b}.hex` |
| Wire decryption sanity check | `src/soe/connection.test.ts` — feeds captured bytes through full pipeline |
| Verify a constcrc value | `src/crc/constcrc.test.ts` — golden values from the C++ table |

## Known limitations (out of MVP scope)

- 2 server-internal CRCs (`0x0e20d7e9 = DescribeConnection`, `0x58c07f21 = SystemAssignedProcessId`) arrive but aren't modeled — logged as `unknownCrc` in transcript; harmless.
- Live integration tests leak timestamp-suffixed characters in the DB unless `CI_REUSE_ACCOUNT` + `CI_REUSE_CHARACTER` are set (see `tests/integration/helpers.ts`). In reuse mode, file parallelism is forced off (`vitest.config.ts`) because the server allows one session per account.
- `ObjControllerMessage` subtype decoding covers the **8 most common** subtypes (CombatAction, CombatSpam, PostureChange, AttributeChanged, SitOnObject, MoodChange, ObjectMenuRequest/Response). Other subtypes still flow as opaque bytes with a diagnostic `subtypeCrcHex`. Add more in `src/messages/game/obj-controller/`.
- **Spatial chat** is fully wire-modeled. `ctx.say(text, opts?)` wraps the server's `spatialChatInternal` CommandQueue command — the same path the real Windows client uses. The direct `CM_spatialChatSend(243)` ObjController subtype is NOT a viable client→server path: the server's `ControllerMessageFactory::allowFromClient` registry has it set to `false` (MessageQueueSpatialChat.cpp:26), so anything sent via that subtype is logged as a HackAttempts entry and dropped (Client.cpp:972). Inbound broadcasts arrive as `ObjControllerMessage` with `message=CM_spatialChatReceive(244)`, decoded via `SpatialChatReceiveDecoder`. The `tests/integration/live-spatial-chat.test.ts` self-broadcast variant exercises the round-trip end-to-end (single client, no need for character creation).
- Send-path fragmentation isn't plumbed into `SoeConnection.sendApp`. Client→server messages are all small (< 200 bytes typical, max ~1KB for ClientCreateCharacter). If you ever need to send something > ~480 bytes, this will need fixing.
- AckAll uses raw 16-bit wire seq rather than reconstructed 64-bit ID. Fine until we accumulate > 65k outstanding reliables (never happens).
- ClockSync/ClockReflect are received and silently dropped. No ping stats. Not needed for any current test.
- Replay compares `recv` shape, not bytes. Live servers emit non-deterministic neighbor updates between runs, so strict order-equality (`--compare=names`) often surfaces "missing"/"unexpected" diffs even on a clean replay. Use `--compare=count` (multiset) for a more permissive check.

## When you next sit down

1. `cd ~/code/swg-ts-client && nvm use && pnpm test` — confirm baseline (should be 413 unit green; 419 total under `LIVE=1`).
2. If anything's red, check `git log --oneline` — most recent change is probably the culprit; revert it locally and retry.
3. If you bumped `~/code/swg-main` submodules, the wire-format may have drifted. Run `LIVE=1 pnpm test tests/integration/live-login.test.ts` — if it fails with a `LoginIncorrectClientId` or `Archive::ReadException`-style error, you're seeing bug-7 manifest in the test client. Either update the message struct here to match (find the C++ commit that added/removed fields, update `varCount` + encode/decode), or roll the server's submodule back. For broader drift, capture a known-good transcript via `pnpm cli capture --output=baseline.ndjson` and `replay` it after the bump.
4. To do "more SWG protocol work" — read `docs/adding-a-message.md` and pick a message from `~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/`. The mechanical pattern handles itself. For ObjController subtypes (combat/movement/etc.) the recipe is the same but the file lives in `src/messages/game/obj-controller/` and registers via the subtype CRC instead of the top-level `messageRegistry`.
5. To write a scenario script — read `docs/scripting.md`, copy a factory in `src/scenarios/index.ts`, and run with `pnpm cli zone --script=<name>`.

## Don't

- Don't add `~/code/swg-main` as a TypeScript dependency. This repo READS the C++ source for spec but never builds against it.
- Don't replace `constcrc.ts`'s 256-entry table with a "cleaner" standard CRC32. It's intentionally weird; the table is the spec.
- Don't switch from `node:dgram` to a UDP wrapper library. The bare API is fine and the dependency hygiene matters.
- Don't add `_stub-*.ts` files back — those were Phase 1 development scaffolding and are gone.
- Don't commit `tests/fixtures/*.hex` with anything new without verifying it via a real tcpdump capture against the live server. Hand-crafted fixtures will silently drift from reality.
