# Lifecycle: login → zone-in → logout

The `SwgClient.fullLifecycle()` method walks a real SWG client through
four stages over **two** UDP sockets (NOT three — see "Architecture
corrections" below). Each stage transitions through a known set of
`ZoneState` enum values (defined in `src/types.ts`).

---

## ZoneState transitions

```
NotConnected
   │
   │   client.fullLifecycle() invoked
   ▼
LoginHandshake          ─── Open socket #1 → LoginServer
   │                        SessionRequest → SessionResponse
   │                        Send LoginClientId(account, password, version)
   ▼
LoginAuthed             ─── Received: ServerNowEpochTime, LoginClientToken,
   │                                  LoginEnumCluster, LoginClusterStatus,
   │                                  [LoginClusterStatusEx], CharacterCreationDisabled,
   │                                  StationIdHasJediSlot, EnumerateCharacterId
   │                        Close socket #1
   ▼
ConnectionHandshake     ─── Open socket #2 → ConnectionServer (per-cluster)
   │                        SessionRequest → SessionResponse
   │                        Send ClientIdMsg(token)
   ▼
   │   Optional: if avatar list is empty AND characterToCreate is set:
   │       Send ClientCreateCharacter(name, template, location, profession)
   │       Receive ClientCreateCharacterSuccess(networkId)
   │       (Retry with name suffix on ClientCreateCharacterFailed)
   │
   │   Received: ClientPermissionsMessage
   │   Send SelectCharacter(networkId)
   ▼
CharacterSelected       ─── (no client-bound success message; server
   │                         internally re-routes our socket to a
   │                         GameConnection — same UDP socket)
   ▼
GameHandshake           ─── Waiting for CmdStartScene
   │
   │   Received: CmdStartScene(playerId, scene, pos, yaw, template, time, ...)
   ▼
ZoningIn                ─── Accumulating baseline flood:
   │                          SceneCreateObjectByCrc/Name * N
   │                          ObjControllerMessage * many (we discard)
   │                          UpdateTransformMessage * many (we discard)
   │
   │   Received: SceneEndBaselines(playerNetworkId)
   │   Send CmdSceneReady()
   ▼
ZonedIn                 ─── If `opts.script` is set, the scenario function
   │                        runs here (movement, survey/sample, crafting,
   │                        missions, group/trade, chat, combat, etc.).
   │                        Otherwise / afterwards, hold for any remaining
   │                        `holdZonedInMs` (default 5s). Heartbeats every 30s
   │                        underneath. See docs/scripting-quickref.md.
   ▼
LoggingOut              ─── Send LogoutMessage()  (suppressed if the script
                            already called `ctx.logout()`)
   │                        Sleep 1s (let server commit save)
   ▼
Disconnected            ─── Send SOE Terminate on socket #2
                            Close socket #2
                            Done.
```

---

## The four stages, in detail

### Stage 1: LoginServer (socket #1)

**Endpoint:** `loginServer.host:loginServer.port` (e.g. 10.254.0.253:44453)
**Driver:** `runLoginStage()` in `src/client/login-stage.ts`
**Code path on server side:** `LoginServer/src/shared/ClientConnection.cpp`,
`LoginServer.cpp:sendAvatarList(stationId, ...)`

#### Messages

| # | Direction | Message | Mandatory? | Purpose |
|---|-----------|---------|------------|---------|
| 1 | C→S | `LoginClientId(id, key, version)` | Y | Credential |
| 2 | S→C | `ServerNowEpochTime` | Y | Server-clock baseline (sent first, line 94) |
| 3 | S→C | `LoginClientToken(bytes, stationId, username)` | Y | Auth token for Stage 2+3 |
| 4 | S→C | `LoginEnumCluster([{id, name, timeZone}], maxCharactersPerAccount)` | Y | Cluster directory |
| 5 | S→C | `LoginClusterStatus([{id, host, port, status, ...}])` | Y | Per-cluster connection info |
| 6 | S→C | `LoginClusterStatusEx([{id, branch, networkVersion, ...}])` | N | Optional extended cluster info (post-2021 servers only) |
| 7 | S→C | `CharacterCreationDisabled(Set<string>)` | N | Which templates can't be created right now |
| 8 | S→C | `StationIdHasJediSlot(int)` | N | Account flag (0/1) |
| 9 | S→C | `EnumerateCharacterId([{name, template, networkId, cluster, type}])` | Y | The avatar list |

The avatar list comes from **LoginServer**, not ConnectionServer (this is
a frequent source of confusion). LoginServer's `sendAvatarList` is at
`LoginServer.cpp:1122`; it sends `StationIdHasJediSlot` then
`EnumerateCharacterId` to the client.

#### Outcome

`LoginStageResult` with:
- `clusters` — joined view of LoginEnumCluster + LoginClusterStatus + Ex
- `token` — token bytes + stationId + echoed username
- `characters` — the avatar list, projected to `CharacterInfo[]`
- `serverNow` — `Date` reconstructed from ServerNowEpochTime
- `hasJediSlot`, `characterCreationDisabled`

Stage 1 closes socket #1 cleanly with a Terminate. The token persists in
memory only.

#### Errors

| Server reply | Cause |
|--------------|-------|
| `ErrorMessage("Login Failed", "Account name is too long!")` | Account > 15 chars (`MAX_ACCOUNT_NAME_LENGTH` in `CommonAPI.cpp:6`) |
| `LoginIncorrectClientId(version, internalVersion)` | NetworkVersionId mismatch (PRODUCTION builds only) |
| Server hangs up after ServerNowEpochTime | External auth URL configured + auth failed |

---

### Stage 2: ConnectionServer (socket #2)

**Endpoint:** Chosen cluster's `connectionServerAddress:connectionServerPort`
(typically 10.254.0.253:44463)
**Driver:** `runConnectionStage()` in `src/client/connection-stage.ts`
**Code path on server side:** `ConnectionServer/src/shared/ClientConnection.cpp`

#### Messages

| # | Direction | Message | Mandatory? | Purpose |
|---|-----------|---------|------------|---------|
| 1 | C→S | `ClientIdMsg(token, gameBitsToClear=0, version)` | Y | Re-authenticate using token from Stage 1 |
| 2 | S→C | `ClientPermissionsMessage(canLogin, canCreateRegular, ...)` | Y | Authorization result |
| 3 | C→S | `ClientCreateCharacter(...)` | N | Only if avatar list was empty |
| 4 | S→C | `ClientCreateCharacterSuccess(networkId)` | N | Reply to above (otherwise `ClientCreateCharacterFailed(name, errorMessage)`) |
| 5 | C→S | `SelectCharacter(networkId)` | Y | Pick character |

`SelectCharacter` is **fire-and-forget** on the client wire. No
ack/success message comes back. Server-side, the message triggers
`ConnectionServer::sendToCentralProcess(ValidateCharacterForLoginMessage(...))`
and an internal pipeline that eventually re-attaches the client's
existing UDP socket to a GameConnection. The client sees no protocol
event until CmdStartScene arrives in Stage 3.

#### Outcome

`ConnectionStageResult` with the same `SoeConnection` + `MessageDispatcher`
ready to be reused for Stage 3 (do NOT call `disconnect()` here).
Plus `permissions`, `selectedCharacter`, `characterWasCreated`.

#### Character creation gotchas

The `startingLocation` field is a **city name key** from
`starting_locations.iff` (e.g. `mos_eisley`, `bestine`, `mos_espa`), NOT
a planet name. Passing `tatooine` will get
`shared:character_create_failed_bad_location`.

The `templateName` is the **server** template (e.g.
`object/creature/player/human_male.iff`), NOT the shared/client variant
(`object/creature/player/shared_human_male.iff`). The shared/client
variant will get `name_declined_not_creature_template`.

Default profession `combat_brawler` works on stock data. Default skill
templates can be empty.

---

### Stage 3: GameServer-via-ConnectionServer (same socket as Stage 2)

**Endpoint:** Same as Stage 2 (NO new socket — see corrections below).
**Driver:** `runGameStage()` in `src/client/game-stage.ts`
**Code path on server side:** `SwgGameServer/src/shared/`, `serverGame/.../network/`

#### Messages

| # | Direction | Message | Mandatory? | Purpose |
|---|-----------|---------|------------|---------|
| 1 | S→C | `CmdStartScene(playerId, scene, pos, yaw, template, ...)` | Y | "World init starts now" |
| 2 | S→C | `SceneCreateObjectByCrc(networkId, transform, templateCrc, hyperspace)` | * | One per nearby object (terrain, NPCs, items). Can be hundreds. |
| 3 | S→C | `SceneCreateObjectByName(networkId, transform, templateName, hyperspace)` | * | Same but template by path string |
| 4 | S→C | `ObjControllerMessage(flags, msg, networkId, value, data)` | N | High-frequency gameplay traffic. Header always captured; the trailer is dispatched through `src/messages/game/obj-controller/` for 8 common subtypes (CombatAction, CombatSpam, PostureChange, AttributeChanged, SitOnObject, MoodChange, ObjectMenuRequest/Response) — unknowns keep an opaque `data: Uint8Array` plus a diagnostic `subtypeCrcHex`. |
| 5 | S→C | `UpdateTransformMessage(...)` | N | Movement updates for nearby objects. Fully decoded. The same class is used client→server during scripted movement (`ctx.walkTo` / `ctx.walkCircle`). |
| 6 | S→C | `AttributeListMessage(...)` | N | Examine-window content. Header captured, discarded. |
| 7 | S→C | `SceneEndBaselines(playerNetworkId)` | Y | "Baseline phase is done" |
| 8 | C→S | `CmdSceneReady()` | Y | "Client ready; I'm participating in the world now" |
| 9 | C↔S | `HeartBeat()` | N | Periodic keep-alive (we send every 30s during dwell; server sends much more often) |
| 10 | C→S | `LogoutMessage()` | Y | Graceful logout |

**Note:** Steps 2-6 may interleave with each other in any order. The end
of baselines is signaled only by `SceneEndBaselines`. We collect
baseline-create events as they arrive (via `onMessage` listeners) until
the wait for SceneEndBaselines resolves.

#### Outcome

`GameStageResult` with:
- `sceneStart` — the parsed CmdStartScene
- `baseline.objectIds` — deduped NetworkIds we saw in SceneCreateObject*
- `baseline.templateNames` — names from SceneCreateObjectByName
- `zonedInAt` — `Date` of SceneEndBaselines
- `logoutAt` — `Date` of LogoutMessage send
- `scriptResult` — `{ elapsedMs, sendsCount, didLogout, error? }` if a script ran during the dwell

The top-level `LifecycleResult` (returned from `fullLifecycle`) additionally carries:
- `latency` — `{ samples, count, min, mean, p50, p95, p99, max } | null` — RTT distribution collected from the connection-stage socket's `ClockSync`/`ClockReflect` exchange (see `docs/wire-spec.md` § 1.1). The SOE connection auto-replies to every inbound `ClockSync` and initiates one every 45s by default (configurable via `SoeConnectionOptions.clockSyncIntervalMs`; set to 0 to disable).

#### Scripting hook

If `FullLifecycleOptions.script` is set, the scenario function runs **after** `CmdSceneReady` is sent and **before** any remaining `holdZonedInMs` is awaited. Inside the script, primitives on the `ScriptContext` translate to the appropriate client→server `GameNetworkMessage`s — movement (over `CM_netUpdateTransform=113` with automatic teleport-ack bootstrap), survey + resource stats, crafting sessions, missions, group/trade flows, chat, combat, posture/dance, inventory ops, and an expectation system for assertions tied to inbound messages. If the script calls `ctx.logout()`, the stage suppresses its own implicit `LogoutMessage` send so logout happens exactly once. See `docs/scripting-quickref.md` and the auto-generated `docs/views-reference.md` + `docs/actions-reference.md`.

---

### Stage 4: Logout (rolled into Stage 3's end)

Sequence is just:
1. Send `LogoutMessage` (empty body)
2. Sleep 1 second to let server-side save complete
3. Build SOE Terminate packet (encrypted + CRC'd)
4. Send it
5. Close socket #2

The server does not send any logout-success message — see
`ClientConnection::handleLogoutMessage` in `serverGame`. Our 1-second
delay matches what the real Windows client uses.

---

## Architecture corrections (original plan was wrong)

The original plan called for **3 UDP sockets** (LoginServer,
ConnectionServer, GameServer). Investigation of
`ConnectionServer/src/shared/ClientConnection.cpp` showed this is wrong:

> `GameServerForLoginMessage` is an **internal** CentralServer→ConnectionServer
> routing message. It's not sent to the client. The client stays on the
> same UDP socket throughout Stages 2 + 3; the ConnectionServer simply
> re-routes its decrypted packets to a GameConnection server-side.

See `ClientConnection.cpp:258` (`handleGameServerForLoginMessage` →
`sendToGameServer(serverId)`) and `1188-1210`
(`sendToGameServer(GameConnection*)`).

The correct architecture is **2 UDP sockets total**:

```
Client                          Server
──────                          ──────
socket #1 ────────────────►   LoginServer (44453)
   │                              │
   │ Stage 1                      │
   │                              │
   X (closed after stage)         X
                                  
socket #2 ────────────────►   ConnectionServer (44463)
   │                              │
   │ Stage 2 + 3 + 4              │  internally re-routes to:
   │                              │   GameConnection → SwgGameServer
   │                              │
   X (closed after logout)        X
```

This is also why `GameServerForLoginMessage` is registered as a known
message in our registry but is **never** received during the lifecycle —
we don't expect it.
