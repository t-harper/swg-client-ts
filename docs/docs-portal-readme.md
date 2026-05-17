# `@swg/ts-client` — Docs portal

A headless TypeScript SWG wire-compatible client. Drives a full
**login → ConnectionServer auth → character create → SelectCharacter →
zone-in → scripted in-world behavior → clean logout** lifecycle against a
real `swg-server`. The basic lifecycle finishes in ~5 seconds; scripted
scenarios run for as long as you want (movement, surveying, sampling,
crafting, chat, combat, missions, groups — all driven through real wire
paths).

This portal is generated on every push to `main` via the
[`Docs portal` GitHub Actions workflow](https://github.com/t-harper/swg-client-ts/actions).
The `Wire-message reference` page is rebuilt from the live registries via
`scripts/gen-wire-docs.ts` before TypeDoc runs, so it always reflects the
current `messageRegistry` + `objControllerRegistry` populations.

## Where to start

- **[Scripting quickref](documents/Scripting_quickref.html)** — every
  method, sugar query, and always-on view a script can call during the
  zoned-in dwell, grouped by category.
- **[Scripting cookbook](documents/Scripting_cookbook.html)** — every
  bundled scenario in `src/scenarios/` with its CLI name, factory link,
  and the prose JSDoc.
- **[ScriptContext API](interfaces/index.ScriptContext.html)** — the typed
  interface with parameters, return types, and any `@example` blocks.
- **[Wire-message reference](documents/Wire-message_reference.html)** —
  auto-indexed table of every registered top-level `GameNetworkMessage`
  and every `ObjController` subtype, with CRCs, ids, source paths, and
  one-line descriptions.
- **[Lifecycle](documents/lifecycle.html)** — state diagram and
  per-stage walkthrough.
- **[Wire spec](documents/wire-spec.html)** — distilled byte-level spec
  for the SOE UDP layer and `GameNetworkMessage` framing.
- **[Adding a message](documents/adding-a-message.html)** — recipe for
  wiring a new wire-format message in.

## Always-on views (`ctx.world`, `ctx.character`, `ctx.inventory`, `ctx.datapad`)

Reactive snapshots, kept current by the dispatcher loop — no polling, no
transcript walking. Read them at any time inside a scenario; they pin to
the player at zone-in and detach automatically at logout.

| View | Symbol | Purpose |
|---|---|---|
| `ctx.world` | [`WorldModel`](classes/index.WorldModel.html) | Live `Map<NetworkId, WorldObject>` populated by the baseline flood. |
| `ctx.character` | [`CharacterSheet`](interfaces/index.CharacterSheet.html) | Live view of the player's CREO + PLAY baselines (HAM, posture, cash, skills, level, group). |
| `ctx.inventory` | [`InventoryView`](interfaces/index.InventoryView.html) | Auto-opened at zone-in; `items`, `findByTemplate(re)`, `findById(id)`. |
| `ctx.datapad` | [`DatapadView`](interfaces/index.DatapadView.html) | Auto-opened at zone-in; `vehicles()`, `pets()`, `waypoints()`, `missions()`. |

## Entry point

The public surface for consumers lives at [`src/index.ts`](modules.html).
Anything not re-exported from there is internal and may change without
notice.

```ts
import {
  SwgClient,
  type ScenarioFn,
  scenarios,
} from '@swg/ts-client';

const client = new SwgClient({ loginServer: { host: '10.254.0.253', port: 44453 } });
const result = await client.fullLifecycle({
  account: 'ci-test',
  characterName: 'TsTest',
  script: scenarios['walk-circle']({ radius: '8', durationMs: '5000' }),
});
console.log(result.scriptResult);
```

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
