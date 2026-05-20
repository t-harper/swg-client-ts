# CLAUDE.md — swg-ts-client

What this is, how to navigate, and the wire-format gotchas worth remembering. Quick-scan style; deep references live in `docs/`.

## What this is

A headless TypeScript SWG wire-compatible client at `~/code/swg-ts-client/`. Drives a full **login → ConnectionServer auth → character create → SelectCharacter → zone-in → scripted in-world behavior → clean logout** lifecycle against a real `swg-server`. The basic lifecycle finishes in ~5 seconds; scripted scenarios run for as long as you want (movement, surveying, sampling, crafting, chat, combat, missions, groups — all driven through real wire paths).

Originally built for CI smoke tests + wire-format regression detection, now a full programmatic SWG bot framework. Catches wire-format drift instantly: a struct-shape mismatch between the client encoding and the server's `Archive::ReadException` parser (the kind that crashes the Windows client at frame 600) fails `pnpm test` in seconds. **Not** for actually playing the game (no rendering, no audio, no animation).

The server side lives at `~/code/swg-main/`. **Read `~/code/swg-main/CLAUDE.md` first** for context on the running server, bring-up failure modes, the Oracle XE setup, etc.

## Quickstart

```bash
cd ~/code/swg-ts-client
nvm use                # Node 24 (LTS as of 2026-05)
pnpm install
pnpm test              # unit tests (~1800), no server needed
LIVE=1 pnpm test       # full suite incl. ~30 LIVE integration tests against 10.254.0.253
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
                  character-pool.ts            ← persistent check-out DB for pre-created chars
                  transcript-io.ts             ← NDJSON capture I/O
                  replay.ts                    ← capture + replay harness
                  reconnect-harness.ts         ← reconnectVerify() — mutate → logout → reconnect → diff
                  cell-graph.ts                ← BFS pathfinder over PortalLayout cell+portal graph
                  building-kb.ts               ← per-template .pob + object-template cache (Knowledge.buildings)
                  navigate.ts                  ← ctx.navigate(target, opts) — mount/walk/portal-walk/verifyCellEntry
                  script/
                    context.ts                 ← ScriptContext (movement/survey/craft/chat/trade/bazaar/sui/npc/...)
                    movement.ts                ← walkTo / walkCircle / walkToCell (mount-cap aware)
                    expectations.ts            ← expectWithin / expectAbsent / expectAfter
                  control/
                    control-server.ts          ← ControlServer — UDS listener (sessions/<name>.sock)
                    session-control.ts         ← SessionControl directives + named-action registry
                    supervisor.ts              ← runSupervised() — outer restart/reload loop
                    session-handle.ts          ← control request → live ScriptContext dispatch
                    projections.ts             ← JSON-safe projections of the live views
                    protocol.ts                ← NDJSON wire format + chunk-safe line reader
                    socket-registry.ts         ← ~/.swg-ts-client/sessions/ path + discovery
                    control-client.ts          ← controlRequest() one-shot UDS client
                src/iff/                       ← SWG IFF readers/writers (read-mostly)
                  iff.ts + iff-writer.ts       ← FORM/CHUNK traversal + emission
                  portal-layout-reader.ts      ← .pob → PortalLayout (cells + portals + door geometry)
                  object-template-reader.ts    ← .iff (server template) → BuildingTemplateInfo
                src/scenarios/                 ← bundled CLI-loadable scenarios
                                                  (walk-line, walk-circle, open-inventory,
                                                   combat-attack, posture-cycle, survey,
                                                   group-trade, ride-vehicle, bazaar-snipe, dwell)
                        ↑
                src/messages/                  ← 66+ top-level + 28+ ObjController subtypes
                  login/         (8)           ← LoginClientId, LoginEnumCluster, ...
                  connection/    (10)          ← ClientIdMsg, EnumerateCharacterId, ...
                  game/          (12)          ← CmdStartScene, LogoutMessage,
                                                  UpdateTransformMessage (broadcast),
                                                  ObjectMenuSelectMessage, ...
                  game/chat/     (6)           ← Tell, channel post, mail, room list
                  game/command-queue/ (3)      ← Enqueue + Remove + TimerData
                  game/survey/   (2)           ← SurveyMessage + ResourceListForSurveyMessage
                  game/missions/ (multi)       ← request list, accept, abort, remove
                  game/crafting/ (multi)       ← session + draft + slots + experimentation
                  game/sui/      (4)           ← SuiCreatePageMessage + Update + ForceClose + EventNotification
                  game/npc/      (5)           ← StartNpcConversation + Stop + Message + Responses + Select (all CM_npcConversation*)
                  game/trade/    (9)           ← SecureTrade handshake (BeginTrade / AddItem / RemoveItem / GiveMoney / AcceptTransaction / UnAccept / VerifyTrade / TradeComplete / AbortTrade)
                  game/commodities/ (17)       ← bazaar / auction-house (AuctionQueryHeaders + Response + Bid + Accept + Create + Cancel + Retrieve + GetAuctionDetails + IsVendorOwner)
                  game/travel/   (3)           ← EnterTicketPurchaseModeMessage + PlanetTravelPointList Request/Response
                  game/obj-controller/ (30+)   ← combat, movement (CM=113/241), teleport-ack,
                                                  posture, mood, chat, crafting, menus,
                                                  group, trade, dance, tip, npc-conversation, ...
                  base.ts + registry.ts        ← framing + CRC dispatch
                        ↑
                src/soe/                       ← UDP transport
                  connection.ts                ← SoeConnection class (one per UDP socket)
                                                  send-side auto-fragments payloads > mMaxDataBytes
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

240+ test files; counts grow as features land — `pnpm test` to confirm. Recent additions: IFF read/write (`src/iff/`), TRE archive read/write (`src/tre/`), terrain helpers + planet-general asset loader (`src/terrain/`), **offline procedural terrain generator** (`src/terrain/sim/` — ~15 k LOC TS port of the C++ `sharedTerrain` + `sharedFractal` libraries; loads any `.trn` and computes per-coord heights without a live server; 281 unit tests covering 27 planets), build-city orchestration (`scripts/build-city/`), ClockSync auto-reply + latency stats (`src/soe/clock-sync.ts`), raw SOE-layer byte capture + offline decoder (`src/soe/raw-capture-*.ts`), SuiPageData widget-tree decode (`src/messages/game/sui/sui-page-data.ts`), 4 ObjController building-permission subtypes (CM_addAllowed/removeAllowed/addBanned/removeBanned), admin `city *` console-command bindings (`scripts/build-city/admin-city.ts`), live group + chat helpers (`ctx.group` / `ctx.guild` / `ctx.chat`) with new `GroupObjectSharedNpDecoder` baseline, **`ctx.character.cityName` / `citizenType`** (PLAY p6 `m_citizenshipCity` — typed server-authoritative signal for `declareresidence` success), build-city's `placeStructure` command-queue placement path (replaces the ITEM_USE-only flow which only opened the client-side preview UI), and a **Unix-socket control plane** (`src/client/control/`) — a running bot or scripted session binds `~/.swg-ts-client/sessions/<name>.sock`; `swg-ts-cli ctl` queries live state and issues write-actions (pause/resume/say/trigger/reload/restart/stop/logout), with `reload` re-running freshly-imported scenario code against the still-connected session (see `docs/control-socket.md`).

## High-level features

The client started as just `SwgClient.fullLifecycle()` and is now a full programmatic SWG bot framework: full lifecycle orchestration (`SwgClient.fullLifecycle`), the scripting engine (`opts.script: ScenarioFn` → `ScriptContext`), multi-client load tests (`Fleet`), transcript capture + replay (`captureLifecycle` / `replay`), the reconnect-verification harness (`reconnectVerify`), and the persistent character pool (`CharacterPool`).

**See [`docs/scripting-quickref.md`](docs/scripting-quickref.md) for the full `ScriptContext` API — every always-on view (`ctx.world` / `ctx.character` / `ctx.inventory` / `ctx.datapad` / `ctx.bank` / `ctx.group` / `ctx.guild` / `ctx.location` / `ctx.combat` / `ctx.safety` / `ctx.chat` / `ctx.cooldowns` / `ctx.serverTime` / `ctx.hitTimer` / `ctx.missions` / `ctx.crafting` / `ctx.sui` / `ctx.npc` / `ctx.travel`) and every method (movement, combat, chat, crafting, survey, missions, vehicles, SUI, NPC, trade, bazaar, shuttle travel) — auto-generated from JSDoc on the `ScriptContext` interface.** [`docs/views-reference.md`](docs/views-reference.md) and [`docs/actions-reference.md`](docs/actions-reference.md) are the typed deep-dives; [`docs/scripting-cookbook.md`](docs/scripting-cookbook.md) is every bundled scenario in `src/scenarios/`.

## Seven wire-format gotchas (memorize)

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

### 6. Client→server movement is `ObjControllerMessage(CM_netUpdateTransform=113)`, NOT top-level `UpdateTransformMessage`
The top-level `UpdateTransformMessage` GameNetworkMessage is the **server-broadcast** wire form — when the server tells you "Bob just moved to (x,z)", that's what arrives. **Client→server** movement only flows through the ObjController subtype:

```
ObjControllerMessage(
  flags     = 0x23 (CLIENT_TO_AUTH_SERVER_FLAGS),
  message   = 113  (CM_netUpdateTransform),  // or 241 (CM_netUpdateTransformWithParent) when in a cell
  networkId = playerNetworkId,
  value     = 0,
  data      = MessageQueueDataTransform   // 45 bytes
)

MessageQueueDataTransform = [u32 syncStamp][i32 seq][Quat 4×f32][Vec3 3×f32][f32 speed=0][f32 lookAtYaw=0][u8 useLookAtYaw=0]
```

`speed` on the wire is **always 0**. The server derives effective speed from `position_delta / (syncStamp_delta_ms / 1000)` and validates against the creature's anti-cheat cap. Sending a non-zero speed can trip the validator for freshly-spawned characters.

**Engine-locked movement pacing**: `walkTo` / `walkCircle` / `walkToCell` / `navigate` do NOT take a `speed?` option. On foot they always run at `BASE_RUN_SPEED = 7.3` m/s (lifted from `shared_base_player.tpf`'s `speed[MT_run]`; verified against `dsrc/sku.0/sys.shared/compiled/game/object/creature/player/base/shared_base_player.tpf`). The only way to change pace is to mount something — `ctx.mount(vehicleId, { speedCap })` sets the effective speed to `speedCap` until `ctx.dismount()`. The cap is per-vehicle: 12 m/s default for a speeder bike, set higher for a swoop, lower for a creature mount. This mirrors the C++ server, where `getBaseRunSpeed()` returns the template value on foot and `m_vehiclePhysicsData->m_runSpeed` once mounted.

**Zone-in teleport-lockout**: `PlayerCreatureController::resyncMovementUpdates` inserts negative sequence ids into `m_teleportIds` during zone-in. Until the client ACKs them via `ObjControllerMessage(message=CM_teleportAck=319, data=[i32 LE seq])`, every client→server transform is rejected by `handleMove`'s `isTeleporting()` check (returns silently — no error response). The script context's `ctx.ackPendingTeleports()` handles this automatically and is called by all built-in movement primitives (`walkTo`, `walkCircle`, `walkToCell`) on first invocation. Manual code paths that build their own ObjControllerMessage transforms via `ctx.send()` MUST call `await ctx.ackPendingTeleports()` once after zone-in before their first transform.

### 7. Cell entry requires `CM_netUpdateTransformWithParent` with a real cell-local position
The server's `ServerController::handleNetUpdateTransform` (line 532 in `~/code/swg-main/.../ServerController.cpp`) for plain `CM_netUpdateTransform=113` passes `nullptr` cell — it does NOT auto-resolve the cell from world position. Only `CM_netUpdateTransformWithParent=241` (line 545) re-parents the CREO, and only if the supplied cell-local position is *inside* the cell's floor per `PortalProperty::findContainingCell`. To walk a player INTO a building, use `ctx.navigate({ buildingId, cellName })` which reads the building's `.pob` portal layout, finds the door's world position, walks the player to it, and sends a cell-local transform that lands them inside.

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
- Server's wire protocol drifted from what we encode → check `~/code/swg-main`'s submodule pin. Update the affected message struct here (find the C++ commit that added/removed fields, update `varCount` + encode/decode) or roll the server's submodule back.
- The `swg-server` cluster isn't reporting "ready for players" → check `podman logs swg-server | grep 'ready'`
- Firewall — the host's `firewalld` must have 44453/UDP, 44463/UDP open (see `~/code/swg-main/CLAUDE.md`)

Run a single live test for fast diagnosis:
```bash
LIVE=1 pnpm test tests/integration/live-login.test.ts
```

If THAT passes but `live-zone-in-and-logout.test.ts` fails, the issue is in Stage 2/3 (character creation, GameServer routing) — start by inspecting the JSON `transcript` field in `LifecycleResult`. For broader drift, capture a known-good transcript via `pnpm cli capture --output=baseline.ndjson` and `replay` it after the bump to surface the diff.

## Public API surface

`src/index.ts` exports:

**Core types & enums** — `ServerEndpoint`, `EncryptionParams`, `ClusterInfo`, `CharacterInfo`, `NetworkId` (bigint), `LoginToken`, `ClientPermissions`, `SceneStart`, `Vector3`, plus enums `EncryptMethod`, `UdpPacketType`, `ClusterStatus`, `PopulationStatus`, `CharacterType`, `ZoneState`.

**Client** — `SwgClient`, `lifecycleResultToJSON`, plus `LifecycleResult`, `FullLifecycleOptions`, `SwgClientOptions`, `TranscriptEvent`, and the per-stage `LoginStageResult` / `ConnectionStageResult` / `GameStageResult` / `BaselineSummary`.

**Scripting** — `ScenarioFn`, `ScriptContext`, `ScriptResult`, `WalkToOptions`, `CircleOptions`, `WalkToCellOptions`, `SayOptions`, `Posture`, `scenarios` (registry), `ScenarioFactory`, `ExpectOptions`.

**Survey / resources** — `SurveyMessage`, `ResourceListForSurveyMessage`, types `ResourceListItem`, `SurveyPoint`. Driven via `ctx.fetchSurveyResources`, `ctx.survey`, `ctx.waitForSurvey`, `ctx.fetchResourceAttributes`.

**Radial menu** — `ObjectMenuSelectMessage`, `RadialMenuTypes` (stable enum: `ITEM_USE=21`, `EXAMINE=7`, `ITEM_OPEN=17`, etc.).

**Missions** — top-level message classes + `CM_mission*` subtype decoders (request list, accept, abort, remove).

**Crafting** — full session helpers and the seven crafting subtype decoders (start, draft schematics, select, slot assign/empty, experiment, result, finish).

**Container baselines** — `buildContainerIndex` (walk inventory trees from a transcript), `ContainerItem`.

**Fleet** — `Fleet`, `FleetClientConfig`, `FleetOptions`, `FleetRunOptions`, `FleetOutcome`, `FleetResult`, `FleetSummary`, `FleetMessageCount`.

**Character pool** — `CharacterPool`, `PooledCharacter`, `PoolOptions`, `CheckoutOptions`, `CheckoutResult`, `CheckoutManyResult`.

**Capture + replay** — `captureLifecycle`, `replay`, `replayScenario`, `attachCapture`, `transcriptToNdjson`, `transcriptFromNdjson`, `readTranscript`, `writeTranscript`, `eventsFromTranscript`, plus `CapturedEvent`, `CaptureLifecycleOptions`, `CaptureLifecycleResult`, `ReplayOptions`, `ReplayResult`, `ReplayScenarioOptions`, `ReplayScriptContext`.

**Control socket** — `ControlServer`, `runSupervised`, `createSessionControl`, `controlRequest`, `CONTROL_PROTOCOL_VERSION`, plus types `ControlServerOptions`, `RunSupervisedOptions`, `RunSupervisedResult`, `SessionControl`, `SessionDirective`, `SessionActionFn`, `ControlRequest`, `ControlResponse`, `ControlRequestSpec`, `ControlQueryName`, `ControlActionName`, `ControlErrorCode`. The Unix-domain-socket control plane that backs `swg-ts-cli ctl` — see `docs/control-socket.md`.

**Chat** — `ChatInstantMessageToCharacter`, `ChatInstantMessageToClient`, `ChatRequestRoomList`, `ChatRoomList`, `ChatSendToRoom`, `ChatPersistentMessageToServer`, plus `chatAvatarId` factory, `ChatRoomType`, `PERSISTENT_MESSAGE_MAX_SIZE`, and types `ChatAvatarId`, `ChatRoomData`. `ObjController` subtype decoders for spatial chat receive.

**Building portals** — `loadPortalLayout` + `parsePortalLayout` (read a `.pob` file into a `PortalLayout` struct: cells, portals, door geometries), plus the related types `PortalLayout` / `Cell` / `CellPortal` / `PortalGeometry` / `DoorTransform`. `findCellPath(layout, fromIndex, toIndex)` runs a BFS over the cell+portal graph and returns the `CellPathHop[]` the navigate planner emits one `walkThroughPortal` step per. The building-template extractor (`loadBuildingTemplateInfo` -> `BuildingTemplateInfo`, including `portalLayoutFilename`) maps a server-template `.iff` path to its `.pob`. Process-wide cache lives at `Knowledge.buildings` (`knowledge.buildings.templateInfoFor` + `portalLayoutFor`) so a fleet of 30 clients entering the same cantina parses each file exactly once. End-user surface: `ctx.navigate({ buildingId, cellName })` reads all of the above automatically and falls back to today's outdoor-anchor walk when any lookup fails.

Individual stage drivers and the `dispatcher` are also exported as types — use them if you want to do something more granular than `fullLifecycle()` (e.g. login but skip zone-in).

## File map for quick navigation

| Need to... | Look at |
|---|---|
| Add a new message | `docs/adding-a-message.md` + any file in `src/messages/login/` as template |
| Add a new ObjController subtype | `docs/adding-a-message.md` → "ObjController subtypes" section |
| Write a scenario script | `docs/scripting-quickref.md` (start here) → `docs/views-reference.md` / `docs/actions-reference.md` (full API) + `src/scenarios/index.ts` as template; `docs/scripting-cookbook.md` enumerates bundled scenarios |
| Understand wire bytes | `docs/wire-spec.md` (distilled spec) |
| Trace the 4-stage lifecycle | `docs/lifecycle.md` (state diagram + per-stage tables + script hook) |
| Survey resources at a location | `scripts/check-resources-at-location.ts` (full radial → list → per-type survey → stats flow) |
| Harvest resources via sampling | `ctx.sample(toolId, resourceTypeName)` + `ctx.waitForSampleEvent` loop; cancel with `ctx.cancelSampling()`. New units stack into matching inventory container automatically. |
| Craft a tool / item end-to-end | `scripts/craft-a-tool.ts` (open session → list schematics → pick recipe → assign slots → finishCrafting) |
| Fetch resource stats without sampling | `ctx.fetchResourceAttributes([ids])` (uses `getAttributesBatch`, chunked at 25 ids/call) |
| Implement movement in a custom script | `ctx.walkTo` / `walkCircle` / `walkToCell` auto-handle teleport-ack; for raw `ctx.send(...)` of transforms call `await ctx.ackPendingTeleports()` once first |
| Walk player into a building | `ctx.navigate({ buildingId, cellName })` (auto-handles multi-cell paths via `src/client/cell-graph.ts` + `src/iff/portal-layout-reader.ts`). `cellName: ''` picks the first public cell; `cellName: 'cell5'` matches by `cellNumber`; any other string matches the SHARED_NP `cellLabel`. Falls back to the legacy outdoor-anchor walk when the `.pob` / cell-path lookups fail. Example: `tests/integration/live-cantina-entry.test.ts`. |
| Run N clients in parallel (load test) | `src/client/fleet.ts` — `Fleet.run([cfgs], opts)`; CLI `swarm` |
| Capture a wire transcript / replay it | `src/client/replay.ts` — `captureLifecycle()` / `replay()`; CLI `capture` / `replay` |
| Query / steer a running bot or session | `swg-ts-cli ctl <list\|status\|get\|pause\|resume\|reload\|restart\|say\|trigger\|stop\|logout> [--session=<name>]` over the session's Unix socket. Library at `src/client/control/`; bind one on any session with `--control-socket=<name>` (`zone`) or `controlSocket` (`fullLifecycle`). Deep-dive: `docs/control-socket.md`. |
| Debug a live test failure | `src/client/swg-client.ts` — `transcript` field captures every send/recv |
| Add a new live test | `tests/integration/live-*.test.ts` as template (LIVE=1 gated) |
| Find a working example for X | `scripts/examples/` — 11 grandiose end-to-end scenarios (`hunter-crafter`, `surveyor-bazaar`, `mission-marathon`, `bazaar-arbitrage-fleet`, `group-hunt-expedition`, `cantina-troupe`, `resource-cartographer-fleet`, `city-recon-surveyor`, `reactive-bodyguard-fleet`, `shuttle-traveler`, `cross-planet-pilgrim`). All chain 2+ subsystems and emit JSON summaries. Helpers in `_lib.ts`. |
| Travel between planets (shuttle / ticket) | `ctx.travel.findTicketVendor` / `buyTicket` / `useTicket` / `listDestinations` (see `src/client/script/travel.ts`). Wire flow: ObjectMenuSelect(terminal, ITEM_USE=21) → EnterTicketPurchaseModeMessage → N PlanetTravelPointListRequest/Response → `purchaseTicket` command → `boardShuttle` on collector → server fires fresh `CmdStartScene`. Example: `scripts/examples/shuttle-traveler.ts`. |
| Reuse a character across CI runs | Set `CI_REUSE_ACCOUNT` + `CI_REUSE_CHARACTER` (`tests/integration/helpers.ts`) |
| Use a check-out pool (multi-account tests) | `swg-ts-cli pool stock --count=N` once → set `CI_USE_POOL=1` → tests call `poolCredentials(prefix, count)`. See `src/client/character-pool.ts`. |
| Inspect captured wire | `tests/fixtures/{session-response-17b,login-enum-cluster-223b}.hex` |
| Wire decryption sanity check | `src/soe/connection.test.ts` — feeds captured bytes through full pipeline |
| Verify a constcrc value | `src/crc/constcrc.test.ts` — golden values from the C++ table |
| Read/write SWG IFF files | `src/iff/` — `Iff.fromFile(path)` to navigate; `IffWriter` to build. See `assets/README.md` for asset staging. |
| Read/write SWG `.tre` archives | `src/tre/` — `TreReader.fromFile(path).read('terrain/naboo.trn')`; `TreWriter` to build a fresh archive. |
| Sample terrain / find buildable spots | `src/terrain/` — `loadPlanetTrn('naboo')` reads metadata; `probeBuildable(ctx, inv, x, z)` checks coords via the live server; `findFlatPatch(ctx, inv, {count, centerX, centerZ, maxRadius})` does a grid search. |
| Compute terrain heights OFFLINE (no server) | `src/terrain/sim/` — `loadPlanetTrnTemplate('naboo')` → `ProceduralTerrainAppearance` → `getHeight(x, z)`. Bit-exact port of the C++ procedural generator (Perlin MultiFractal + layer graph + height affectors); chunk cache + bilinear interpolation. 27 planets supported. |
| Find a flat 750×750 m patch on a planet offline | `pnpm tsx bin/find-flat-land.ts --planet=naboo [--window=750] [--grid=100] [--top=10]` — coarse heightmap scan + sliding-window range filter + NPC-city exclusion; emits JSON + `/planetwarp` commands for the top candidates. |
| Build a player city autonomously (Naboo or any other planet) | `scripts/build-city/orchestrator.ts` + `bin/build-city.ts` — Fleet-coordinated 30-character build. See README "Asset setup" section for the `.trn` requirement. |
| Wipe leftover player structures around coords (admin destroy) | `pnpm tsx bin/cleanup-city.ts --planet=naboo --x=2800 --z=-2800` — admin-warps in, scans WorldModel for BUIOs within radius, `object destroy <oid>` each non-cityhall. Used to clear ground for fresh build-city runs after auto-decay leaves orphan houses. |
| Read live survey/crafting/mission state from a script | `ctx.survey.lastResults` / `ctx.survey.bestKnown(name)` / `ctx.crafting.session` / `ctx.missions.active`. Caches at `src/client/{survey-cache,crafting-session,missions-cache}.ts` — auto-attached by `createScriptContext`, detached at `runScript` teardown. |

## Known limitations

- Some server-internal CRCs (e.g. `0x0e20d7e9 = DescribeConnection`, `0x58c07f21 = SystemAssignedProcessId`, plus various baseline/template hashes) arrive but aren't modeled — logged as `unknownCrc` in transcript; harmless.
- Live integration tests leak timestamp-suffixed characters in the DB unless `CI_REUSE_ACCOUNT` + `CI_REUSE_CHARACTER` are set, or `CI_USE_POOL=1` leases from a pre-stocked character pool (see `tests/integration/helpers.ts`). In reuse mode, file parallelism is forced off (`vitest.config.ts`) because the server allows one session per account.
- `ObjControllerMessage` subtype decoding covers 32+ subtypes (combat, movement, posture, mood, chat, crafting, missions, groups, trade, menus, dance, tip, NPC conversation, mount/dismount, building permissions add/remove allowed/banned 403-406, etc.). Anything not registered flows as opaque bytes with a diagnostic `subtypeCrcHex`. Add more in `src/messages/game/obj-controller/`.
- **Spatial chat** is fully wire-modeled. `ctx.say(text, opts?)` wraps the server's `spatialChatInternal` CommandQueue command — the same path the real Windows client uses. The direct `CM_spatialChatSend(243)` ObjController subtype is NOT a viable client→server path: the server's `ControllerMessageFactory::allowFromClient` registry has it set to `false` (MessageQueueSpatialChat.cpp:26), so anything sent via that subtype is logged as a HackAttempts entry and dropped (Client.cpp:972). Inbound broadcasts arrive as `ObjControllerMessage` with `message=CM_spatialChatReceive(244)`, decoded via `SpatialChatReceiveDecoder`. `tests/integration/live-spatial-chat.test.ts` exercises the round-trip end-to-end.
- **Survey tools spawned via admin `/object createIn` work** (they have the right `VAR_SURVEY_CLASS` objvar). Fresh characters created via `domestics_trader` profession (or any non-NGE legacy profession) do NOT come with tools — the NPE roadmap reward table grants tools as the player completes phase-1 novice tasks, not at character creation. For scripted tests use a character that already has tools (admin-spawned or pre-NPE).
- AckAll uses raw 16-bit wire seq rather than reconstructed 64-bit ID. Fine until we accumulate > 65k outstanding reliables (never happens).
- ClockSync (opcode 7) is auto-replied as ClockReflect (opcode 8) on every recv; RTT samples accumulate in `SoeConnection.getLatencyStats()` and `LifecycleResult.latency`. Client also initiates a ClockSync every 45s by default (configurable via `SoeConnectionOptions.clockSyncIntervalMs`, set to 0 to disable).
- Replay compares `recv` shape, not bytes. Live servers emit non-deterministic neighbor updates between runs, so strict order-equality (`--compare=names`) often surfaces "missing"/"unexpected" diffs even on a clean replay. Use `--compare=count` (multiset) for a more permissive check.
- Only `swg`–`swg5` accounts can create characters (admin allowlist at `dsrc/.../datatables/admin/stella_admin.tab`). Other accounts will see `canCreateRegularCharacter=false` and `ClientCreateCharacterFailed`. Fleet tests using arbitrary `--user-prefix` accounts therefore need the character pool or pre-existing characters.
- **Crafting + sampling stale-state**: server-side `m_craftingStage` and `surveying.takingSamples` persist on the player/tool across disconnects. If a previous session ended mid-flow, the next `requestCraftingSession` / `requestcoresample` succeeds but the follow-up step (`selectDraftSchematic` → `requestDraftSlots`, or sample-loop tick) silently fails until a fresh tool is used or the cluster is restarted. `craft-a-tool.ts` tries multiple tools as a workaround; ultimately a `podman restart swg-server` is the most reliable reset.
- **SUI page widget tree is decoded** as of release/0.1. `SuiCreatePageMessage.pageData` / `SuiUpdatePageMessage.pageData` are typed `SuiPageData` (`{ pageId, pageName, commands: SuiCommand[], associatedObjectId, associatedLocation, maxRangeFromObject }`). All 9 `SuiCommand` variants from `SuiCommand::Type` are implemented (`createWidget`/`setProperty`/`subscribeToEvent`/`addDataItem`/etc.); unknown command types wrap as `{ type: 'unknown', commandType, parametersWide, parametersNarrow }` for forward-compat. Raw bytes still available via `msg.pageDataBytes`. See `src/messages/game/sui/sui-page-data.ts`.
- **NGE profession picker maps to a legacy wire string + skillTemplate**: the Windows client's "Domestics Trader" picker sends `profession="social_entertainer"` + `skillTemplate="trader_0a"` + `workingSkill="class_domestics_phase1_novice"` on the wire. Only 7 legacy profession strings (`crafting_artisan`/`combat_brawler`/`social_entertainer`/`combat_marksman`/`science_medic`/`outdoors_scout`/`jedi`) are accepted by `PlayerCreationManager`. NGE class items come from the NPE roadmap (driven by skillTemplate), not from character creation. `connection-stage.ts` `ClientCreateCharacterOptions` accepts both `profession` and `skillTemplate`/`workingSkill`.

## When you next sit down

1. `cd ~/code/swg-ts-client && nvm use && pnpm test` — confirm baseline (`pnpm test` for unit-only; `LIVE=1 pnpm test` for the full suite incl. integration tests).
2. If anything's red, check `git log --oneline` — most recent change is probably the culprit; revert it locally and retry.
3. If you bumped `~/code/swg-main` submodules, the wire-format may have drifted. Run `LIVE=1 pnpm test tests/integration/live-login.test.ts` — if it fails with a `LoginIncorrectClientId` or `Archive::ReadException`-style error, the message struct shape changed server-side. Find the C++ commit that added/removed fields, update `varCount` + encode/decode here. For broader drift, replay a baseline NDJSON capture (`pnpm cli capture` once on green, then `pnpm cli replay --compare=count` after the bump).
4. To do "more SWG protocol work" — read `docs/adding-a-message.md` and pick a message from `~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/`. The mechanical pattern handles itself. For ObjController subtypes (combat/movement/etc.) the recipe is the same but the file lives in `src/messages/game/obj-controller/` and registers via the subtype CRC instead of the top-level `messageRegistry`.
5. To write a scenario script — start at `docs/scripting-quickref.md`, browse `docs/views-reference.md` / `docs/actions-reference.md` for the full `ScriptContext` API, copy a factory in `src/scenarios/index.ts`, and run with `pnpm cli zone --script=<name>`. For one-off in-world bots, look at `scripts/examples/` for 11 working end-to-end demos (combat+craft, survey+bazaar, mount+hunt+trade, shuttle, etc.).
6. To survey resources at a location — `pnpm tsx scripts/check-resources-at-location.ts --host=... --user=... --character=... --x=... --z=...` does the full radial-Use → ResourceListForSurveyMessage → per-type survey → resource-stats fetch loop end-to-end.

## Don't

- Don't add `~/code/swg-main` as a TypeScript dependency. This repo READS the C++ source for spec but never builds against it.
- Don't replace `constcrc.ts`'s 256-entry table with a "cleaner" standard CRC32. It's intentionally weird; the table is the spec.
- Don't switch from `node:dgram` to a UDP wrapper library. The bare API is fine and the dependency hygiene matters.
- Don't add `_stub-*.ts` files back — those were Phase 1 development scaffolding and are gone.
- Don't commit `tests/fixtures/*.hex` with anything new without verifying it via a real tcpdump capture against the live server. Hand-crafted fixtures will silently drift from reality.
