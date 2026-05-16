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
        → optional dwell + heartbeats
        → LogoutMessage → SOE Terminate
```

This MVP exercises every server in the cluster (LoginServer, CentralServer,
ConnectionServer, SwgDatabaseServer, PlanetServer, SwgGameServer) and would
have caught the [Aug 2021 wire-format mismatch bug](
../swg-main/CLAUDE.md#the-big-one--submodule-pin-must-match-the-prebuilt-client)
instantly on any submodule bump.

## Quickstart

```bash
# Requires Node 24 (see .nvmrc) and pnpm
nvm use
pnpm install
pnpm test                                              # unit tests (no server needed)
LIVE=1 pnpm test tests/integration/live-login.test.ts  # one live test
LIVE=1 pnpm test                                       # all unit + live tests

# CLI: do a full zone-in lifecycle and dump JSON event log
pnpm cli zone --host=10.254.0.253 --user=ci-test --character=TsTest --planet=mos_eisley
```

## CLI flags

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
| `--verbose` | off | Stream message names + state transitions to stderr |
| `--skip-game` | off | Stop after `SelectCharacter` (skip zone-in + logout) |
| `--no-pretty` | off | Single-line JSON instead of pretty-printed |

Exit code: 0 on success, 1 on failure. JSON always goes to stdout; logs
to stderr.

## Programmatic use

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

## Architecture

| Layer | Files | Notes |
|---|---|---|
| CRC | `src/crc/` | `Crc32` (with encryptCode seed scramble) + `constcrc` (custom CRC for message names — NOT standard CRC32) |
| Archive | `src/archive/` | The wire serialization library: `ByteStream`, `ReadIterator`, primitives, `std::string`, `Unicode::String`, `NetworkId`, `Transform`, `AutoArray<T>`, `AutoVariable<T>` |
| SOE | `src/soe/` | UDP transport: SessionRequest/Response, XOR encrypt, UserSupplied (zlib) encrypt, CRC32, reliable channel, multipacket, fragment reassembly |
| Messages | `src/messages/` | Per-class definitions for ~22 message types covering login → zone-in → logout |
| Client | `src/client/` | The 3-stage orchestrator wrapping it all into a single `await client.fullLifecycle()` |

## Reference

All wire-format facts are documented in:

- `docs/wire-spec.md` — distilled byte-level spec
- `docs/lifecycle.md` — 4-stage state diagram
- `docs/adding-a-message.md` — recipe for the next ~80 messages (gameplay)
- `../swg-main/CLAUDE.md` — the server side (read this first if you're new)

Ground truth is the C++ source at `~/code/swg-main/src/` — never modified,
always referenced.
