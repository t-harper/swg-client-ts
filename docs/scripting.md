# Scripting, Fleet, and Capture/Replay

Beyond `SwgClient.fullLifecycle()`, this client offers three layered toolkits:

1. **Scripting engine** — a `ScriptContext` exposed during the zoned-in dwell, with primitives for movement, combat, chat, inventory, and lifecycle.
2. **Fleet** — run N independent `SwgClient`s in parallel for load and concurrency testing.
3. **Capture + replay** — record any session as NDJSON and re-run it later to detect wire-format drift.

The CLI surfaces all three (`zone --script`, `swarm`, `capture`, `replay`). The programmatic API lives in `src/index.ts`.

---

## 1. Scripting engine

A scenario is a plain async function: `(ctx: ScriptContext) => Promise<void>`. It runs in place of the `holdZonedInMs` sleep at `src/client/game-stage.ts`; any remaining hold time after the script returns is still awaited.

```ts
import { SwgClient, ScenarioFn } from '@swg/ts-client';

const myScenario: ScenarioFn = async (ctx) => {
  await ctx.walkTo({ x: -100, z: 50 }, { speed: 5 });
  await ctx.walkCircle({ centerX: -100, centerZ: 50, radius: 10, durationMs: 5_000 });
  ctx.openPlayerInventory();
  ctx.tell('SomeFriend', 'hi');
  ctx.attackTarget(targetNetworkId);
  await ctx.wait(1_000);
  await ctx.logout();
};

const client = new SwgClient({ loginServer: { host: '10.254.0.253', port: 44453 } });
const result = await client.fullLifecycle({
  account: 'ci-test', characterName: 'TsTest', script: myScenario,
});
console.log(result.scriptResult);  // { elapsedMs, sendsCount, didLogout, error? }
```

If `ctx.logout()` is called from inside the script, the lifecycle suppresses its own implicit `LogoutMessage` to avoid double-send.

### `ScriptContext` API

Declared in `src/client/script/context.ts`.

| Method | Purpose |
|---|---|
| `position(): Vector3` | Live cursor (best estimate from movement primitives) |
| `yaw(): number` | Live heading in radians |
| `cellPosition(): Vector3` / `parentCell(): NetworkId` / `setCellPose(...)` | Cell-relative cursor (when inside a building) |
| `nextSequenceNumber()` / `nextCommandSequence()` / `nextChatSequence()` / `nextMissionSequence()` | Per-channel monotonic counters |
| `nextSyncStamp()` | Monotonic ms-since-script-start, wrapped u32 — used as `MessageQueueDataTransform.syncStamp` |
| `send(msg)` | Escape hatch: send any `GameNetworkMessage` and count it in `sendsCount` |
| `wait(ms)` | Sleep; rejects with `aborted` if the signal fires |
| `waitForMessage(ctor, { timeoutMs?, predicate? })` | Resolve on next matching inbound message |
| **Movement** | |
| `walkTo({ x, z, y? }, { speed?, tickMs?, y? })` | Linear walk; defaults: speed 4 m/s, tickMs 500. Uses `ObjControllerMessage(CM_netUpdateTransform=113)` with float positions, server-validated speed window. |
| `walkCircle({ centerX, centerZ, radius, durationMs, speed?, tickMs?, direction?, y? })` | Parametric circle, same wire path as `walkTo` |
| `walkToCell(parentId, { x, z, y? }, ...)` | Cell-relative walk via `CM_netUpdateTransformWithParent=241`; cell cursor tracked separately from world cursor |
| `ackPendingTeleports()` | Auto-called by the walk primitives on first invocation. Scans the transcript for inbound `CM_netUpdateTransform` with negative `sequenceNumber` (zone-in teleport-lockout signals from `PlayerCreatureController::resyncMovementUpdates`) and replies with `CM_teleportAck=319`. Manual `ctx.send(...)` paths that build their own transforms MUST `await ctx.ackPendingTeleports()` once after zone-in. |
| **Inventory / containers** | |
| `openContainer(containerId, slot?)` | Send `ClientOpenContainerMessage` |
| `openPlayerInventory()` | Sugar for `openContainer(playerNetworkId, 'inventory')` |
| `closeContainer(id)` | Documentation no-op (no wire close exists; server infers from next action) |
| **Combat / command queue** | |
| `useAbility(name, targetId?, params?)` | Queue `CommandQueueEnqueue` wrapped in `ObjControllerMessage(CM_commandQueueEnqueue=278)` |
| `attackTarget(targetId)` | Sugar for `useAbility('attack', targetId)` |
| `changePosture('standing'\|'crouched'\|'prone'\|'sitting')` | Posture commands |
| **Chat** | |
| `tell(target, text)` | Private message via `ChatInstantMessageToCharacter` |
| `sendToChannel(channelId, text)` | Post via `ChatSendToRoom` |
| `sendMail(target, subject, body)` | In-game mail via `ChatPersistentMessageToServer` |
| `say(text, opts?)` | Speak real spatial chat — uses the server-side `spatialChatInternal` CommandQueue command (the path the real Windows client uses; `CM_spatialChatSend=243` is `allowFromClient=false` server-side and would be dropped). Server-side: `commandFuncSpatialChatInternal` builds the `MessageQueueSpatialChat`, looks up the right volume from `chat/spatial_chat_types.iff`, runs the chat-spam limiter, and broadcasts `CM_spatialChatReceive(244)` to observers. Defaults to `/say`; pass `chatType: SpatialChatType.Shout`/`Whisper` or a `targetId` for directed chat. Inbound broadcasts arrive as `ObjControllerMessage` with `message=CM_spatialChatReceive`, decoded by `SpatialChatReceiveDecoder` |
| `requestChannelList()` | Request `ChatRoomList` from server |
| **Survey** | |
| `fetchSurveyResources(toolId, { timeoutMs? })` | Two-step radial-Use flow: sends `ObjControllerMessage(CM_objectMenuRequest=326)` then `ObjectMenuSelectMessage(targetId=tool, ITEM_USE=21)`, waits for `ResourceListForSurveyMessage`, returns `ResourceListItem[]` (name/resourceId/parentClassName). Requires the tool's `VAR_SURVEY_CLASS` objvar to be set (crafted tools and admin-spawned templates have it). |
| `survey(toolId, resourceTypeName)` | `useAbility('requestsurvey', toolId, resourceTypeName)`. **`resourceTypeName` is a specific spawned type** (e.g. `"Resotine"`), NOT a class name like `"mineral"` — the server's `TaskSurvey` looks the type up by exact name. Use `fetchSurveyResources` first to discover legal values. |
| `waitForSurvey({ timeoutMs? })` | Resolve next `SurveyMessage` (default 60s). Returns 9 sample points per survey: `{ location: Vector3, efficiency: 0..1 }`. |
| `fetchResourceAttributes([ids], { timeoutMs?, clientRevision?, maxBatchSize? })` | Batched `useAbility('getAttributesBatch', 0n, '<id> -1 <id> -1 ...')`, split into chunks of `maxBatchSize` (default 25) so we stay under the single-packet wire ceiling. Server queues one `TaskGetAttributes` per id; ResourceTypeObject ids route through `getResourceAttributes()` and return the full OQ/CR/DR/HR/SR/UT/ER/PE/MA/CD stat block as `AttributeListMessage`. Returns `Map<NetworkId, AttributePair[]>`; ids that didn't respond by `timeoutMs` are omitted. |
| **Sampling / harvest** | |
| `sample(toolId, resourceTypeName)` | `useAbility('requestcoresample', toolId, resourceTypeName)`. Server starts a ~30-second-tick sample loop. Each tick has a ~50-70% success chance (skill-dependent); successful units stack into an existing matching resource container in inventory or create a new one. |
| `cancelSampling()` | Walks 2.5m to bust the loop on the next server tick. Returns once the move is sent; the server's `sample_cancel` chat arrives a few seconds later. |
| `waitForSampleEvent({ timeoutMs?, predicate? })` | Resolves to `{ kind: SampleEventKind, raw }` where `kind` is one of `'located'` / `'failed'` / `'cancel'` / `'in_progress'` / `'start'` / `'mind'` / `'density'` / `'trace'` / `'other'` (parsed from the STF token in `ChatSystemMessage.outOfBand`). |
| **Missions** | |
| `requestMissionList(terminalId, { flags? })` / `acceptMission` / `removeMission` / `abortMission` | Driven through `CM_mission*` subtypes; server replies with `MissionObject` baselines + `PopulateMissionBrowserMessage` + `CM_missionAcceptResponse` |
| **Commodities / bazaar** | |
| `browseBazaar(terminalId, { searchType?, category?, minPrice?, maxPrice?, textFilterAll?, textFilterAny?, advancedSearch?, queryOffset?, myVendorsOnly?, timeoutMs? })` | Sends `AuctionQueryHeadersMessage` and resolves with the depalettized `AuctionListing[]` from the matching `AuctionQueryHeadersResponseMessage`. Request id is auto-generated and used to filter responses so concurrent browses don't cross-talk. |
| `getAuctionDetails(auctionId, { timeoutMs? })` | Sends `GetAuctionDetails`, awaits the matching `GetAuctionDetailsResponse`, returns `{ itemId, userDescription, propertyList, templateName, appearanceString }`. |
| `bidOn(auctionId, credits, maxProxy?)` | Fire-and-forget `BidAuctionMessage`. `maxProxy` defaults to `credits` (no auto-rebid). Use `ctx.waitForMessage(BidAuctionResponseMessage, ...)` to confirm. |
| `listForSale(terminalId, itemId, { price, durationHours?, description?, localizedName?, instantSale?, premium?, vendorTransfer? })` | Sends `CreateAuctionMessage` (auction-style) or `CreateImmediateAuctionMessage` (when `instantSale: true`) and resolves with `{ success, auctionId?, resultCode, errorReason? }` parsed from `CreateAuctionResponseMessage`. `durationHours` defaults to 24. |
| `retrieveBazaarItem(terminalId, itemId)` / `cancelMyListing(auctionId)` | Fire-and-forget `RetrieveAuctionItemMessage` / `CancelLiveAuctionMessage`. Responses arrive asynchronously as `RetrieveAuctionItemResponseMessage` / `CancelLiveAuctionResponseMessage`. |
| **Crafting** | |
| `beginCrafting(toolId, schematicCrc?)` | `useAbility('requestCraftingSession', toolId, ...)`. Server opens session and replies with `CM_craftingResult` + `CM_draftSchematicsMessage`. |
| `waitForDraftSchematics({ timeoutMs? })` | Resolves the server's `DraftSchematicsMessage` — list of `{serverCrc, sharedCrc, category}` entries you can choose from. Default timeout 8s. |
| `selectCraftingSchematic(index)` | `useAbility('selectDraftSchematic', 0n, String(index))`. Server replies with `CM_draftSlotsMessage`. |
| `waitForDraftSlots({ timeoutMs? })` | Resolves the server's `ManufactureSchematicMessage` — the in-flight `manfSchemId` + `prototypeId` plus per-slot `{name, optional, options[], hardpoint}` requirements. Default timeout 8s. |
| `assignCraftingSlot(slotIndex, ingredientId, { optionIndex?, quantity? })` | `CM_fillSchematicSlotMessage` |
| `clearCraftingSlot(slotIndex, targetContainer?)` | `CM_emptySchematicSlotMessage` |
| `craftExperiment([{ attribute, points }], { coreLevel? })` | `CM_experimentMessage`; server responds via `CM_experimentResult` (275) |
| `finishCrafting(toolId, { realPrototype? })` | `useAbility('createPrototype', toolId, '<seq> <real>')` |
| **Expectations** | |
| `expectWithin(ctor, timeoutMs, { predicate?, soft? })` | Wait for inbound message; soft mode records `assertionFailures` instead of throwing |
| `expectAbsent(ctor, windowMs, { predicate? })` | Assert nothing matching arrives in the window |
| `expectAfter(trigger, ctor, { withinMs, predicate?, soft? })` | Trigger an action, then assert the response arrives |
| `fail(reason)` / `assertionFailures()` | Manual soft-failure recording |
| **Lifecycle** | |
| `logout()` | Send `LogoutMessage` + brief settle |

### Bundled scenarios (CLI-loadable)

Registered in `src/scenarios/index.ts`. Pass `--script=<name>` and zero or more `--script-arg=k=v`.

| Name | Args (defaults) | What it does |
|---|---|---|
| `walk-line` | `x=0 z=0 speed=5 holdMs=1000` | Walk to (x, z) then dwell |
| `walk-circle` | `radius=8 durationMs=5000 centerX=current centerZ=current speed=auto direction=1` | Trace a circle |
| `open-inventory` | `holdMs=2000` | Open inventory, hold, close (no-op) |
| `combat-attack` | `targetId=(required) durationMs=5000 tickMs=1000` | Queue `attack` against `targetId` every tickMs |
| `posture-cycle` | `durationMs=5000 tickMs=1000` | Cycle standing → crouched → prone → standing |
| `survey` | `toolId=(required) resourceTypeName=(required) waitMs=2000` | One-shot `requestsurvey` (assumes the tool is already activated; use `ctx.fetchSurveyResources` to discover legal `resourceTypeName` values) |
| `group-trade` | `role=leader|invitee otherId=(required) tradeAmount?` | Two-client coordination — invite, form group, optional secure-trade, disband. See `scripts/group-trade-demo.ts`. |
| `bazaar-snipe` | `terminalId=(required) auctionId?=(opt) credits=(required when auctionId set) browseMs=5000` | When `auctionId` is set, fire a `BidAuctionMessage(auctionId, credits)`. Otherwise browse the bazaar at `terminalId` for `browseMs` and surface the top-three lowest-priced listings via `ctx.fail(...)` (soft-log into `ScriptResult.assertionFailures`). |
| `dwell` | `durationMs=5000` | Idle baseline |

`NetworkId` args accept hex (`0x...`) or decimal.

To add a scenario, drop a new factory in `src/scenarios/index.ts`, add it to the `scenarios` map. Unit-test it with `createFakeContext()` from `src/client/script/test-helpers.ts`.

Looking for more advanced examples? `scripts/examples/` has ~25 ready-to-run scripts: walking patterns (figure-eight, spiral-out, square-patrol, random-walk, parade), survey loops (survey-loop, survey-walking-grid, gradient-ascent-survey, multi-resource-survey, find-best-resource), chat/mail (channel-bot, mail-blast, chat-spam, town-crier, welcome-greeter), combat (combat-then-flee, endless-combat, target-acquisition), crafting (crafting-bench-soak, experiment-spam), social (dance-party, synchronized-dance, parade), and infrastructure (capture-soak, idle-fleet, reconnect-loop, swarm-circle, whirlwind).

### Wire details worth knowing

- **Client→server movement is `ObjControllerMessage(CM_netUpdateTransform=113)`**, NOT top-level `UpdateTransformMessage` (that's the server-broadcast form). Trailer is the 45-byte `MessageQueueDataTransform`: `[u32 syncStamp][i32 seq][Quat 4×f32][Vec3 3×f32][f32 speed=0][f32 lookAtYaw=0][u8 useLookAtYaw=0]`. Cell-relative variant is `CM_netUpdateTransformWithParent=241`, prefixed with `[NetworkId parentCell]`. See `src/messages/game/obj-controller/data-transform.ts` and `data-transform-with-parent.ts`.
- **Speed on the wire is 0.** The server derives effective speed from `position_delta / (syncStamp_delta_ms / 1000)` and validates against the creature's anti-cheat speed cap. Sending non-zero can trip the validator for fresh characters. The `WalkToOptions.speed` field controls our local pacing (m/s) but always encodes 0 on the wire.
- **Zone-in teleport-lockout**: `PlayerCreatureController::resyncMovementUpdates` inserts negative sequence ids into `m_teleportIds` during zone-in. Until the client ACKs them via `ObjControllerMessage(message=CM_teleportAck=319, data=[i32 LE seq])`, every client→server transform is silently rejected by `handleMove`'s `isTeleporting()` check. The built-in walk primitives call `ctx.ackPendingTeleports()` automatically on first invocation. Manual `ctx.send(...)` of transforms must do it themselves.
- **Position is float**, not fixed-point — write directly as `f32`. Wire range is whatever the planet's coordinate system allows (-8192..8192 on most ground zones).
- **Yaw → quaternion** about the Y axis via `yawToQuat(yaw)`. SWG world heading is `atan2(dx, dz)` (z = north).
- Default movement cadence is **500ms** with **4 m/s** speed (matches the real Windows client's sparse cadence; produces position deltas of ~2m per tick which the server's anti-cheat tolerates easily).
- The command-queue path wraps `CommandQueueEnqueue` inside an `ObjControllerMessage` with subtype `CM_commandQueueEnqueue=278` and flags `0x23` (`CLIENT_TO_AUTH_SERVER_FLAGS = SEND|RELIABLE|DEST_AUTH_SERVER`). See `src/messages/game/command-queue/`.
- Chat strings are `Unicode::String` (UTF-16 LE), not `std::string` (UTF-8). The chat helpers handle this — only matters if you build chat messages by hand.

---

## 2. Fleet (multi-client)

`Fleet` runs N independent `SwgClient`s in parallel via `Promise.allSettled` — one client crashing doesn't abort the others. Per-outcome error capture; per-message-name summary aggregation (full per-client transcripts stay attached but no merged super-transcript).

```ts
import { Fleet, scenarios } from '@swg/ts-client';

const fleet = new Fleet({ loginServer: { host: '10.254.0.253', port: 44453 } });

const result = await fleet.run(
  Array.from({ length: 10 }, (_, i) => ({
    account: `load-${i}`,
    characterName: `LoadChar${i}`,
    script: scenarios['walk-circle']({ radius: '8', durationMs: '30000' }),
  })),
  { staggerMs: 200, maxConcurrent: 5 },
);

// result.summary  — totalClients, succeeded, failed, totalElapsedMs,
//                   totalUpdateTransformsSent, clientsWithErrorMessage,
//                   messageCounts: { [name]: { send, recv } }
// result.outcomes — per-client { config, lifecycleResult?, error?, elapsedMs }
```

CLI: `pnpm cli swarm --count=N --user-prefix=<p> [--stagger-ms=N] [--max-concurrent=N]`. The CLI derives accounts as `${prefix}<runTag><i>` (clamped to the server's 15-char account limit).

**Constraint**: the server allows one session per account. Fleet uses distinct accounts; don't aim N clients at the same account.

---

## 3. Capture and replay

Records every send/recv at the **GameNetworkMessage layer** (not SOE-level) and writes one event per line as NDJSON. Replay starts a fresh `SwgClient`, runs the normal login + connection + zone-in stages, then injects the captured high-level sends during the dwell — preserving original spacing (`asCaptured`) or firing back-to-back (`asFast`).

The comparison is over inbound **message names** (or as a multiset with `--compare=count`), not exact bytes, because the server emits fresh sequence numbers and timestamps every run.

### Programmatic

```ts
import { captureLifecycle, replay, writeTranscript, readTranscript } from '@swg/ts-client';

// Record once after a known-good build
const cap = await captureLifecycle({
  loginServer: { host: '10.254.0.253', port: 44453 },
  account: 'ci-test', characterName: 'TsTest',
});
await writeTranscript(cap.events, 'baseline.ndjson');

// After a server submodule bump, replay it
const events = await readTranscript('baseline.ndjson');
const res = await replay({
  loginServer: { host: '10.254.0.253', port: 44453 },
  account: 'ci-test', characterName: 'TsTest',
  capture: events, pacing: 'asFast', compare: 'count',
});
if (!res.succeeded) console.error('drift:', res.missing);
```

### CLI

```bash
pnpm cli capture --host=... --user=... --character=... --output=/tmp/zone-in.ndjson
pnpm cli replay  --host=... --user=... --character=... --input=/tmp/zone-in.ndjson \
                 --pacing=asFast --compare=count
```

Exit code 1 if `missing.length > 0`. This is a **drift detector**, not a strict equality check — live servers have non-deterministic background traffic, so `--compare=count` is typically more useful than the default `--compare=names`.

### Caveats

- Inbound `unknownCrc` events are recorded with `unknownCrc: true` and the raw bytes; they round-trip losslessly.
- Encryption/SOE framing is re-derived from the live session — captures are at the message layer, not raw UDP.
- Large worlds produce big files (a 5s dwell can be 100KB+). Don't commit captures to git without good reason.

---

## How the pieces fit together

```
                                          ┌────────────────────────────┐
                                          │ Bundled scenarios          │
                                          │ src/scenarios/             │
                                          │ scripts/examples/ (25+)    │
                                          └──────────┬─────────────────┘
                                                     │ ScenarioFn
                                                     ▼
SwgClient.fullLifecycle({ script })       ┌────────────────────────────┐
   ├── Stage 1: LoginServer               │ ScriptContext              │
   ├── Stage 2: ConnectionServer          │ src/client/script/         │
   ├── Stage 3: GameServer (zone-in)      │  Movement:                 │
   │      ├── CmdStartScene               │   walkTo / walkCircle /    │
   │      ├── baseline flood              │   walkToCell (auto         │
   │      ├── CmdSceneReady               │   teleport-ack bootstrap)  │
   │      │                               │  Survey:                   │
   │      ├── *** script runs here *** ───┤   fetchSurveyResources →   │
   │      │                               │   survey → waitForSurvey   │
   │      │                               │   fetchResourceAttributes  │
   │      │                               │  Crafting / missions /     │
   │      │                               │   group / trade / chat /   │
   │      │                               │   combat / posture / dance │
   │      │                               │  Expectations:             │
   │      │                               │   expectWithin / Absent /  │
   │      │                               │   After                    │
   │      │                               │  Lifecycle: wait / logout  │
   │      └── (remaining hold + LogoutMessage)
   └── Stage 4: SOE Terminate

Fleet({...}).run([cfgs])  →  N parallel SwgClient.fullLifecycle calls
captureLifecycle()        →  records events, writes NDJSON
replay({ capture })       →  SwgClient.fullLifecycle({ script: replayScenario })
CharacterPool             →  JSON-backed pre-stocked character lease DB
```

---

## Adding a new ScriptContext primitive

1. Identify or add the underlying `GameNetworkMessage` (`docs/adding-a-message.md`).
2. Append a method to the `ScriptContext` interface in `src/client/script/context.ts` (additive only — keeps merge-friendly).
3. Implement it in `createScriptContext()` alongside the existing primitives. Use `ctx.send(...)` so `sendsCount` and the transcript see it.
4. If it needs its own monotonic counter, add a state slot + a `nextXxxSequence()` method.
5. Add tests in `src/client/script/context.test.ts` using `createFakeContext()`.
6. Optionally add a CLI-loadable scenario in `src/scenarios/index.ts`.

That's it — the dispatcher, encoding, and transcript wiring are reused.
