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
pnpm test              # ~1734 unit tests — no server needed
LIVE=1 pnpm test       # ~1761 total under LIVE (includes ~27 integration tests against 10.254.0.253)
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
                  script/
                    context.ts                 ← ScriptContext (movement/survey/craft/chat/trade/bazaar/sui/npc/...)
                    movement.ts                ← walkTo / walkCircle / walkToCell (mount-cap aware)
                    expectations.ts            ← expectWithin / expectAbsent / expectAfter
                src/scenarios/                 ← bundled CLI-loadable scenarios
                                                  (walk-line, walk-circle, open-inventory,
                                                   combat-attack, posture-cycle, survey,
                                                   group-trade, ride-vehicle, bazaar-snipe, dwell)
                        ↑
                src/messages/                  ← 63+ top-level + 28+ ObjController subtypes
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

240+ test files; counts grow as features land — `pnpm test` to confirm. Recent additions: IFF read/write (`src/iff/`), TRE archive read/write (`src/tre/`), terrain helpers + planet-general asset loader (`src/terrain/`), build-city orchestration (`scripts/build-city/`), ClockSync auto-reply + latency stats (`src/soe/clock-sync.ts`), raw SOE-layer byte capture + offline decoder (`src/soe/raw-capture-*.ts`), SuiPageData widget-tree decode (`src/messages/game/sui/sui-page-data.ts`), 4 ObjController building-permission subtypes (CM_addAllowed/removeAllowed/addBanned/removeBanned), admin `city *` console-command bindings (`scripts/build-city/admin-city.ts`).

## High-level features

The client started as just `SwgClient.fullLifecycle()` and is now a full programmatic SWG bot framework:

| Feature | Where | What |
|---|---|---|
| **Full lifecycle** | `SwgClient.fullLifecycle(opts)` | Login → connect → select → zone-in → dwell → logout in ~5s |
| **Scripting engine** | `opts.script: ScenarioFn` | Async function gets a `ScriptContext` during the dwell. See `docs/scripting.md`. |
| **Always-on inventory** | `ctx.inventory.items` / `findByTemplate(re)` / `findById(id)` / `ready` / `containerId` | Auto-opened at zone-in via `ClientOpenContainerMessage(playerId, 'inventory')`. Items derived live from WorldModel — no manual openContainer or transcript walking. 3-tier discovery (template-name → SHARED-baseline `nameStringId={item_n, inventory}` → player-child heuristic) because the live server pushes containers via ByCrc, not ByName. |
| **Always-on datapad** | `ctx.datapad.items` / `vehicles()` / `pets()` / `waypoints()` / `missions()` / `findByTemplate(re)` | Auto-opened at zone-in via `ClientOpenContainerMessage(playerId, 'datapad')`. Items classified by templateName into vehicle-pcd / pet-pcd / waypoint / mission / ship / manufacturing-schematic / other. Used by `rideVehicleScenario` for zero-config PCD lookup. |
| **Always-on character sheet** | `ctx.character.health` / `.cashBalance` / `.bankBalance` / `.skills` / `.posture` / `.level` / `.skillTitle` / `.playedTime` / `.position` / `.group` etc. | Live view of player CREO + PLAY baselines, kept current by the dispatcher loop. Subscribes to `BaselinesMessage` / `DeltasMessage` / `ObjControllerMessage(CM_setPosture=305)`. `ready` flips true after first CREO baseline. Detached automatically at logout. |
| **Movement (working)** | `ctx.walkTo` / `walkCircle` / `walkToCell` | Real `ObjControllerMessage(CM_netUpdateTransform=113)` wire path with auto teleport-ack bootstrap. Float positions, server-validated speed. Character actually moves in-game. |
| **Survey flow** | `ctx.fetchSurveyResources(toolId)` → `ctx.survey(toolId, name)` → `ctx.waitForSurvey()` | Two-step radial-menu Use → ResourceListForSurveyMessage → per-type requestsurvey → SurveyMessage. Returns 9 sample points per type. |
| **Sampling / harvest** | `ctx.sample(toolId, name)` / `ctx.waitForSampleEvent()` / `ctx.cancelSampling()` | `requestcoresample` wire path with sample-loop event classification (`located`, `failed`, `cancel`, `in_progress`, `mind`, `density`, `trace`, `start`). Units stack into existing same-type inventory containers. |
| **Resource stats** | `ctx.fetchResourceAttributes([ids])` | Batched `getAttributesBatch` → AttributeListMessage per id, chunked at 25 ids/call to stay under wire ceiling. Full OQ/CR/DR/HR/SR/UT/ER/PE/MA/CD stats for any ResourceTypeObject; no physical core-sampling needed. |
| **Crafting session** | `ctx.beginCrafting` → `ctx.waitForDraftSchematics` → `selectCraftingSchematic` → `ctx.waitForDraftSlots` → `assignCraftingSlot` × N → optional `craftExperiment` → `finishCrafting` | Full discovery-driven flow with decoded `DraftSchematicsMessage` (server's schematic list) and `ManufactureSchematicMessage` (slot requirements). End-to-end demo in `scripts/craft-a-tool.ts`. |
| **Missions** | `ctx.requestMissionList` / `acceptMission` / `removeMission` / `abortMission` | Driven through `MissionObject` baselines + the four `CM_mission*` subtypes |
| **Group + trade** | `ctx.useAbility('invite'|'join'|...)` + `ctx.tradeWith(otherId, { items?, credits? })` | Two-client coordination via Fleet — full SecureTrade handshake (9 top-level messages: BeginTrade / AddItem / RemoveItem / GiveMoney / AcceptTransaction / UnAcceptTransaction / VerifyTrade / TradeComplete / AbortTrade) wraps the `CM_secureTrade` ObjController. See `scripts/group-trade-demo.ts`. |
| **Commodities / bazaar** | `ctx.browseBazaar` / `getAuctionDetails` / `bidOn` / `listForSale` / `retrieveBazaarItem` / `cancelMyListing` | Full `Auction*` / `Bid*` top-level message family — palettized headers response decoder, advanced-search conditions, and `bazaar-snipe` bundled scenario. |
| **Chat** | `ctx.say` / `tell` / `sendMail` / `sendToChannel` / `requestChannelList` | `say` uses the server-side `spatialChatInternal` CommandQueue command (the path the real Windows client uses) |
| **Combat / posture / dance** | `attackTarget` / `useAbility` / `changePosture` / `startDance` | Posture cycling, dance/perform, combat queueing |
| **SUI dialogs** | `ctx.waitForSui()` / `ctx.respondToSui(pageId, eventType, returnList?)` | Receive server-pushed SUI pages (`SuiCreatePageMessage` / `SuiUpdatePageMessage` / `SuiForceClosePage`) and reply with `SuiEventNotification`. **Page widget tree is now decoded** (`SuiPageData` with 9 typed `SuiCommand` variants — see `src/messages/game/sui/sui-page-data.ts`). Raw bytes still available via `msg.pageDataBytes`. |
| **NPC conversation** | `ctx.talkTo(npcId)` / `ctx.waitForNpcDialog()` / `ctx.selectDialog(n)` / `ctx.endConversation()` | Start/respond/stop handshake via command-queue. `waitForNpcDialog` pairs the server's `CM_npcConversationMessage(223)` prompt with its `CM_npcConversationResponses(224)` option menu. |
| **Bundled scenarios** | `src/scenarios/` + CLI `--script=<name>` | `walk-line`, `walk-circle`, `open-inventory`, `combat-attack`, `posture-cycle`, `survey`, `group-trade`, `bazaar-snipe`, `ride-vehicle`, `dwell` |
| **Example scripts** | `scripts/examples/` | ~25 ready-to-run scripts: walking patterns, surveying loops, chat/mail bots, parade/dance, crafting soak, gradient-ascent surveys, etc. |
| **Fleet (multi-client)** | `Fleet.run([cfgs], opts)` + CLI `swarm` | N independent clients in parallel with staggered launches + concurrency caps + per-message-name summary |
| **Capture + replay** | `captureLifecycle()` / `replay()` + CLI `capture`/`replay` | Record a session as NDJSON; replay it to detect server-side wire-format drift |
| **Reconnect harness** | `reconnectVerify({ mutate, observe?, expectedDrift? })` | Two-pass lifecycle + `snapshot()`/`diffSnapshots()` round-trip — mutate state, log out, reconnect, assert the server preserved everything modulo known-ephemeral fields. See `docs/scripting.md` § Reconnect verification. |
| **Expectations** | `ctx.expectWithin` / `expectAbsent` / `expectAfter` | Async assertions tied to inbound messages — soft (record failure) or hard (throw) |
| **ObjController subtype decoder** | `src/messages/game/obj-controller/` | 30+ subtypes decoded: combat, movement (`CM_netUpdateTransform=113`/`241`, `CM_teleportAck=319`), posture, mood, chat, crafting, menus, missions, groups, trade, dance, tip, building permissions (`CM_addAllowed=403` / `CM_removeAllowed=404` / `CM_addBanned=405` / `CM_removeBanned=406`). |
| **Character pool** | `CharacterPool` + CLI `pool` + `poolCredentials()` in `tests/integration/helpers.ts` | Persistent check-out DB (JSON-backed, lockfile-coordinated). Pre-stock once via `pool stock`; tests `CI_USE_POOL=1` lease instead of leaking new chars. |
| **Vehicle / Mount / Pet** | `ctx.callVehicle` / `mount` / `dismount` / `storeVehicle` / `callPet` / `storePet` / `petCommand` + bundled `ride-vehicle` scenario | Mount/dismount ride on `useAbility('mount'|'dismount', ...)` (CommandQueue path). Call/store/pet-commands use radial `ObjectMenuSelectMessage(controlDeviceId, PET_CALL=45/PET_STORE=60/PET_FOLLOW=225/PET_STAY=226/PET_ATTACK=229/PET_GUARD=227/PET_PATROL=230)` — same as the real Windows client. `mount()` sets `state.mountedSpeedCap` (default 12 m/s, speeder-bike class) that the movement primitives clamp `speed` against to avoid tripping the server's anti-cheat. Server→server CM_emergencyDismountForRider=540 / CM_detachRiderForMount=541 / CM_detachAllRidersForMount=1205 are modeled as decoders for transcript inspection. |
| **Building + Cell baselines (interior nav)** | `BuildingObjectSharedNpDecoder` / `CellObjectSharedNpDecoder` (variant 6) + `buildBuildingCellIndex(transcript)` helper in `baseline-helpers.ts` | Closes the cell-containment gap: scan a transcript and get `{ buildings: Map<oid, {name?, cells: oid[]}>, cells: Map<oid, {buildingId, cellNumber, cellName?, isPublic?}> }`. Prerequisite for cell-aware navigation scripts; build-city Phase 3's house-entry logic. |
| **DeltasMessage decoding (full coverage)** | `DeltasMessage` + `deltaRegistry` + `tryDecodeDelta` + 19 per-package decoders under `src/messages/game/baselines/*-delta-*.ts` | Post-baseline incremental updates. Envelope mirrors `BaselinesMessage` (target/typeId/packageId/packageBytes); a registered `(typeId, packageId)` decoder produces `decodedDelta: { kind, data: Partial<BaselineType> }` carrying just the changed fields — typed via the same baseline interfaces. **All 19 baseline packages have matching delta decoders** (TANO p1/3/4/6, CREO p1/3/6/8/9, PLAY p1/3/4/6, BUIO p3/6, SCLT p3/6, MISO p3, RCNO p3). AutoDelta* container fields decoded via `auto-delta-delta-codecs.ts` (`readAutoDeltaVectorDelta` / `readAutoDeltaSetDelta` / `readAutoDeltaMapDelta` — return discriminated command unions like `{kind: 'insert', value}` / `{kind: 'erase', index}` / `{kind: 'clear'}`). The WorldModel automatically merges primitive-field deltas into the absorbed baseline state via `Object.assign`; container-field deltas surface as command arrays on the baseline-shaped slot (consumers re-apply them however they want — full container-state replay isn't built-in). |
| **WorldModel — live in-memory world view** | `WorldModel` class at `src/client/world-model.ts`; exposed on `LifecycleResult.world` and `ctx.world` | Each `SwgClient` builds and maintains a `Map<NetworkId, WorldObject>` that absorbs the baseline flood and stays current via deltas, transforms (world + cell), containment changes, and SceneDestroyObject. Query API: `world.get(id)`, `world.has(id)`, `world.byType(ObjectTypeTags.CREO)`, `world.nearby(20)` (defaults to player position), `world.filter(pred)`, `world.toArray()`. Event API: `world.on(e => ...)` for `'create' \| 'baseline' \| 'delta' \| 'transform' \| 'containment' \| 'destroy'`. WorldObject carries `position`, `yaw`, `parentCell`, `cellPosition`, `containerId`, `slotArrangement`, plus `baselines: Map<packageId, T>` sparse-updated by deltas via `Object.assign`. Player ID is pinned automatically when `CmdStartScene` arrives. `WorldModel.toSnapshot({ includeBaselineData? })` returns a JSON-safe `WorldSnapshot` (NetworkId→string, Uint8Array→hex, Maps preserved) so capture/replay can serialize world state. Detached at logout — snapshot stays queryable, no further mutation. |
| **`ctx.world` sugar for common queries** | `ctx.findNearest(typeId, opts?)` / `ctx.nearestHostile(opts?)` / `ctx.findInContainer(containerId)` / `ctx.playersInRange(radiusM)` | Convenience wrappers over `ctx.world.*` for the patterns scripts kept open-coding. `findNearest` returns the closest object of `typeId` (defaults to excluding self, accepts `maxRadiusM`); `nearestHostile` looks for CREOs with `inCombat=true` from their SHARED_NP baseline (auto-targeting for combat scripts); `findInContainer` returns every object whose `containerId` matches (mid-script accuracy — no transcript scan); `playersInRange` returns sorted PLAY objects within radius, excluding self. All four bottomed on the WorldModel — same correctness guarantees. |
| **Modernized scenarios + new world-aware examples** | `src/scenarios/index.ts` (combat-attack, ride-vehicle, bazaar-snipe, group-trade) + `scripts/examples/` (target-acquisition, endless-combat, combat-then-flee, bank-tourist, container-spelunker, welcome-greeter, town-crier, **loot-on-death**, **flee-on-aggro**, **mirror-bot**, **spawn-detector**, **crowd-density**) + `scripts/group-trade-demo.ts` | All four bundled scenarios accept their `NetworkId` args as optional now; when omitted they auto-resolve via the sugar API (combat picks `nearestHostile`, ride-vehicle scans the datapad for vehicle PCDs, bazaar-snipe finds the nearest commodities terminal, group-trade finds the other player). Seven existing examples got the same treatment (back-compat preserved when the id is supplied explicitly). Five new examples showcase reactive WorldModel patterns: `loot-on-death` queues + walks to CREO destroy events; `flee-on-aggro` watches CREO p6 deltas for `intendedTarget === self` and sprints away; `mirror-bot` follows a target's transforms in real time with min-delta + follow-offset; `spawn-detector` emits NDJSON for every world create/destroy; `crowd-density` periodic population snapshots. |
| **City admin commands** | `scripts/build-city/admin-city.ts` — `adminCityInfo` / `adminCityListCitizens` / `adminCityListStructures` / `adminCityGetCityAtLocation` | Wrappers over `city showCityDetails` / `city listByPlanet` from `ConsoleCommandParserCity.cpp`. Used by build-city Phase 6 for deterministic verify (citizen + structure counts via server query, not heuristic transcript scan). |
| **Building permissions** | `scripts/build-city/admin-permissions.ts` — `adminStructurePermissionAdd` / `Remove` / `List` + 4 obj-controller subtype decoders | Drives the `permissionListModify` command-queue command idempotently (queries the list first, only toggles if needed). Server→server CM_addAllowed/removeAllowed/addBanned/removeBanned (403-406) modeled as decoders. Build-city Phase 3 grants paired guildExtras ENTRY+ADMIN on each resident's house. |
| **StructureRecord tracking** | `placeDeed()` returns `{ deedOid, structureOid, structureTemplate, ... }`; orchestrator persists per owner to `state.structures` | After successful placement, scans incoming `SceneCreateObjectByName` for the deed→structure template match (`*_deed.iff` → `*.iff` under `object/{building,installation,tangible}/`) and captures the new structure's NetworkId. State persisted via `onStructurePlaced` callback wired into each Phase 2/3/4/5 scenario. |
| **ClockSync / latency stats** | Auto-reply to opcode-7 ClockSync; RTT samples from opcode-8 ClockReflect | `SoeConnection.getLatencyStats()` returns `{ samples, count, min, mean, p50, p95, p99, max }`. `LifecycleResult.latency` carries the connection-stage socket's stats. Periodic client-initiated ClockSync every 45s (configurable via `clockSyncIntervalMs`; set to 0 to disable). Plus `SoeConnection.addClockReflectListener(cb)` for multi-subscriber per-sample observation (RTT + the server's reflected `serverSyncStampLong`). |
| **Cooldown tracker** | `ctx.cooldowns.msUntil(name)` / `isReady(name)` / `all()` — `src/client/timing.ts` | Live per-command-name cooldown view derived from `ObjControllerMessage(CM_commandTimer=762)`. Hash→name map populated automatically by `ctx.useAbility` calls so by-name lookups work without extra registration. Decays against `Date.now()` on every read — no internal timer. |
| **Server-time tracker** | `ctx.serverTime.ms()` / `seconds()` / `samples` — `src/client/timing.ts` | Best-estimate of the current server wall-clock. Seeded from `CmdStartScene.serverEpoch` (Unix epoch seconds; NOT `serverTimeSeconds`, which is server uptime). Refined by every ClockReflect sample via an EMA-smoothed offset. Useful for comparing mission-expiry / bazaar-window timestamps without sending another wire request. |
| **Combat timer** | `ctx.combat.timeSinceLastHitMs` / `engaged` / `lastHit()` — `src/client/timing.ts` | Tracks the most-recent `ObjControllerMessage(CM_combatAction=204)` where the player is in the `defenders[]` list. Returns `POSITIVE_INFINITY` if never hit; `engaged` is true within 10s of the last hit (window configurable via direct `createCombatTimer({engagementWindowMs})` constructor). |
| **Raw SOE byte capture + offline decode** | `FullLifecycleOptions.rawCapture: { basePath }` writes one NDJSON per stage; `pnpm cli decode-raw --input=<file>` replays through the SOE pipeline offline | For wire-drift debugging when the GameNetworkMessage transcript doesn't show the issue. Captures pre-decrypt datagrams + the session-negotiated `encryptCode`/`encryptMethods`/`crcBytes` so the offline decoder can reconstruct everything. |

## Six wire-format gotchas (memorize)

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

**Zone-in teleport-lockout**: `PlayerCreatureController::resyncMovementUpdates` inserts negative sequence ids into `m_teleportIds` during zone-in. Until the client ACKs them via `ObjControllerMessage(message=CM_teleportAck=319, data=[i32 LE seq])`, every client→server transform is rejected by `handleMove`'s `isTeleporting()` check (returns silently — no error response). The script context's `ctx.ackPendingTeleports()` handles this automatically and is called by all built-in movement primitives (`walkTo`, `walkCircle`, `walkToCell`) on first invocation. Manual code paths that build their own ObjControllerMessage transforms via `ctx.send()` MUST call `await ctx.ackPendingTeleports()` once after zone-in before their first transform.

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

**Chat** — `ChatInstantMessageToCharacter`, `ChatInstantMessageToClient`, `ChatRequestRoomList`, `ChatRoomList`, `ChatSendToRoom`, `ChatPersistentMessageToServer`, plus `chatAvatarId` factory, `ChatRoomType`, `PERSISTENT_MESSAGE_MAX_SIZE`, and types `ChatAvatarId`, `ChatRoomData`. `ObjController` subtype decoders for spatial chat receive.

Individual stage drivers and the `dispatcher` are also exported as types — use them if you want to do something more granular than `fullLifecycle()` (e.g. login but skip zone-in).

## File map for quick navigation

| Need to... | Look at |
|---|---|
| Add a new message | `docs/adding-a-message.md` + any file in `src/messages/login/` as template |
| Add a new ObjController subtype | `docs/adding-a-message.md` → "ObjController subtypes" section |
| Write a scenario script | `docs/scripting.md` + `src/scenarios/index.ts` as template |
| Understand wire bytes | `docs/wire-spec.md` (distilled spec) |
| Trace the 4-stage lifecycle | `docs/lifecycle.md` (state diagram + per-stage tables + script hook) |
| Survey resources at a location | `scripts/check-resources-at-location.ts` (full radial → list → per-type survey → stats flow) |
| Harvest resources via sampling | `ctx.sample(toolId, resourceTypeName)` + `ctx.waitForSampleEvent` loop; cancel with `ctx.cancelSampling()`. New units stack into matching inventory container automatically. |
| Craft a tool / item end-to-end | `scripts/craft-a-tool.ts` (open session → list schematics → pick recipe → assign slots → finishCrafting) |
| Fetch resource stats without sampling | `ctx.fetchResourceAttributes([ids])` (uses `getAttributesBatch`, chunked at 25 ids/call) |
| Implement movement in a custom script | `ctx.walkTo` / `walkCircle` / `walkToCell` auto-handle teleport-ack; for raw `ctx.send(...)` of transforms call `await ctx.ackPendingTeleports()` once first |
| Run N clients in parallel (load test) | `docs/scripting.md` → "Fleet" section + `src/client/fleet.ts` |
| Capture a wire transcript / replay it | `docs/scripting.md` → "Capture and replay" + `src/client/replay.ts` |
| Debug a live test failure | `src/client/swg-client.ts` — `transcript` field captures every send/recv |
| Add a new live test | `tests/integration/live-*.test.ts` as template (LIVE=1 gated) |
| Find a working example for X | `scripts/examples/` — ~25 scripts covering walking, surveying, chat/mail bots, parade/dance, crafting soak, etc. |
| Reuse a character across CI runs | Set `CI_REUSE_ACCOUNT` + `CI_REUSE_CHARACTER` (`tests/integration/helpers.ts`) |
| Use a check-out pool (multi-account tests) | `swg-ts-cli pool stock --count=N` once → set `CI_USE_POOL=1` → tests call `poolCredentials(prefix, count)`. See `src/client/character-pool.ts`. |
| Inspect captured wire | `tests/fixtures/{session-response-17b,login-enum-cluster-223b}.hex` |
| Wire decryption sanity check | `src/soe/connection.test.ts` — feeds captured bytes through full pipeline |
| Verify a constcrc value | `src/crc/constcrc.test.ts` — golden values from the C++ table |
| Read/write SWG IFF files | `src/iff/` — `Iff.fromFile(path)` to navigate; `IffWriter` to build. See `assets/README.md` for asset staging. |
| Read/write SWG `.tre` archives | `src/tre/` — `TreReader.fromFile(path).read('terrain/naboo.trn')`; `TreWriter` to build a fresh archive. |
| Sample terrain / find buildable spots | `src/terrain/` — `loadPlanetTrn('naboo')` reads metadata; `probeBuildable(ctx, inv, x, z)` checks coords via the live server; `findFlatPatch(ctx, inv, {count, centerX, centerZ, maxRadius})` does a grid search. |
| Build a player city autonomously (Naboo or any other planet) | `scripts/build-city/orchestrator.ts` + `bin/build-city.ts` — Fleet-coordinated 30-character build. See README "Asset setup" section for the `.trn` requirement. |

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

1. `cd ~/code/swg-ts-client && nvm use && pnpm test` — confirm baseline (should be ~1734 unit green; ~1761 total under `LIVE=1`).
2. If anything's red, check `git log --oneline` — most recent change is probably the culprit; revert it locally and retry.
3. If you bumped `~/code/swg-main` submodules, the wire-format may have drifted. Run `LIVE=1 pnpm test tests/integration/live-login.test.ts` — if it fails with a `LoginIncorrectClientId` or `Archive::ReadException`-style error, the message struct shape changed server-side. Find the C++ commit that added/removed fields, update `varCount` + encode/decode here. For broader drift, replay a baseline NDJSON capture (`pnpm cli capture` once on green, then `pnpm cli replay --compare=count` after the bump).
4. To do "more SWG protocol work" — read `docs/adding-a-message.md` and pick a message from `~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/`. The mechanical pattern handles itself. For ObjController subtypes (combat/movement/etc.) the recipe is the same but the file lives in `src/messages/game/obj-controller/` and registers via the subtype CRC instead of the top-level `messageRegistry`.
5. To write a scenario script — read `docs/scripting.md`, copy a factory in `src/scenarios/index.ts`, and run with `pnpm cli zone --script=<name>`. For one-off in-world bots, look at `scripts/examples/` for ~25 working examples.
6. To survey resources at a location — `pnpm tsx scripts/check-resources-at-location.ts --host=... --user=... --character=... --x=... --z=...` does the full radial-Use → ResourceListForSurveyMessage → per-type survey → resource-stats fetch loop end-to-end.

## Don't

- Don't add `~/code/swg-main` as a TypeScript dependency. This repo READS the C++ source for spec but never builds against it.
- Don't replace `constcrc.ts`'s 256-entry table with a "cleaner" standard CRC32. It's intentionally weird; the table is the spec.
- Don't switch from `node:dgram` to a UDP wrapper library. The bare API is fine and the dependency hygiene matters.
- Don't add `_stub-*.ts` files back — those were Phase 1 development scaffolding and are gone.
- Don't commit `tests/fixtures/*.hex` with anything new without verifying it via a real tcpdump capture against the live server. Hand-crafted fixtures will silently drift from reality.
