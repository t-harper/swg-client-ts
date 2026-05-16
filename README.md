# @swg/ts-client

Headless TypeScript SWG wire-compatible client. Speaks the SOE UDP protocol +
SWG's `GameNetworkMessage` layer well enough to perform the full login →
zone-in → logout lifecycle against a running SWG-Source server. Built for CI,
load testing, regression detection, fuzzing, and protocol documentation —
**not** for actually playing the game (no rendering, no audio, no animation).

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
        → optional script (walk, attack, chat, open inventory, ...)
        → LogoutMessage → SOE Terminate
```

Exercises every server in the cluster (LoginServer, CentralServer,
ConnectionServer, SwgDatabaseServer, PlanetServer, SwgGameServer) and would
have caught the [Aug 2021 wire-format mismatch bug](
../swg-main/CLAUDE.md#the-big-one--submodule-pin-must-match-the-prebuilt-client)
instantly on any submodule bump.

Beyond the basic lifecycle, you get:

- **Scripting engine** — async scenario functions with primitives for movement
  (`walkTo`, `walkCircle`), inventory (`openPlayerInventory`), combat
  (`attackTarget`, `useAbility`, `changePosture`), chat (`tell`, `sendMail`,
  `sendToChannel`), and lifecycle (`wait`, `logout`).
- **Fleet** — run N clients in parallel with staggered launches and a
  concurrency cap. Per-outcome error isolation; per-message-name summary stats.
- **Capture + replay** — record any session as NDJSON, replay against a fresh
  server to detect wire-format drift. Powerful regression tool after submodule
  bumps.
- **ObjController subtype decoders** — 8 most common in-game messages
  (CombatAction, PostureChange, AttributeChanged, …) decoded for assertion.

See `docs/scripting.md` for the full surface.

## Quickstart

```bash
# Requires Node 24 (see .nvmrc) and pnpm
nvm use
pnpm install
pnpm test                                              # 413 unit tests, no server needed
LIVE=1 pnpm test tests/integration/live-login.test.ts  # one live test
LIVE=1 pnpm test                                       # full suite (419 tests)

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
| `--script` | optional | Name of a bundled scenario to run during the dwell: `walk-line`, `walk-circle`, `open-inventory`, `combat-attack`, `posture-cycle`, `dwell` |
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
  await ctx.walkTo({ x: -100, z: 50 }, { speed: 5 });
  await ctx.walkCircle({ centerX: -100, centerZ: 50, radius: 10, durationMs: 5_000 });
  ctx.openPlayerInventory();
  ctx.tell('SomeFriend', 'hi');
  ctx.attackTarget(targetNetworkId);
  await ctx.wait(1_000);
  await ctx.logout();
};

const result = await client.fullLifecycle({
  account, characterName, script: myScenario,
});

// result.scriptResult — { elapsedMs, sendsCount, didLogout, error? }
```

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
| Messages | `src/messages/` | 32 top-level GameNetworkMessages (login/connection/game/chat/command-queue) + 8 ObjController subtype decoders |
| Client | `src/client/` | Orchestrator (`swg-client.ts`), dispatcher, per-stage drivers (`login-stage`, `connection-stage`, `game-stage`), `fleet.ts`, `transcript-io.ts`, `replay.ts` |
| Script | `src/client/script/` | `ScriptContext` interface + movement primitives (`walkTo`, `walkCircle`) |
| Scenarios | `src/scenarios/` | CLI-loadable scenario factories (`walk-line`, `walk-circle`, `open-inventory`, `combat-attack`, `posture-cycle`, `dwell`) |

## Reference

- `docs/wire-spec.md` — distilled byte-level spec
- `docs/lifecycle.md` — 4-stage state diagram (with script hook)
- `docs/adding-a-message.md` — recipe for new top-level messages + ObjController subtypes
- `docs/scripting.md` — `ScriptContext` API, bundled scenarios, Fleet, capture/replay
- `../swg-main/CLAUDE.md` — the server side (read this first if you're new)

Ground truth is the C++ source at `~/code/swg-main/src/` — never modified,
always referenced.
