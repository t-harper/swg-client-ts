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
pnpm test             # unit tests against captured wire fixtures
LIVE=1 pnpm test      # integration tests against the live swg-server at 10.254.0.253

# CLI: do a full zone-in lifecycle and dump JSON event log
pnpm cli zone --host=10.254.0.253 --user=ci-test --planet=tatooine
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
