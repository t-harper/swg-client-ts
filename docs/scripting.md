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
| `nextSequenceNumber()` / `nextCommandSequence()` / `nextChatSequence()` | Per-channel monotonic counters (movement vs command queue vs chat) |
| `send(msg)` | Escape hatch: send any `GameNetworkMessage` and count it in `sendsCount` |
| `wait(ms)` | Sleep; rejects with `aborted` if the signal fires |
| `waitForMessage(ctor, { timeoutMs?, predicate? })` | Resolve on next matching inbound message |
| **Movement** | |
| `walkTo({ x, z, y? }, { speed?, tickMs?, y? })` | Linear walk at ~5Hz, fixed-point quantized |
| `walkCircle({ centerX, centerZ, radius, durationMs, speed?, tickMs?, direction?, y? })` | Parametric circle |
| **Inventory / containers** | |
| `openContainer(containerId, slot?)` | Send `ClientOpenContainerMessage` |
| `openPlayerInventory()` | Sugar for `openContainer(playerNetworkId, 'inventory')` |
| `closeContainer(id)` | Documentation no-op (no wire close exists; server infers from next action) |
| **Combat / command queue** | |
| `useAbility(name, targetId?, params?)` | Queue `CommandQueueEnqueue` wrapped in `ObjControllerMessage` |
| `attackTarget(targetId)` | Sugar for `useAbility('attack', targetId)` |
| `changePosture('standing'\|'crouched'\|'prone'\|'sitting')` | Posture commands |
| **Chat** | |
| `tell(target, text)` | Private message via `ChatInstantMessageToCharacter` |
| `sendToChannel(channelId, text)` | Post via `ChatSendToRoom` |
| `sendMail(target, subject, body)` | In-game mail via `ChatPersistentMessageToServer` |
| `say(text, opts?)` | Speak real spatial chat — uses the server-side `spatialChatInternal` CommandQueue command (the path the real Windows client uses; `CM_spatialChatSend=243` is `allowFromClient=false` server-side and would be dropped). Server-side: `commandFuncSpatialChatInternal` builds the `MessageQueueSpatialChat`, looks up the right volume from `chat/spatial_chat_types.iff`, runs the chat-spam limiter, and broadcasts `CM_spatialChatReceive(244)` to observers. Defaults to `/say`; pass `chatType: SpatialChatType.Shout`/`Whisper` or a `targetId` for directed chat. Inbound broadcasts arrive as `ObjControllerMessage` with `message=CM_spatialChatReceive`, decoded by `SpatialChatReceiveDecoder` |
| `requestChannelList()` | Request `ChatRoomList` from server |
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
| `dwell` | `durationMs=5000` | Idle baseline |

`NetworkId` args accept hex (`0x...`) or decimal.

To add a scenario, drop a new factory in `src/scenarios/index.ts`, add it to the `scenarios` map. Unit-test it with `createFakeContext()` from `src/client/script/test-helpers.ts`.

### Wire details worth knowing

- **Position** is meters → `int16` via `Math.round(meters * 4)` (0.25m resolution). Wire range is roughly ±8192m per axis.
- **Yaw** is radians → `int8` via `Math.round(yaw * 16)`. SWG uses `atan2(dx, dz)` (z = north).
- Movement primitives clamp per-tick distance ≤ 90m to stay under server `getMoveMaxDistance` (~100m).
- The default tick cadence is **200ms (~5Hz)**, matching what the real Windows client emits while running.
- The command-queue path wraps `CommandQueueEnqueue` inside an `ObjControllerMessage` with subtype `CM_commandQueueEnqueue` (278) and flags `0x23` (SEND|RELIABLE|DEST_AUTH_SERVER). See `src/messages/game/command-queue/`.
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
                                          ┌──────────────────────┐
                                          │ Bundled scenarios    │
                                          │ src/scenarios/       │
                                          └──────────┬───────────┘
                                                     │ ScenarioFn
                                                     ▼
SwgClient.fullLifecycle({ script })       ┌──────────────────────┐
   ├── Stage 1: LoginServer               │ ScriptContext        │
   ├── Stage 2: ConnectionServer          │ src/client/script/   │
   ├── Stage 3: GameServer (zone-in)      │  • walkTo/walkCircle │
   │      ├── CmdStartScene               │  • useAbility/attack │
   │      ├── baseline flood              │  • tell/sendMail     │
   │      ├── CmdSceneReady               │  • openContainer     │
   │      │                               │  • wait/logout       │
   │      ├── *** script runs here ***  ──┤                      │
   │      │                               └──────────────────────┘
   │      └── (remaining hold + LogoutMessage)
   └── Stage 4: SOE Terminate

Fleet({...}).run([cfgs])  →  N parallel SwgClient.fullLifecycle calls
captureLifecycle()        →  records events, writes NDJSON
replay({ capture })       →  SwgClient.fullLifecycle({ script: replayScenario })
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
