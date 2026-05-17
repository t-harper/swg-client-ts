# `@swg/ts-client` — Quickstart

Headless TypeScript SWG wire-compatible client. Drives a full
**login → ConnectionServer auth → character create → SelectCharacter →
zone-in → scripted in-world behavior → clean logout** lifecycle against a
real `swg-server`. The basic lifecycle finishes in ~5 seconds; scripted
scenarios run for as long as you want (movement, surveying, sampling,
crafting, chat, combat, missions, groups — all driven through real wire
paths).

This portal is generated on every push to `main` via the
[`Docs portal` GitHub Actions workflow](https://github.com/t-harper/swg-client-ts/actions).
The auto-gen pages (Always-on views, Actions, Wire-message reference,
Scripting cookbook) are rebuilt from source by `scripts/gen-wire-docs.ts`
before TypeDoc runs, so they always reflect the current `ScriptContext`,
`messageRegistry`, `objControllerRegistry`, and `src/scenarios/`.

## Where to start

1. **[Quickstart snippet](#one-minute-quickstart)** below — copy / paste a
   full lifecycle into a `.ts` file.
2. **[Always-on views](documents/Always-on_views.html)** — every `ctx.*`
   field a script can read at any time. Reactive snapshots kept current by
   the dispatcher loop; no polling required.
3. **[Actions](documents/Actions.html)** — every method on
   `ScriptContext` (movement, combat, chat, crafting, survey, missions,
   vehicles, SUI dialogs, NPC conversation, trade, bazaar).
4. **[Wire-message reference](documents/Wire-message_reference.html)** —
   auto-indexed table of every registered top-level `GameNetworkMessage`
   and every `ObjController` subtype, with CRCs, ids, source paths, and
   one-line descriptions.
5. **[Scripting cookbook](documents/Scripting_cookbook.html)** — every
   bundled scenario in `src/scenarios/` with its CLI name, factory link,
   and the prose JSDoc.
6. **Internals** (less commonly needed):
   - [Lifecycle](documents/lifecycle.html) — state diagram and per-stage
     walkthrough.
   - [Wire spec](documents/wire-spec.html) — distilled byte-level spec
     for the SOE UDP layer and `GameNetworkMessage` framing.
   - [Adding a message](documents/adding-a-message.html) — recipe for
     wiring a new wire-format message in.

## One-minute quickstart

```ts
import { SwgClient, type ScenarioFn, scenarios } from '@swg/ts-client';

// 1) Compose a scenario from `ctx.*` views + actions.
const myScenario: ScenarioFn = async (ctx) => {
  // Always-on views: read live state any time, no polling.
  console.log('Health:', ctx.character.health, '/', ctx.character.maxHealth);
  console.log('Players in range:', ctx.playersInRange(50).length);

  // Actions: drive wire traffic.
  await ctx.walkTo({ x: -100, z: 50 }, { speed: 5 });
  const target = ctx.nearestHostile({ maxRadiusM: 40 });
  if (target) await ctx.combat.attackingNearest({ timeoutMs: 30_000 });
  await ctx.logout();
};

// 2) Or pick a bundled scenario from `src/scenarios/`.
const walkLoop = scenarios['walk-circle']({ radius: '8', durationMs: '5000' });

// 3) Hand it to the orchestrator.
const client = new SwgClient({
  loginServer: { host: '10.254.0.253', port: 44453 },
});
const result = await client.fullLifecycle({
  account: 'ci-test',
  characterName: 'TsTest',
  script: myScenario,            // or `walkLoop`
});

console.log(result.scriptResult); // { elapsedMs, sendsCount, didLogout, error? }
```

## Public API surface

The full typed surface for consumers is at
[`src/index.ts`](modules.html). Anything not re-exported from there is
internal and may change without notice.

The canonical entry types are:

- [`SwgClient`](classes/index.SwgClient.html) — orchestrator with
  `fullLifecycle()`.
- [`ScriptContext`](interfaces/index.ScriptContext.html) — the runtime
  passed into every scenario (parameters, return types, `@example`
  blocks).
- [`Fleet`](classes/index.Fleet.html) — N independent `SwgClient`s in
  parallel for load tests.
- [`captureLifecycle`](functions/index.captureLifecycle.html) +
  [`replay`](functions/index.replay.html) — wire-transcript capture +
  replay for drift detection.

## Wire-format gotchas

Six things that are easy to get wrong are detailed in `CLAUDE.md` in the
repo; the most-cited:

1. `constcrc()` is **not** standard CRC32 — uses a 256-entry custom table.
2. Every message wire-frame is `[u16 LE varCount][u32 LE typeCrc][payload]`.
3. Client→server movement is `ObjControllerMessage(CM_netUpdateTransform=113)`,
   not the top-level `UpdateTransformMessage`.

See [Wire spec](documents/wire-spec.html) and
[Wire-message reference](documents/Wire-message_reference.html) for the
full set.
