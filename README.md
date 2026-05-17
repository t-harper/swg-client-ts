# @swg/ts-client

Headless TypeScript SWG wire-compatible client. Speaks the SOE UDP protocol +
SWG's `GameNetworkMessage` layer well enough to perform the full login →
zone-in → logout lifecycle against a running SWG-Source server, then drive
realistic in-world behavior — movement, surveying, sampling, crafting, chat,
combat, group/trade flows. Built for CI, load testing, regression detection,
fuzzing, scripted bots, and protocol documentation — **not** for actually
playing the game (no rendering, no audio, no animation).

## What it does

```
LoginServer (44453/udp)
    → SessionRequest → LoginClientId → LoginEnumCluster + LoginClusterStatus
        → LoginClientToken
ConnectionServer (per-cluster, typically 44463/udp)
    → SessionRequest → ClientIdMsg → ClientPermissionsMessage
        → EnumerateCharacterId (create one if empty)
        → SelectCharacter → GameServerForLoginMessage
GameServer (assigned by PlanetServer)
    → SessionRequest → ClientIdMsg → CmdStartScene
        → consume SceneCreateObjectByCrc flood → SceneEndBaselines
        → CmdSceneReady (now "zoned in")
        → optional script (walk, survey, craft, attack, chat, ...)
        → LogoutMessage → SOE Terminate
```

Exercises every server in the cluster (LoginServer, CentralServer,
ConnectionServer, SwgDatabaseServer, PlanetServer, SwgGameServer). Catches
wire-format drift instantly on any submodule bump — a struct-shape mismatch
that would crash the Windows client at frame 600 fails `pnpm test` in seconds.

What's available beyond the basic lifecycle:

- **Working movement** — `walkTo` / `walkCircle` / `walkToCell` drive the
  real `ObjControllerMessage(CM_netUpdateTransform=113)` wire path with auto
  teleport-ack bootstrap. Characters actually move in-game; positions are
  validated by the server's anti-cheat speed window.
- **Survey + sample flow** — `fetchSurveyResources(toolId)` triggers the
  radial-menu "Use" flow to get the spawned resource list, then
  `survey(toolId, resourceTypeName)` + `waitForSurvey()` rounds out the full
  scan. `fetchResourceAttributes()` returns full OQ/CR/DR/... stats for any
  ResourceTypeObject via `getAttributesBatch` — no physical core-sampling
  required.
- **Resource harvesting** — `sample(toolId, resourceTypeName)` starts the
  server's ~30s-tick sample loop; `waitForSampleEvent()` classifies each
  tick (`located` / `failed` / `cancel` / `in_progress` / `mind` / `density`
  / `trace`). Units stack into matching inventory containers automatically.
  `cancelSampling()` terminates the loop cleanly.
- **Crafting session (discovery-driven)** — open a session, walk the
  available draft schematics (`waitForDraftSchematics`), pick one, read its
  slot requirements (`waitForDraftSlots`), assign/clear resource
  ingredients, run experimentation passes, finalize a prototype. See
  `scripts/craft-a-tool.ts` for a complete end-to-end demo that crafts a
  survey tool from harvested resources.
- **Missions** — request mission list from a terminal, accept, abort, remove.
- **Group + full SecureTrade** — invite/join/disband + `ctx.tradeWith(otherId,
  { items?, credits? })` drives the full 9-message handshake (BeginTrade /
  AddItem / RemoveItem / GiveMoney / AcceptTransaction / UnAcceptTransaction
  / VerifyTrade / TradeComplete / AbortTrade) end-to-end. See
  `scripts/group-trade-demo.ts`.
- **Commodities / bazaar / auction house** — `browseBazaar`, `getAuctionDetails`,
  `bidOn`, `listForSale`, `retrieveBazaarItem`, `cancelMyListing`. Full
  `Auction*`/`Bid*`/`Create*` message family with palettized headers response
  decoder and advanced-search conditions. Bundled scenario: `bazaar-snipe`.
- **SUI dialogs + NPC conversation** — receive server-pushed SUI pages
  (`waitForSui` / `respondToSui`); drive NPC handshake (`talkTo` /
  `waitForNpcDialog` / `selectDialog` / `endConversation`). Pairs the
  server's two-subtype prompt + responses into one `NpcDialogPrompt`.
- **Vehicle / Mount / Pet** — `callVehicle`, `mount`, `dismount`, `storeVehicle`,
  `callPet`, `storePet`, `petCommand`. Movement primitives auto-clamp to
  the mounted speed cap. Bundled scenario: `ride-vehicle`.
- **Reconnect-verification harness** — `reconnectVerify({ mutate, observe? })`
  runs two `fullLifecycle` passes and snapshots/diffs the persisted state
  to catch DB save/load regressions automatically.
- **Send-path fragmentation** — `SoeConnection.sendApp` auto-splits payloads
  >489 bytes into chained `Fragment1` packets (was: small-sends only).
- **Chat** — spatial `say` (uses the server's `spatialChatInternal` command,
  the same path the real Windows client uses), `tell`, mail, channel post.
- **Combat / posture / dance** — `attackTarget`, `useAbility`,
  `changePosture`, `startDance`.
- **Fleet** — run N independent clients in parallel with staggered launches,
  per-outcome error isolation, per-message-name summary stats.
- **Capture + replay** — record any session as NDJSON, replay against a fresh
  server to detect wire-format drift.
- **Character pool** — JSON-backed, lockfile-coordinated pool of pre-created
  characters for tests that need many accounts without leaking new chars per
  run.
- **ObjController subtype decoders** — 28+ in-game message subtypes decoded
  for assertion (combat, movement, posture, mood, chat, crafting, missions,
  groups, trade, menus, NPC conversation, mount/dismount, etc.).

See `docs/scripting.md` for the full `ScriptContext` API, `docs/wire-spec.md`
for the byte-level reference, and `scripts/examples/` for ~25 ready-to-run
example scenarios.

## Quickstart

```bash
# Requires Node 24 (see .nvmrc) and pnpm
nvm use
pnpm install
pnpm test                                              # ~1152 unit tests, no server needed
LIVE=1 pnpm test tests/integration/live-login.test.ts  # one live test
LIVE=1 pnpm test                                       # full suite (~1177 tests)

# Plain zone-in
pnpm cli zone --host=10.254.0.253 --user=ci-test --character=TsTest

# Scripted scenario during the dwell
pnpm cli zone --host=10.254.0.253 --user=ci-test --character=TsTest \
    --script=walk-circle --script-arg=radius=8 --script-arg=durationMs=3000

# Multi-client load test (3 parallel clients with 500ms stagger)
pnpm cli swarm --host=10.254.0.253 --count=3 --user-prefix=fleet --stagger-ms=500

# Record + replay a session
pnpm cli capture --host=10.254.0.253 --user=ci-test --character=TsTest \
    --output=/tmp/zone-in.ndjson
pnpm cli replay  --host=10.254.0.253 --user=ci-test --character=TsTest \
    --input=/tmp/zone-in.ndjson --pacing=asFast
```

To avoid leaking timestamp-suffixed accounts/characters on the test DB,
set `CI_REUSE_ACCOUNT` and `CI_REUSE_CHARACTER` to a pinned pair (live
tests then run sequentially because the server allows one session per
account — see `vitest.config.ts`).

## CLI

Four subcommands: `zone`, `swarm`, `capture`, `replay`. Exit code is 0 on
success, 1 on failure. JSON always goes to stdout; logs to stderr.

### `zone` flags

| Flag | Default | Notes |
|------|---------|-------|
| `--host` | `127.0.0.1` | LoginServer UDP address |
| `--port` | `44453` | LoginServer UDP port |
| `--user` | (required) | Account name. Max 15 chars (server limit). |
| `--character` | optional | Character name. If supplied and the account has no characters, one is created. |
| `--cluster` | first | Cluster name to attach to (typically `swg`). |
| `--planet` | `mos_eisley` | `starting_locations.iff` key (NOT a planet name); for character creation only |
| `--profession` | `combat_brawler` | for character creation only |
| `--hold-ms` | `5000` | Time to dwell in the zoned-in state before logging out |
| `--script` | optional | Name of a bundled scenario to run during the dwell: `walk-line`, `walk-circle`, `open-inventory`, `combat-attack`, `posture-cycle`, `survey`, `dwell` |
| `--script-arg=k=v` | repeatable | Scenario args (e.g. `--script-arg=radius=8`) |
| `--verbose` | off | Stream message names + state transitions to stderr |
| `--skip-game` | off | Stop after `SelectCharacter` (skip zone-in + logout) |
| `--no-pretty` | off | Single-line JSON instead of pretty-printed |

### `swarm` (Fleet) flags

Per-client config is derived from `--user-prefix=<p>` → accounts `${p}<runTag>0`, `${p}<runTag>1`, …
Character names follow `Fleet${p}<i>`.

| Flag | Default | Notes |
|------|---------|-------|
| `--count` | required | Number of parallel clients |
| `--user-prefix` | `fleet` | Account-name prefix (capped to 15 chars total) |
| `--stagger-ms` | `0` | Delay between client launches for ramp-up |
| `--max-concurrent` | `0` (unlimited) | Concurrency cap |
| `--hold-ms`, `--planet`, `--skip-game`, `--verbose`, `--no-pretty` | (same as `zone`) | |

### `capture` / `replay` flags

| Flag | Notes |
|------|-------|
| `--output=<path>.ndjson` | (capture) Where to write the NDJSON transcript |
| `--input=<path>.ndjson` | (replay) Capture file to replay |
| `--pacing=asFast\|asCaptured` | (replay) Replay sends back-to-back, or honor original timing |
| `--compare=names\|count` | (replay) Compare observed recv names ordered (default) or as a multiset |

Replay exits 1 if any expected recv name is missing from the observed stream.

## Programmatic use

### Simple zone-in

```typescript
import { SwgClient } from '@swg/ts-client';

const client = new SwgClient({
  loginServer: { host: '10.254.0.253', port: 44453 },
});

const result = await client.fullLifecycle({
  account: 'ci-test',
  characterName: 'TsTest',        // created if not in avatar list
  planet: 'mos_eisley',           // starting_locations.iff key
  holdZonedInMs: 5000,
  onTranscript: (event) => console.log(event.direction, event.messageName),
  onStateChange: (state) => console.log('->', state),
});

// result.baselineObjectCount > 0 means we zoned in successfully
// result.transcript[] is the full send + recv trace
```

### Scripted scenario

```typescript
import { SwgClient, ScenarioFn } from '@swg/ts-client';

const myScenario: ScenarioFn = async (ctx) => {
  // Movement primitives use the real CM_netUpdateTransform wire path and
  // auto-ack the zone-in teleport lockout on first call.
  await ctx.walkTo({ x: -100, z: 50 }, { speed: 4 });
  await ctx.walkCircle({ centerX: -100, centerZ: 50, radius: 10, durationMs: 5_000 });

  // Inventory / chat
  ctx.openPlayerInventory();
  ctx.tell('SomeFriend', 'hi');
  ctx.say('hello world');

  // Combat
  ctx.attackTarget(someTargetNetworkId);
  await ctx.wait(1_000);
  await ctx.logout();
};

const result = await client.fullLifecycle({
  account, characterName, script: myScenario,
});

// result.scriptResult — { elapsedMs, sendsCount, didLogout, error? }
```

### Survey + resource stats

```typescript
const surveyScenario: ScenarioFn = async (ctx) => {
  // Walk to the spot you want to survey
  await ctx.walkTo({ x: 3527, z: -4806 });

  // For each survey tool in inventory, fetch the spawned resource types
  // (server replies with ResourceListForSurveyMessage), then survey each
  // type by name.
  const types = await ctx.fetchSurveyResources(mineralToolId);
  for (const type of types) {
    ctx.survey(mineralToolId, type.resourceName);
    const survey = await ctx.waitForSurvey({ timeoutMs: 30_000 });
    console.log(type.resourceName, 'max efficiency =',
      Math.max(...survey.points.map(p => p.efficiency)));
  }

  // For any resource type, fetch its full OQ/CR/DR/HR/SR/UT/... stat block
  // in one batched request — no physical core-sampling needed.
  const stats = await ctx.fetchResourceAttributes(
    types.map(t => t.resourceId),
  );
  for (const [id, attrs] of stats) {
    console.log(id, attrs.map(p => `${p.key}=${p.value}`).join(' '));
  }
};
```

`scripts/check-resources-at-location.ts` is a ready-to-run CLI that uses all
of the above to survey every resource class at a given coordinate and dump
stats for anything above a density threshold.

### Multi-client load test

```typescript
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

// result.summary  — totalClients, succeeded, failed, totalElapsedMs, ...
// result.outcomes — per-client { config, lifecycleResult?, error? }
```

### Capture and replay

```typescript
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
if (!res.succeeded) console.error('wire drift detected:', res.missing);
```

See `docs/scripting.md` for the full `ScriptContext` API and the
ObjController subtype dispatch.

## Architecture

| Layer | Files | Notes |
|---|---|---|
| CRC | `src/crc/` | `Crc32` (with encryptCode seed scramble) + `constcrc` (custom CRC for message names — NOT standard CRC32) |
| Archive | `src/archive/` | The wire serialization library: `ByteStream`, `ReadIterator`, primitives, `std::string`, `Unicode::String`, `NetworkId`, `Transform`, `AutoArray<T>`, `AutoVariable<T>` |
| SOE | `src/soe/` | UDP transport: SessionRequest/Response, XOR encrypt, UserSupplied (zlib) encrypt, CRC32, reliable channel, multipacket, fragment reassembly |
| Messages | `src/messages/` | 35+ top-level GameNetworkMessages (login/connection/game/chat/command-queue/survey) + 25+ ObjController subtype decoders (combat, movement, posture, mood, chat, crafting, missions, groups, menus, etc.) |
| Client | `src/client/` | Orchestrator (`swg-client.ts`), dispatcher, per-stage drivers (`login-stage`, `connection-stage`, `game-stage`), `fleet.ts`, `transcript-io.ts`, `replay.ts`, `character-pool.ts` |
| Script | `src/client/script/` | `ScriptContext` interface + primitives (`movement.ts` — `walkTo`/`walkCircle`/`walkToCell` over `CM_netUpdateTransform=113` with auto teleport-ack; survey/sample helpers; crafting; chat; combat; missions; groups; expectations) |
| Scenarios | `src/scenarios/` | CLI-loadable scenario factories (`walk-line`, `walk-circle`, `open-inventory`, `combat-attack`, `posture-cycle`, `survey`, `group-trade`, `dwell`) |
| Examples | `scripts/examples/` | ~25 ready-to-run example scripts: walking patterns, surveying loops, chat bots, parade/dance, crafting soak, mail-blast, combat-then-flee, etc. |

## Reference

- `docs/wire-spec.md` — distilled byte-level spec
- `docs/lifecycle.md` — 4-stage state diagram (with script hook)
- `docs/adding-a-message.md` — recipe for new top-level messages + ObjController subtypes
- `docs/scripting.md` — `ScriptContext` API, bundled scenarios, Fleet, capture/replay
- `../swg-main/CLAUDE.md` — the server side (read this first if you're new)

Ground truth is the C++ source at `~/code/swg-main/src/` — never modified,
always referenced.
