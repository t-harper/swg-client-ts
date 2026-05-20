# Control socket — introspect & steer a running session

A long-running bot or scripted `fullLifecycle` session is otherwise a black box:
once it's up, the only controls are an in-game `/say kill` and SIGINT, and
neither lets you *read* live state. The **control socket** fixes that. A session
host binds a Unix-domain socket; an external `swg-ts-cli ctl …` client connects
over a tiny NDJSON line protocol to **query** live state (world, character
sheet, inventory, location, …) and issue **write-actions** (stop, logout,
restart, pause/resume, say, trigger, reload).

`reload` is the dev-loop payoff: it re-imports edited scenario code and re-runs
it **against the still-connected game session** — iterate on bot behavior in
subseconds instead of paying a full login → zone-in on every change.

The library lives in `src/client/control/`; the CLI surface is `swg-ts-cli ctl`.

## Quick tour

```bash
# terminal 1 — start a bot (it binds a control socket automatically)
pnpm tsx bin/entertainer-bot.ts --user=tslive06 --character=Bard2 --verbose

# terminal 2 — introspect and steer it
pnpm cli ctl list                                  # discover live sessions
pnpm cli ctl status        --session=entbot-Bard2  # session + zone state
pnpm cli ctl get character --session=entbot-Bard2  # full character sheet
pnpm cli ctl get world --param=limit=10 --session=entbot-Bard2
pnpm cli ctl pause         --session=entbot-Bard2  # suspend bot behavior
pnpm cli ctl say "intermission" --session=entbot-Bard2
pnpm cli ctl resume        --session=entbot-Bard2
# …edit scripts/entertainer-bot-scenario.ts, then:
pnpm cli ctl reload        --session=entbot-Bard2  # new code, no reconnect
pnpm cli ctl stop          --session=entbot-Bard2  # end the session
```

Every `ctl` command prints one JSON object on stdout and exits `0` on
`{ ok: true }`, `1` on `{ ok: false }`, `2` on a usage error.

## Sessions & discovery

A session host writes two files under `~/.swg-ts-client/sessions/`:

| File | Purpose |
|---|---|
| `<name>.sock` | the Unix-domain socket itself (chmod `0600`, owner-only) |
| `<name>.json` | metadata sidecar — `{ name, pid, account, character, planet, socketPath, protocolVersion, startedAt, supervised }` |

On bind, a stale `.sock` left by a crashed process is probed with a `status`
ping — if it answers, the bind fails ("session already running"); if the
connection is refused, the stale socket is unlinked and re-bound. `stop()`
removes both files; a `process.on('exit')` unlink is the backstop.

**Session names** default per host (override with `--control-socket=<name>` /
`controlSocket`):

| Host | Default name |
|---|---|
| `bin/entertainer-bot.ts` | `entbot-<character>` |
| `bin/buff-bot.ts` | `buffbot-<character>` |
| `pnpm cli zone --supervise` | `zone-<user>` |

`ctl list` scans the sidecars, probes each socket, and reports liveness
(`pidAlive`, `socketAlive`), reaping dead entries. Every other `ctl` command
resolves its target this way: `--socket=<path>` wins; else `--session=<name>`
maps to `sessions/<name>.sock`; else if exactly one session is live it is used
automatically; otherwise you get an error listing the candidates.

## Queries — `ctl get <query>` / `ctl status`

Read-only. All payloads are JSON-safe (bigint → decimal string, `Date` → ISO,
`Uint8Array` → hex, `Map` → object).

| Query | Returns |
|---|---|
| `status` | session directive, zone state, `protocolVersion`, character name/level, whether performing — answers even before zone-in completes |
| `character` | full `CharacterSheet.toJSON()` (identity, HAM, skills, performance, …) |
| `world` | `WorldModel` objects — filter with `--param=type=…`, `--param=near=…`, `--param=limit=…`, `--param=includeBaselineData=true` |
| `inventory` | inventory container tree |
| `location` | planet, world position, containing cell/building |
| `group` | group members + roles |
| `combat` | current target, posture, HAM, defenders |
| `cooldowns` | active ability cooldown timers |
| `datapad` | datapad contents (waypoints, schematics, vehicles, …) |
| `knowledge` | process-wide `Knowledge` cache summary |

`ctl status` is its own top-level action (no `get`); the rest go through
`ctl get <query>`. World snapshots are large — the query is lean by default;
opt into baseline blobs with `--param=includeBaselineData=true`.

## Write-actions

Each action sets a directive on the session's `SessionControl` state machine.

| Action | Effect | Directive |
|---|---|---|
| `pause` | bot idle loop suspends behavior (still answers queries) | `paused` |
| `resume` | leave `paused` | `run` |
| `say <text…>` | send in-game spatial chat | — |
| `trigger <name>` | invoke a scenario-registered named action | — |
| `reload` | re-import edited scenario code, re-run on the **same** connection | `reload` → `run` |
| `restart` | drop the connection, reconnect the same character | `restart` → `run` |
| `stop` | end the session immediately | `stop` (terminal) |
| `logout` | graceful in-game logout, then end the session | `logout` (terminal) |

`run` ↔ `paused` toggle freely. `reload` and `restart` are transient — handled,
then cleared back to `run`. `stop` and `logout` are terminal: the supervisor
loop exits and the process ends.

## The supervisor — restart & reload

`restart` and `reload` are two different loops. The supervisor outer loop owns
the socket for the process lifetime and drives `restart`; game-stage's inner
loop drives `reload`:

```
runSupervised()                    ── OUTER loop — owns the control socket
  └ ControlServer.start()             binds ~/.swg-ts-client/sessions/<name>.sock
  └ while (true):
      client.fullLifecycle({ scriptProvider, sessionControl, controlSocket })
        └ runGameStage()           ── INNER loop — one game connection
            └ while (true):
                createScriptContext(…same world / dispatcher…)
                runScript(scenarioFn, ctx)        ← idle loop watches SessionControl
                if directive == 'reload':
                    scriptProvider()  → re-imported code, continue  (SAME connection)
                else break
      if directive == 'restart': continue          (NEW connection, same character)
      else break
```

- **`reload`** keeps the live game connection. The inner loop builds a fresh
  `ScriptContext` against the same dispatcher / connection / `WorldModel`,
  re-invokes `scriptProvider()` (which re-imports the scenario module with a
  cache-busting query string), and runs the new code. Sequence-counter
  high-water marks are forwarded into the next context so the server doesn't
  reject stale sequences. Subsecond — no login, no zone-in.
- **`restart`** drops and re-establishes the connection: a new
  `fullLifecycle` iteration, the same character, the warm process-wide
  `Knowledge` cache. Useful when the game session itself is wedged.
- A reload that hits a **compile error** keeps the connection alive, pauses,
  and surfaces the error — fix the code and `ctl reload` again.

## Two-module bot split

`reload` re-imports scenario code, so that code must be **import-safe** — a
module that runs `main()` at import time can't be dynamically re-imported.
Each bot is therefore two files:

| File | Role |
|---|---|
| `scripts/<bot>-scenario.ts` | import-safe — exports `makeScenario` + args/constants, **no top-level execution**. `reload` re-imports *this*. |
| `scripts/<bot>.ts` | thin entry — `parseArgs` + `runSupervised` + signal handlers. |
| `bin/<bot>.ts` | one-line shim that imports `../scripts/<bot>.ts`. |

When you `ctl reload`, only the `-scenario.ts` half is re-imported (with
`import(url + '?v=' + Date.now())`); the cached `@swg/ts-client` graph stays
intact. Edit the scenario half freely between reloads.

`trigger` invokes actions a scenario registered via
`session.registerAction(name, fn)`. The registry is cleared at the start of
each script run, so a reload re-registers exactly the action set the *current*
code defines — a removed `registerAction` call really removes the trigger.

## Programmatic API

Exported from `@swg/ts-client`.

**Any scripted session** — pass `controlSocket` to bind a server for the
single script run (no supervisor, no reload/restart):

```typescript
await client.fullLifecycle({
  account, characterName,
  script: myScenario,
  controlSocket: 'my-session',   // ~/.swg-ts-client/sessions/my-session.sock
});
```

Or on the CLI: `pnpm cli zone … --script=<name> --control-socket=my-session`.

**A supervised host** — `runSupervised` is the outer loop both bots use; it
enables `restart` and `reload`:

```typescript
import { SwgClient, runSupervised } from '@swg/ts-client';

await runSupervised({
  client: new SwgClient({ loginServer: { host, port } }),
  sessionName: 'my-bot',
  scriptProvider: () => import(`./my-scenario.js?v=${Date.now()}`).then((m) => m.makeScenario(args)),
  lifecycle: { account, characterName },
  restartSettleMs: 8000,   // wait after logout before reconnecting on restart
});
```

`pnpm cli zone --supervise --script=<name>` runs the supervised loop for a
bundled scenario (requires `--script`).

**A control client** — `controlRequest(socketPath, spec, opts)` is the
one-shot UDS request helper the `ctl` CLI is built on.

Other exports: `ControlServer`, `createSessionControl` + `SessionControl` /
`SessionDirective` / `SessionActionFn`, `CONTROL_PROTOCOL_VERSION`, and the
`ControlRequest` / `ControlResponse` / `ControlErrorCode` protocol types.

## NDJSON protocol

One JSON object per line, `\n`-terminated. A client writes one request line and
reads exactly one response line, correlated by `id`. UDS `data` events don't
respect message boundaries, so both ends buffer partial chunks via `readLines`
(which throws on an over-long line — an unbounded-buffer guard).

```jsonc
// request
{ "id": "c-1", "kind": "query",  "name": "status" }
{ "id": "c-2", "kind": "action", "name": "say", "params": { "text": "hi" } }
// response
{ "id": "c-1", "ok": true,  "data": { … } }
{ "id": "c-2", "ok": false, "error": { "code": "no_session", "message": "…" } }
```

Error codes:

| Code | Meaning |
|---|---|
| `bad_request` | unparseable line / missing fields / over the line limit |
| `unknown_command` | `name` is not a recognized query or action |
| `no_session` | the server is up but no live session is attached yet |
| `not_supported` | recognized, but unavailable in this configuration (e.g. `restart` on a non-supervised host) |
| `session_error` | the query/action ran but threw |

There is no handshake frame — a client verifies compatibility by reading
`protocolVersion` off the `status` response. `CONTROL_PROTOCOL_VERSION` is
bumped only on a breaking change to the request/response shape.

## The dev loop

The reason the feature exists:

```bash
# terminal 1 — bot stays up across every edit
pnpm tsx bin/entertainer-bot.ts --user=tslive06 --character=Bard2 --verbose

# terminal 2 — tighten behavior without ever reconnecting
pnpm cli ctl get character --session=entbot-Bard2   # confirm live state
vim scripts/entertainer-bot-scenario.ts             # edit makeScenario
pnpm cli ctl reload --session=entbot-Bard2          # ~subsecond — new code runs
pnpm cli ctl status --session=entbot-Bard2          # verify
# repeat. when done:
pnpm cli ctl stop --session=entbot-Bard2
```

See also: `tests/integration/live-control-socket.test.ts` exercises the full
query → pause → resume → say → stop round-trip against the live server.
