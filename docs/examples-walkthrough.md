---
title: Examples walkthrough
---

# Examples walkthrough

Annotated reading-guide for the eleven end-to-end scenarios in `scripts/examples/`. Each section explains what the script does, points at the key functions and line ranges, lists the soft-fail conditions, and includes a copy-paste invocation.

For the typed `ScriptContext` API the scenarios call into, see [`views-reference.md`](views-reference.md) and [`actions-reference.md`](actions-reference.md). For the wire protocol underneath, see [`wire-spec.md`](wire-spec.md). For the smaller CLI-loadable scenarios in `src/scenarios/`, see [`scripting-cookbook.md`](scripting-cookbook.md).

## Conventions

Every example follows the same skeleton:

1. **Imports + arg parsing.** `parseCommonArgs(process.argv.slice(2), defaults)` from `_lib.ts` collects the shared `--host` / `--user` / `--character` / `--minutes` / `--verbose` flags; per-scenario flags drop into `args.extra` for a private `parseScriptArgs(extra)` to lift.
2. **Scenario factory.** `buildScenario(args, verbose, out)` returns a `ScenarioFn` (`(ctx) => Promise<void>`) that closes over both the parsed arg struct and a mutable summary object the orchestrator can read out at the end.
3. **`main()`.** Wires `runScenario` (solo) or `runFleet` (multi-character) from `_lib.ts`, folds the scenario summary into `summary.extra`, prints JSON to stdout, and sets the exit code.

The shared utilities in `_lib.ts` worth knowing about:

- `parseCommonArgs`, `usage`, `formatJson` — CLI plumbing.
- `runScenario`, `runFleet` — drive `SwgClient.fullLifecycle` / `Fleet.run`, return a stable JSON summary shape.
- `makeLogger(label, verbose)` — gated stderr logger.
- `durationMs`, `repeatUntil`, `delay`, `nowSeconds`, `unique15` — small helpers.
- `findNearestByTemplate(ctx, pattern, opts?)`, `pollForNearestByTemplate(ctx, pattern, {scanMs, ...})` — one-shot or polling `WorldModel` scan filtered by a `templateName` regex.
- `medianOf(values)`, `dist2(a, b)` — generic math.

Fleet scenarios pass shared mutable state between their per-character `ScenarioFn`s via closure capture — there is no wire-level rendezvous protocol. When a fleet scenario needs each character's `NetworkId` known up front (e.g. to invite the other to a group), it runs a two-phase fleet: a Phase-1 lookup fleet with `skipGameStage: true` to collect ids from Stage 1, then a Phase-2 scenario fleet that closure-captures the resolved ids. The pattern is borrowed from `src/scenarios/group-trade.ts`; see [group-hunt-expedition](#group-hunt-expedition) and [reactive-bodyguard-fleet](#reactive-bodyguard-fleet) for examples.

All scenarios are designed to **soft-fail** on missing world state (no terminal in scene, no survey tool in inventory, no creature in range) — they log the reason via `ctx.fail(reason)`, push it into `summary.assertionFailures`, log out cleanly, and emit the partial JSON. They never throw on a missing prerequisite.

**Movement speed is engine-locked.** `walkTo` / `walkCircle` / `walkToCell` / `navigate` no longer take a `speed?` option; on foot, every script runs at `BASE_RUN_SPEED = 7.3` m/s (the canonical `speed[MT_run]` from `shared_base_player.tpf`). When `ctx.mount(vehicleId, { speedCap })` is in effect, the cap replaces the base run speed — that's the only way to go faster (or slower) than 7.3 m/s. Scripts that previously passed `--walk-speed` / `--ride-speed` / `--evac-speed` flags either drop them entirely (on-foot speed isn't tunable) or feed them into `mount({ speedCap })` instead (mount-tier control still belongs to the scenario).

## Index

| Scenario | Shape | Key chain |
|---|---|---|
| [hunter-crafter](#hunter-crafter) | solo | combat → loot → craft |
| [surveyor-bazaar](#surveyor-bazaar) | solo | survey → sample → bazaar list |
| [mission-marathon](#mission-marathon) | solo | terminal → N missions → navigate → complete |
| [city-recon-surveyor](#city-recon-surveyor) | solo (admin) | terrain grid → walk → buildable probe |
| [shuttle-traveler](#shuttle-traveler) | solo | minimal `ctx.travel` demo |
| [cross-planet-pilgrim](#cross-planet-pilgrim) | solo (admin) | shuttle → re-zone → mission round-trip |
| [bazaar-arbitrage-fleet](#bazaar-arbitrage-fleet) | 3-char | scout + buyer + reseller market-maker |
| [group-hunt-expedition](#group-hunt-expedition) | 4-char | invite + mount + focus-fire + loot share |
| [cantina-troupe](#cantina-troupe) | 4-char | dancers + spotters performance |
| [reactive-bodyguard-fleet](#reactive-bodyguard-fleet) | 2-char | VIP + protector with intercepts + evac |
| [resource-cartographer-fleet](#resource-cartographer-fleet) | 10-char | distributed grid survey + heatmap |

---

## hunter-crafter

**Purpose:** A solo character zones in, hunts the nearest hostile creature, loots its corpse, walks to a crafting tool already in inventory, opens a session against the first draft schematic, fills whatever resource slots it can from inventory, runs one experimentation pass, and finalises a real prototype. Each step soft-fails into the JSON summary when prerequisites are missing (empty zones, NPE characters with no crafting tool, no matching resources) rather than throwing.

**Default character / account:** `tslive01` / `ExHunter`. Single-client scenario — no fleet.

### Flow

1. Wait up to 10s for the first CREO baseline to populate `ctx.character.ready` so `nearestHostile` has SHARED_NP filled in.
2. Scan progressively outward (80 m → 240 m) for a CREO with `inCombat=true`; if none, poll for ~30 s and finally fall back to "any non-self CREO" (some servers don't flip `inCombat` until a real attack lands).
3. Compute a stand-off point 5 m short of the target's hitbox and `ctx.walkTo` it (the movement primitive auto-calls `ackPendingTeleports` so the zone-in lockout doesn't drop the transform).
4. Snapshot the inventory NetworkId set, then call `ctx.combat.attackingNearest` — that sugar drives the per-tick attack cadence and re-targets until the WorldModel drops the target (it died/despawned) or the per-mission budget elapses.
5. If the corpse object still exists, fire `ctx.useAbility('loot', targetId)`; otherwise wait 2.5 s for any auto-loot pushes from the server.
6. Diff inventory IDs against the pre-combat snapshot to count newly-arrived loot.
7. Find a crafting tool by regex over `templateName` / `name` in `ctx.inventory` (and one level into nested bags); soft-fail if none — NPE characters don't start with one.
8. Cancel any stale session via `useAbility('cancelCraftingSession', ...)`, then `ctx.beginCrafting(toolId)` and `await ctx.waitForDraftSchematics`. Pick schematic index 0.
9. `ctx.selectCraftingSchematic(0)` → `await ctx.waitForDraftSlots`. Walk every slot's options for the first `ResourceClass` type, find any inventory crate with `quantity >= amountNeeded`, and `ctx.assignCraftingSlot(i, crate, { optionIndex })`.
10. Optionally `ctx.craftExperiment([{attribute: 0, points: 1}])`, then `ctx.finishCrafting(toolId, { realPrototype: true })`.
11. Poll inventory for up to 15 s to spot the new prototype as a diff against the pre-craft snapshot (skipping the bookkeeping `manfSchemId` / server-reported `prototypeId`); fall back to the server-reported id if the diff misses.
12. `ctx.logout`.

### Key APIs used

| `ctx.*` | Purpose |
|---|---|
| `ctx.character.ready` | Gate on first CREO baseline before reading character fields. |
| `ctx.nearestHostile({ maxRadiusM })` / `ctx.findNearest(ObjectTypeTags.CREO, ...)` | Hostile target search + fallback. |
| `ctx.walkTo` | Move to the stand-off point; auto-acks pending teleports. |
| `ctx.combat.attackingNearest` | Per-tick attack loop, terminates when the target leaves the WorldModel. |
| `ctx.world.has(id)` | Cheap "is the corpse still around" check post-combat. |
| `ctx.useAbility('loot', targetId)` | Fire the `loot` command-queue ability against the corpse. |
| `ctx.inventory.items` / `ctx.inventory.resources()` | Snapshot inventory + iterate resource crates for slot fill. |
| `ctx.findInContainer(id)` | Walk one level of nested containers when scanning for a tool. |
| `ctx.beginCrafting` / `ctx.waitForDraftSchematics` / `ctx.selectCraftingSchematic` / `ctx.waitForDraftSlots` / `ctx.assignCraftingSlot` / `ctx.craftExperiment` / `ctx.finishCrafting` | Full crafting session state machine. |
| `ctx.logout` | Clean shutdown. |

### Code map

| Location | What |
|---|---|
| `scripts/examples/hunter-crafter.ts:41-54` | `parseScriptArgs` — pulls `attack-tick-ms`, `combat-timeout-ms`, `experiment` off `args.extra`. |
| `scripts/examples/hunter-crafter.ts:56-68` | `RunSummary` shape — every field mirrored into `summary.extra`. |
| `scripts/examples/hunter-crafter.ts:70-286` | `buildScenario` — the whole hunt → loot → craft chain assembled as a `ScenarioFn`. |
| `scripts/examples/hunter-crafter.ts:81-90` | Step 1: character-baseline wait via `waitFor` polling `ctx.character.ready`. |
| `scripts/examples/hunter-crafter.ts:92-105` | Step 2: target acquisition via `findHostile`. |
| `scripts/examples/hunter-crafter.ts:111-127` | Steps 3-4: stand-off walk + `ctx.combat.attackingNearest`. |
| `scripts/examples/hunter-crafter.ts:135-153` | Steps 5-6: post-combat loot fire-and-forget + inventory-diff. |
| `scripts/examples/hunter-crafter.ts:155-216` | Steps 7-9: tool discovery + session open + schematic / slots fetch. |
| `scripts/examples/hunter-crafter.ts:217-251` | Step 9 cont.: iterate slot options, assign first matching crate per slot. |
| `scripts/examples/hunter-crafter.ts:247-256` | Step 10: optional `craftExperiment` + `finishCrafting`. |
| `scripts/examples/hunter-crafter.ts:260-282` | Step 11: prototype-arrival inventory-diff poll with skip-set guard. |
| `scripts/examples/hunter-crafter.ts:288-299` | `waitFor` — generic poll-until-true helper. |
| `scripts/examples/hunter-crafter.ts:301-333` | `findHostile` — progressive-radius CREO scan with peaceful fallback. |
| `scripts/examples/hunter-crafter.ts:335-346` | `approachPoint` — geometry for the standoff coordinate. |
| `scripts/examples/hunter-crafter.ts:348-368` | `inventoryIdSet` + `findCraftingTool` — inventory snapshot + tool discovery (template regex + nested container BFS). |
| `scripts/examples/hunter-crafter.ts:370-385` | `pickResourceCrate` — naive RCNO crate match by `quantity >= amountNeeded`. |
| `scripts/examples/hunter-crafter.ts:387-429` | `main` — CLI parse, summary scaffold, `runScenario`, stdout JSON. |

### CLI flags

- `--attack-tick-ms` (default 1500) — ms between command-queue attack ticks inside `attackingNearest`.
- `--combat-timeout-ms` (default 60000) — hard cap on the `attackingNearest` budget (also clamped by remaining `--minutes`).
- `--experiment` (default `true`) — set to `false` to skip the single experimentation pass and go straight to `finishCrafting`.

### Soft-fail conditions

- Character baseline never arrives within 10 s (`character baseline never arrived`).
- No hostile / CREO found within the 30 s scan budget (`no hostile creature found within scan budget`).
- No crafting tool in inventory (`no crafting tool in inventory (NPE chars do not start with one)`).
- Tool returns no draft schematics or an empty list.
- No `DraftSlots` arrives within 10 s of `selectCraftingSchematic`.
- No inventory crate satisfies any schematic slot (`no inventory resources matched any schematic slot`).

### Try it

```bash
LIVE=1 pnpm exec tsx scripts/examples/hunter-crafter.ts --user=tslive01 --character=ExHunter --minutes=2 --verbose
```

---

## surveyor-bazaar

**Purpose:** End-to-end demonstration of the full surveyor pipeline — pick a survey tool, discover what resource types are spawned for it, find the highest-peak sweet spot, walk there, sample until target units are stacked, fetch the resource's OQ/CR/DR stats, then locate a bazaar terminal, comp the listing, and post the crate for sale. Soft-fails record the exact reason and still emit the partial JSON summary.

**Default character / account:** `tslive02` / `ExSurveyor`. Single-client scenario.

### Flow

1. Wait 2.5 s for baselines + containment to settle so the inventory view is queryable.
2. `findSurveyTools(ctx)` (from `_lib-survey.ts`) BFS-scans `ctx.inventory.items` + `ctx.findInContainer` for any survey tool template, producing a `class → toolId` map. Prefer the universal `*` tool when present; otherwise the first class-specific tool.
3. `ctx.fetchSurveyResources(toolId)` drives the radial-menu `Use` flow end-to-end (`CM_objectMenuRequest` → response → `ObjectMenuSelectMessage(ITEM_USE=21)` → `ResourceListForSurveyMessage`) and returns the list of currently-spawned resource types for that tool's class.
4. Loop the type list: `ctx.survey(toolId, name)` + `await ctx.waitForSurvey`, keep the single SurveyPoint with the highest efficiency across all types.
5. `ctx.walkTo` to the peak sample's `(x, z)` so the sample loop starts on the sweet spot.
6. Snapshot the existing crate's `quantity` for this resource type so we can compute "units harvested this run" later.
7. Sample loop: alternate `ctx.sample(toolId, name)` with `await ctx.waitForSampleEvent`, counting `'located'` kinds as harvests. Bail on `--target-units` (default 6), `--sample-timeout-ms` (120 s) overall, or any `'mind' | 'density' | 'cancel'` (server ended the loop).
8. `ctx.cancelSampling()` (walks 2.5 m to bust the server-side loop), then settle 2.5 s so inventory reflects the freshly-stacked crate.
9. `ctx.fetchResourceAttributes([resourceId])` for the resource's full stats; normalise to short OQ/CR/DR keys via the `SHORT` table in `attrsToObject`.
10. `pollForNearestByTemplate` (5 s budget) for any `bazaar|terminal_bazaar|vendor_bazaar` template; soft-fail when none in scene (`mos_eisley` has none — expected on a vanilla cluster).
11. Walk to a point ~6 m short of the terminal, then `ctx.browseBazaar(terminalId, { textFilterAll: resourceName })` and compute the median of `buyNowPrice || highBid` across the comps.
12. Find the freshly-stacked crate in `ctx.inventory.resources()` (matched by `resourceType === resourceId`).
13. `ctx.listForSale(terminalId, crateId, { price: median ?? defaultPrice, durationHours, description })` and record `auctionId` + `resultCode` on the summary.
14. `ctx.logout`.

### Key APIs used

| `ctx.*` | Purpose |
|---|---|
| `ctx.inventory.items` / `ctx.inventory.resources()` | Tool + crate discovery and baseline-quantity snapshot. |
| `ctx.findInContainer(id)` | BFS into nested bags during tool scan (in `_lib-survey.ts`). |
| `ctx.fetchSurveyResources(toolId)` | Discover spawned resource types for a tool's class. |
| `ctx.survey(toolId, name)` + `ctx.waitForSurvey` | Per-type survey request + radial-response parse. |
| `ctx.walkTo` | Move to the peak point and toward the bazaar terminal. |
| `ctx.sample(toolId, name)` + `ctx.waitForSampleEvent` | Sample-loop drive + `{kind, raw}` event observation. |
| `ctx.cancelSampling()` | 2 m bump to bust the server's sample loop. |
| `ctx.fetchResourceAttributes([id])` | Batched `getAttributesBatch` for resource stats. |
| `ctx.browseBazaar` | `AuctionQueryHeaders` request + response parse, with `textFilterAll`. |
| `ctx.listForSale` | `CreateAuctionMessage` + response parse — returns `{success, auctionId, resultCode, errorReason}`. |
| `ctx.fail` | Soft-fail bookkeeping into `summary.assertionFailures`. |

### Code map

| Location | What |
|---|---|
| `scripts/examples/surveyor-bazaar.ts:74-98` | `parseScriptArgs` — target-units, sample timeouts, bazaar scan radius, default price. |
| `scripts/examples/surveyor-bazaar.ts:100-144` | `pickBestResourceAtLocation` — surveys every type and returns the single highest-peak sample. |
| `scripts/examples/surveyor-bazaar.ts:146-155` | `medianPrice` — median across `buyNowPrice ?? highBid` comps. |
| `scripts/examples/surveyor-bazaar.ts:157-186` | `attrsToObject` — normalise SWG attribute keys to short OQ/CR/DR form. |
| `scripts/examples/surveyor-bazaar.ts:188-204` | `RunSummary` shape — copied into `summary.extra` at the end. |
| `scripts/examples/surveyor-bazaar.ts:206-452` | `buildScenario` — the survey → sample → bazaar pipeline. |
| `scripts/examples/surveyor-bazaar.ts:213-228` | Step 1-2: settle, find tools via `findSurveyTools`, pick primary. |
| `scripts/examples/surveyor-bazaar.ts:230-252` | Step 3: `ctx.fetchSurveyResources` with timeout-and-empty soft-fails. |
| `scripts/examples/surveyor-bazaar.ts:254-277` | Step 4: best-peak pick + position log. |
| `scripts/examples/surveyor-bazaar.ts:279-318` | Steps 5-8: walk-to-peak, sample loop, `cancelSampling`. |
| `scripts/examples/surveyor-bazaar.ts:320-336` | Step 9: `fetchResourceAttributes` + stats log. |
| `scripts/examples/surveyor-bazaar.ts:338-371` | Step 10-11: bazaar discovery + approach. |
| `scripts/examples/surveyor-bazaar.ts:373-388` | Step 11 cont.: `browseBazaar` + median comp price. |
| `scripts/examples/surveyor-bazaar.ts:389-416` | Step 12: locate matching crate, abort if nothing to sell. |
| `scripts/examples/surveyor-bazaar.ts:417-451` | Step 13-14: `listForSale` + outcome bookkeeping + `logout`. |
| `scripts/examples/surveyor-bazaar.ts:454-467` | `pickPrimaryTool` — prefer the universal `*` tool, else first class-specific. |
| `scripts/examples/surveyor-bazaar.ts:469-477` | `currentUnitsFor` — pre-sample crate baseline. |
| `scripts/examples/surveyor-bazaar.ts:479-494` | `approachPoint` — step toward target without walking through it. |
| `scripts/examples/surveyor-bazaar.ts:496-504` | `formatAttrsShort` — stable OQ/CR/DR ordering for the listing description. |
| `scripts/examples/surveyor-bazaar.ts:506-559` | `main` — defaults to `--minutes=8`, scaffold + summary print. |

### CLI flags

- `--target-units` (default 6) — stop sampling after this many `'located'` events.
- `--sample-timeout-ms` (default 120000) — overall sampling budget.
- `--per-sample-tick-ms` (default 35000) — per-tick `waitForSampleEvent` timeout.
- `--survey-timeout-ms` (default 8000) — per-type survey response timeout.
- `--bazaar-scan-ms` (default 5000) — wall-clock to wait for a bazaar baseline.
- `--bazaar-max-radius` (default 800) — ignore bazaars farther than this from spawn.
- `--listing-duration-hours` (default 24) — auction window for `listForSale`.
- `--default-price` (default 500) — credits when no comps exist.

### Soft-fail conditions

- No survey tool in inventory.
- `fetchSurveyResources` times out or returns an empty type list.
- All per-type surveys empty (`all surveys empty — nothing to harvest`).
- No bazaar terminal in scene within `--bazaar-max-radius` (the expected path on a fresh `mos_eisley`).
- No units harvested AND no pre-existing crate to fall back on.
- Listing rejected by the server (records `resultCode` + `errorReason`).

### Try it

```bash
LIVE=1 pnpm exec tsx scripts/examples/surveyor-bazaar.ts --user=tslive02 --character=ExSurveyor --minutes=8
```

---

## mission-marathon

**Purpose:** Soak the mission system end-to-end. A solo character finds a mission terminal, accepts up to N missions, navigates to each waypoint, drives the appropriate completion path (combat for destroy/bounty/hunting; radial-Use for delivery/recon/survey), and emits a JSON summary with per-mission outcomes plus total credits + XP earned. Useful as a high-level "does the mission stack still work end-to-end" smoke under wire-format drift.

**Default character / account:** `tslive03` / `ExMissionRunner`. Single-client scenario.

### Flow

1. Wait ≤ 5 s for `ctx.character.ready`, then snapshot starting bank, cash, and the XP map for the eventual delta.
2. `findNearestMissionTerminal` — pattern-match TANO templates against `terminal_mission|mission_terminal` within `--terminal-radius` (default 120 m).
3. If nothing found, `nudgeTowardLandmark` walks toward the nearest starport / cantina / travel terminal / hotel to bring a mission terminal into baseline range, then waits 2 s and retries the scan.
4. `ctx.navigate` to the terminal (`useMount: 'never'` — server gates mission interactions on close presence), then `ctx.requestMissionList(terminalId, { flags: 0 })`. Poll `ctx.missions.active` for up to 5 s, treating any newly-arrived MISO baselines as the offered set.
5. Rank the offered missions by `--pick` strategy (`payout` = highest credits first; `distance` = shortest waypoint first), then call `ctx.acceptMission(missionId, terminalId)` for the top `--max-missions` (default 3).
6. For each accepted mission, `runMission(ctx, m, args, log)`:
   - `ctx.navigate(waypoint, { useMount: 'auto' })` — uses a vehicle PCD automatically if distance > 50 m and one is in the datapad.
   - If the mission `type` matches `destroy|bounty|hunting|assassinat`, run `ctx.combat.attackingNearest` in 15 s slices until the mission falls out of `ctx.missions.active` (server's `MissionObject` cleanup on completion) or the per-mission budget elapses.
   - Otherwise pick the closest interactable inside the arrival radius (TANO first, CREO as fallback) and fire `ObjectMenuSelectMessage(targetId, ITEM_USE)` via `ctx.send`. For many delivery/recon missions arrival itself completes server-side; the radial-Use is belt-and-braces. Poll the cache until completion or deadline.
   - `ctx.combat.autoLoot = true` so any combat drops auto-loot.
   - If the budget runs out, `ctx.abortMission(m.id)`.
7. After the loop, return to the original terminal via `ctx.navigate({ useMount: 'auto' })` for canonical close-out.
8. Snapshot final bank/cash/XP, compute deltas (cash + bank delta, per-XP-type delta), and `ctx.logout`.

### Key APIs used

| `ctx.*` | Purpose |
|---|---|
| `ctx.character.ready` / `ctx.character.bankBalance` / `ctx.character.cashBalance` / `ctx.character.xp` | Starting + ending economy snapshot. |
| `ctx.world.byType(ObjectTypeTags.TANO)` / `ctx.world.byType(ObjectTypeTags.BUIO)` | Terminal + landmark candidate pools. |
| `ctx.navigate` | Multi-segment go-there with auto vehicle handling. |
| `ctx.requestMissionList` / `ctx.acceptMission` / `ctx.abortMission` | Terminal browse + per-mission lifecycle. |
| `ctx.missions.active` | Live MISO cache; missions drop out on server-side completion. |
| `ctx.combat.attackingNearest` / `ctx.combat.autoLoot` / `ctx.combat.damagedSet()` | Combat completion path + auto-loot + diagnostic kill count. |
| `ctx.send(new ObjectMenuSelectMessage(id, RadialMenuTypes.ITEM_USE))` | Fire the radial Use as a defensive belt-and-braces for delivery / recon. |
| `ctx.position()` / `ctx.sceneStart.sceneName` | Spawn coord + planet for the summary. |
| `ctx.logout` | Clean shutdown. |

### Code map

| Location | What |
|---|---|
| `scripts/examples/mission-marathon.ts:49-73` | `parseScriptArgs` — pulls `max-missions`, `per-mission-timeout-s`, scan/walk radii, `--pick` strategy. |
| `scripts/examples/mission-marathon.ts:75-78` | Pattern constants — `MISSION_TERMINAL_RE`, `FALLBACK_LANDMARK_RE`, `COMBAT_MISSION_RE`. |
| `scripts/examples/mission-marathon.ts:79-91` | `PerMissionStat` shape — one row per accepted mission in the summary. |
| `scripts/examples/mission-marathon.ts:93-112` | `MarathonStats` shape — top-level summary fields. |
| `scripts/examples/mission-marathon.ts:114-131` | `xpMapToObject` + `diffXp` — flatten + delta the per-XP-type map. |
| `scripts/examples/mission-marathon.ts:133-138` | `findNearestMissionTerminal` — single-shot template-pattern scan in the world model. |
| `scripts/examples/mission-marathon.ts:140-185` | `nudgeTowardLandmark` — fallback "walk toward a starport / cantina" to surface a terminal in baseline. |
| `scripts/examples/mission-marathon.ts:187-203` | `rankMissions` — payout-descending or distance-ascending order for acceptance. |
| `scripts/examples/mission-marathon.ts:205-330` | `runMission` — per-mission completion driver (navigate → combat / radial-Use → poll for cache drop → abort fallback). |
| `scripts/examples/mission-marathon.ts:266-290` | Combat-mission branch — slice-and-repeat `attackingNearest` checking `ctx.missions.active`. |
| `scripts/examples/mission-marathon.ts:291-312` | Non-combat branch — pick interactable + `ObjectMenuSelectMessage(ITEM_USE)` + poll. |
| `scripts/examples/mission-marathon.ts:332-361` | `pickInteractableNearWaypoint` — closest TANO with a templateName, CREO fallback. |
| `scripts/examples/mission-marathon.ts:363-553` | `buildScenario` — terminal search + accept loop + per-mission run + return trip + final snapshot. |
| `scripts/examples/mission-marathon.ts:391-421` | Terminal search with landmark-nudge fallback and clean-exit when none found. |
| `scripts/examples/mission-marathon.ts:438-465` | Browse — fire `requestMissionList`, poll `ctx.missions.active` for newly-arrived MISO baselines. |
| `scripts/examples/mission-marathon.ts:467-492` | Accept loop honoring `--max-missions`. |
| `scripts/examples/mission-marathon.ts:494-523` | Per-mission run loop with overall deadline-budget abort path. |
| `scripts/examples/mission-marathon.ts:540-552` | Final snapshot — credits + XP delta + summary completion log. |
| `scripts/examples/mission-marathon.ts:555-606` | `main` — defaults, summary scaffold, stdout JSON. |

### CLI flags

- `--max-missions` (default 3) — cap on missions to accept this run.
- `--per-mission-timeout-s` (default 60) — seconds before aborting any single mission.
- `--terminal-radius` (default 120) — baseline-range radius for the initial terminal scan.
- `--fallback-walk-radius` (default 250) — radius scanned for a landmark when no terminal in range.
- `--arrival-radius` (default 12) — radius around the waypoint for the completion-target scan.
- `--pick` (`payout` | `distance`, default `payout`) — acceptance-order strategy.

### Soft-fail conditions

- No mission terminal within `--terminal-radius` after the landmark nudge (`no mission terminal in baseline range after landmark nudge`).
- Terminal returns no new missions (`mission terminal returned no new missions`).
- All accepts fail (`no missions accepted (all failed)`).
- Per-mission navigation fails → `outcome: 'navigation-failed'` and best-effort abort.
- Per-mission budget exhausted → `outcome: 'aborted'` with `reason: 'budget-exhausted'` or `'engaged-timeout'`.

### Try it

```bash
LIVE=1 pnpm exec tsx scripts/examples/mission-marathon.ts --user=tslive03 --character=ExMissionRunner --max-missions=3 --per-mission-timeout-s=60 --minutes=10
```

---

## city-recon-surveyor

**Purpose:** Solo scout walks a region, scoring candidate lots for a future player city by combining offline terrain analysis (TRN metadata + radial layout) with live server placement probes (admin deed spawn + structure-placement chat-OOB monitoring). Emits a ranked top-N for use by `scripts/build-city/`. Requires an admin-level character because `probeBuildable` uses ConGenericMessage admin commands to spawn the probe deed and warp the player.

**Default character / account:** `tslive04` / `ExCityScout`. Single-client scenario.

### Flow

1. Zone in on the requested planet. If `--planet=X` is supplied but the character lands on a different planet (`ctx.sceneStart.sceneName`), abort with a `wrong-planet` hint pointing at the correct flag.
2. `loadPlanetTrn(planet)` reads the staged `.trn` from `assets/terrain/<planet>.trn` (or via `SWG_TRE_PATH`); `parseTrnMetadata` extracts `mapWidth`, `chunkWidth`, and `globalWaterHeight`. Soft-fail with `no-terrain-assets` and a setup hint if the file isn't staged.
3. `generateCandidateGrid({ centerX, centerZ, maxRadius, rings, angularSteps })` produces a concentric-ring grid of `(x, z)` candidate spots.
4. `scoreCandidates` assigns each spot a synthetic `flatnessScore` from radial position, map-edge clearance, and water-table proximity. The score is intentionally not a real heightmap probe — the live `probeBuildable` is the source of truth for buildability; the score just orders which candidates to spend probe-time on first.
5. Sort by score descending, then walk the list picking the top `--probes` candidates that are at least `--min-spacing` apart from any already-chosen probe coord.
6. `resolveInventoryOid(ctx)` (from `scripts/build-city/place.ts`) — admin-lookup first, then `ctx.inventory.containerId` fallback. Cache the OID for reuse across all probes.
7. For each chosen candidate (until `--minutes` deadline):
   - `ctx.walkTo({ x, z })` — record `terrainHeight` from `ctx.position().y` after arrival.
   - `probeBuildable(ctx, inventoryOid, x, z, { settleMs, teleportToCoord: false })` — admin-spawns a probe deed into the inventory, USEs it at the spot, and watches `ChatSystemMessage` outOfBand chatter for rejection tokens during the settle window. Returns `{ buildable, chatOob }`.
   - We pass `teleportToCoord: false` because the scenario walks to each spot itself (a manual walk surfaces a more honest "can the player physically stand here" check than a server-side warp).
8. Sort results: buildable first, then by `flatnessScore` descending. Take the top 5 for `meta.top5`.
9. `ctx.logout`. Exit code is 0 only if both `summary.ok` AND `meta.status === 'ok'`.

### Key APIs used

| `ctx.*` / helper | Purpose |
|---|---|
| `ctx.sceneStart.sceneName` | Planet check + the planet name passed to `probeBuildable`'s warp logic. |
| `loadPlanetTrn(planet)` + `parseTrnMetadata` | Offline TRN metadata read for the map bounds + water table. |
| `generateCandidateGrid({...})` | Concentric-ring `(x, z)` candidate generator. |
| `resolveInventoryOid(ctx)` | Admin lookup → `ctx.inventory.containerId` fallback for the deed-spawn container. |
| `ctx.walkTo({ x, z })` | Move the player to each probe candidate. |
| `ctx.position()` | Read terrain height (`y`) after arrival. |
| `probeBuildable(ctx, inventoryOid, x, z, opts)` | Live placement probe (admin deed spawn + USE + chat-OOB watch). |
| `ctx.logout` | Clean shutdown. |

### Code map

| Location | What |
|---|---|
| `scripts/examples/city-recon-surveyor.ts:49-75` | `parseScriptArgs` — planet, search center/radius, ring grid shape, probe budget, spacing, settle. |
| `scripts/examples/city-recon-surveyor.ts:77-96` | `ReconMeta` + `CandidateScore` summary shapes. |
| `scripts/examples/city-recon-surveyor.ts:98-101` | `ScoredCandidate` — internal pre-rank tuple. |
| `scripts/examples/city-recon-surveyor.ts:103-110` | `tryLoadPlanetMetadata` — wraps `loadPlanetTrn` + `parseTrnMetadata` with error capture. |
| `scripts/examples/city-recon-surveyor.ts:112-133` | `scoreCandidates` — synthetic 60/40 radial+edge-clearance score. |
| `scripts/examples/city-recon-surveyor.ts:135-144` | `tooClose` — min-spacing dedup for probe picks. |
| `scripts/examples/city-recon-surveyor.ts:146-280` | `buildScenario` — orchestrate planet check → TRN load → grid → score → walk + probe loop. |
| `scripts/examples/city-recon-surveyor.ts:156-166` | Step 1: planet check using the regex extraction off `sceneStart.sceneName`. |
| `scripts/examples/city-recon-surveyor.ts:168-187` | Step 2: TRN load with `no-terrain-assets` setup hint. |
| `scripts/examples/city-recon-surveyor.ts:189-210` | Steps 3-5: grid generation, scoring, min-spacing dedup. |
| `scripts/examples/city-recon-surveyor.ts:212` | Step 6: `resolveInventoryOid` once, reuse for every probe. |
| `scripts/examples/city-recon-surveyor.ts:214-260` | Step 7: per-candidate walk + probe loop with deadline guard. |
| `scripts/examples/city-recon-surveyor.ts:262-276` | Step 8: rank (buildable-first, then by score) + top5 + summary fields. |
| `scripts/examples/city-recon-surveyor.ts:282-317` | `main` — defaults, summary scaffold, stdout JSON, exit code gates on `meta.status === 'ok'`. |

### CLI flags

- `--planet` (default: the planet the character zones into) — name to load `.trn` for and to enforce a sanity match.
- `--centerX` / `--centerZ` (default 0/0) — center of the radial search.
- `--max-radius` (default 500) — outer ring radius in metres.
- `--rings` (default 4) — concentric ring count.
- `--angular-steps` (default 6) — candidates per ring.
- `--probes` (default 10) — top-N candidates to spend live probe-time on.
- `--min-spacing` (default 60) — min metres between any two probed spots.
- `--settle-ms` (default 4500) — ms to listen for a placement rejection chat-OOB inside `probeBuildable`.

### Soft-fail conditions

- Character zones into the wrong planet → `status: 'wrong-planet'` with a corrective hint and clean logout.
- TRN asset not staged or unreadable → `status: 'no-terrain-assets'` with a pointer to `assets/README.md` / `SWG_TRE_PATH`.
- Deadline reached mid-loop — remaining probes are skipped and the loop emits results for what was already scanned (`status` still flips to `'ok'`).
- Individual probe throws — captured as `probeNotes: 'probe-error: ...'` on the per-candidate row (loop continues).

### Try it

```bash
LIVE=1 pnpm exec tsx scripts/examples/city-recon-surveyor.ts --user=tslive04 --character=ExCityScout --planet=naboo --centerX=0 --centerZ=0 --max-radius=500 --rings=4 --angular-steps=6 --probes=10 --minutes=10
```

---

## shuttle-traveler

**Purpose:** Smallest possible end-to-end demo of `ctx.travel`: find the nearest ticket vendor, list every (planet, point) destination it offers, buy a single ticket, walk to the collector droid, and board the shuttle. Each step maps 1:1 to one helper on the travel view or one top-level action.

**Default character / account:** `tslive20` / `ExShuttle` (account is on the admin allowlist so character creation works against a fresh DB).

### Flow

1. `await ctx.wait(scanMs)` (default 4s) — give the planet baseline flood time to push the vendor and surrounding objects into `WorldModel`. Travel-vendor terminals usually arrive as `SceneCreateObjectByCrc` events without a templateName, so `ctx.travel.findTicketVendor` matches on the template-CRC set at `src/client/script/travel.ts:218-221`.
2. Call `ctx.travel.findTicketVendor()` with the default 64m radius. If nothing matches, retry with `--max-radius` (default 250m); if a wider scan finds one, walk to within 4m of it and re-look. Soft-exit (logout, return) if still nothing.
3. `await ctx.listDestinations({timeoutMs: 12_000})` — this top-level action delegates into `travel.ts:fetchAllDestinations` (line 369), which sends `ObjectMenuSelectMessage(vendorId, ITEM_USE=21)` to trigger the server's `enterClientTicketPurchaseMode`, waits for the `EnterTicketPurchaseModeMessage` reply, then loops over the standard 12-planet roster sending one `PlanetTravelPointListRequest` per planet and matching each response by `planetName`. Returns the flattened `"<planet>/<point>"` strings.
4. `await ctx.buyTicket({destination, destinationPlanet?, timeoutMs: 15_000})` — this is the meaty bit. The helper at `travel.ts:477` re-runs the destination fetch (since cost data lives there), matches the requested destination case-insensitively, snapshots the current ticket inventory via `ctx.travel.currentTickets()`, sends `useAbility('purchaseTicket', 0n, "<dep_planet> <dep_point> <arr_planet> <arr_point> <roundtrip> <instant>")` through the command queue, then polls `currentTickets()` every 250ms looking for a new `travel_ticket` item to appear in inventory. Returns the new ticket's NetworkId. The space-to-underscore substitution for travel-point names (`travel.ts:441-443`) matches the server's `underscoreToSpace` normalization in `CommandCppFuncs.cpp`.
5. If `--board=false`, log and logout cleanly without using the ticket.
6. Otherwise call `ctx.travel.findTicketCollector({maxRadiusM:80})`. The collector finder (`travel.ts:285`) prefers actual `ticket_collector.iff` droids but falls back to the lambda/player/kash shuttle CREOs (template regex at `travel.ts:205`).
7. Walk to the collector, then `await ctx.useTicket({ticketId, timeoutMs: 25_000})`. The helper at `travel.ts:574` sends `useAbility('boardShuttle', collectorId, ticketId)` and blocks on the inbound `CmdStartScene` for the destination scene. On return, the result carries the new `destinationPlanet` (normalized via `normalizePlanetName`) and the spawn `Vector3`.
8. Sleep 2s and `ctx.logout()`.

Note that this script does NOT issue a `CmdSceneReady` ack after arrival — `useTicket` returns on `CmdStartScene` alone and the script logs out immediately. The cross-planet-pilgrim walkthrough below shows the full re-zone handshake.

### Key APIs used

| `ctx.*` | Purpose |
|---|---|
| `ctx.travel.findTicketVendor({maxRadiusM?})` | Nearest `terminal_travel.iff` by templateName regex or templateCrc set |
| `ctx.travel.findTicketCollector({maxRadiusM?})` | Nearest `ticket_collector.iff`, falling back to lambda/player shuttle CREOs |
| `ctx.listDestinations({timeoutMs?})` | EnterTicketPurchaseMode → 12 PlanetTravelPointListRequest round-trips → flatten |
| `ctx.buyTicket({destination, destinationPlanet?, timeoutMs?})` | Vendor SUI → purchaseTicket command → inventory-poll for the new ticket |
| `ctx.useTicket({ticketId, timeoutMs?})` | boardShuttle command → wait for inbound CmdStartScene |
| `ctx.walkTo({x, z})` | Approach the vendor / collector if not already adjacent |
| `ctx.wait(ms)` | Settle windows for baseline flood + post-arrival pause |
| `ctx.logout()` | Stage 4 clean logout |

### Code map

| Symbol | Description |
|---|---|
| `parseScriptArgs` (shuttle-traveler.ts:37-45) | Read `destination`, `destinationPlanet?`, `scanMs`, `maxRadiusM`, `board` |
| `buildScenario` (shuttle-traveler.ts:47-107) | The single scenario closure — vendor → list → buy → board |
| `main` (shuttle-traveler.ts:109-130) | CLI parsing + `runScenario` + JSON summary |

### CLI flags

- `--destination` (default `bestine`) — Travel point to buy a ticket to. Matched case-insensitively against the vendor's reported names.
- `--destination-planet` (default unset) — Restrict the search to one planet; otherwise the first matching name across all planets wins.
- `--scan-ms` (default 4000) — Settle window before scanning for the vendor.
- `--max-radius` (default 250) — Fallback search radius when the default 64m scan doesn't find a vendor at spawn.
- `--board=false` — Buy the ticket but skip boarding (useful for purchase-only smoke tests).

### Soft-fail conditions

- No ticket vendor within `--max-radius` of spawn — log, logout, exit 0.
- `--board=true` (default) but no collector / shuttle within 80m after purchase — log, logout, exit 0.

### Try it

```bash
LIVE=1 pnpm exec tsx scripts/examples/shuttle-traveler.ts \
  --user=tslive20 --character=ExShuttle \
  --destination=bestine --verbose
```

---

## cross-planet-pilgrim

**Purpose:** Solo end-to-end shuttle journey + mission round-trip. Spawns on one planet, optionally admin-warps to a known starport anchor, buys a ticket to a different planet, boards the shuttle, manually drives the destination's re-zone handshake (`CmdStartScene` → `SceneEndBaselines` → `CmdSceneReady` → teleport-ack), then accepts and immediately removes one mission at a destination terminal to exercise the mission wire path. The script is intentionally small: `ctx.travel.*` absorbs what would otherwise be ~500 lines of inline SUI / command-queue / inventory-poll handshakes; the admin `setGodMode` + `money namedTransfer` knobs and the `object move` warp remain only because the test cluster needs a way to position and fund a fresh character.

**Default character / account:** `tslive18` / `ExPilgrim` (admin-allowlisted account so character creation succeeds; admin abilities work because the same allowlist gates `setGodMode`).

### Flow

1. Snapshot `startCredits` (bank + cash) and `startPlanet` (parsed from `ctx.sceneStart.sceneName` via `normalizePlanet`, line 276).
2. **Optional admin top-up** (`adminTopUp`, line 95): if `--admin-deposit=N` is set and current credits are below it, fire `useAbility('setGodMode', 0n, '1')` then `ctx.send(new ConGenericMessage('money namedTransfer <playerOid> customerService -<deposit>'))`. `ConGenericMessage` is the server-console command bus — the negative amount flips the transfer direction so credits flow into the player. Without this top-up a fresh character can't afford the interplanetary ticket cost.
3. **Optional admin warp** (`adminWarp`, line 109): if `--warp-to-x` and `--warp-to-z` are set, send `ConGenericMessage('object move <playerOid> <x> 0 <z>')`, wait 2s, call `ctx.ackPendingTeleports()` to clear the negative-sequence teleport lockouts the server inserts during the warp, and `ctx.setPose` to sync the local cursor with the new position. This drops you next to a known starport for repeatable runs.
4. Call `ctx.travel.findTicketVendor({maxRadiusM: vendorRadius})`. Soft-fail with `bailReason` if nothing's in range.
5. Call `ctx.travel.listDestinations({vendorId: vendor.id})` and pick the first destination whose point name contains `--destination` AND whose planet differs from the start planet (and matches `--destination-planet` if provided). Soft-fail if no candidate matches.
6. `await ctx.travel.buyTicket({vendorId, destination, destinationPlanet})`. The helper drives `ObjectMenuSelectMessage(ITEM_USE=21)` → `EnterTicketPurchaseModeMessage` → twelve `PlanetTravelPointListRequest`/`Response` round-trips → `purchaseTicket` command-queue enqueue → inventory poll for the new `travel_ticket` (full details: `src/client/script/travel.ts:477`). Soft-fail with the error message if it throws.
7. `ctx.travel.findTicketCollector({maxRadiusM: vendorRadius})` and walk to within 2m of it.
8. `await ctx.travel.useTicket({ticketId, collectorId})`. Sends `useAbility('boardShuttle', collectorId, ticketId)` and blocks on the inbound `CmdStartScene`. Returns `{destinationPlanet, destinationPosition}`.
9. **Re-zone handshake** (`waitForRezone`, line 129): the initial zone-in handshake is driven by the orchestrator, but the re-zone is on the script. Wait for the destination's `CmdStartScene` again, then `SceneEndBaselines`, send `CmdSceneReady` ourselves, wait 500ms, and `ctx.ackPendingTeleports()` to clear the new teleport lockouts. If any timeout fires, soft-fail with `bailReason`.
10. Wait `scanMs` (default 5s) to let the destination's baseline flood populate the WorldModel.
11. `ctx.world.filter(o => /terminal_mission|mission_terminal/i.test(o.templateName))[0]` — pick any mission terminal in scene. If none, just skip mission step and finish.
12. `ctx.requestMissionList(terminal.id, {flags: 0})`, wait 2s, then `ctx.missions.bestPayout() ?? ctx.missions.active[0]`. If a mission resolves: `ctx.acceptMission(mission.id, terminal.id)`, wait 1s, then `ctx.removeMission(mission.id, terminal.id)` to round-trip the abandon path.
13. Snapshot `endCredits`, log out.

### Key APIs used

| `ctx.*` | Purpose |
|---|---|
| `ctx.travel.findTicketVendor({maxRadiusM})` | Nearest starport ticket terminal |
| `ctx.travel.listDestinations({vendorId})` | All (planet, point) tuples the vendor offers, with cost |
| `ctx.travel.buyTicket({vendorId, destination, destinationPlanet})` | Full purchase handshake, returns the new ticket's NetworkId |
| `ctx.travel.findTicketCollector({maxRadiusM})` | Nearest collector droid or shuttle CREO |
| `ctx.travel.useTicket({ticketId, collectorId})` | Board the shuttle, return on destination CmdStartScene |
| `ctx.waitForMessage(CmdStartScene/SceneEndBaselines, {timeoutMs})` | Re-zone synchronization barriers |
| `ctx.send(new CmdSceneReady())` | Acknowledge the new scene so the server starts pushing baselines |
| `ctx.ackPendingTeleports()` | Clear negative-sequence teleport lockouts from the warp + the re-zone |
| `ctx.send(new ConGenericMessage(...))` | Server-console command bus for admin warp + money transfer |
| `ctx.useAbility('setGodMode', 0n, '1')` | Toggle god-mode (required for the money transfer to succeed) |
| `ctx.setPose(position, yaw)` | Resync the local cursor after the admin warp |
| `ctx.requestMissionList(terminalId, {flags})` | Populate the missions cache from a terminal |
| `ctx.missions.bestPayout()` / `ctx.missions.active` | Live mission cache reads |
| `ctx.acceptMission(missionId, terminalId)` | Accept the picked mission |
| `ctx.removeMission(missionId, terminalId)` | Abandon it (round-trip the wire path) |
| `ctx.character.bankBalance + ctx.character.cashBalance` | Credit accounting before/after |

### Code map

| Symbol | Description |
|---|---|
| `parseScriptArgs` (cross-planet-pilgrim.ts:62-76) | Parse destination, warp coords, deposit, timeouts |
| `adminTopUp` (cross-planet-pilgrim.ts:95-107) | `setGodMode` + `ConGenericMessage("money namedTransfer ...")` |
| `adminWarp` (cross-planet-pilgrim.ts:109-127) | `ConGenericMessage("object move ...")` + teleport-ack + setPose |
| `waitForRezone` (cross-planet-pilgrim.ts:129-140) | `CmdStartScene` → `SceneEndBaselines` → `CmdSceneReady` → teleport-ack |
| `buildScenario` (cross-planet-pilgrim.ts:142-274) | The main scenario closure: vendor → list → buy → board → re-zone → mission |
| `normalizePlanet` (cross-planet-pilgrim.ts:276-280) | Strip `terrain/` prefix and `.trn` suffix from a scene name |
| `main` (cross-planet-pilgrim.ts:282-321) | CLI parsing + `runScenario` + JSON summary emit |

### CLI flags

- `--destination` (default `bestine`) — Travel-point name substring to match.
- `--destination-planet` (default unset) — Optional planet name restrictor; default is "any planet other than the spawn planet".
- `--vendor-radius` (default 120) — Search radius for both vendor and collector.
- `--scan-ms` (default 5000) — Settle window after re-zone before scanning for the mission terminal.
- `--rezone-timeout-ms` (default 30000) — Wait budget for the destination's `CmdStartScene` after `useTicket`.
- `--warp-to-x` / `--warp-to-z` (default unset) — Admin-warp to (x, 0, z) before searching for the vendor.
- `--admin-deposit` (default 0) — Top up the character to at least this many credits before buying (skipped if already wealthier).

### Soft-fail conditions

Every soft-fail records `bailReason` in `summary.extra`, logs out cleanly, and exits 0:

- No ticket vendor within `--vendor-radius` of spawn (or post-warp position).
- Vendor has no destinations on a different planet from spawn (or none matching `--destination` / `--destination-planet`).
- `buyTicket` rejected by the server (insufficient credits, point-name mismatch, vendor not at home starport).
- No ticket collector / shuttle within `--vendor-radius` after purchase.
- Re-zone `CmdStartScene` never arrives within `--rezone-timeout-ms`.
- No mission terminal in scene at the destination (mission step is just skipped, not flagged).

### Try it

```bash
LIVE=1 pnpm exec tsx scripts/examples/cross-planet-pilgrim.ts \
  --user=tslive18 --character=ExPilgrim \
  --warp-to-x=3528 --warp-to-z=-4806 --admin-deposit=20000 \
  --destination=bestine --verbose
```

---

## bazaar-arbitrage-fleet

**Purpose:** Three characters cooperate on a poor-man's market-maker: one scout polls bazaar listings and flags items priced below the rolling median, a buyer instant-buys (or bids on) each flag, and a reseller re-lists the won items at a markup. End-to-end demo of `ctx.browseBazaar` / `ctx.bidOn` / `AcceptAuctionMessage` / `ctx.retrieveBazaarItem` / `ctx.listForSale` plus a hard credit-spend cap as a wire-drift safety net.

**Roles (fleet):** `Scout` (default account `tslive07`, character `ExArbScout`), `Buyer` (`tslive08`/`ExArbBuyer`), `Reseller` (`tslive09`/`ExArbReseller`). All three spawn at `mos_eisley`, launched 600 ms apart via `runFleet(..., { staggerMs: 600 })` so the scout has a head-start populating the shared queue before the buyer begins polling it.

### Flow

The three roles never message each other on the wire — they share a single in-process `SharedState` object (built by `makeSharedState`, line 122) closure-captured into each `ScenarioFn`. Coordination is queue-driven: scout appends to `shared.flagged`, buyer `splice`s items off that queue and pushes them onto `shared.pendingRetrieve` (then `shared.retrieved` once `ctx.inventory.findById` confirms the item physically landed), reseller drains `shared.retrieved`. A `shared.zonedIn` triple-bool acts as a soft handshake but nothing currently blocks on it — each role simply waits for the bazaar terminal scan to succeed.

1. **All roles** — locate the nearest object whose `templateName` matches `/bazaar|commodities/i` within 60 m via `findAndApproachBazaar` (line 191), walk to within 3 m, and resolve a single `terminal.id`. If no terminal is in range after the 8 s scan, the role logs cleanly and idles for the remaining duration — Mos Eisley's default `server_halloween_*` buildout lacks one, so this is a routine soft-fail rather than a crash.
2. **Scout** (`makeScoutScenario`, line 231) — every `--scout-interval-ms` (default 30 s) calls `ctx.browseBazaar(terminal.id, { timeoutMs: 10_000 })`, buckets listings by `itemType` into a local `history` map, computes `medianOf` per type once it has ≥3 samples, and pushes any listing whose effective price (`buyNowPrice || highBid`) falls below `median * --buy-threshold` (default 0.70) into `shared.flagged`. Each candidate is gated by `shared.attemptedItemIds` and a `shared.flagged.some(itemId)` linear scan to dedupe.
3. **Buyer** (`makeBuyerScenario`, line 328) — every `--buyer-tick-ms` (default 1500) `splice`s up to `--max-buy-per-tick` (default 3) items off `shared.flagged`. Before each purchase it checks `shared.stats.totalCreditsAtRisk + eff > --spend-cap` (default 1_000_000 credits) — hitting the cap breaks the batch cleanly. For `buyNowPrice > 0` flags it sends `new AcceptAuctionMessage(itemId)` via `ctx.send`; for `bidOnly` flags it calls `ctx.bidOn(itemId, eff)`. Immediately fires `ctx.retrieveBazaarItem(terminal.id, itemId)` (fire-and-forget) and records the spend. Each tick, items in `shared.pendingRetrieve` are reclassified into `shared.retrieved` if `ctx.inventory.findById` reports them — that's the only authoritative "item is mine now" signal.
4. **Reseller** (`makeResellerScenario`, line 418) — every `--reseller-tick-ms` (default 2000) drains `shared.retrieved`, re-checks each id against its own `ctx.inventory.findById` (since the buyer is a separate character — in this example the item rarely actually appears in the reseller's inventory and the loop just continues), then calls `ctx.listForSale(terminal.id, itemId, { price: round(median * --markup), durationHours: 24, instantSale: true })` and bumps `shared.stats.relistingsPlaced` only on `res.success`.

The whole fleet runs for `--minutes`; per-role outcomes are merged into `summary.extra` at line 558 (listings scanned, undervalued flags, purchases, total spend, etc.) and printed as JSON at exit.

### Key APIs used

| `ctx.*` | Purpose |
|---|---|
| `ctx.browseBazaar(terminalId, { timeoutMs })` | Sends `AuctionQueryHeadersMessage`, awaits the matching `AuctionQueryHeadersResponseMessage`, returns depalettized `AuctionListing[]` |
| `ctx.send(new AcceptAuctionMessage(itemId))` | Fire-and-forget instant-buy for a fixed-price listing |
| `ctx.bidOn(itemId, credits)` | Bid path for bid-only auctions (`buyNowPrice === 0`) |
| `ctx.retrieveBazaarItem(terminalId, itemId)` | Fire-and-forget `RetrieveAuctionItemMessage`; server replies async |
| `ctx.listForSale(terminalId, itemId, opts)` | Sends `CreateImmediateAuctionMessage` (or `CreateAuctionMessage`), awaits `CreateAuctionResponseMessage`, returns parsed result |
| `ctx.inventory.findById(itemId)` | Authoritative "did the retrieve finish?" check |
| `ctx.walkTo`, `ctx.position`, `ctx.wait`, `ctx.signal` | Approach to terminal + scheduling + cooperative abort |
| `findNearestByTemplate` (from `_lib.ts`) | Synchronous WorldModel template-regex scan within radius |
| `medianOf` (from `_lib.ts`) | Rolling median for the per-type price bucket |

### Code map

| File:line | Function | Purpose |
|---|---|---|
| `bazaar-arbitrage-fleet.ts:95` | `interface SharedState` | The single closure-captured coordination object — `flagged`/`pendingRetrieve`/`retrieved` queues plus the dedupe sets and `stats` |
| `bazaar-arbitrage-fleet.ts:122` | `makeSharedState` | Factory for a zeroed `SharedState` per run |
| `bazaar-arbitrage-fleet.ts:146` | `parseScriptArgs` | Parses every `--*` flag including spend cap and threshold; enforces the 3-account/3-character invariant |
| `bazaar-arbitrage-fleet.ts:191` | `findAndApproachBazaar` | Polls `findNearestByTemplate` for `/bazaar|commodities/i` within `terminalMaxRadiusM`, walks to within 3 m, returns terminal id or null |
| `bazaar-arbitrage-fleet.ts:231` | `makeScoutScenario` | Scout role — periodic `browseBazaar`, per-type median computation, flag queue producer |
| `bazaar-arbitrage-fleet.ts:328` | `makeBuyerScenario` | Buyer role — splice flagged queue, spend-cap-gated `AcceptAuctionMessage`/`bidOn`, retrieve + reclassify pending→retrieved |
| `bazaar-arbitrage-fleet.ts:418` | `makeResellerScenario` | Reseller role — drain retrieved queue, re-list at `median * markup` |
| `bazaar-arbitrage-fleet.ts:493` | `buildConfigs` | Wires accounts/characters to scenarios, all on `mos_eisley` with `holdZonedInMs: 0` |
| `bazaar-arbitrage-fleet.ts:528` | `main` | Parse → build shared state → `runFleet(..., { staggerMs: 600 })` → fold stats into `summary.extra` → emit JSON |

### CLI flags

- `--accounts=A,B,C` / `--characters=A,B,C` — must be exactly 3-element comma lists; mismatched length throws.
- `--scout-interval-ms` (default 30000) — scout `browseBazaar` cadence.
- `--buyer-tick-ms` (default 1500) — buyer queue-drain cadence.
- `--reseller-tick-ms` (default 2000) — reseller queue-drain cadence.
- `--buy-threshold` (default 0.70) — flag if `effectivePrice < median * F`.
- `--markup` (default 1.30) — relist at `median * F`.
- `--duration-hours` (default 24) — re-listing auction window.
- `--max-buy-per-tick` (default 3) — buyer rate cap (also caps spam during a wire-drift bug).
- `--spend-cap` (default 1000000) — hard credit ceiling; further flags ignored once breached.
- `--terminal-scan-ms` (default 8000) — wait budget for the terminal scan.
- `--terminal-max-radius` (default 60) — m radius for the template scan.

### Soft-fail conditions

- No bazaar terminal within `--terminal-max-radius` after `--terminal-scan-ms`: logs "no terminal — idling for duration", waits out the `--minutes` budget and exits OK (default Mos Eisley spawn behaviour).
- `browseBazaar` throws (server unavailable / timed-out): logs the error, sleeps one cadence interval, retries. Never aborts the run.
- Buy attempt throws: logged, the credits-at-risk is still tracked, the item is skipped.
- `listForSale` returns `{ success: false }`: logged with `resultCode`/`errorReason`, item dropped (not retried).
- Item never lands in the reseller's inventory (expected with three separate characters and no transfer step): the reseller silently continues — `summary.extra.relistingsPlaced` will commonly be 0.
- Spend cap reached: buyer logs and exits the inner batch loop cleanly.

### Try it

```bash
LIVE=1 pnpm exec tsx scripts/examples/bazaar-arbitrage-fleet.ts --minutes=3
```

---

## group-hunt-expedition

**Purpose:** Four characters form a group, mount vehicles, ride to a hunting ground, focus-fire a tough hostile, and the leader splits the bounty via SecureTrade to each member. Exercises group invite/accept, vehicle call+mount, leader-follow movement mirroring, multi-target combat focus-fire, and the full 9-message SecureTrade handshake repeated three times.

**Roles (fleet):** `Leader` (account `tslive10`, character `ExHuntLeader`), three members (`tslive11`–`tslive13` / `ExHuntMember1`–`ExHuntMember3`). Launched with `--stagger-ms` (default 300) so each character zones in slightly after the previous one, reducing the chance of all four hitting the connection server at the same instant.

### Flow

This is the canonical **Phase-1 NetworkId pre-resolve** pattern from `src/scenarios/group-trade.ts`: each member needs the leader's `NetworkId` baked into its scenario closure to detect the invite, and the leader needs all three member ids to issue `useAbility('invite', m)`. Since `NetworkId`s are only known after Stages 1+2 complete, `main` does TWO Fleet runs.

1. **Phase 1: lookup** — `resolveNetworkIds` (line 327) builds a `Fleet` and calls `fleet.run(configs, { staggerMs })` with `skipGameStage: true` on every entry. This runs LoginServer + ConnectionServer for each account, then exits before zone-in. Each `LifecycleResult.character.networkId` is collected into a `NetworkId[]`. On failure the script emits a JSON `{ ok: false, phase: 'lookup', error }` and exits 1.
2. **Phase 2: scenario fleet** — `main` constructs the four `FleetClientConfig` entries; each member's scenario is built via `makeMemberScenario(script, leaderId, ...)` (closure-captures the leader id) and the leader's via `makeLeaderScenario(script, memberIds, ...)`. Then `runFleet(args, configs, { staggerMs })` runs the actual game stage.

Inside the scenario fleet, runtime coordination is mostly wire-driven (group invite deltas, target sharing, trade handshake), with two pieces of shared in-process state for accounting:

- A `leaderOutcome: HuntOutcome` object the leader mutates (group formation, boss id, kill bool, per-member trade results, free-form `notes`).
- A `memberOutcomes: HuntOutcome[]` array, one entry per member.

Both are folded into `summary.extra` at line 457 after the fleet completes.

The per-character timeline:

1. **Leader** (`makeLeaderScenario`, line 147) — issues a defensive `useAbility('disband')` to wipe stale group state (same reason as in `src/scenarios/group-trade.ts`: a previous run that died mid-handshake would otherwise hit `SID_GROUP_ALREADY_GROUPED`), then fires `useAbility('invite', m)` for each of the three resolved `memberIds` with a 250 ms gap. Polls `ctx.group.size` until it reaches `1 + memberIds.length` or `--group-timeout-ms` elapses (`outcome.groupFormed` records the result). Tries to mount a vehicle (`tryMountVehicle`, line 119 — best-effort; on-foot still works), `walkTo`s `(--hunt-x, --hunt-z)` at the mount cap (`--mount-speed-cap`), dismounts, picks a boss via `pickBossCandidate`, sets `ctx.combat.autoLoot = true`, attacks on a `--attack-tick-ms` cadence until `!ctx.world.has(boss.id)` or `--attack-timeout-ms` elapses, then drives `ctx.tradeWith(m, { credits: floor(bounty / memberCount), ...timeouts })` for each member sequentially. Disbands at the end.
2. **Members** (`makeMemberScenario`, line 233) — defensively `decline` + `disband`, then poll `ctx.character.groupInviter` until non-null or `--group-timeout-ms` elapses; on invite, `useAbility('join')`, then poll `ctx.group.size >= 2` to confirm. Mount, then **call `await ctx.ackPendingTeleports()` before `ctx.group.follow(leaderId)`** — `follow` re-emits the leader's transform broadcasts as raw `CM_netUpdateTransform` sends bypassing the movement primitives that would normally ack teleports, so the explicit ack is mandatory after zone-in (without it every mirrored transform gets dropped by the server's `isTeleporting()` check). While following, scan `ctx.combat.targets()` and `pickBossCandidate` to focus-fire whatever the leader is attacking. After the ride budget elapses, unsubscribe `unfollow()`, dismount, and call `ctx.acceptIncomingTrade({ ... })` to wait for the leader's trade request and complete the handshake.

### Key APIs used

| `ctx.*` | Purpose |
|---|---|
| `ctx.useAbility('disband' \| 'invite' \| 'join' \| 'decline' \| 'leaveGroup' \| 'mount' \| 'dismount', targetId?)` | Server-side command-table commands wrapped in `CM_commandQueueEnqueue` |
| `ctx.group.size`, `ctx.character.groupInviter`, `ctx.group.follow(leaderId)` | Live group view + leader-follow primitive that mirrors transform broadcasts |
| `ctx.ackPendingTeleports()` | Mandatory before raw transform sends after zone-in (see CLAUDE.md gotcha #6) |
| `ctx.walkTo({ x, z })` | Multi-segment walk; auto-handles teleport ack on first call |
| `ctx.datapad.vehicles()`, `ctx.callVehicle(pcdId)`, `ctx.mount(vehicleId, { speedCap })`, `ctx.mountedSpeedCap()`, `ctx.dismount()` | Vehicle PCD call + mount/dismount |
| `ctx.world.byType(ObjectTypeTags.CREO)`, `ctx.world.has(id)`, `o.baselines.get(6)` | Boss candidate selection from the CREO pool + `inCombat` predicate from SHARED_NP |
| `ctx.combat.autoLoot`, `ctx.combat.targets()`, `ctx.attackTarget(id)` | Combat helpers + raw attack-enqueue |
| `ctx.tradeWith(otherId, { credits, beginTimeoutMs, acceptTimeoutMs, verifyTimeoutMs })` | Leader-side SecureTrade initiator |
| `ctx.acceptIncomingTrade({ requestTimeoutMs, beginTimeoutMs, ... })` | Member-side SecureTrade recipient |
| `ctx.sceneStart.playerNetworkId` | Self-id for filtering candidates and labelling trade results |

### Code map

| File:line | Function | Purpose |
|---|---|---|
| `group-hunt-expedition.ts:90` | `pickBossCandidate` | Scores nearby CREOs by template regex (`/rancor|krayt|.../`), `inCombat` flag, and distance; returns the highest-weighted match within 250 m |
| `group-hunt-expedition.ts:119` | `tryMountVehicle` | Best-effort: read first datapad PCD, `callVehicle`, wait 1.5 s, find the freshly-spawned vehicle template (matches `/vehicle|speeder|swoop|landspeeder/i`), `mount` with `speedCap: --mount-speed-cap` (default 12). Returns `null` if datapad has no vehicle |
| `group-hunt-expedition.ts:147` | `makeLeaderScenario` | Leader's full timeline: disband → invite × N → wait for group → mount → walk to hunt ground → dismount → pick boss → attack loop → tradeWith × N → disband |
| `group-hunt-expedition.ts:233` | `makeMemberScenario` | Member's timeline: decline/disband → wait for invite → join → wait for group → mount → `ackPendingTeleports` → `group.follow(leaderId)` → focus-fire loop → unfollow → dismount → `acceptIncomingTrade` → leaveGroup |
| `group-hunt-expedition.ts:327` | `resolveNetworkIds` | Phase-1 lookup — runs a Fleet with `skipGameStage: true` against each `{ account, characterName }`, returns the `LifecycleResult.character.networkId` array in caller order |
| `group-hunt-expedition.ts:356` | `main` | Phase-1 lookup → build leader+member `HuntOutcome` accumulators → build per-role configs with the resolved ids closure-captured → Phase-2 `runFleet` → fold combined outcome into `summary.extra` |

### CLI flags

- `--hunt-x` (default 100), `--hunt-z` (default -4700) — hunting-ground world coords; rendezvous point for the whole group.
- `--bounty` (default 40000) — total credits split evenly across members (each member receives `floor(bounty / memberCount)`).
- `--mount-speed-cap` (default 12) — m/s ceiling passed to `ctx.mount({ speedCap })` for the ride to the hunting ground. Foot speed is engine-locked, so this is the only knob.
- `--attack-tick-ms` (default 1500) — interval between repeated `attackTarget` enqueues.
- `--attack-timeout-ms` (default 90000) — total ms the leader will keep attacking before giving up.
- `--group-timeout-ms` (default 20000) — per-step timeout for invite arrival, group formation polling.
- `--trade-timeout-ms` (default 20000) — per-phase SecureTrade timeout (begin/accept/verify each get this budget).
- `--stagger-ms` (default 300) — launch stagger for both the Phase-1 lookup fleet and the Phase-2 scenario fleet.

### Soft-fail conditions

- Phase-1 lookup fails: emits `{ ok: false, phase: 'lookup', error }` JSON and returns exit code 1.
- Group never fully forms: `leaderOutcome.groupFormed = false`, `notes` appended with "group did not fully form before timeout"; scenario still proceeds — mount, ride, attack are attempted anyway.
- Member never sees the invite (`ctx.character.groupInviter` stays `null`): member logs "invite never arrived", appends to notes, and returns early (skips ride/combat/trade).
- No vehicle in datapad: `tryMountVehicle` returns `null`, continues on foot.
- No tough hostile within 250 m of the hunting ground: `notes` appended with "no tough hostile found"; combat phase skipped; trades still issued (so the loot-share path is still exercised).
- Trade aborted or times out: `entry.abortReason` is recorded (`'no-begin' | 'no-verify' | 'no-complete' | 'aborted'`); `outcome.lootShared` stays false unless at least one trade completed.

### Try it

```bash
LIVE=1 pnpm exec tsx scripts/examples/group-hunt-expedition.ts --minutes=5
```

---

## cantina-troupe

**Purpose:** Four characters stage a coordinated cantina performance — two dancers perform inside the building, two spotters loiter near the entrance broadcasting a rotating spatial-chat ad and counting unique attendees. Demos the entertainer command path (`startdance` / `stopdance`), `ctx.say` spatial-chat broadcast, `ctx.chat.onTell` inbound subscription, and `ctx.playersInRange` audience snapshotting.

**Roles (fleet):** `Dancer1` + `Dancer2` (defaults `tslive14`/`ExCantinaDancer1`, `tslive15`/`ExCantinaDancer2`), `Spotter1` + `Spotter2` (`tslive16`/`ExCantinaSpotter1`, `tslive17`/`ExCantinaSpotter2`). Launched with `--stagger-ms` (default 500) so the dancers settle into their dance pose before the spotters' first ad goes out.

### Flow

Coordination is a single closure-captured `TroupeState` object (built in `main` at line 263) shared across all four scenarios. Spotters poll `state.dancersReady === 2` as a barrier before broadcasting — no point advertising a show that hasn't started. Each dancer increments `state.dancersReady` after `startdance` succeeds and decrements it on stop. No wire-level message passes between the four; the rendezvous is purely in-process.

Per-role timeline:

1. **Dancer** (`makeDancerScenario`, line 101) — `changePosture('standing')`, then `walkTo` a dance spot 1.5 m laterally offset from the anchor (dancer 0 left, dancer 1 right) . Issues `useAbility('startdance', 0n, args.danceStyle)` (default `'basic'`), increments `state.dancersReady` AND `state.dancersPerformed`, then sleeps in 5-second chunks until the `--minutes` deadline. At the end fires `useAbility('stopdance')` and decrements `state.dancersReady`.
2. **Spotter** (`makeSpotterScenario`, line 140) — `changePosture('standing')`, `walkTo` an entrance position 6 m south of the anchor (spotter 0 at `-spotter-spread`, spotter 1 at `+spotter-spread`). Subscribes `ctx.chat.onTell(/./)` to log every inbound tell into `state.tellsReceived`. Then enters its main loop:
   - If `state.dancersReady < 2`: log "waiting for dancers" once, then wait 2 s and retry (the dancer-barrier).
   - Otherwise: pull the next ad line from `AD_LINES` (rotation seeded with the spotter index so the two spotters don't say the same line back-to-back), `ctx.say(ad)`, snapshot `ctx.playersInRange(args.scanRadiusM)`, accumulate unique ids into `state.attendees` plus a name lookup in `state.attendeeNames`. Sleep `--ad-interval-ms` (default 45 s) and repeat.
   - Cleanup: `unsubTell()` (the `try`/`finally` ensures the chat subscription is detached even on error).

`main` builds the configs via `buildConfigs` (line 210) which throws if fewer than 4 accounts or characters are supplied, then `runFleet(args, configs, { staggerMs })`, then folds `state` into `summary.extra` (broadcasts sent, unique attendees, attendee ids, tells received, average audience size).

### Key APIs used

| `ctx.*` | Purpose |
|---|---|
| `ctx.changePosture('standing')` | Issues `useAbility('changeposture')` with the posture-int param; ensures the dancer isn't sitting/dead when `startdance` fires |
| `ctx.walkTo({ x, z })` | Approach to the dance spot / entrance |
| `ctx.useAbility('startdance', 0n, danceStyle)`, `ctx.useAbility('stopdance')` | Entertainer command-queue path; `params` carries the style string |
| `ctx.say(text)` | Spatial-chat broadcast via the `spatialChatInternal` command queue (the only `CM_spatialChat*` path that passes the server's `allowFromClient` gate — see CLAUDE.md "Known limitations") |
| `ctx.chat.onTell(/./, (text, sender) => ...)` | Predicate-driven tell subscription; returns an unsubscribe fn |
| `ctx.playersInRange(radiusM)` | Sorted `PLAY`-type `WorldObject` list within radius (excluding self) |
| `ctx.wait(ms)`, `ctx.signal` (implicit via wait) | Cooperative sleep + abort propagation |

### Code map

| File:line | Function | Purpose |
|---|---|---|
| `cantina-troupe.ts:42` | `AD_LINES` | The rotating ad copy — 5 strings cycled by `rotation % AD_LINES.length` |
| `cantina-troupe.ts:64` | `interface TroupeState` | Shared closure state — `dancersReady` (the barrier), `attendees`/`attendeeNames`, `tellsReceived`, broadcast/scan counters |
| `cantina-troupe.ts:85` | `parseScriptArgs` | Parses cantina anchor, dancer offsets, spotter spread, dance style, ad cadence, scan radius, and the 4-element account/character lists |
| `cantina-troupe.ts:101` | `makeDancerScenario` | Dancer role — walk to offset spot, `startdance`, hold until deadline, `stopdance` |
| `cantina-troupe.ts:140` | `makeSpotterScenario` | Spotter role — walk to entrance, subscribe `onTell`, dancer-barrier poll, `say` the rotating ad, snapshot `playersInRange` after each ad |
| `cantina-troupe.ts:210` | `buildConfigs` | Build per-role `FleetClientConfig` (dancers at indices 0–1, spotters at 2–3); throws if fewer than 4 accounts/characters |
| `cantina-troupe.ts:243` | `main` | Parse → build shared `TroupeState` → `runFleet(args, configs, { staggerMs: 500 })` → fold state into `summary.extra` |

### CLI flags

- `--cantinaX` (default 3528), `--cantinaZ` (default -4805) — Mos Eisley cantina anchor; swap to re-target Theed/Coronet.
- `--dancer-offset-x` (default 4), `--dancer-offset-z` (default 0) — dancer pose offset from anchor; per-dancer lateral spread is hardcoded as ±1.5 m around the offset.
- `--spotter-spread` (default 3) — spotters stand `±N` m laterally from the anchor, 6 m south on Z.
- `--style` (default `basic`) — the `params` string passed to `startdance` (other valid values: `lyrical`, `rhythmic`, etc.).
- `--ad-interval-ms` (default 45000) — pause between consecutive spatial-chat ads.
- `--scan-radius` (default 50) — m radius for the `playersInRange` snapshot after each ad.
- `--stagger-ms` (default 500) — launch stagger between the four clients.
- `--accounts=A,B,C,D`, `--characters=A,B,C,D` — comma lists (dancers first, then spotters).

### Soft-fail conditions

- `walkTo` to the dance spot or entrance fails: logged "walkTo failed: ...", the scenario continues — the character `startdance`s or broadcasts wherever it landed.
- Spotter sees `state.dancersReady < 2`: logs "waiting for dancers" once (waitedForDancers latch), sleeps 2 s, retries. Never aborts; if dancers never start, the spotter simply never broadcasts.
- No players in range when scanning: `state.scanSamples` still increments with 0 audience; `summary.extra.avgAttendees` reflects this.
- Fewer than 4 accounts or characters supplied: `buildConfigs` throws synchronously in `main`, which propagates as a fatal stderr write.

### Try it

```bash
LIVE=1 pnpm exec tsx scripts/examples/cantina-troupe.ts --minutes=5
```

---

## reactive-bodyguard-fleet

**Purpose:** A two-character VIP-and-protector demo. The VIP walks a 40 m circular perimeter; the Bodyguard mirrors the VIP's position from ~5 m back, scans the live `WorldModel` for hostile CREOs whose `inCombat` flag is set near the VIP, intercepts them with `ctx.attackTarget`, and triggers a vehicle-mounted evac if the VIP's HAM ratio dips below a threshold.

**Roles (fleet):**
- **VIP** — default account `tslive05`, character `ExVIP`. Walks the perimeter, self-flees at 20% HAM, shouts for help when hit.
- **Bodyguard** — default account `tslive06`, character `ExBodyguard`. Mirrors the VIP, intercepts aggressors, drives the evac.

### Flow

The scenario runs in two phases. The first phase exists purely to learn each character's NetworkId without paying the cost of a full zone-in. This is the same pattern the `groupTradeScenario` (`src/scenarios/index.ts:247`) uses: cross-character coordination needs each side to know the other's id, but the LoginServer's `EnumerateCharacterId` already carries it.

**Phase 1 — NetworkId lookup (`resolveNetworkIds`, reactive-bodyguard-fleet.ts:330-356):**

1. Build two `FleetClientConfig` entries with `skipGameStage: true` (handled at `src/client/fleet.ts:58` and `src/client/swg-client.ts:315` — Stage 3 zone-in is short-circuited).
2. Run a tiny `Fleet` whose only job is Stage 1 (LoginServer) + Stage 2 (ConnectionServer / character select). After Stage 1, `LifecycleResult.character.networkId` is populated for each client.
3. Throw if either id is missing — the rest of the scenario can't function without them.

**Phase 2 — Real run (`main`, reactive-bodyguard-fleet.ts:398-415):**

The second `Fleet` launches the actual scenarios, passing the opposite character's id into each closure. `staggerMs: 250` makes the VIP zone in slightly ahead of the Bodyguard so the VIP's CREO is already in the world when the Bodyguard subscribes.

**VIP per-tick loop (`buildVipScenario`, reactive-bodyguard-fleet.ts:111-180):**

1. Register a self-flee watcher via `ctx.safety.fleeWhenHealthBelow(0.2, {...})` — at 20% HAM it breaks combat, calls a vehicle, and walks to the evac coordinates.
2. Spin a 750 ms sampler that increments `positionsVisited` when the player moves >2 m, tracks `minHealthSeen`, and if `ctx.hitTimer.engaged` is true (set whenever a `CM_combatAction(204)` lands on the player within 10 s) shouts "Help! Under attack!" via `ctx.say`, throttled to once every 8 s.
3. Run `ctx.walkCircle({centerX, centerZ, radius:40, durationMs})` for the full duration. The sampler is cleared in `finally`.

**Bodyguard per-tick loop (`buildBodyguardScenario`, reactive-bodyguard-fleet.ts:182-328):**

1. Same `fleeWhenHealthBelow` registration for self-preservation.
2. `tryEvac` (line 232) reads the VIP's HAM directly from its `CreatureObjectSharedNpBaseline` (`totalAttributes[0] / totalMaxAttributes[0]` — the standard HAM-package layout at `BaselinePackageIds.SHARED_NP`). Below the evac fraction it calls `ctx.callVehicle` on the first datapad PCD, waits for the speeder to materialize, dismounts/recalls to dodge stale-mount state, picks the most recently spawned CREO via `firstSeenAt`, mounts it, and walks to the evac point at the engine-locked run speed (mount cap if mounted).
3. `pickAggressor` (line 212) scans `ctx.world.byType(ObjectTypeTags.CREO)` for any non-self / non-VIP creature whose SHARED_NP `inCombat` flag is true and is inside the scan radius of both the bodyguard and the VIP. Returns the closest such target.
4. The main loop locks onto an active aggressor, re-attacks every 1.5 s, and drops the lock when the target either disappears from the world (counted as a kill) or both combatants leave combat.
5. When idle, if the bodyguard has fallen >8 m behind the VIP, it walks toward `(VIP - followDistance)` at 6 m/s. Otherwise it waits 500 ms.

### Key APIs used

| `ctx.*` | Purpose |
|---|---|
| `ctx.safety.fleeWhenHealthBelow(ratio, opts)` | Auto self-flee at HAM threshold: peace → vehicle → walk to safe coords |
| `ctx.hitTimer.engaged` | True when a `CM_combatAction` landed on us within the last 10 s |
| `ctx.walkCircle({centerX, centerZ, radius, durationMs})` | Cell-aware perimeter circuit; honors mount cap |
| `ctx.walkTo({x, z})` | Straight-line move with auto teleport-ack on first call |
| `ctx.world.byType(ObjectTypeTags.CREO)` | Live snapshot of every creature CREO baseline currently in scene |
| `ctx.world.get(id)` | Look up one tracked object by NetworkId |
| `ctx.position()` | Server-authoritative world-space (x, y, z) |
| `ctx.attackTarget(id)` | Queue the standard `attack` command at the target via the command queue |
| `ctx.say(text)` | Wraps `spatialChatInternal` — same path the live client uses |
| `ctx.callVehicle(pcdId)` / `ctx.mount(id)` / `ctx.dismount()` | Vehicle handling for the evac |
| `ctx.datapad.vehicles()` | Live list of vehicle PCDs the character owns |
| `ctx.character.health.current` | Current HAM health from the player's own SHARED_NP baseline |
| `ctx.logout()` | Clean Stage 4 logout |

### Code map

| Symbol | Description |
|---|---|
| `parseScriptArgs` (reactive-bodyguard-fleet.ts:56-73) | Read scenario-specific flags out of `args.extra` |
| `readCreatureHam` (reactive-bodyguard-fleet.ts:90-102) | Pull `{current, max}` from a CREO's SHARED_NP baseline |
| `readCreatureInCombat` (reactive-bodyguard-fleet.ts:104-109) | Read the SHARED_NP `inCombat` flag |
| `buildVipScenario` (reactive-bodyguard-fleet.ts:111-180) | VIP closure: circuit + help-shout + self-flee |
| `buildBodyguardScenario` (reactive-bodyguard-fleet.ts:182-328) | Bodyguard closure: follow + intercept + evac |
| `resolveNetworkIds` (reactive-bodyguard-fleet.ts:330-356) | Phase 1 lookup Fleet using `skipGameStage: true` |
| `main` (reactive-bodyguard-fleet.ts:358-433) | Phase 2 Fleet wiring + JSON summary emit |

### CLI flags

- `--circuit-radius` (default 40) — VIP perimeter radius in metres.
- `--follow-distance` (default 5) — Bodyguard's ideal trailing distance.
- `--catchup-distance` (default 8) — Distance above which the Bodyguard breaks idle and walks toward the VIP.
- `--scan-radius` (default 20) — Hostile-detection radius around both Bodyguard and VIP.
- `--evac-health` (default 0.5) — VIP HAM ratio that triggers the Bodyguard's evac response.
- `--evac-x` / `--evac-z` (default 0, 0) — Safe coordinates for both self-flee and evac.
- `--vip-account` / `--bodyguard-account` / `--vip-character` / `--bodyguard-character` — Override the default credentials.
- `--vip-safety` (default 0.2) / `--bodyguard-safety` (default 0.2) — Self-flee HAM ratios for each role.

### Soft-fail conditions

- Phase 1 lookup returns a missing NetworkId for either character (`Error` thrown — exits non-zero with the lookup-phase error messages).
- VIP runs the full duration with no aggressors in scene: the loop just records `positionsVisited` and `helpCallsIssued=0`. Not a failure.
- Bodyguard never sees a matching hostile: `aggressorsIntercepted` stays 0 in the JSON summary. Not a failure.
- Either side trips its `fleeWhenHealthBelow` watcher: the evac runs but the scenario continues until the deadline.

### Try it

```bash
LIVE=1 pnpm exec tsx scripts/examples/reactive-bodyguard-fleet.ts \
  --user=tslive05 --character=ExVIP \
  --bodyguard-account=tslive06 --bodyguard-character=ExBodyguard \
  --minutes=4 --verbose
```

---

## resource-cartographer-fleet

**Purpose:** Ten characters fan out across a planet-scale grid, survey the requested resource class at their assigned cell centre, and stream every survey point back to a single aggregated NDJSON heatmap on disk. Demos large-fleet coordination (10 clients), per-character cell assignment, the radial `Use` → `ResourceListForSurveyMessage` → `survey` → `SurveyMessage` flow at scale, and post-run aggregation of fleet output.

**Roles (fleet):** Ten `Cartographer` clients — `tslive11`/`ExCartog01` through `tslive20`/`ExCartog10`. All roles are functionally identical (a single `makeScenario` factory parameterised by `CellAssignment`); cell ids are assigned 0–9 against the grid produced by `planGrid` (line 106). Launched with `--stagger-ms` (default 750) to avoid hammering the connection server with 10 simultaneous auths.

### Flow

There's no inter-character runtime coordination at all — every assignment is computed up-front in `main` from the `--cols × --rows` grid (must total ≥ 10) and each character only ever touches its own cell. Aggregation happens after the fleet completes via a shared `SharedResults` closure object that each scenario appends to.

1. **Grid planning** — `planGrid` (line 106) generates the first 10 `CellAssignment`s from a `--cols × --rows` grid centred on `(--centerX, --centerZ)` with `--cellSize` spacing. `cellIndex` is row-major (`col + row*cols`); each cell carries its `centerX/centerZ`. Anything beyond cell 9 is discarded.
2. **Config build** — `buildConfigs` (line 270) pairs cell `i` with account `LIVE_ACCOUNTS[i]` and character `LIVE_CHARACTERS[i]`, building a `FleetClientConfig` whose `script` is a fresh `makeScenario(cell, ...)` closure. All ten configs share the same `shared: SharedResults` accumulator and the same `--planet` (default `mos_eisley`).
3. **Per-character scenario** (`makeScenario`, line 155):
   - Sleep 2.5 s for baselines + containment messages to settle (so `findSurveyTools` sees the inventory).
   - `findSurveyTools(ctx)` (from `_lib-survey.ts`) — BFS the inventory + nested containers for survey-tool template patterns, returning a `class → NetworkId` map. `pickToolForClass(tools, args.resource)` returns either the exact-class tool or the universal `*` fallback. **Soft-fail**: no matching tool → `status.status = 'no-tool'`, push to `shared.statuses`, `ctx.logout()`, return.
   - `ctx.walkTo({ x: cell.centerX, z: cell.centerZ })` — outdoor cells can be hundreds of metres from spawn. Foot speed is engine-locked at `BASE_RUN_SPEED`; if `--minutes` runs out before all cells are visited, the remaining cells just don't get sampled. `walkTo` failure → `status.status = 'walk-failed'`, log, `ctx.logout()`, return.
   - Wait 1.2 s for the world to settle, snapshot `ctx.position()`.
   - `ctx.fetchSurveyResources(toolId, { timeoutMs })` — drives the full `CM_objectMenuRequest` → `CM_objectMenuResponse` → `ObjectMenuSelectMessage(ITEM_USE)` → `ResourceListForSurveyMessage` flow and returns the `ResourceListItem[]` of spawned types this tool can reach at this location. Empty list or thrown timeout → `status.status = 'no-types'`, logout, return.
   - Slice the first `--max-types` types, call `ctx.survey(toolId, type.resourceName)` for each, then `await ctx.waitForSurvey({ timeoutMs })` for the inbound `SurveyMessage`. Each result is appended to `shared.allSurveys` as a `CellSurvey` (cell metadata + the raw `SurveyPoint[]`). Per-type timeout is logged but doesn't abort the cell — other types still get scanned.
   - `ctx.logout()` at the end (or on any soft-fail) so the cluster doesn't have to time out the session itself.
4. **Aggregation** — after `runFleet` returns, `writeHeatmap` (line 308) flattens every `CellSurvey.points` into one `HeatmapRow` per sample (with cell metadata + concentration) and writes NDJSON to `--output-ndjson` (default `/tmp/cartography-<ts>.ndjson`). `main` also scans for the global `peakConcentration` and emits the cell index that produced it. Exit code is `0` only if the fleet succeeded AND `totalPoints > 0` — an entirely empty NDJSON is treated as failure.

### Key APIs used

| `ctx.*` / helper | Purpose |
|---|---|
| `findSurveyTools(ctx)` (`_lib-survey.ts`) | BFS inventory + sub-containers for survey-tool templates; returns `class → NetworkId` map |
| `pickToolForClass(tools, args.resource)` (`_lib-survey.ts`) | Resolve exact class or universal `*` fallback |
| `ctx.walkTo({ x, z })` | Walk to cell centre; auto-handles teleport ack on first call |
| `ctx.position()` | Snapshot the actual sampled location (may differ from `cell.centerX/Z`) |
| `ctx.fetchSurveyResources(toolId, { timeoutMs })` | Drives the radial `Use` flow; returns `ResourceListItem[]` |
| `ctx.survey(toolId, resourceName)` | Fires `useAbility('requestsurvey', toolId, resourceName)`; resourceName must be a SPECIFIC spawned type, not a class |
| `ctx.waitForSurvey({ timeoutMs })` | Awaits the next inbound `SurveyMessage`, returns `{ points: SurveyPoint[] }` |
| `ctx.logout()` | Clean shutdown after the cell's work is done |
| `ctx.wait(ms)` | Settle delays between baseline arrival and inventory scan |

### Code map

| File:line | Function | Purpose |
|---|---|---|
| `resource-cartographer-fleet.ts:60` | `interface ScriptArgs` | Per-script flag struct including grid geometry, resource class, output path |
| `resource-cartographer-fleet.ts:75` | `parseScriptArgs` | Parses every `--*` flag; enforces `cols * rows >= 10` |
| `resource-cartographer-fleet.ts:106` | `planGrid` | Generates the first 10 row-major `CellAssignment`s centred on `(centerX, centerZ)` with `cellSize` spacing |
| `resource-cartographer-fleet.ts:141` | `interface CellStatus` | Per-cell soft-fail reason (`'no-tool' \| 'no-types' \| 'walk-failed' \| 'error' \| 'ok'`) plus type/point counts |
| `resource-cartographer-fleet.ts:150` | `interface SharedResults` | Shared accumulator — `allSurveys: CellSurvey[]` and `statuses: CellStatus[]`; closure-captured into every scenario |
| `resource-cartographer-fleet.ts:155` | `makeScenario` | Per-cell scenario: settle → find tool → walk → fetch list → survey N types → push to `shared.allSurveys` → logout |
| `resource-cartographer-fleet.ts:270` | `buildConfigs` | Pair each cell with its account/character, all sharing the same `SharedResults` |
| `resource-cartographer-fleet.ts:308` | `writeHeatmap` | Post-fleet: flatten `CellSurvey.points` into one NDJSON row per sample, write to `--output-ndjson` |
| `resource-cartographer-fleet.ts:333` | `main` | Plan grid → build configs → `runFleet(args, configs, { staggerMs: 750 })` → write heatmap → compute peak → emit summary; exit 1 if `totalPoints === 0` |

### CLI flags

- `--resource=CLASS` (default `mineral`) — resource class (`mineral`, `gas`, `water`, `flora_resources`, etc.); resolved via `pickToolForClass` → universal `*` fallback.
- `--centerX` (default 3500), `--centerZ` (default -4800) — grid centre in world metres.
- `--cellSize` (default 750) — m spacing between adjacent cell centres.
- `--cols` (default 4), `--rows` (default 3) — grid geometry; `cols * rows` must be `>= 10`.
- `--max-types` (default 3) — cap on resource types surveyed per cell.
- `--survey-timeout-ms` (default 8000) — per-response timeout for `fetchSurveyResources` and each `waitForSurvey`.
- `--stagger-ms` (default 750) — launch stagger between the 10 clients.
- `--planet=CITY` (default `mos_eisley`) — `starting_locations.iff` key for character creation.
- `--output-ndjson=PATH` (default `/tmp/cartography-<ts>.ndjson`) — heatmap output path; `mkdir -p` happens automatically.

### Soft-fail conditions

Each is recorded as a `CellStatus` entry in `shared.statuses` and the scenario then calls `ctx.logout()` cleanly:

- `pickToolForClass` returns `undefined` → `status.status = 'no-tool'`, `reason = "no /<class>|universal/ survey tool in inventory"`.
- `ctx.walkTo` throws → `status.status = 'walk-failed'`, `reason = err.message`.
- `fetchSurveyResources` throws (timeout, no `VAR_SURVEY_CLASS` objvar) → `status.status = 'no-types'`, `reason = "fetchSurveyResources: ..."`.
- Server returns empty resource list → `status.status = 'no-types'`, `reason = "server returned empty resource list"`.
- Per-type `waitForSurvey` timeout: logged but doesn't abort the cell — other types still get scanned, only that one type contributes no points.
- Outer `try` catches any other throw → `status.status = 'error'`, `reason = err.message`.

A run is overall "successful" only if the fleet itself succeeded AND `totalPoints > 0`; the exit code is `1` if the heatmap NDJSON is empty even when every character logged out cleanly.

### Try it

```bash
LIVE=1 pnpm exec tsx scripts/examples/resource-cartographer-fleet.ts --minutes=8 --resource=mineral --output-ndjson=/tmp/cart.ndjson
```
