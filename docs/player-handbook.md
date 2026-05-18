---
title: Player Handbook
---

# Player Handbook

A hand-written, human-friendly companion to the auto-generated [`views-reference.md`](views-reference.md) and [`actions-reference.md`](actions-reference.md). The auto refs tell you _what_ every `ctx.*` field and method is; this handbook tells you _what it means in SWG terms_, _what a typical value looks like_, _what to do with it_, and _what trips people up_.

Audience: a developer who knows TypeScript well but is new to SWG and to this framework. Every chapter follows the same pattern — concept first (in plain SWG-player terms), then how it maps to `ctx.*`, then real templates / numbers / workflows, then gotchas, then quick recipes.

## A note on the real-world examples

Most "real value" snippets in this handbook come from a single live capture against the canonical test cluster at `10.254.0.253:44453/udp`:

- **Account / character:** `tslive01` / `TsLive01` (an admin-allowlist account; default character; human male)
- **Spawn:** Mos Eisley, Tatooine — `terrain/tatooine.trn` at `(3528, 4, -4804)`, yaw `2.66 rad`
- **Captured:** May 17 2026 (see `docs/handbook-snapshot.json` for the raw dump and `scripts/capture-handbook-data.ts` for the capture script — run it yourself with `LIVE=1 pnpm exec tsx scripts/capture-handbook-data.ts`)

Where you see a **"Captured live:"** block in a chapter, that's literal output from `TsLive01` mid-Mos Eisley. The wider narrative uses personas like `TsHunter` (a Bothan Marksman), `ExSurveyor` (a Master Domestics Trader), and `ExPilgrim` (a planet-hopping Smuggler) for storytelling continuity. Treat the personas as illustrations of the API surface; treat the "Captured live" blocks as ground truth about what the server actually sends.

## Index

| # | Chapter | What you'll learn |
|---|---|---|
| 1 | [Who is your character?](#chapter-1-who-is-your-character) | Account, character, station ID, profession, species, character creation |
| 2 | [The character sheet](#chapter-2-the-character-sheet) | HAM, posture, skills, abilities, XP, factions, buffs, weapon |
| 3 | [Where you are: position, scene, cells, navigation](#chapter-3-where-you-are-position-scene-cells-navigation) | Two coordinate frames, walkTo/walkCircle/walkToCell/navigate, teleport ack |
| 4 | [Mounts, vehicles, and pets](#chapter-4-mounts-vehicles-and-pets) | PCDs, calling, mounting, speedCap, pet commands |
| 5 | [Travel: planet-hopping with shuttles](#chapter-5-travel-planet-hopping-with-shuttles) | `ctx.travel`, vendor/collector, ticket flow, re-zone handshake |
| 6 | [Inventory, equipment, and the bank](#chapter-6-inventory-equipment-and-the-bank) | Items, equipped slots, sub-containers, bank terminal, credits |
| 7 | [The datapad: vehicles, pets, schematics, waypoints, missions](#chapter-7-the-datapad-vehicles-pets-schematics-waypoints-missions) | What "intangible" means, datapad shape, lifecycle of each item type |
| 8 | [Waypoints, houses, lots, and player structures](#chapter-8-waypoints-houses-lots-and-player-structures) | Datapad waypoints vs world waypoints, deeds, lot allowance, cities |
| 9 | [The WorldModel: NPCs, creatures, buildings, finding things](#chapter-9-the-worldmodel-npcs-creatures-buildings-finding-things) | `ctx.world` queries, ObjectTypeTags, baselines, subscriptions |
| 10 | [Resources, survey, and crafting](#chapter-10-resources-survey-and-crafting) | The harvest-craft loop end-to-end |
| 11 | [Combat, abilities, and the command queue](#chapter-11-combat-abilities-and-the-command-queue) | Engage, attack, loot, cooldowns, self-flee |
| 12 | [Talking and socializing: chat, groups, and guilds](#chapter-12-talking-and-socializing-chat-groups-and-guilds) | Five chat channels, group invites, follow, guilds |
| 13 | [Doing business: trade, missions, NPCs, SUI, and the bazaar](#chapter-13-doing-business-trade-missions-npcs-sui-and-the-bazaar) | SecureTrade, mission terminals, NPC dialogs, SUI pages, listings |
| 14 | [Operating at scale: fleets, persistence, and the engine](#chapter-14-operating-at-scale-fleets-persistence-and-the-engine) | Fleet, NetworkId pre-resolve, character pool, capture/replay, lifecycle |

---

## Chapter 1: Who is your character?

In SWG, your **character** is your avatar in the world — a named Bothan Marksman, a Wookiee Bounty Hunter, a human Medic, etc. Before you can walk anywhere, survey resources, craft, or fight, the server needs to know exactly who you are. This chapter walks you through the identity system that underpins every lifecycle: the account name, the character name, the profession, species, and starting location. You'll meet these concepts first as a player would see them, then as they appear in your code via `ctx.*` and the wire messages.

### The account name

Your **account** is a login credential — the name you enter into the launcher. Account names cap at **15 characters** (`MAX_ACCOUNT_NAME_LENGTH` in `CommonAPI.cpp:6`). Try `my_super_long_username` (20 chars) and the server returns an `ErrorMessage` with `"Account name is too long!"`.

In dev/CI, most accounts follow a pattern. The canonical test pool is `tslive01` through `tslive20` (the **admin-whitelisted pool**). These accounts are hardcoded into the server's admin allowlist (`stella_admin.tab`) and bypass character-creation limits — `canCreateRegularCharacter=true` is guaranteed. Non-admin accounts will see `canCreateRegularCharacter=false` and fail with `ClientCreateCharacterFailed`.

The pool solves a real problem: every fresh test run otherwise leaks a timestamp-suffixed character. The admin accounts are short-lived — you pick the least-recently-used one (via `pickAdminPoolAccount()` in `tests/integration/helpers.ts`) and wait 12 seconds between uses to let the server's GameConnection close.

In code:
- `FullLifecycleOptions.account` — the string you pass to `SwgClient.fullLifecycle()`.
- Stage 1 (LoginServer) reads it from your `LoginClientId`.
- The server replies with a `LoginClientToken` that includes an internal **StationId** (account number) — a per-account integer used to track characters and subscriptions. You don't send it back; it's embedded in the token.

```typescript
const result = await client.fullLifecycle({
  account: 'tslive01',          // Stage 1 sends this in LoginClientId
  characterName: 'TsHunter',
  planet: 'tatooine',
});
```

**Captured live:** account `tslive01`, station id resolved from `LoginClientToken`. The framework's `pickAdminPoolAccount()` rotates through the 20 admin slots by PID mod 20 so concurrent vitest workers don't collide.

### The character name

Your **character name** is your in-world identity — the name other players see in /tell and above your avatar. UTF-16 on the wire, no published global length cap (30–40 chars is normal), must be unique within a cluster, and passes through a profanity filter (`BadWordFilter.cpp`).

If creation fails on collision, `createCharacterWithRetry()` in `src/client/connection-stage.ts` retries with a numeric suffix: `TsHunter1`, `TsHunter2`, etc.

**Recommended persona for this handbook:** `TsHunter`, a Bothan Marksman on Tatooine (account `tslive01`).

**Captured live:** account `tslive01` actually already had a character named `TsLive01` (the default), so the orchestrator selected it instead of creating `TsHandbook`. This is the framework's default "pick first matching character or create one" behavior. If you really want a specific new name, set `characterToCreate.name` explicitly.

```typescript
// Sample CharacterInfo from EnumerateCharacterId (Stage 1) for tslive01:
{
  networkId: 0x22c790f5n,           // 8-byte bigint NetworkId — stable across logins
  name: 'TsLive01',
  objectTemplateId: 0x...,            // CRC of shared_human_male.iff
  clusterId: 1,
  characterType: 1,                  // Normal=1, Jedi=2, Spectral=3
}
```

### The cluster (server)

SWG is multi-server. Stage 1 sends `LoginEnumCluster` + `LoginClusterStatus` listing available clusters; you pick one and connect to its `ConnectionServer` in Stage 2. For dev/test, usually just one cluster (`swg`).

```typescript
const result = await client.fullLifecycle({
  account: 'tslive01',
  characterName: 'TsHunter',
  clusterName: 'swg',  // explicit; default is first
});
```

### The profession (7 legacy values + NGE mapper)

Your **profession** gates which skills you can learn. The server's `PlayerCreationManager` accepts **only 7 legacy strings**:

1. `combat_brawler` — hand-to-hand and melee (default)
2. `combat_marksman` — ranged weapons
3. `crafting_artisan` — item creation
4. `social_entertainer` — music, dancing, healing wounds
5. `science_medic` — healing and buffs
6. `outdoors_scout` — scouting and tracking
7. `jedi` — Force-sensitive (special unlock)

Any other value → `shared:character_create_failed_bad_profession`.

**The NGE picker mapping**: the Windows client UI has "Domestics Trader", "Armor Trader", "Marksman", etc. — but those are NOT what goes on the wire. Behind the scenes the client translates:

- UI "Domestics Trader" → `profession='social_entertainer'`, `skillTemplate='trader_0a'`, `workingSkill='class_domestics_phase1_novice'`
- UI "Armor Trader" → `profession='social_entertainer'`, `skillTemplate='trader_0b'`, `workingSkill='class_armor_phase1_novice'`
- UI "Marksman" → `profession='combat_marksman'`, empty skillTemplate/workingSkill
- UI "Jedi" → `profession='jedi'`, empty skillTemplate/workingSkill

```typescript
// Domestics Trader (full NGE picker mapping)
await client.fullLifecycle({
  account: 'tslive01',
  characterName: 'TsTrader',
  characterToCreate: {
    profession: 'social_entertainer',
    skillTemplate: 'trader_0a',
    workingSkill: 'class_domestics_phase1_novice',
  },
});
```

### Species and gender

10 species — `human`, `bothan`, `trandoshan`, `ithorian`, `moncal`, `rodian`, `sullustan`, `twi'lek`, `wookiee`, `zabrak`. Most have male/female; **ithorians and wookiees are gender-fixed** server-side regardless of what you send.

Species + gender encode into the **server** `templateName`: `object/creature/player/<species>_<gender>.iff`. NOT the `shared_*` variant — the server's `GameServer::getServerCreatureObjectTemplate()` looks up the non-shared path and rejects the shared one with `shared:character_create_failed_bad_template`.

**Captured live:** the character we zoned in as was created with `templateName: object/creature/player/shared_human_male.iff` — that's the SHARED-template (what's seen on the wire after creation). The original creation request used `object/creature/player/human_male.iff` (the server template); the server stores both and broadcasts the shared variant in baselines.

### The starting location (city key, NOT planet name)

`startingLocation` is a **city key** from `starting_locations.iff`, not a planet name. Valid keys:

- Tatooine: `mos_eisley`, `bestine`, `mos_espa`
- Naboo: `theed`, `keren`, `tyrena`, `kor_vella`
- Corellia: `coronet`, `dearic`
- Lok: `nklpit`
- Rori: `restuss`, `spaceport_imperial`
- Dantooine: `eisley`

Default: `mos_eisley`. Pass `'tatooine'` and you'll get `shared:character_create_failed_bad_location`.

### Character types

`CharacterInfo.characterType` enum: `Normal=1`, `Jedi=2`, `Spectral=3`. The Jedi slot is gated per-account by `StationIdHasJediSlot` (returned in Stage 1).

### Character creation in two stages

When you run a lifecycle:

1. **Stage 1 (LoginServer):** `LoginClientId` sent → server replies with `EnumerateCharacterId` containing the avatar list (all existing characters on this account for this cluster).
2. **Stage 2 (ConnectionServer):** If the avatar list is empty, the framework sends `ClientCreateCharacter` with your options. Server replies with `ClientCreateCharacterSuccess` (new NetworkId) or `ClientCreateCharacterFailed`. On collision, retry with numeric suffix.

If the avatar list is non-empty, the framework skips creation and picks the first character (or honors your custom predicate).

### Reusing characters across runs

Every `fullLifecycle()` otherwise creates a fresh timestamp-suffixed character. To reuse:

**Pin one (forces serial mode):**
```bash
export CI_REUSE_ACCOUNT=tslive01
export CI_REUSE_CHARACTER=TsHunter
```

**Persistent pool (concurrent-safe):**
```bash
# Pre-stock the pool once
pnpm cli pool stock --count=10 --user=tslive --character-prefix=Ts

# Run tests with the pool
export CI_USE_POOL=1
pnpm test
```

Tests call `poolCredentials(prefix, count)` from `tests/integration/helpers.ts`. Each test checks out distinct characters from `~/.swg-ts-client/character-pool.json`. Chapter 14 covers the pool API in detail.

### Common gotchas

- **Account > 15 chars** → server rejects with `Account name is too long!`. Use `unique15(prefix, suffix)` from `_lib.ts`.
- **`templateName` must be the server path**, not the `shared_*` variant.
- **`startingLocation` is a city key**, not a planet name. `'mos_eisley'`, not `'tatooine'`.
- **Profession is the 7 legacy strings only.** Use the NGE picker mapping (`skillTemplate` + `workingSkill`) if you want a specific NGE class.
- **Non-admin accounts can't create characters** — `canCreateRegularCharacter=false` returns from Stage 2. Use `tslive01..tslive20` or pool-leased characters for tests.

### Quick recipes

```typescript
// 1. Marksman on Tatooine (our test persona)
await client.fullLifecycle({
  account: 'tslive01',
  characterName: 'TsHunter',
  characterToCreate: {
    profession: 'combat_marksman',
    templateName: 'object/creature/player/bothan_male.iff',
    startingLocation: 'mos_eisley',
  },
});

// 2. Domestics Trader (NGE picker)
await client.fullLifecycle({
  account: 'tslive01',
  characterName: 'TsTrader',
  characterToCreate: {
    profession: 'social_entertainer',
    skillTemplate: 'trader_0a',
    workingSkill: 'class_domestics_phase1_novice',
  },
});

// 3. Reuse a pinned character
// $ export CI_REUSE_ACCOUNT=tslive01 CI_REUSE_CHARACTER=TsHunter
// then just call fullLifecycle — no creation, just selection.

// 4. Check out a pool character
const { credentials, release } = await poolCredentials('fl', 1);
const [{ account, characterName }] = credentials;
await client.fullLifecycle({ account, characterName });
await release();

// 5. Look up your StationId after Stage 1
const loginResult = await runLoginStage({ ... });
const stationId = loginResult.token.stationId;

// 6. Check if your account can host a Jedi
const loginResult = await runLoginStage({ ... });
const canJedi = loginResult.hasJediSlot;

// 7. Theed (Naboo) starting location
await client.fullLifecycle({
  account: 'tslive01',
  characterName: 'TsNaboo',
  characterToCreate: { startingLocation: 'theed' },
});
```

### See also

- [Chapter 2](#chapter-2-the-character-sheet) — your character's live state (HAM, skills, XP)
- [Chapter 14](#chapter-14-operating-at-scale-fleets-persistence-and-the-engine) — pool management, multi-character orchestration
- [`docs/lifecycle.md`](lifecycle.md) — full Stage 1/2/3 state diagram
- [`docs/wire-spec.md`](wire-spec.md) — byte-level message encoding
- `src/client/connection-stage.ts` — `ClientCreateCharacterOptions` shape

---

## Chapter 2: The character sheet

Your character's identity, state, and capabilities live in a single always-on view: `ctx.character`. It's a `CharacterSheet` — a live snapshot of Health/Action/Mind, level, skills, buffs, faction, and everything else the server broadcasts about you. The sheet is **real-time**: every CREO baseline and delta updates it automatically.

### The `ready` gate

The character sheet doesn't exist in a fully-initialized state the instant you zone in. The first CREO baseline might not arrive for a few frames. Until it does, `level` reads `0`, `health.max` reads `0`, `skills` reads `[]`. Always check `ready`:

```typescript
if (!ctx.character.ready) {
  await ctx.wait(100);
}
```

Once `ready` is true, the rest of the view is safe. The flag flips the moment any CREO baseline arrives — usually within a frame or two after zone-in.

### Identity on the character

```typescript
ctx.character.name        // 'TsLive01'
ctx.character.level       // 1 (for our freshly-zoned-in test char)
ctx.character.networkId   // 0x22c790f5n (your CREO id; pinned at zone-in)
ctx.character.templateName // 'object/creature/player/shared_human_male.iff'
ctx.character.species     // 'human' (or null if not yet observed)
ctx.character.gender      // 'male' / 'female' / null
```

**Captured live for `TsLive01`:**
- `name`: "TsLive01"
- `level`: 1
- `posture`: "standing"
- `species`/`gender`: both `null` (the enriched parser hasn't decoded this yet — open gotcha)

### HAM bars

HAM = Health/Action/Mind. Each pool has `current` and `max`:

```typescript
ctx.character.health.current  // 1000
ctx.character.health.max      // 1000
ctx.character.action.current  // 300
ctx.character.action.max      // 300
ctx.character.mind.current    // 300
ctx.character.mind.max        // 300
```

**Captured live for `TsLive01`:** `H=1000/1000`, `A=300/300`, `M=300/300`. That's the un-buffed level-1 baseline for a fresh human male.

Combat damages all three pools. Sleep restores Mind. Incapacitation hits when any pool hits 0; death follows after overkill or repeated incaps.

A 0..1 ratio for "how healthy am I":
```typescript
const ratio = ctx.character.health.current / (ctx.character.health.max || 1);
if (ratio < 0.25) ctx.safety.fleeWhenHealthBelow(0.25);
```

### Posture

Posture is a state enum surfaced as a friendly name:

```typescript
ctx.character.posture  // 'standing' | 'crouched' | 'prone' | 'sneaking' | 'blocking' |
                        // 'climbing' | 'flying' | 'lyingDown' | 'sitting' |
                        // 'skillAnimating' | 'drivingVehicle' | 'ridingCreature' |
                        // 'knockedDown' | 'incapacitated' | 'dead' | 'unknown'
```

Change posture:
```typescript
await ctx.changePosture('sitting');
await ctx.wait(500);
console.log(ctx.character.posture);  // 'sitting'
```

The action maps friendly names to server commands (`'standing'` → `'stand'`, `'crouched'` → `'crouch'`, `'prone'` → `'prone'`, `'sitting'` → `'sit'`).

Posture-gated commands matter: you can't mount, cast, or attack while `dead` or `incapacitated`. Always guard:

```typescript
if (ctx.character.posture === 'standing') await ctx.attackTarget(targetId);
```

### Mood

```typescript
ctx.character.mood  // 0 = regular, 1 = sad, 2 = frustrated, ...
```

Numeric enum; mapping to names lives in a server-side mood table. Set via `useAbility('setMood', 0n, String(moodInt))`.

### Faction

Three faction values + enriched details:

```typescript
ctx.character.faction          // 0 = neutral, 1 = imperial, 2 = rebel
ctx.character.factionDetails.name     // 'neutral' | 'imperial' | 'rebel'
ctx.character.factionDetails.standing // GCW points (negative = opposite faction has been hit harder)
ctx.character.factionDetails.pvpStatus // same as faction (historical field)
```

**Captured live:** `faction: 0`, `factionDetails: { type: 0, name: 'neutral', standing: 0, pvpStatus: 0 }`. Neutral characters don't accumulate GCW standing; only declared Imperial/Rebel characters do.

### Skills (5+ name strings)

Skills are the "boxes" you've trained:

```typescript
ctx.character.skills.length    // 5 (for our fresh test char)
ctx.character.skills.slice(0, 5)
// => ['class_chronicles_novice',
//     'social_language_basic_speak',
//     'social_language_basic_comprehend',
//     'social_language_wookiee_comprehend',
//     'species_human']
```

**Captured live for `TsLive01`** — even a brand-new level-1 character starts with 5 baseline skills: the chronicles tutorial unlock, two basic language packs, wookiee comprehension (lets you parse Shyriiwook), and a species-anchor skill.

For a Master Marksman you'd see things like `marksman_novice`, `marksman_carbine_speed_03`, `marksman_master`. Names are CRC-keyed on the wire; the sheet surfaces the resolved strings.

### Skill mods (numeric bonuses)

`skillMods` is a `Map<string, number>` of named modifiers:

```typescript
ctx.character.skillMods.get('precision')          // e.g. 25
ctx.character.skillMods.get('block')              // 500 (display-only at level 1)
ctx.character.skillMods.get('creature_harvesting')  // 25
ctx.character.skillMods.get('minDamage')          // 5
ctx.character.skillMods.get('maxDamage')          // 65
```

**Captured live, top 15 mods on `TsLive01`:**

```
chronicles_max_tasks:        6
chronicles_relic_quality:    1
creature_harvesting:        25
display_only_block:        500
display_only_critical:     500
display_only_dodge:        500
display_only_evasion:      500
display_only_parry:        500
display_only_strikethrough:500
language_basic_comprehend: 100
language_basic_speak:      100
language_wookiee_comprehend:100
maxDamage:                  65
minDamage:                   5
```

The `display_only_*` mods are placeholder values shown in the character sheet UI before you train any combat skills — they're the "this is where your block/dodge/parry value would be" stat windows. Real combat values arrive once you train skills that grant them.

### XP map

XP is tracked by category:

```typescript
ctx.character.xp.get('combat_general')       // 1500
ctx.character.xp.get('crafting_artisan')     // 200
ctx.character.xp.get('entertainer_dancing')  // 50
```

**Captured live:** empty (`[]`). A fresh character with no kills, no crafts, no dances has no XP entries yet — the map only grows as you accrue.

### Buffs and effects

Active enhancements (food, dance, doctor, jedi force):

```typescript
ctx.character.effects.length  // 0 (fresh char has no buffs)
// For a buffed char:
// [{ name: 'mind_focus_buff_a', magnitude: 15, durationSec: 120, expiresAt: 1621234567 }, ...]
```

The `name` field is a hex string CRC (no `0x` prefix) because the client doesn't have a buff-name table. To match a specific buff, compute the CRC with `constcrc(buffName)`.

### Money

```typescript
ctx.character.bankBalance  // 0 (we're broke!)
ctx.character.cashBalance  // 0
```

Both are credit-denominated. Total liquid: `bankBalance + cashBalance`.

### Group + guild

```typescript
ctx.character.groupId       // 0x...n or null (null when solo)
ctx.character.groupInviter  // { id, name } when someone has invited you, else null
ctx.guild.id                // numeric guild id; 0 if none
```

`groupInviter` non-null = pending invitation. Used by the canonical group-flow in `src/scenarios/group-trade.ts`: invitee polls `ctx.character.groupInviter` until non-null, then sends `useAbility('join')`.

### Played time

```typescript
ctx.character.playedTime  // 10290 seconds = 2h 51m
```

**Captured live:** `10290` seconds. Cumulative across all sessions — useful as a soak metric.

### Weapon (enriched)

```typescript
ctx.character.currentWeapon  // 0x22c790fcn (raw NetworkId of equipped weapon)
ctx.character.weapon  // {
  //   networkId: 0x22c790fcn,
  //   templateName: null,        // not yet observed
  //   minDamage: null,           // requires fetchResourceAttributes
  //   maxDamage: null,
  //   attackSpeed: 0.5,
  //   range: 5,
  //   ammoRemaining: null,
  // }
```

`minDamage`/`maxDamage` populate only after `ctx.fetchResourceAttributes([weaponId])` triggers the server's `AttributeListMessage`. `attackSpeed` and `range` come from the WEAO SHARED baseline.

### Roadmap (NGE NPE progress)

```typescript
ctx.character.roadmap  // { currentPhase: 'phase1', currentTask: 'novice', tasksRemaining: 5 } or null
```

**Captured live:** `{ currentPhase: '', currentTask: '', tasksRemaining: 0 }` — our character is not on the active NPE track (admin-spawned creation skips the tutorial).

### Common gotchas

- **HAM before baseline arrival reads 0.** Always check `ctx.character.ready` first, or guard with health-max-positive.
- **`species` and `gender` aren't fully decoded yet** on every character (see captured live above — both null on TsLive01). For an authoritative species, parse `ctx.character.templateName` for the species substring.
- **Posture-gated commands silently fail server-side.** Check `posture === 'standing'` before mount/attack.
- **Skill names are CRC-keyed.** The sheet resolves to names where it can; unknown CRCs surface as `0x...` strings.
- **Faction `standing` doesn't accumulate for neutrals.** Declare Imperial/Rebel via the recruiter NPC first.
- **Weapon damage is null until fetched.** Call `ctx.fetchResourceAttributes([weaponId])` to populate.
- **Group `group` (enriched) requires a `GroupObject` baseline.** The id arrives in a CREO delta; the member list may lag by a frame.
- **Played time is monotonic across sessions** — it's a great drift detector.

### Quick recipes

```typescript
// Wait for character sheet to populate
while (!ctx.character.ready) await ctx.wait(100);

// Check if you can mount
if (ctx.character.posture === 'standing' && ctx.character.health.current > 0) {
  await ctx.mount(vehicleId);
}

// Read HAM as a 0..1 ratio
const ratio = ctx.character.health.current / (ctx.character.health.max || 1);

// Find a specific skill
const hasMaster = ctx.character.skills.includes('marksman_master');

// Faction check
const isImperial = ctx.character.factionDetails.name === 'imperial';

// XP delta for a single category (snapshot before/after)
const before = ctx.character.xp.get('combat_general') ?? 0;
// ... do combat ...
const after = ctx.character.xp.get('combat_general') ?? 0;
console.log('XP gained:', after - before);
```

### See also

- [Chapter 11](#chapter-11-combat-abilities-and-the-command-queue) — combat, abilities, cooldowns
- [Chapter 6](#chapter-6-inventory-equipment-and-the-bank) — equipped items + worn slots
- [Chapter 12](#chapter-12-talking-and-socializing-chat-groups-and-guilds) — group membership

---

## Chapter 3: Where you are: position, scene, cells, navigation

You've spawned on Tatooine at coordinates (3528, -4804), standing in Mos Eisley. The server knows exactly where you are. Your script needs to know exactly where you are too — and more importantly, know how to *move* to somewhere else. This chapter is about the two coordinate systems, how to track them, and how to walk from one place to another.

### Two coordinate frames

**World coordinates** (`x`, `y`, `z`) describe your position on the planet's surface. Tatooine, Naboo, Corellia — each is a 2D grid. The `x` and `z` axes are the horizontal plane (meters). The `y` axis is vertical (altitude). When your script says "walk to (3600, 100, -4900)", you're asking the server to move you in the world frame.

**Cell coordinates** describe your position *relative to a cell's local origin*. Cells are building interiors — the Mos Eisley cantina is a cell. Inside a cell, (0, 0, 0) is the cell's architectural origin. Walk to (10, 0, -5) inside the cell and you move 10m along the cell's local X axis, -5m along the local Z.

**Why this matters: y is sticky indoors.** Outside, the server mostly ignores your `y` and snaps you to the terrain. Inside a cell, the `y` you send is the `y` the server uses — cells have explicit floor heights. If the cantina's main floor is at `y = 0`, you stay at `y = 0`. If you climb a staircase to a mezzanine at `y = 3`, you must send `y = 3` or you'll hover above the floor.

### Your live pose cursor

Every movement primitive maintains a **live pose cursor** — your current location and facing direction:

```typescript
const pos = ctx.position();       // { x: 3528, y: 4, z: -4804 }
const facing = ctx.yaw();         // radians, 0 = north (+z), π/2 = east (+x)
```

**Captured live for `TsLive01` at spawn:**
- `position`: `{ x: 3528, y: 4.04, z: -4804 }`
- `yaw`: `2.66 rad` (≈ 152° — facing roughly southeast)
- `cell`: `null` (outdoors)
- `planet`: `"tatooine"` (normalized from `sceneStart.sceneName: "terrain/tatooine.trn"`)

The cursor is the orchestrator's local model of where you've sent yourself. The server's notion (in `ctx.world`) lags ~500ms behind. For continuous walking, trust the cursor.

You can manually set it (rarely needed):
```typescript
ctx.setPose({ x: 3600, y: 100, z: -4900 }, 0);  // face north
```

### Cell-relative cursor

When you're indoors, you also have:

```typescript
const cellPos = ctx.cellPosition();  // { x: 10, y: 0, z: -5 }
const cellId = ctx.parentCell();     // NetworkId of the cell, or 0n if outdoors
```

`parentCell` is set by `ctx.walkToCell()` or by `ctx.setCellPose()`. Cell coords don't persist when you leave — `parentCell` becomes `0n` and `cellPosition` is meaningless.

### `ctx.sceneStart`: the immutable spawn record

When you zone in, the server sends `CmdStartScene`. The context captures it:

```typescript
ctx.sceneStart.playerNetworkId  // 0x22c790f5n
ctx.sceneStart.sceneName        // "terrain/tatooine.trn"
ctx.sceneStart.startPosition    // { x: 3528, y: 4.04, z: -4804 }
ctx.sceneStart.startYaw         // 2.66
ctx.sceneStart.templateName     // "object/creature/player/shared_human_male.iff"
ctx.sceneStart.serverTime       // server's Unix timestamp at zone-in
```

### `ctx.location`: high-level view

```typescript
ctx.location.planet        // "tatooine" (always normalized)
ctx.location.position      // current world pose
ctx.location.cell          // null if outdoors; { buildingId, cellName, cellNumber, isPublic } if inside
```

The framework normalizes scene names: `"terrain/tatooine.trn"` → `"tatooine"`. Always use `ctx.location.planet` instead of `ctx.sceneStart.sceneName`.

### Engine-locked run speed

**On foot, you always move at 7.3 m/s.** This is `BASE_RUN_SPEED` — lifted from `dsrc/.../shared_base_player.tpf`'s `speed[MT_run] = 7.3`. Every player species inherits this; none override.

You cannot walk slower or faster on foot. The engine speaks for the character.

The only way to change pace is to mount — `ctx.mountedSpeedCap()` returns the vehicle's max speed (a speeder bike is 12 m/s, a swoop 15, a beast-of-burden 4). The walk primitives automatically clamp to this cap (Chapter 4 covers mounting in detail).

### `ctx.walkTo({x, z, y?}, opts?)` — straight-line walk

```typescript
await ctx.walkTo({ x: 3700, z: -4800 });        // walk ~172m east
await ctx.walkTo({ x: 3600, z: -4900, y: 50 }); // override y to 50
```

Emits one transform message per `tickMs` (default 500ms), moving at the effective run speed. The server ignores the wire `speed` field (it's always 0) and derives effective speed from position-delta / sync-stamp-delta. Anti-cheat caps at the creature's allowed run speed.

`opts` is just `{ tickMs?, y? }` — no `speed` option (engine-locked).

### `ctx.walkCircle({centerX, centerZ, radius, durationMs, tickMs?, y?, direction?})`

Orbital walk around a point — patrol routes, ceremonial dances:

```typescript
await ctx.walkCircle({
  centerX: 3550, centerZ: -4850,
  radius: 20, durationMs: 60_000,
  direction: 1,  // 1 = counter-clockwise, -1 = clockwise
});
```

Derived tangential speed = `(2π · radius) / durationMs`. If that exceeds the effective run speed, the orbit takes longer (capped, not sped up).

### `ctx.walkToCell(cellId, {x, z, y?}, opts?)` — cell-relative walk

```typescript
await ctx.walkToCell(cellNetworkId, { x: 5, z: -8 });
```

Sends `CM_netUpdateTransformWithParent (241)` instead of `CM_netUpdateTransform (113)`. The cell id tells the server which local frame to use.

You can't mix these: if you're indoors and send a world-frame transform, the server drops it silently. Same in reverse.

### `ctx.navigate(target, opts?)` — the high-level workhorse

For anything non-trivial, use `navigate()`. It handles mounting, dismounting, cell entry, and all the glue:

```typescript
// Outdoor coord
await ctx.navigate({ x: 3700, z: -4800 });

// Into a building cell
await ctx.navigate({
  buildingId: cantinaBuildingId,
  cellName: 'cell1',          // or 'Main Room', or '' for first public cell
  position: { x: 5, z: -8 },  // cell-local target; defaults to {x: 0, z: 0}
});
```

Plan steps: `callVehicle → mount → walkTo → dismount → walkToCell`. If distance > 50m AND you have a vehicle in datapad AND you're outdoors, it mounts. Otherwise foot. Always dismounts before cell entry.

Customize:
```typescript
await ctx.navigate(target, {
  useMount: 'never',           // always walk
  mountThresholdM: 100,        // mount only if > 100m
  dismountDistanceM: 10,
});
```

### Teleport-ack bootstrap (critical wire detail)

The server's `PlayerCreatureController::resyncMovementUpdates` inserts negative sequence IDs into a queue at zone-in. Until you ACK them via `ctx.ackPendingTeleports()`, every transform is silently dropped.

The walk primitives auto-ack on first invocation. **But** if you build raw transforms via `ctx.send()` directly, you MUST call `await ctx.ackPendingTeleports()` once first:

```typescript
await ctx.ackPendingTeleports();
ctx.send(new ObjControllerMessage(/* my CM_netUpdateTransform */));
```

### Sequence numbers and sync stamps

```typescript
const syncStamp = ctx.nextSyncStamp();        // auto-managed
const seq = ctx.nextSequenceNumber();         // auto-managed
```

Walk primitives manage these. Rarely needed directly.

### Tick cadence

Default 500ms per movement message. Matches the real Windows client's send rate. At 7.3 m/s × 500ms = 3.65m per tick — comfortably under the server's anti-cheat window.

### Concrete navigation examples

**Walk to Mos Eisley cantina door** (from spawn at (3528, -4804); cantina ~50m north at (3570, -4820)):

```typescript
await ctx.navigate({ x: 3570, z: -4820 });
// Computes distance, decides no mount needed (~50m), walks straight ~15 ticks (~7.5s)
```

**Enter cantina, walk to the bartender:**

```typescript
const cantinaId = ctx.world.byType(ObjectTypeTags.BUIO)
  .find((b) => /cantina/i.test(b.templateName ?? ''))?.id;

await ctx.navigate({
  buildingId: cantinaId!,
  cellName: '',                   // first public cell
  position: { x: 15, z: 5 },      // cell-local bartender position
});
```

**Detect what planet you spawned on:**
```typescript
console.log(ctx.location.planet);  // "tatooine"
```

**Check if you're indoors:**
```typescript
if (ctx.location.cell) {
  console.log(`In ${ctx.location.cell.cellName} of building 0x${ctx.location.cell.buildingId.toString(16)}`);
}
```

### Common gotchas

- **Raw transforms need `ackPendingTeleports`.** The walk primitives auto-ack; manual sends via `ctx.send()` do not.
- **walkTo caps each step at 8m.** Long distances take many ticks. For >50m, prefer `navigate()` (auto-mounts).
- **Cell coords are ephemeral.** `cellPosition()` is only meaningful while `parentCell()` ≠ 0. Store it if you need it later.
- **`navigate()` throws on missing BUIO baseline.** If you navigate to a building whose baseline isn't observed yet, walk close to it first so the baseline lands.
- **`y` is sticky indoors.** Outdoors the server snaps to terrain; indoors you must send the correct floor height.
- **Server dismounts you on cell entry** automatically. The framework's `navigate()` issues an explicit dismount first so the state syncs.
- **The wire `speed` field is always 0.** Anti-cheat derives effective speed from delta; sending non-zero can trip the validator.

### Quick recipes

```typescript
// Walk to an outdoor coord
await ctx.navigate({ x: 3700, z: -4800 });

// Orbit a point
await ctx.walkCircle({ centerX: 3550, centerZ: -4850, radius: 20, durationMs: 30_000 });

// Enter a building
await ctx.navigate({ buildingId, cellName: '', position: { x: 5, z: -8 } });

// Get current world coord
const pos = ctx.position();

// Get current facing (radians)
const yaw = ctx.yaw();

// Detect planet
const planet = ctx.location.planet;

// Detect cell membership
const indoors = ctx.location.cell !== null;
```

### See also

- [Chapter 4](#chapter-4-mounts-vehicles-and-pets) — mount-cap interaction with movement
- [Chapter 5](#chapter-5-travel-planet-hopping-with-shuttles) — planet hopping
- [`docs/wire-spec.md`](wire-spec.md) section 3.2 — `MessageQueueDataTransform` byte layout

---

## Chapter 4: Mounts, vehicles, and pets

### The PCD concept

When you "call your swoop," you're not creating the swoop from nothing. You're using a **Personal Control Device** (PCD) — an intangible item that lives permanently in your datapad. The PCD is the authorization; the actual creature (the swoop) is spawned on demand and lives in the world.

**Captured live for `TsLive01`:** the datapad has 1 vehicle PCD (template not yet resolved on the wire — most PCDs arrive as `SceneCreateObjectByCrc` and the templateName isn't broadcast). State: `'stored'`, `linkedCreatureId: null`. Until called, no creature exists.

**Two NetworkIds you'll juggle:**

- **PCD NetworkId** — stable, in datapad, never changes. Use to call/store.
- **Creature NetworkId** — ephemeral, only exists while spawned. Use to mount/command.

### Listing your vehicles

```typescript
const vehicles = ctx.datapad.vehicles();
// e.g. [{ networkId: 0x2205937cn, templateName: '...', name: null, state: 'stored', linkedCreatureId: null, condition: null }]
```

Each entry has `name`, `templateName` (if known), `linkedCreatureId` (the spawned creature, or null), `state` (`stored`/`called`/`following`/etc.), `condition` (0..1 HP ratio).

Real SWG vehicle templates:
- `object/intangible/vehicle/shared_vehicle_speeder_swoop_pcd.iff` — swoop (fast)
- `object/intangible/vehicle/shared_landspeeder_av21_pcd.iff` — landspeeder
- `object/intangible/vehicle/shared_speederbike_pcd.iff` — speeder bike
- `object/intangible/vehicle/shared_at_st_pcd.iff` — AT-ST walker (rare)

The spawned creature templates (different from PCDs):
- `object/mobile/vehicle/shared_landspeeder_av21.iff`
- `object/mobile/vehicle/shared_speederbike.iff`
- `object/mobile/vehicle/shared_speederbike_swoop.iff`

### Calling a vehicle

```typescript
const pcdId = ctx.datapad.vehicles()[0]?.networkId;
if (pcdId !== undefined) ctx.callVehicle(pcdId);
```

Wire: `ObjectMenuSelectMessage(pcdId, RadialMenuTypes.PET_CALL=45)`. Server spawns the vehicle creature beside you. You don't get the creature's id back immediately — it arrives as a `SceneCreateObjectByCrc` over the next 1-3 frames.

**Always give the vehicle time to materialize:**

```typescript
ctx.callVehicle(pcdId);
await ctx.wait(1500);  // settle window

const fresh = ctx.world
  .byType(ObjectTypeTags.CREO)
  .filter((o) => /vehicle|speeder|swoop|landspeeder/i.test(o.templateName ?? ''))
  .filter((o) => o.id !== ctx.sceneStart.playerNetworkId)
  .sort((a, b) => b.firstSeenAt - a.firstSeenAt);
const vehicle = fresh[0];
if (vehicle) ctx.mount(vehicle.id, { speedCap: 12 });
```

### Mounting

```typescript
ctx.mount(vehicleId, { speedCap: 12 });
```

Wraps `useAbility('mount', vehicleId)`. Sets your `States::RidingMount` flag. The `speedCap` is the only speed knob — Chapter 3 explains why on-foot speed is engine-locked.

Default caps by vehicle class (real values):
- Speeder bike: 12 m/s
- Swoop: 15-17.5 m/s
- Landspeeder: 10-12 m/s
- BARC speeder: 13-15 m/s
- Jetpack: 5-15 m/s
- Beast mount (bantha, ronto): 4-8 m/s

```typescript
ctx.mountedSpeedCap();  // 12, 15, etc., or null when on foot
```

The walk primitives (`walkTo`, `walkCircle`, `walkToCell`) automatically clamp to this cap.

### Dismounting

```typescript
ctx.dismount();
// Wire: useAbility('dismount'). Clears mountedSpeedCap() back to null.
```

**Things that auto-dismount you:**
- Combat hits (most often)
- Cell entries
- Certain crowd-control abilities
- Server-side knock-down effects

Always check `mountedSpeedCap() !== null` before assuming you're riding.

### Storing a vehicle

```typescript
ctx.storeVehicle(vehicleId);
// Wire: ObjectMenuSelectMessage(vehicleId, RadialMenuTypes.PET_STORE=60)
```

The creature despawns; the PCD stays in datapad. **Always dismount first** — if you store while mounted, the creature vanishes but your mount state lingers, freezing you in place.

### Pets

Same PCD pattern. Pet templates: `object/intangible/pet/shared_pet_control_device.iff`. Real pets: kaadu, ronto, gualama, bantha, dewback, falumpaset, narglatch, brackaset.

```typescript
const pet = ctx.datapad.pets()[0];
if (pet) {
  ctx.callPet(pet.networkId);
  await ctx.wait(1500);
  const creature = ctx.world.byType(ObjectTypeTags.CREO).find((o) => {
    const shared = o.baselines.get(6) as { masterId?: bigint } | undefined;
    return shared?.masterId === ctx.sceneStart.playerNetworkId;
  });
  if (creature) ctx.petCommand(creature.id, 'follow');
}
```

Pet commands (via radial enum):
- `'follow'` (PET_FOLLOW=225)
- `'stay'` (PET_STAY=226)
- `'guard'` (PET_GUARD=227)
- `'friend'` (PET_FRIEND=228)
- `'attack'` (PET_ATTACK=229) — pass target id
- `'patrol'` (PET_PATROL=230)

```typescript
ctx.petCommand(petId, 'attack', enemyId);
ctx.petCommand(petId, 'follow');
ctx.storePet(petId);
```

Some pets are rideable (bantha, ronto): `ctx.mount(creatureId, { speedCap: 8 })`. Use `SERVER_PET_MOUNT=288` / `SERVER_PET_DISMOUNT=289` radials for full creature mounts.

### Common gotchas

- **PCD id vs creature id.** PCD is in datapad (stable). Creature spawns in world (ephemeral). Mount uses the creature id, not the PCD id.
- **Server auto-dismounts** on combat hits + cell entry. Always check `mountedSpeedCap()`.
- **Store without dismount → UI lock.** Creature despawns but your state still says mounted. Always dismount first.
- **Settle window matters.** Give 1.5s between `callVehicle` and `mount` for the creature to appear in baseline.
- **Pets need masterId match.** Filter creatures by their SHARED_NP `masterId === yourId` to find your pet.

### Quick recipes

```typescript
// 1. Call + mount your first vehicle
const pcdId = ctx.datapad.vehicles()[0]?.networkId;
if (pcdId) {
  ctx.callVehicle(pcdId);
  await ctx.wait(1500);
  const v = ctx.world.byType(ObjectTypeTags.CREO)
    .filter((o) => o.id !== ctx.sceneStart.playerNetworkId)
    .filter((o) => /vehicle|speeder|swoop/i.test(o.templateName ?? ''))
    .sort((a, b) => b.firstSeenAt - a.firstSeenAt)[0];
  if (v) ctx.mount(v.id, { speedCap: 12 });
}

// 2. Ride to a coord (walkTo respects mountedSpeedCap)
await ctx.walkTo({ x: 100, z: -4700 });

// 3. Tell your pet to follow
ctx.petCommand(petId, 'follow');

// 4. Always dismount before storing
ctx.dismount();
await ctx.wait(500);
ctx.storeVehicle(vehicleId);
```

### See also

- [Chapter 3](#chapter-3-where-you-are-position-scene-cells-navigation) — `walkTo` honors `mountedSpeedCap()`
- [Chapter 7](#chapter-7-the-datapad-vehicles-pets-schematics-waypoints-missions) — datapad as the home for PCDs
- `src/scenarios/index.ts` — bundled `rideVehicle` factory
- `scripts/examples/group-hunt-expedition.ts:119` — full `tryMountVehicle` helper

---

## Chapter 5: Travel: planet-hopping with shuttles

You're on Tatooine and Naboo's calling. Travel in SWG is a five-step ritual: find a ticket vendor terminal, buy a ticket, walk to the collector droid, board the shuttle, re-zone to the destination. `ctx.travel` collapses all of that into four helpers.

### The five-step ritual

1. **Find a ticket vendor terminal.** Template `object/tangible/terminal/shared_terminal_travel.iff`. Always at starports.
2. **ITEM_USE the vendor.** Server replies with `EnterTicketPurchaseModeMessage(planet, point, instantTravel)` to scope the UI to the terminal's starport.
3. **Per planet of interest**, send `PlanetTravelPointListRequest(playerId, planet)`. Server replies with parallel arrays: name, position, cost, isInterplanetary.
4. **Pick a destination → `purchaseTicket` command-queue.** Server debits credits, adds a `travel_ticket` to inventory.
5. **Walk to the collector** (`object/tangible/travel/ticket_collector/shared_ticket_collector.iff`, or shuttle creature). Use the ticket via `boardShuttle`. Server fires fresh `CmdStartScene` for the destination.

### `ctx.travel` API

```typescript
ctx.travel.findTicketVendor({ maxRadiusM?: number }): WorldObject | undefined
ctx.travel.findTicketCollector({ maxRadiusM?: number }): WorldObject | undefined
ctx.travel.currentTickets(): TravelTicket[]
ctx.travel.listDestinations({ vendorId?, timeoutMs? }): Promise<string[]>  // "<planet>/<point>"
ctx.travel.buyTicket({ vendorId?, destination, destinationPlanet?, timeoutMs? }): Promise<NetworkId>
ctx.travel.useTicket({ ticketId?, collectorId?, timeoutMs? }): Promise<{ destinationPlanet, destinationPosition }>
```

`findTicketVendor` and `findTicketCollector` match by templateName regex OR by a known set of template CRCs (the server often spawns these via `SceneCreateObjectByCrc` without templateName, so both lookups matter).

`findTicketCollector` falls back from the droid to a lambda/player/kashyyyk shuttle creature — at some starports the shuttle IS the boarding point.

**Captured live for `TsLive01` at Mos Eisley spawn:**
```
travel.findTicketVendor({ maxRadiusM: 250 })    → null
travel.findTicketCollector({ maxRadiusM: 250 }) → null
travel.currentTickets()                         → []
```

The starport terminals are out of baseline range at the default spawn (3528, -4804). You'd need to walk north toward the actual starport building (~30m+ away from spawn) to bring the vendor into scene. This is the typical scripted setup: walk to a known starport anchor, then call `findTicketVendor`.

### `buyTicket` end-to-end

```typescript
const ticketId = await ctx.travel.buyTicket({ destination: 'bestine' });
console.log(`Ticket: 0x${ticketId.toString(16)}`);
```

What `buyTicket` does internally:
1. Find or use the supplied vendor.
2. `ObjectMenuSelectMessage(vendorId, ITEM_USE=21)` to open it.
3. Wait for `EnterTicketPurchaseModeMessage`.
4. Loop over 12 known SWG planets, sending `PlanetTravelPointListRequest` each, collecting responses.
5. Match `destination` (case-insensitive substring against each `<planet>/<point>` pair).
6. `useAbility('purchaseTicket', 0n, "<dep_planet> <dep_point> <arr_planet> <arr_point> <roundtrip> <instant>")` — spaces in travel-point names encoded as `_` for the server's `underscoreToSpace` parser.
7. Poll `currentTickets()` every 250ms until the new ticket appears.

Throws on: no vendor, no destinations, destination not found, or timeout waiting for ticket.

### `useTicket` and the re-zone

```typescript
const result = await ctx.travel.useTicket({ ticketId, collectorId });
console.log(`Arrived at ${result.destinationPlanet} at (${result.destinationPosition.x}, ${result.destinationPosition.z})`);
```

Sends `useAbility('boardShuttle', collectorId, ticketId)`, blocks on the destination's `CmdStartScene`. Returns the planet + position.

**`useTicket` does NOT complete the re-zone handshake.** It returns on `CmdStartScene` only. If you intend to do anything at the destination, you must complete the rest yourself:

```typescript
await ctx.travel.useTicket({ ticketId });

// Complete the re-zone:
await ctx.waitForMessage(SceneEndBaselines, { timeoutMs: 30_000 });
ctx.send(new CmdSceneReady());
await ctx.wait(500);
await ctx.ackPendingTeleports();
// NOW safe to move, use items, interact
```

The minimal `shuttle-traveler.ts` example logs out immediately on arrival so it doesn't need this. The full `cross-planet-pilgrim.ts` example shows the proper re-zone (in `waitForRezone()` at line 129).

### Real destination examples

| From | To | Type | Cost |
|---|---|---|---|
| Mos Eisley | Bestine | intraplanetary | ~100c |
| Mos Eisley | Mos Espa | intraplanetary | ~100c |
| Theed | Keren | intraplanetary | ~100c |
| Tatooine starport | Naboo starport | interplanetary | ~1500c |
| Corellia → any other planet | interplanetary | ~1500-2500c |

The 12 standard SWG planets the helper enumerates: `tatooine`, `naboo`, `corellia`, `talus`, `rori`, `dantooine`, `dathomir`, `endor`, `lok`, `yavin4`, `kashyyyk`, `mustafar`.

### Test-cluster setup (admin warp + admin deposit)

Fresh characters spawn ~6km from starports with 0 credits. For repeatable test runs:

```typescript
// Warp to Mos Eisley starport anchor
const playerOid = ctx.sceneStart.playerNetworkId.toString();
ctx.send(new ConGenericMessage(`object move ${playerOid} 3528 0 -4806`));
await ctx.wait(2_000);
await ctx.ackPendingTeleports();

// Top up to 20k credits (requires god-mode + admin allowlist)
ctx.useAbility('setGodMode', 0n, '1');
await ctx.wait(500);
ctx.send(new ConGenericMessage(`money namedTransfer ${playerOid} customerService -20000`));
await ctx.wait(500);
```

The negative amount flips the transfer direction (server pulls FROM `customerService` INTO you). `customerService` is the canonical god-mode-only money source.

### Common gotchas

- **CmdStartScene doesn't complete the re-zone.** `useTicket` returns early; complete the handshake (`SceneEndBaselines` + `CmdSceneReady` + `ackPendingTeleports`) before moving.
- **Admin warp needs god-mode first.** `object move` is gated on `Client::isGod()` which requires `setGodMode 1`.
- **Travel-point names normalize spaces ↔ underscores.** The helper handles both directions — pass `"mos eisley"` or `"Mos Eisley"` or `"mos_eisley"`, all work.
- **Vendor not in initial baseline.** A fresh character spawns far from the starport. Either widen the search radius or walk closer first.
- **`findTicketCollector` falls back to shuttle creatures.** If no discrete droid, the helper returns the lambda/player shuttle — `boardShuttle` works on either.

### Quick recipes

```typescript
// Buy a ticket to Bestine
const ticketId = await ctx.travel.buyTicket({ destination: 'bestine' });

// Travel + accept a mission at destination
const ticketId = await ctx.travel.buyTicket({ destination: 'theed', destinationPlanet: 'naboo' });
const collector = ctx.travel.findTicketCollector();
if (collector) {
  await ctx.walkTo(collector.position);
  await ctx.travel.useTicket({ ticketId });
  await ctx.waitForMessage(SceneEndBaselines, { timeoutMs: 30_000 });
  ctx.send(new CmdSceneReady());
  await ctx.ackPendingTeleports();
  await ctx.wait(2000);
  // ... now find a mission terminal and accept
}

// List all destinations
const dests = await ctx.travel.listDestinations();
console.log(dests);  // ["tatooine/Mos Eisley", "naboo/Theed Starport", ...]

// Check ticket inventory
const tickets = ctx.travel.currentTickets();
```

### See also

- [Chapter 3](#chapter-3-where-you-are-position-scene-cells-navigation) — walking to vendor/collector
- [Chapter 4](#chapter-4-mounts-vehicles-and-pets) — dismount before boarding
- `src/client/script/travel.ts` — full API impl (~640 lines)
- `scripts/examples/shuttle-traveler.ts` — minimal demo
- `scripts/examples/cross-planet-pilgrim.ts` — full re-zone + mission round-trip

---

## Chapter 6: Inventory, equipment, and the bank

Your inventory is the gate to everything in SWG. Every weapon, every survey tool, every loot crate, every credit. If you don't understand what you're carrying and how the slots work, none of the rest of the API will save you.

### The always-on inventory view

`ctx.inventory` is a live snapshot — reactive, auto-updating as items arrive/leave/move. Real shape:

**Captured live for `TsLive01`:**
```
ctx.inventory.containerId   → 0x22c790f6n
ctx.inventory.totalSlots    → 80
ctx.inventory.usedSlots     → 17
ctx.inventory.freeSlots     → 63
ctx.inventory.items.length  → 17

items (all CRC-only — server sent them as SceneCreateObjectByCrc):
  - item_publish_gift_update_14_comlink   × 1
  - survey_tool_mineral                   × 9   ← starter kit with multiple survey tools
  - naboo_city_deed                       × 6   ← starter kit with multiple city deeds (!)
  - item_pgc_starter_kit                  × 1
```

The 9 mineral survey tools + 6 Naboo city deeds are the **default starter-kit gift** that the test cluster's `tslive01` account has been seeded with. A real fresh character would have 1-2 starter items at most.

### Item shape

```typescript
interface InventoryItem {
  networkId: NetworkId;          // bigint
  templateName: string | null;   // null when server sent only the templateCrc
  templateCrc: number | null;
  name: string | null;           // resolved short name (e.g. "survey_tool_mineral")
  arrangementId: number | null;  // slot index in container, or -1 if unslotted
  containerId: NetworkId;
}
```

Real templates you'll see:
- Weapons: `object/weapon/ranged/pistol/shared_pistol_dl44.iff` (DL-44), `object/weapon/melee/sword/shared_sword_curved_01.iff`
- Tools: `object/tangible/survey_tool/shared_survey_tool_mineral.iff`, `object/tangible/crafting_tool/shared_weapon_crafting_tool.iff`
- Wearables: `object/tangible/wearables/armor/composite/shared_armor_composite_chest_plate.iff`
- Food: `object/tangible/food/shared_food_bantha_steak.iff`, `object/tangible/food/shared_food_jawa_beer.iff`
- Resource crates: `object/tangible/resource/shared_resource_container.iff` (RCNO)
- Tickets: `object/tangible/travel/shared_travel_ticket.iff`
- Deeds: `object/tangible/deed/...`

### Equipped vs inventory items

`ctx.inventory.items` shows items DIRECTLY in your inventory container. Equipped items live elsewhere — they're children of the player object (not the inventory). Equipped items have `arrangementId` set to a slot name like:

- `hold_r` / `hold_l` — right/left hand
- `chest2` — chest armor
- `pants1` — pants
- `hat` — hat/helmet
- `eyes` — goggles/visor
- `gloves`, `bicep_r`, `bicep_l`, `bracer_upper_r`, etc.

To enumerate equipped items, scan the player's direct children:

```typescript
const playerId = ctx.sceneStart.playerNetworkId;
const equipped = ctx.world.filter((o) => o.containerId === playerId && o.slotArrangement !== undefined);
```

### Find items

```typescript
// By regex over templateName
const tools = ctx.inventory.findByTemplate(/survey_tool/i);

// By NetworkId
const item = ctx.inventory.findById(0x123n);

// Resource crates (RCNO) specifically
const crates = ctx.inventory.resources();
// each: { containerId, resourceType, quantity }
```

### Sub-containers (bags, backpacks)

Your main inventory auto-opens at zone-in. Sub-containers (a backpack inside inventory) do NOT — you must explicitly open them:

```typescript
ctx.openContainer(backpackId);
await ctx.wait(100);
const contents = ctx.findInContainer(backpackId);
```

`closeContainer(id)` exists for documentation but emits no wire bytes — SWG has no explicit close message; the server just notices when you open something else or move away.

### Bank

Like inventory but separate, and DOES NOT auto-open at zone-in. You must use a bank terminal:

```typescript
await ctx.bank.use(terminalId?);  // optional: omit to auto-find nearest
while (!ctx.bank.ready) await ctx.wait(50);

ctx.bank.items;            // same shape as inventory items
ctx.bank.findByTemplate(/credit/i);
ctx.bank.findById(itemId);
ctx.bank.containerId;
```

Bank terminal template: `object/tangible/terminal/shared_terminal_bank.iff`.

### Credits

Credits are NOT inventory items — they're on your character:

```typescript
ctx.character.bankBalance  // 0 (TsLive01 is broke)
ctx.character.cashBalance  // 0
```

Total liquid = `bankBalance + cashBalance`.

To deposit/withdraw via a bank terminal:
```typescript
ctx.useAbility('deposit', terminalId, '<amount>');
ctx.useAbility('withdraw', terminalId, '<amount>');
```

### Common gotchas

- **Fresh NPE characters don't have survey/crafting tools.** They arrive via the NPE roadmap reward table. Use admin-spawn-able tools or pre-NPE characters.
- **Bank doesn't auto-open at zone-in.** Call `ctx.bank.use(terminalId)` first.
- **Credits live on the character, not inventory.** `ctx.character.bankBalance + cashBalance`, never `ctx.inventory.find...`
- **Sub-containers require explicit `openContainer`.** Inventory's children populate; deeper nests don't.
- **`slotArrangement` is opaque for inventory slots.** For equipped items the strings are meaningful (`hold_r`, `chest2`); for unequipped items it's just an integer index.
- **Most item template names arrive as CRC-only.** The captured TsLive01 inventory has every item with `templateName: null` (CRC sent without resolution table). The `name` field (short form, e.g., "survey_tool_mineral") is usually populated.

### Quick recipes

```typescript
// Find your survey tool
const tools = ctx.inventory.findByTemplate(/survey_tool/i);

// List bank contents (after opening)
await ctx.bank.use(terminalId);
while (!ctx.bank.ready) await ctx.wait(50);
ctx.bank.items.forEach(i => console.log(i.name));

// Find a freshly-spawned ticket
const tickets = ctx.inventory.findByTemplate(/travel_ticket/i);

// Snapshot before combat, diff after for loot
const before = new Set(ctx.inventory.items.map(i => i.networkId));
// ... combat ...
const loot = ctx.inventory.items.filter(i => !before.has(i.networkId));

// Read total credits
const total = ctx.character.bankBalance + ctx.character.cashBalance;

// Open a backpack and list contents
ctx.openContainer(bagId);
await ctx.wait(100);
const inBag = ctx.findInContainer(bagId);

// Count resources
ctx.inventory.resources().forEach(r => console.log(`${r.quantity} units of ${r.resourceType}`));

// Wait for inventory at zone-in
while (!ctx.inventory.ready) await ctx.wait(50);
```

### See also

- [Chapter 7](#chapter-7-the-datapad-vehicles-pets-schematics-waypoints-missions) — the datapad, a separate special container
- [Chapter 10](#chapter-10-resources-survey-and-crafting) — RCNO crates feed into crafting
- [Chapter 11](#chapter-11-combat-abilities-and-the-command-queue) — `useAbility('equip', itemId)` to wear an item
- [Chapter 13](#chapter-13-doing-business-trade-missions-npcs-sui-and-the-bazaar) — listing inventory items for sale

---

## Chapter 7: The datapad: vehicles, pets, schematics, waypoints, missions

Your datapad is the personal inventory of your _collection_ — not items you carry in your hands, but things you _own_: vehicles parked in the bank, pets you've tamed, recipes you've learned, places you've discovered. Unlike your regular inventory (Chapter 6), the datapad auto-opens the moment you zone in. Its contents are mostly **intangible** objects.

### What the datapad IS

The datapad is a TANO-typed container (template usually `object/tangible/container/general/shared_default_datapad.iff`), parented to the player CREO at zone-in. Most of its children are intangible (INSO type): vehicle PCDs, pet PCDs, ship PCDs, waypoints, manufacturing schematics, mission objects.

Compare:
- **Inventory** holds tangible (TANO) physical items: weapons, armor, food, tools.
- **Datapad** holds intangible (INSO + special types) ownership records: PCDs, schematics, waypoints, mission tickets.

**Captured live for `TsLive01`:**
```
ctx.datapad.containerId  → 0x22c790f8n
ctx.datapad.itemCount    → 2
ctx.datapad.vehicles()   → [{ networkId: 0x2205937cn, state: 'stored', ... }]
ctx.datapad.pets()       → []
ctx.datapad.waypoints()  → []
ctx.datapad.missions()   → []
```

Even a fresh test character has 2 items in the datapad — typically 1 vehicle PCD (starter speeder) + 1 ship item or starter pack. The "2" includes datapad children of all types, not just vehicles.

### The `ctx.datapad` view

```typescript
interface DatapadView {
  containerId: NetworkId | null;
  items: ReadonlyArray<DatapadItem>;
  ready: boolean;
  vehicles(): DatapadItem[];
  pets(): DatapadItem[];
  waypoints(): DatapadItem[];
  missions(): DatapadItem[];
  findByTemplate(re: RegExp): DatapadItem[];
  findById(id: NetworkId): DatapadItem | undefined;
}

interface DatapadItem {
  networkId: NetworkId;
  templateName: string | null;
  templateCrc: number | null;
  name: string | null;
  kind: 'vehicle-pcd' | 'pet-pcd' | 'waypoint' | 'mission' | 'ship' | 'manufacturing-schematic' | 'other';
  containerId: NetworkId;
  linkedCreatureId: NetworkId | null;   // for PCDs: spawned creature id, or null
  condition: number | null;             // 0..1 HP ratio, or null
  state: 'stored' | 'called' | 'following' | 'staying' | 'attacking' | null;
}
```

The `kind` field is auto-derived from template/CRC.

### Vehicles in the datapad

Each vehicle PCD entry:
```typescript
{
  networkId: 0x2205937cn,
  templateName: 'object/intangible/vehicle/shared_vehicle_speeder_swoop_pcd.iff',
  kind: 'vehicle-pcd',
  name: 'The Shatterer',
  linkedCreatureId: null,    // null when stored; the spawned creature id when called
  state: 'stored',
  condition: null,
}
```

Real PCD templates:
- `shared_vehicle_speeder_swoop_pcd.iff` — Swoop bike
- `shared_landspeeder_av21_pcd.iff` — Landspeeder AV-21
- `shared_speederbike_pcd.iff` — basic speeder bike
- `shared_barc_speeder_pcd.iff` — BARC

Calling/mounting/storing: see Chapter 4.

### Pets in the datapad

Same shape as vehicles. Real templates use the generic `object/intangible/pet/shared_pet_control_device.iff`. Pet examples: kaadu, rancor, bantha (rideable), gualama, dewback.

### Waypoints in the datapad

Waypoints are persistent personal markers. Each entry's shape via `DatapadItem` is light:

```typescript
{
  networkId: 0x00012345n,
  name: 'Carbosteel mining pit',
  kind: 'waypoint',
  templateName: 'object/waypoint/shared_world_waypoint.iff',
  ...
}
```

For full waypoint details (coordinates, color, active state), read the waypoint object from the world:

```typescript
const waypointId = ctx.datapad.waypoints()[0]?.networkId;
const wp = ctx.world.get(waypointId);
const shared = wp?.baselines.get(3) as {
  name?: string;
  location?: { coordinates: { x: number; y: number; z: number }; cell: bigint; sceneIdCrc: number };
  color?: number;     // 1=Blue, 2=Green, 3=Orange, 4=Yellow, 5=Purple, 6=White, 7=Space
  active?: boolean;
};
```

**Example waypoints in a typical Trader's datapad** (illustrative, NOT captured):
- "Carbosteel mining pit" at (2150, 0, -3800) on Tatooine, color Green, active
- "Home" at (-5235, 0, 1432) on Naboo, color Blue, inactive
- "Mission Waypoint: destroy 5 desert demons" — server-generated, attached to an accepted mission

Create / activate / rename / delete:
```typescript
ctx.useAbility('createWaypoint', 0n, `${x} ${y} ${z} ${planet} ${name}`);
ctx.useAbility('renameWaypoint', waypointId, newName);
ctx.useAbility('activateWaypoint', waypointId);
ctx.useAbility('deactivateWaypoint', waypointId);
ctx.useAbility('removeWaypoint', waypointId);
```

### Manufacturing schematics

Each schematic is a recipe you've LEARNED. Template `object/intangible/data/shared_manf_schematic.iff` or specific variants like `shared_survey_tool_mineral_schematic.iff`.

```typescript
const schematics = ctx.datapad.findByTemplate(/manf_schematic|schematic/i);
console.log(`You know ${schematics.length} recipes.`);
```

Real schematic examples a Master Trader might have:
- "Survey Tool, Mineral (Master)"
- "Combat Pistol, DL-44 (Journeyman)"
- "Composite Armor Plate (Apprentice)"
- "Bantha Steak (Master Chef)"

You don't delete schematics directly — the server manages them via skill respec.

### Mission objects

When you accept a mission, the server creates a `MissionObject` (MISO-typed) and parents it to your datapad. Each carries: type (destroy/recon/deliver/etc.), payout, location, target template, description, waypoint.

```typescript
const missions = ctx.datapad.missions();
// Lower-level than ctx.missions.active (Chapter 13), but same underlying objects.
```

Mission objects auto-disappear when you complete or abort — the server destroys the MISO and removes the waypoint.

### Ship items

Starship PCDs for space content. `object/intangible/ship/shared_ship_pcd.iff`. Mostly out-of-scope for ground gameplay; the datapad will list them via `findByTemplate(/ship/)`.

### Intangible vs tangible

The mental model: **the datapad holds intangible objects**. They don't take inventory slots, can't be dropped in the world, and have special server lifecycle rules. Some implications:

- You can't transfer a PCD to another player via SecureTrade — they're bound.
- You can't sell schematics on the bazaar — they're bound.
- Mission objects appear/disappear server-side based on mission state.

### Common gotchas

- **Datapad auto-opens, bank doesn't.** Different containers, different open semantics.
- **Vehicle PCD ≠ vehicle creature.** PCD lives in datapad; creature lives in world when called.
- **Datapad waypoints ≠ in-world waypoint objects** (Chapter 8 clarifies).
- **Schematics aren't deletable.** Skill system owns them.
- **Mission objects auto-disappear** on completion. Re-query `ctx.missions.active` or `ctx.datapad.missions()` after each mission state change.

### Quick recipes

```typescript
// Find first vehicle
const v = ctx.datapad.vehicles()[0];

// Find a named waypoint
const home = ctx.datapad.waypoints().find(w => w.name === 'Home');

// List learned schematics
const recipes = ctx.datapad.findByTemplate(/manf_schematic/i);

// Count active missions
const missionCount = ctx.datapad.missions().length;

// Create a waypoint at your current position
const here = ctx.position();
ctx.useAbility('createWaypoint', 0n, `${here.x} ${here.y} ${here.z} ${ctx.location.planet} Marker`);
```

### See also

- [Chapter 4](#chapter-4-mounts-vehicles-and-pets) — calling + mounting vehicle PCDs
- [Chapter 8](#chapter-8-waypoints-houses-lots-and-player-structures) — in-world waypoint objects, structure placement
- [Chapter 10](#chapter-10-resources-survey-and-crafting) — using schematics in crafting sessions
- [Chapter 13](#chapter-13-doing-business-trade-missions-npcs-sui-and-the-bazaar) — high-level mission lifecycle

---

## Chapter 8: Waypoints, houses, lots, and player structures

You've learned the basics of zoning in and moving around. Now you'll place and manage the permanent fixtures of the world: waypoints that mark important locations, houses and factories that players own, and the city structures that give a settlement its identity.

### Two kinds of waypoint (don't confuse them)

**Datapad waypoint** — a personal bookmark. `ctx.datapad.waypoints()` from Chapter 7. Intangible, only you see it, shows up as a HUD pin. The server stores it as data on your character.

**In-world waypoint object** — a tangible object with template `object/waypoint/shared_world_waypoint.iff`. `ctx.world.byType(ObjectTypeTags.WAYP)`. Visible to everyone. Placed by server scripts for mission goals, quest locations, NPC shops.

When you create "a waypoint," you mean the datapad kind. When you walk past a glowing waypoint marker, that's the object kind.

### Creating datapad waypoints

```typescript
ctx.useAbility('createWaypoint', 0n, `${x} ${y} ${z} ${planet} ${name}`);
```

Server-side parses the param string with simple splits. Examples:

```typescript
ctx.useAbility('createWaypoint', 0n, '-5235 100 1432 naboo Outpost');
ctx.useAbility('createWaypoint', 0n, '500 0 -2000 tatooine Secret Cave');
```

Rename / activate / deactivate / remove:
```typescript
ctx.useAbility('renameWaypoint', waypointId, newName);
ctx.useAbility('activateWaypoint', waypointId);
ctx.useAbility('deactivateWaypoint', waypointId);
ctx.useAbility('removeWaypoint', waypointId);
```

### Placing structures: the deed → object pattern

A "deed" is a TANO inventory item that, when used (radial menu ITEM_USE), the server:
1. Checks your lot allowance (default 10; some servers buff to 12).
2. Validates placement (no water, slope OK, not too close to other structures, not in another player's lot).
3. On success: consumes deed, spawns the structure.
4. On failure: emits a chat error, returns the deed.

**Real deed templates:**
- Houses: `object/tangible/deed/player_house_deed/shared_player_house_small_naboo_deed.iff`, `_medium_naboo_deed.iff`, `_large_naboo_deed.iff` (also corellia/tatooine/endor variants + generic `_small_deed.iff` etc.)
- Factories: `object/tangible/deed/player_house_deed/shared_player_factory_clothing_deed.iff`, `_food_deed.iff`, `_item_deed.iff`, `_structure_deed.iff`
- Harvesters: `object/tangible/deed/harvester_deed/shared_harvester_ore_heavy_deed.iff`, `_wind_power_deed.iff`, `_solar_power_deed.iff`
- Generators: `object/tangible/deed/generator_deed/shared_generator_fusion_style_1_deed.iff`

**Captured live for `TsLive01`:** the inventory has **6 `naboo_city_deed` items** — these are the special city-formation deeds used by the `scripts/build-city/` orchestrator. They're not house deeds; they're the seed deeds used to declare a new city at the placement coord.

### Lot cost table

| Structure | Lots |
|---|---|
| Small house | 2 |
| Medium house | 3 |
| Large house | 5 |
| Naboo "large style" house | 5 |
| Clothing/Food/Item factory | 4 |
| Structure factory | 3-4 |
| Heavy ore harvester | 1 |
| Wind/Solar power | 1 |
| Fusion generator | 1 |

Read your lot state:
```typescript
const used = ctx.character.lotsUsed ?? 0;
const limit = ctx.character.lotLimit ?? 10;
console.log(`${used}/${limit} lots`);
```

If you try to place over the limit, server rejects with a `ChatSystemMessage` containing `no_room` / `max_lots`.

### Placing a deed

The TS framework provides a placement helper in `scripts/build-city/place.ts`:

```typescript
import { resolveInventoryOid, placeDeed } from '../scripts/build-city/place.js';

const inventoryOid = await resolveInventoryOid(ctx);
const deedTemplate = 'object/tangible/deed/player_house_deed/shared_player_house_small_naboo_deed.iff';

await ctx.walkTo({ x: -5235, z: 1432 });
const result = await placeDeed(ctx, deedTemplate, { settleMs: 5000, suiTimeoutMs: 8000 });

if (result.rejected) console.log('Failed:', result.chatErrors);
else console.log('Structure OID:', result.structureOid);
```

The function spawns the deed (admin), sends radial USE (handles SUI dialogs), watches for `SceneCreateObjectByName` for the new structure, collects rejection chat. Returns rejected/oid/template/errors.

### Probing before committing

`probeBuildable` spawns a temporary deed, places, monitors rejection chat, cleans up:

```typescript
import { probeBuildable } from '../src/terrain/probe.js';

const probe = await probeBuildable(ctx, inventoryOid, x, z, {
  settleMs: 4500,
  teleportToCoord: true,
  keepDeedOnSuccess: false,
});

if (probe.buildable) {
  // safe to place real deed here
} else {
  console.log('Rejected:', probe.chatOob);  // 'water' / 'slope' / 'too_close' / etc.
}
```

### Finding flat spots: `findFlatPatch`

```typescript
import { findFlatPatch } from '../src/terrain/find-flat-patch.js';

const spots = await findFlatPatch(ctx, inventoryOid, {
  centerX: 0, centerZ: 0,
  maxRadius: 500,
  count: 5,           // return first N buildable spots
  minSpacing: 30,
  rings: 6,
  angularSteps: 8,
});
```

Walks concentric rings, probes candidates, returns the first N that pass with `minSpacing` met.

### Cells (interior rooms)

Placed houses are BUIO (Building Objects). Their interiors are SCLT (Cell) children. Find cells via:

```typescript
const cells = ctx.world.filter((o) => o.containerId === buildingId && o.typeIdString === 'SCLT');
```

Or use `buildBuildingCellIndex(transcript)` to walk the whole map:

```typescript
import { buildBuildingCellIndex } from '../src/index.js';
const { buildings, cells } = buildBuildingCellIndex(ctx.transcript);
const building = buildings.get(buildingId);  // { name?, cells: [oid, ...] }
const cell = cells.get(cellId);              // { buildingId, cellNumber, cellName?, isPublic? }
```

**Captured live worldwise:** 308 cells observed within 80m of `TsLive01`'s spawn — that's a LOT of player housing interiors. 33 buildings with 3-16 cells each. Tatooine's Mos Eisley has a dense housing buildout in the area we observed.

### Permissions: ENTRY / ADMIN / BANNED

Each placed structure has three permission lists:
- **ENTRY** — players who can walk in
- **ADMIN** — full control (modify other lists, settings)
- **BANNED** — cannot enter, overrides ENTRY

```typescript
import {
  adminStructurePermissionAdd,
  adminStructurePermissionRemove,
  adminStructurePermissionList,
} from '../scripts/build-city/admin-permissions.js';

await adminStructurePermissionAdd(ctx, houseId, 'entry', 'FriendName');
await adminStructurePermissionAdd(ctx, houseId, 'admin', 'FriendName');
await adminStructurePermissionAdd(ctx, houseId, 'banned', 'RoguePlayer');

const perms = await adminStructurePermissionList(ctx, houseId);
console.log('Entry:', perms.entry);
console.log('Admin:', perms.admin);
console.log('Banned:', perms.banned);
```

Under the hood: `useAbility('permissionListModify', houseId, '<list> <playerName>')`. The cross-server CM_addAllowed/removeAllowed/addBanned/removeBanned ObjController subtypes (403-406) carry the auth sync.

### Cities

A player city = city hall building + civic amenities + citizen houses. Cities have an id, a name, location + radius, citizen roster, treasury.

```typescript
import {
  adminCityInfo,
  adminCityListCitizens,
  adminCityListStructures,
  adminCityGetCityAtLocation,
} from '../scripts/build-city/admin-city.js';

const info = await adminCityInfo(ctx, cityId);
// { cityName, mayorId, centerX, centerZ, radius, rank (1-5), citizenCount, structureCount }

const citizens = await adminCityListCitizens(ctx, cityId);
const structures = await adminCityListStructures(ctx, cityId);
const atSpot = await adminCityGetCityAtLocation(ctx, 'naboo', x, z, 50);
```

Declare residence (after walking inside a residential building you own):

```typescript
import { walkInAndDeclareResidence } from '../scripts/build-city/place.js';
await walkInAndDeclareResidence(ctx, { x: -5235, z: 1432 }, { buildingId: myHouseId });
```

### Common gotchas

- **Datapad waypoint vs world waypoint confusion.** Datapad = personal HUD pin. World = physical placed object visible to all.
- **Check lot allowance before placing.** Server silently rejects over-the-limit attempts.
- **Deed is consumed on use.** No "cancel"; the commit is immediate. Use `probeBuildable` first if unsure.
- **Permission grants are async.** No return confirmation; re-query `adminStructurePermissionList` to verify.
- **Cell baselines race the building baseline.** A BUIO may arrive before its SCLT children. `navigate()` handles this with retries.

### Quick recipes

```typescript
// Place a small house at current spot
const inv = await resolveInventoryOid(ctx);
const result = await placeDeed(ctx, 'object/tangible/deed/player_house_deed/shared_player_house_small_naboo_deed.iff');

// Find every placed harvester I own
const owned = ctx.world.filter((o) =>
  /harvester/i.test(o.templateName ?? '') && o.ownerId === ctx.character.networkId,
);

// Grant a friend ENTRY on my house
await adminStructurePermissionAdd(ctx, myHouseOid, 'entry', 'FriendName');

// Probe a coord
const probe = await probeBuildable(ctx, inv, x, z);

// List cells inside a building
const { buildings } = buildBuildingCellIndex(ctx.transcript);
const cells = buildings.get(houseOid)?.cells ?? [];

// Get lot usage
const used = ctx.character.lotsUsed ?? 0;
const limit = ctx.character.lotLimit ?? 10;

// Find city at a location
const cityId = await adminCityGetCityAtLocation(ctx, 'naboo', x, z);
```

### See also

- [Chapter 7](#chapter-7-the-datapad-vehicles-pets-schematics-waypoints-missions) — datapad waypoints
- [Chapter 9](#chapter-9-the-worldmodel-npcs-creatures-buildings-finding-things) — world queries for cells/buildings
- [Chapter 10](#chapter-10-resources-survey-and-crafting) — surveying for harvester sites
- `scripts/build-city/` — full city-build orchestration
- `src/terrain/` — `probeBuildable`, `findFlatPatch`, `loadPlanetTrn`

---

## Chapter 9: The WorldModel: NPCs, creatures, buildings, finding things

You're standing in Mos Eisley, alive on the network. The server has told you about everything nearby — NPCs at the cantina, the starport landing platform, traders, creatures beyond the town limits, buildings you can walk into. All of this lives in `ctx.world`, a live in-memory mirror of the server's map of your zone.

### What `ctx.world` is

A `WorldModel` — a reactive cache that tracks every NetworkId the server has told us about. It starts empty, populates explosively at zone-in (hundreds of CreateObject events), then stays updated continuously.

**Captured live for `TsLive01`** after walking 50m toward the starport:

```
ctx.world counts:
  total: 638 objects
  CREO: 37    (creatures + the player + NPCs)
  PLAY: 1     (one other actual player in scene)
  TANO: 44    (terminals, tangibles, deeds, items)
  BUIO: 33    (buildings — including dense player housing in this area)
  SCLT: 308   (interior cells inside buildings)
  INSO: 0     (intangibles — most live in containers, not world)
```

That's a typical Mos Eisley snapshot: a few dozen creatures around the spawn, many buildings (player housing density), hundreds of interior cells. No INSO at the world level because PCDs are container children (datapad), not world objects.

### `WorldObject` shape

```typescript
interface WorldObject {
  id: NetworkId;
  typeId: number;
  typeIdString: 'CREO' | 'PLAY' | 'TANO' | 'BUIO' | 'SCLT' | 'INSO' | 'MISO' | 'WAYP' | 'RCNO' | ...;
  templateName: string | undefined;     // path like 'object/mobile/shared_rancor.iff'; often undefined for CRC-only creates
  templateCrc: number;                  // always set
  position: Vector3;                    // world coords
  yaw: number;
  parentCell: NetworkId;                // 0n outdoors, else cell NetworkId
  cellPosition: Vector3;
  containerId: NetworkId;
  slotArrangement: string | undefined;  // slot id when equipped
  hyperspace: boolean;
  baselines: Map<number, unknown>;      // package id → decoded fields
  firstSeenAt: number;
  lastUpdatedAt: number;
}
```

### ObjectTypeTags

```typescript
import { ObjectTypeTags } from '@swg/ts-client';

ObjectTypeTags.CREO  // creature (NPC/monster/player CREO)
ObjectTypeTags.PLAY  // player flag on top of CREO
ObjectTypeTags.TANO  // tangible (items, terminals)
ObjectTypeTags.BUIO  // building
ObjectTypeTags.SCLT  // cell (interior)
ObjectTypeTags.INSO  // intangible (PCDs)
ObjectTypeTags.MISO  // mission object
ObjectTypeTags.WAYP  // waypoint (in-world)
ObjectTypeTags.RCNO  // resource container
```

### Query methods

```typescript
ctx.world.get(id)               // WorldObject | undefined
ctx.world.has(id)               // boolean
ctx.world.byType(typeTag)       // WorldObject[]
ctx.world.filter(pred)          // WorldObject[]
ctx.world.nearby(radiusM)       // WorldObject[] sorted by distance
```

Sugar on `ctx`:
```typescript
ctx.findNearest(typeId, opts?)               // nearest matching type
ctx.nearestHostile({ maxRadiusM? })          // nearest CREO with inCombat=true
ctx.findInContainer(containerId)             // every object whose containerId === id
ctx.playersInRange(radiusM)                  // PLAY-typed within radius
```

From `_lib.ts` (used heavily by the bundled examples):
```typescript
findNearestByTemplate(ctx, /regex/, { typeTag?, maxRadiusM? })
pollForNearestByTemplate(ctx, /regex/, { scanMs, typeTag?, maxRadiusM? })
```

### Subscribing to world events

```typescript
const unsub = ctx.world.on('create' | 'baseline' | 'delta' | 'transform' | 'containment' | 'destroy',
  (event) => { /* handle */ });
// later
unsub();
```

Wait for a specific creature to spawn:
```typescript
const targetCrc = constcrc('object/creature/npc/theme_park/shared_jabba_the_hutt.iff');
await new Promise((resolve, reject) => {
  const unsub = ctx.world.on('create', (e) => {
    if (e.object?.templateCrc === targetCrc) {
      unsub();
      resolve(e.object.id);
    }
  });
  setTimeout(() => { unsub(); reject(new Error('timeout')); }, 30_000);
});
```

### Baseline packages

Most queryable state lives in SHARED_NP (`baselines.get(6)`). For creatures: `inCombat`, `name`, HAM, posture, mood. For tangibles: condition, charges.

```typescript
const creature = ctx.world.get(creatureId);
const np = creature?.baselines.get(6) as { name?: string; inCombat?: boolean } | undefined;
if (np?.inCombat) console.log(`${np.name} is fighting`);
```

### Real-world query examples

**Captured live nearby creatures (first 10):**

```
- CREO 0x2201c477  template=CRC-only  name=null
- CREO 0x2201d249  template=CRC-only  name=null
- CREO 0x220568b7  template=CRC-only  name=null
- CREO 0x22018cc5  template=CRC-only  name=null
- CREO 0x2201d290  template=CRC-only  name=null
- (and ~30 more)
```

All these CREOs arrived via `SceneCreateObjectByCrc` without templateName resolution. The server doesn't always send the full template path for nearby NPCs in the baseline flood — you only see the CRC. To resolve names, you'd need to call `ctx.fetchResourceAttributes([id])` or wait for a SHARED_NP baseline that includes the name field.

**Captured live nearby buildings (7 within 80m):**

```
- BUIO 0x9354c6   pos=(3529, 5, -4753)   cells=3   template=CRC-only
- BUIO 0x138881   pos=(3500, 5, -4743)   cells=12  template=CRC-only
- BUIO 0x10e1c0   pos=(3619, 5, -4801)   cells=16  template=CRC-only
- BUIO 0x1085fa   pos=(3432, 5, -4818)   cells=15  template=CRC-only
- BUIO 0x1387d4   pos=(3440, 5, -4715)   cells=9   template=CRC-only
- BUIO 0x1226fe   pos=(3466, 5, -4675)   cells=9   template=CRC-only
- BUIO 0x138dfd   pos=(3385, 5, -4837)   cells=12  template=CRC-only
```

Each building has 3-16 cells. These are player-placed houses around the Mos Eisley starport area.

**Captured live nearby other players:**

```
PLAY 0x22c7910d  name=null  pos=(0,0,0)
```

One other player in scene — `(0,0,0)` is the placeholder (the other player's transform may not have streamed yet).

### Query examples

```typescript
// Find every other player within 50m
const nearbyPlayers = ctx.playersInRange(50);

// Find the nearest mission terminal within 120m
const terminal = findNearestByTemplate(ctx, /terminal_mission|mission_terminal/i, {
  typeTag: ObjectTypeTags.TANO,
  maxRadiusM: 120,
});

// Find a tough boss
const TOUGH = /rancor|krayt|nightsister|gronda|reek/i;
const candidates = ctx.world.byType(ObjectTypeTags.CREO)
  .filter(o => o.id !== ctx.sceneStart.playerNetworkId)
  .map(o => ({
    obj: o,
    d2: dist2(o.position, ctx.position()),
    weight: TOUGH.test(o.templateName ?? '') ? 100 : 1,
  }))
  .sort((a, b) => b.weight - a.weight || a.d2 - b.d2);

// Count loot crates in 20m
const crates = ctx.world.nearby(20).filter(o => /loot/.test(o.templateName ?? ''));

// Read creature HAM from SHARED_NP
const np = ctx.world.get(creatureId)?.baselines.get(6) as {
  totalAttributes?: number[];
  totalMaxAttributes?: number[];
} | undefined;
const health = np?.totalAttributes?.[0] ?? null;
const maxHealth = np?.totalMaxAttributes?.[0] ?? null;
```

### Common gotchas

- **templateName is undefined for CRC-only creates.** Use `templateCrc` if you know the value, or filter by `typeIdString`.
- **Querying too early returns empty.** Wait ~2s after zone-in for the baseline flood.
- **`baselines.get(6)` may be undefined.** That package hasn't arrived yet for this object.
- **Subscriptions leak.** Always unsubscribe in a `finally`.
- **Cell-parented objects appear in world queries** with their world position, not cell coords. Filter `parentCell === 0n` for outdoor-only.

### Quick recipes

```typescript
// Nearest mission terminal
const term = findNearestByTemplate(ctx, /terminal_mission/i, { typeTag: ObjectTypeTags.TANO, maxRadiusM: 120 });

// Wait for a specific creature to spawn
const id = await pollForNearestByTemplate(ctx, /jabba/i, { scanMs: 30_000, typeTag: ObjectTypeTags.CREO });

// Count melee-range enemies
const enemies = ctx.world.nearby(5).filter(o => (o.baselines.get(6) as any)?.inCombat);

// Read player's own state
const me = ctx.world.get(ctx.sceneStart.playerNetworkId);

// Players in a specific building
const playersInside = ctx.world.byType(ObjectTypeTags.PLAY).filter(p => p.parentCell !== 0n);
```

### See also

- [Chapter 2](#chapter-2-the-character-sheet) — your own CREO state
- [Chapter 4](#chapter-4-mounts-vehicles-and-pets) — vehicle creatures in the world
- [Chapter 11](#chapter-11-combat-abilities-and-the-command-queue) — `nearestHostile`, `inCombat` flags
- `src/client/world-model.ts` — full implementation
- `src/messages/game/baselines/registry.ts` — ObjectTypeTags + BaselinePackageIds

---

## Chapter 10: Resources, survey, and crafting

The SWG economy runs on resources: minerals, gases, flora, water that harvesters extract, and crafters transform into weapons, armor, tools, food. This chapter teaches the full pipeline: survey → sample → fetch attributes → craft.

### Resource ecosystem

Every resource has a **class** (mineral, gas, flora_resources, water, etc.) — fixed. Within each class the server spawns **types** — runtime-generated names like `Resotine` (an iron variant), `Yponaco` (steel), `Carboseuweroris` (carbosteel). Each spawned type lasts hours before being replaced.

Each resource carries **attributes**: OQ (overall quality), CR (cold resist), HR (heat resist), SR (shock resist), DR (decay resist), ER (entangle resist), CD (conductivity), MA (malleability), PE (potential energy), FL (flavor), UT (unit toughness).

Harvesting = **sampling**: stand on a peak concentration spot, run a sample loop, extract units into an **RCNO** (Resource Container) in your inventory.

### Survey tools

Each tool is bound to one or more resource classes:

| Template | Classes |
|---|---|
| `object/tangible/survey_tool/shared_survey_tool_mineral.iff` | mineral |
| `object/tangible/survey_tool/shared_survey_tool_inorganic.iff` | inorganic_chemical |
| `object/tangible/survey_tool/shared_survey_tool_organic.iff` | organic_chemical |
| `object/tangible/survey_tool/shared_survey_tool_lumber.iff` | flora_resources |
| `object/tangible/survey_tool/shared_survey_tool_gas.iff` | gas |
| `object/tangible/survey_tool/shared_survey_tool_liquid.iff` | water |
| `object/tangible/survey_tool/shared_survey_tool_all.iff` | * (universal) |

**Captured live for `TsLive01`:** inventory has **9 mineral survey tools** (`survey_tool_mineral`). Plenty for harvesting iron, steel, copper, aluminum, carbosteel — anything in the mineral class.

### Survey: discover what's spawned

Step 1: get the list of spawned types for this tool's class.

```typescript
const toolId = ctx.inventory.findByTemplate(/survey_tool_mineral/i)[0]?.networkId;
const types = await ctx.fetchSurveyResources(toolId, { timeoutMs: 8_000 });
// Each item: { resourceName: 'Resotine', resourceId: 0x...n, resourceClass: 'mineral' }
```

Wire flow: client sends `ObjectMenuSelectMessage(toolId, ITEM_USE=21)`, server replies with `ResourceListForSurveyMessage` carrying every spawned type for this tool's class.

Step 2: survey each type. The server returns a 3x3 grid of sample points (9 efficiencies).

```typescript
for (const t of types) {
  ctx.survey(toolId, t.resourceName);  // MUST be the spawned name, NOT the class
  const { points } = await ctx.waitForSurvey({ timeoutMs: 8_000 });
  for (const p of points) {
    console.log(`(${p.location.x.toFixed(0)}, ${p.location.z.toFixed(0)}): ${(p.efficiency * 100).toFixed(1)}%`);
  }
}
```

**Critical gotcha**: pass the spawned runtime name (`"Resotine"`), NOT the class (`"mineral"`). The server does an exact-name lookup. If you pass a class name, the server silently ignores it — no SurveyMessage ever broadcast.

### Sample: harvest units

Walk to the highest-efficiency point, then run the sample loop.

```typescript
const peak = points.reduce((a, b) => a.efficiency > b.efficiency ? a : b);
await ctx.walkTo({ x: peak.location.x, z: peak.location.z });
await ctx.wait(1_500);

let located = 0;
while (located < 6) {
  ctx.sample(toolId, name);  // useAbility('requestcoresample', toolId, name)
  const { kind } = await ctx.waitForSampleEvent({ timeoutMs: 35_000 });
  if (kind === 'located') { located++; console.log(`unit ${located}`); }
  if (kind === 'mind' || kind === 'density' || kind === 'cancel') break;
}
await ctx.cancelSampling();  // walks 2.5m to bust the server's sample loop
await ctx.wait(2_500);       // let inventory settle
```

Event kinds:
- `'located'` — success, units added to RCNO
- `'failed'` — this tick's roll failed; try again
- `'mind'` — your Action attribute drained, server stopped
- `'density'` — concentration dropped below threshold
- `'cancel'` — you moved >1m (or called `cancelSampling`)
- `'in_progress'` — stale loop from a prior session
- `'start' | 'trace' | 'other'` — diagnostic

Server starts a ~30s sample loop; each tick has a ~50% success chance (higher with skill). Units stack into an existing RCNO of that type, or create a new crate.

### Fetch attributes (OQ/CR/DR/...)

```typescript
const attrMap = await ctx.fetchResourceAttributes([resourceId], { timeoutMs: 8_000 });
const pairs = attrMap.get(resourceId);
// each: { key: '@obj_attr_n:quality', value: '824' }
```

Normalize to short-form:

```typescript
const SHORT: Record<string, string> = {
  quality: 'OQ',
  cold_resistance: 'CR',
  heat_resistance: 'HR',
  shock_resistance: 'SR',
  decay_resistance: 'DR',
  entangle_resistance: 'ER',
  conductivity: 'CD',
  malleability: 'MA',
  potential_energy: 'PE',
  flavor: 'FL',
  unit_toughness: 'UT',
};

function attrsToObject(pairs: { key: string; value: string }[]) {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const tail = p.key.replace(/^@obj_attr_n:/, '').replace(/^res_/, '');
    out[SHORT[tail] ?? tail] = p.value;
  }
  return out;
}
```

Most attributes are 1-1000. Higher OQ + the right resistances for your craft = better-quality output.

### Crafting session state machine

```typescript
// 1. Open
const craftingToolId = ctx.inventory.findByTemplate(/weapon_crafting_tool/i)[0]?.networkId;
ctx.beginCrafting(craftingToolId);
const { schematics } = await ctx.waitForDraftSchematics({ timeoutMs: 8_000 });

// 2. Pick
ctx.selectCraftingSchematic(0);  // pick by index
const mfData = await ctx.waitForDraftSlots({ timeoutMs: 8_000 });
// mfData.slots is array of { name, optional, options: [{ ingredientType, amountNeeded }] }

// 3. Fill slots
for (let i = 0; i < mfData.slots.length; i++) {
  const slot = mfData.slots[i];
  const crate = ctx.inventory.resources().find(r => r.quantity >= slot.options[0].amountNeeded);
  if (crate) ctx.assignCraftingSlot(i, crate.containerId);
}

// 4. Optional experiment
ctx.craftExperiment([{ attribute: 'OQ', points: 10 }]);

// 5. Finalize
ctx.finishCrafting(craftingToolId, { realPrototype: true });
await ctx.wait(2_000);
```

Crafting tool templates:
- `object/tangible/crafting_tool/shared_weapon_crafting_tool.iff`
- `object/tangible/crafting_tool/shared_armor_crafting_tool.iff`
- `object/tangible/crafting_tool/shared_food_crafting_tool.iff`
- `object/tangible/crafting_tool/shared_clothing_crafting_tool.iff`
- `object/tangible/crafting_tool/shared_generic_crafting_tool.iff`

### Cache views

```typescript
// Call the survey; cache the results
ctx.survey(toolId, 'Resotine');
const { points } = await ctx.waitForSurvey();

// Query the cache later
ctx.survey.lastResults;                    // { resourceType, points } | null
ctx.survey.bestKnown('Resotine');          // { x, z, concentration } | null — across whole session

// Active crafting session view
const session = ctx.crafting.session;
if (session.active) {
  console.log(`slots: ${session.slots.length}, canFinish: ${session.canFinish}`);
}
```

### Common gotchas

- **Survey CLASS vs RUNTIME NAME.** `ctx.survey(toolId, 'mineral')` does NOTHING. Use `'Resotine'` (from `fetchSurveyResources`).
- **Stale state across disconnects.** Server keeps your `m_craftingStage` and `surveying.takingSamples` alive. If a previous session died mid-flow, the next `beginCrafting`/`requestcoresample` succeeds but the follow-up step silently fails. Use a fresh tool or restart the cluster.
- **NPE characters don't have tools.** Tools arrive via the roadmap. Admin-spawn or use a pre-NPE character. **Captured live: `TsLive01` has 9 mineral survey tools — special admin-seeded inventory.**
- **Component slots aren't supported.** Only resource-class slots work in this client. See `scripts/craft-a-tool.ts:389`.
- **`cancelSampling` walks you 2.5m.** Triggers the server's >1m-cancel check. Plan accordingly.
- **Attribute keys need normalization.** Always use `attrsToObject` to get short-form (OQ/CR/DR/...).

### Quick recipes

```typescript
// Find best mineral at current spot
const types = await ctx.fetchSurveyResources(mineralToolId);
let best = null;
for (const t of types) {
  ctx.survey(mineralToolId, t.resourceName);
  const { points } = await ctx.waitForSurvey();
  const peak = points.reduce((a, b) => a.efficiency > b.efficiency ? a : b);
  if (!best || peak.efficiency > best.efficiency) best = { type: t, peak };
}

// Sample 6 units of a specific resource
let n = 0;
while (n < 6) {
  ctx.sample(toolId, 'Resotine');
  const { kind } = await ctx.waitForSampleEvent({ timeoutMs: 35_000 });
  if (kind === 'located') n++;
  if (['mind', 'density', 'cancel'].includes(kind)) break;
}
await ctx.cancelSampling();

// Read OQ
const m = await ctx.fetchResourceAttributes([resourceId]);
const attrs = attrsToObject(m.get(resourceId) ?? []);
console.log('OQ:', attrs.OQ);

// Open session + pick schematic 0
ctx.beginCrafting(toolId);
await ctx.waitForDraftSchematics();
ctx.selectCraftingSchematic(0);
await ctx.waitForDraftSlots();

// Assign first slot from inventory
const crate = ctx.inventory.resources()[0];
ctx.assignCraftingSlot(0, crate.containerId);

// Finalize
ctx.finishCrafting(toolId, { realPrototype: true });
```

### See also

- [Chapter 6](#chapter-6-inventory-equipment-and-the-bank) — RCNO crates + inventory
- [Chapter 7](#chapter-7-the-datapad-vehicles-pets-schematics-waypoints-missions) — schematics live in datapad
- [Chapter 13](#chapter-13-doing-business-trade-missions-npcs-sui-and-the-bazaar) — bazaar for selling resources
- `scripts/examples/surveyor-bazaar.ts` — full survey + sample + list flow
- `scripts/examples/hunter-crafter.ts` — hunt + loot + craft chain
- `scripts/craft-a-tool.ts` — reference crafting script

---

## Chapter 11: Combat, abilities, and the command queue

In SWG, combat is a **command queue**. When you attack, you don't strike — you *enqueue* a command for the server to validate, execute, and broadcast. Every ability (`attack`, `headshot1`, `mindblast2`, `peace`, `mount`) flows the same way. Every one can silently fail (too far, target dead, missing skill, on cooldown).

### Mental model

1. **Client enqueue** — `ObjControllerMessage(CM_commandQueueEnqueue=278)` with `{sequenceId, commandHash, targetId, params}`. `commandHash` = `constcrc(commandName.toLowerCase())`.
2. **Server validate** — skill check, posture check, range check, cooldown check.
3. **Server execute** — warmup timer → execution → `CM_combatAction(204)` broadcast to nearby players. `CM_commandTimer(762)` refreshes your cooldown.
4. **You react** — read deltas from `ctx.world`, watch for kill events, loot.

### Core actions

```typescript
ctx.useAbility(commandName, targetId?, params?): number   // returns sequence id
ctx.attackTarget(targetId): number                        // sugar for useAbility('attack', targetId)
ctx.changePosture('standing' | 'crouched' | 'prone' | 'sitting'): Promise<void>
```

Examples:
```typescript
ctx.attackTarget(demonId);
ctx.useAbility('healthshot2', 0n);     // self-heal
ctx.useAbility('force_choke', enemyId);
ctx.useAbility('requestsurvey', toolId, 'Resotine');
await ctx.changePosture('prone');
ctx.useAbility('legshot1', targetId);
```

### `ctx.combat` view

```typescript
ctx.combat.targets()         // CombatTargetEntry[] — who's targeting us, sorted by distance
ctx.combat.engaged           // boolean — in a fight right now?
ctx.combat.autoLoot          // boolean — auto-fire 'loot' on creatures you killed
ctx.combat.attackingNearest({ maxRadiusM?, ability?, tickMs?, timeoutMs?, stopIf? })  // workhorse
ctx.combat.damagedSet()      // Set<NetworkId> — creatures you've damaged this session
```

`CombatTargetEntry`:
```typescript
{ id: NetworkId; distance: number; ham: { health: number; healthMax: number } | null }
```

### `ctx.hitTimer`

```typescript
ctx.hitTimer.timeSinceLastHitMs   // null or number
ctx.hitTimer.engaged              // true if hit within last 10s
```

Bodyguard scenarios watch the VIP's hit timer to trigger help calls.

### `ctx.cooldowns`

```typescript
ctx.cooldowns.isReady('mount')              // boolean
ctx.cooldowns.msUntil('headshot1')          // ms until ready (0 if ready)
ctx.cooldowns.all()                         // Map<command, { msUntilReady }>
```

Populated by `CM_commandTimer(762)` broadcasts. After `useAbility`, poll the cooldown within ~100ms to see the fresh value.

### `ctx.safety.fleeWhenHealthBelow`

```typescript
ctx.safety.fleeWhenHealthBelow(0.3, {
  goTo: { x: 0, z: 0 },           // safe destination
  usePeace: true,                 // break combat first
  useVehicle: true,               // call+mount a vehicle from datapad
  vehicleSettleMs: 1_200,
  onTrigger: (info) => console.log(`fled @ ${(info.healthRatio*100).toFixed(0)}%`),
});
```

Installed as a watcher; fires once when HAM ratio drops below threshold. To re-arm after recovery, call again.

### Real ability names

**Combat:**
- `attack` — basic, ~2s cd
- `kneelshot`, `headshot1`, `headshot2` — special shots, ~10s cd
- `bodyshot1`, `legshot1`, `eyeshot1`, `flurryshot1`
- `intimidate1` — CC

**Combat medic:**
- `healthshot2` — heal, ~3s cd
- `mindblast2` — damage, ~15s cd

**Jedi:**
- `force_choke`, `lightsaber_strike1`, `force_run_1`

**Posture/general:**
- `stand`, `crouch`, `prone`, `sit`
- `kneel` (legacy, prefer `crouch`)
- `peace` — break combat
- `changeposture <int>` — direct posture set

**Social/emote:**
- `dance basic`, `dance lyrical`, `stopdance`, `flourish 1`
- `entertainerHeal`, `bow`, `wave`

**Loot/exam:**
- `loot` (target = corpse id)
- `examine`, `corpseGreet`

**System:**
- `mount`, `dismount`
- `peace`
- `equip <itemId>`, `unequip`
- `pickup`, `drop`

**Trade/group:**
- `invite <targetId>`, `join`, `decline`, `disband`, `leaveGroup`
- `requestTradeReverse`

### Loot mechanics

Loot is NOT automatic. Either set `autoLoot = true` or manually `useAbility('loot', corpseId)`:

```typescript
ctx.combat.autoLoot = true;  // fires loot for every creature you killed
// OR
if (ctx.world.has(corpseId)) ctx.useAbility('loot', corpseId);
```

Detection signals (autoLoot watches for both):
1. `ChatSystemMessage` with kill-confirm STF (`prose_target_dead`)
2. `SceneDestroyObject` on a CREO in your damaged set

Looting requires being the killer OR in the killer's group.

### Real combat loops

**Solo hunt:**
```typescript
ctx.safety.fleeWhenHealthBelow(0.3, { goTo: { x: 0, z: 0 } });
ctx.combat.autoLoot = true;

const target = ctx.nearestHostile({ maxRadiusM: 60 });
if (!target) { ctx.fail('no hostile'); return; }
await ctx.walkTo({ x: target.position.x, z: target.position.z });
await ctx.combat.attackingNearest({ timeoutMs: 60_000 });
```

**Manual loop with cooldown polling:**
```typescript
const target = ctx.nearestHostile({ maxRadiusM: 40 });
if (!target) return;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline && ctx.world.has(target.id)) {
  if (ctx.cooldowns.isReady('headshot1')) ctx.useAbility('headshot1', target.id);
  else ctx.attackTarget(target.id);
  await ctx.wait(1500);
}
```

**Bodyguard intercept:**
```typescript
function tryIntercept(ctx, vipId) {
  const vip = ctx.world.get(vipId);
  if (!vip) return;
  for (const hostile of ctx.world.byType(ObjectTypeTags.CREO)) {
    if (hostile.id === ctx.sceneStart.playerNetworkId) continue;
    const np = hostile.baselines.get(6);
    if (!np?.inCombat) continue;
    const dVip = Math.hypot(vip.position.x - hostile.position.x, vip.position.z - hostile.position.z);
    if (dVip < 20) { ctx.attackTarget(hostile.id); return; }
  }
}
```

### Common gotchas

- **autoLoot only fires for kills YOU caused.** Group-mate kills aren't auto-looted unless your group settings + character permissions allow.
- **Posture-gated abilities silently fail.** `kneelshot` requires kneeling. Always `changePosture` first.
- **`fleeWhenHealthBelow` needs `goTo`.** Default is (0,0) — make sure it's reachable.
- **`hitTimer` is heuristic.** Non-combat damage (poison, environment) may not update it.
- **Unknown commands silently rejected.** Server may emit a `ChatSystemMessage`, may not. Check skills first.
- **Combat range cones.** Most abilities have 40-50m range; out-of-range fires queue but server rejects.

### Quick recipes

```typescript
// Attack until dead
await ctx.combat.attackingNearest({ timeoutMs: 60_000 });

// Auto-loot every kill
ctx.combat.autoLoot = true;

// Self-flee at 30%
ctx.safety.fleeWhenHealthBelow(0.3, { goTo: { x: 0, z: 0 }, usePeace: true, useVehicle: true });

// Fire ability with cooldown check
if (ctx.cooldowns.isReady('headshot1')) ctx.useAbility('headshot1', targetId);

// Check combat state
if (ctx.combat.engaged) console.log('fighting');

// Break combat
ctx.useAbility('peace');

// Posture-then-ability
await ctx.changePosture('prone');
ctx.useAbility('legshot1', targetId);

// Focus-fire whoever is targeting us
const targets = ctx.combat.targets();
if (targets[0]) ctx.attackTarget(targets[0].id);
```

### See also

- [Chapter 2](#chapter-2-the-character-sheet) — HAM bars, posture, skills
- [Chapter 4](#chapter-4-mounts-vehicles-and-pets) — combat dismounts you
- [Chapter 12](#chapter-12-talking-and-socializing-chat-groups-and-guilds) — group focus-fire
- [Chapter 13](#chapter-13-doing-business-trade-missions-npcs-sui-and-the-bazaar) — trading loot
- `src/client/combat-helpers.ts` — CombatView + SafetyView
- `scripts/examples/hunter-crafter.ts` — solo combat
- `scripts/examples/reactive-bodyguard-fleet.ts` — bodyguard reactor
- `scripts/examples/group-hunt-expedition.ts` — focus-fire

---

## Chapter 12: Talking and socializing: chat, groups, and guilds

You're alone on Tatooine until a nearby player shouts "Free drinks!" in the cantina. You send them a tell asking where. A guildmate posts to the planet channel about a Krayt Dragon hunt. Later, you invite three friends, ride to a hunting ground together, then trade loot via SecureTrade.

This chapter covers all five chat channels, groups, and guilds.

### The five chat channels

**1. Spatial chat (`ctx.say`)** — public broadcast within ~50m.

```typescript
ctx.say('Free drinks in the cantina!');
```

`say()` does NOT use the direct `CM_spatialChatSend(243)` ObjController subtype — that has `allowFromClient=false` server-side and triggers a HackAttempts log entry if you try. Instead, `say()` wraps the text in a `spatialChatInternal` CommandQueue command. The server processes it like any player command, broadcasts `CM_spatialChatReceive(244)` to observers.

Options:
```typescript
ctx.say('Whisper to you', { targetId: somePlayerId, chatType: 2 /* 0=Say, 1=Shout, 2=Whisper */ });
```

**2. Tells (`ctx.tell`)** — direct messages.

```typescript
ctx.tell('BobTheHunter', 'Need group for krayt?');
// Same-server. For cross-server:
import { chatAvatarId } from '@swg/ts-client';
ctx.tell(chatAvatarId('BobTheHunter', 'serverName', 'clusterName'), 'Hi');
```

Wire: `ChatInstantMessageToCharacter` (send), `ChatInstantMessageToClient` (recv).

**3. Channel posts (`ctx.sendToChannel`)** — persistent rooms.

```typescript
ctx.requestChannelList();  // populate list
ctx.sendToChannel(channelId, 'Hunting at (100, -4700)');
```

Wire: `ChatSendToRoom` / `ChatRoomList`.

**4. Mail (`ctx.sendMail`)** — persistent message.

```typescript
ctx.sendMail('BobTheHunter', 'Thanks!', 'Long body here...');
```

Capped at `PERSISTENT_MESSAGE_MAX_SIZE` (~4000 chars). Wire: `ChatPersistentMessageToServer`.

**5. System messages (server → you)** — `ChatSystemMessage` with optional `outOfBand` payload.

The survey loop uses outOfBand to encode sample results.

### Chat handlers

```typescript
const unsub = ctx.chat.onSay(/free/i, (text, sender) => console.log(sender.name, ':', text));
const unsub2 = ctx.chat.onTell(/help/i, (text, sender) => ctx.tell(sender.name, 'On my way'));
const unsub3 = ctx.chat.onSystemMessage(/damage/, (text) => console.log('hit:', text));
// later
unsub();
```

Predicates can be RegExp or `(text, sender) => boolean`. Subscriptions auto-detach at scenario end.

### Groups

A group is a server-side GROP-typed object with a roster. Members get the same baseline via universe-scope broadcast.

```typescript
ctx.group.id            // GroupObject NetworkId, or null
ctx.group.size          // member count
ctx.group.leader        // { id, name, position, health, posture, distance } or null
ctx.group.members       // same shape, sorted somehow
```

#### Forming a group

Leader invites:
```typescript
ctx.useAbility('invite', targetPlayerId);
```

This stores `m_groupInviter` on the target. The invitee polls:

```typescript
while (ctx.character.groupInviter === null && Date.now() < deadline) {
  await ctx.wait(250);
}
ctx.useAbility('join');  // accept
// OR
ctx.useAbility('decline');
```

**Defensive disband first.** Stale group state from a prior aborted run will block re-invites:
```typescript
ctx.useAbility('disband');
await ctx.wait(300);
// now safe to invite
```

#### `ctx.group.follow(leaderId)` — sync movement

```typescript
await ctx.ackPendingTeleports();  // REQUIRED before follow()
const unfollow = ctx.group.follow(leaderId);
try {
  await ctx.wait(30_000);
} finally {
  unfollow();
}
```

`follow()` subscribes to the leader's `UpdateTransformMessage` broadcasts and re-emits them as your own `CM_netUpdateTransform`. This bypasses the movement primitives' auto-ack, so you MUST `ackPendingTeleports()` once after zone-in or every mirrored transform is silently dropped server-side.

#### Group commands

```typescript
ctx.useAbility('disband');     // leader-only, breaks group
ctx.useAbility('leaveGroup');  // any member, just leaves
```

XP is shared server-side based on contribution.

### Guilds

```typescript
ctx.guild.id        // numeric, 0 if none
ctx.guild.name      // null if GuildObject baseline not visible
ctx.guild.abbrev    // null if unknown
```

GuildObject baselines are mostly SERVER-package only, so client-side visibility is limited. Your guild id comes from your CREO baseline; name/abbrev depend on what the server sends.

Forming/managing guilds requires a Guild Hall and the leader role — mostly out-of-scope for scripted automation.

### Common gotchas

- **`say` must go through CommandQueue.** Direct `CM_spatialChatSend` is `allowFromClient=false` → HackAttempts log.
- **Group follow needs pre-ack.** Call `ackPendingTeleports()` once after zone-in before first `follow()`.
- **Mail capped at ~4000 chars.**
- **Channel ids must be discovered.** Call `requestChannelList()` first.
- **Guild name often unavailable.** GuildObject SHARED baseline isn't routinely sent.
- **GroupInviter expires after ~60s.** Don't make the invitee wait too long.

### Quick recipes

```typescript
// Tell
ctx.tell('Bob', 'Where you at?');

// Broadcast
ctx.say('Free XP buff at cantina!');

// Auto-reply
ctx.chat.onTell(/help/i, (text, sender) => ctx.tell(sender.name, 'Coming!'));

// Invite 3 to group
for (const id of [id1, id2, id3]) {
  ctx.useAbility('invite', id);
  await ctx.wait(250);
}

// Mirror leader's movement
await ctx.ackPendingTeleports();
const stop = ctx.group.follow(leaderId);
// ... later: stop();

// Mail
ctx.sendMail('Bob', 'Thanks', 'Long body...');

// Players in range
const nearby = ctx.playersInRange(50);
```

### See also

- [Chapter 11](#chapter-11-combat-abilities-and-the-command-queue) — focus-fire in groups
- [Chapter 13](#chapter-13-doing-business-trade-missions-npcs-sui-and-the-bazaar) — SecureTrade for loot-share
- [Chapter 14](#chapter-14-operating-at-scale-fleets-persistence-and-the-engine) — multi-character coordination
- `scripts/examples/cantina-troupe.ts` — broadcast + ad pattern
- `scripts/examples/group-hunt-expedition.ts` — full invite→follow→hunt→trade flow
- `src/scenarios/group-trade.ts` — canonical invite/join reference

---

## Chapter 13: Doing business: trade, missions, NPCs, SUI, and the bazaar

Five interactive subsystems that drive scripted commerce and quests.

### SecureTrade (player-to-player exchange)

The 9-message handshake:
1. **RequestTrade** — `CM_secureTrade(TMI_RequestTrade)` with target id
2. **BeginTrade** — server pushes to both sides
3. **AddItem × N** — each item offered
4. **GiveMoney** — credit contribution
5. **AcceptTransaction** — lock in
6. **UnAcceptTransaction** — change mind
7. **VerifyTrade** — both echo, server confirms
8. **TradeComplete** — items + credits transferred
9. **AbortTrade** — cancel at any point before TradeComplete

#### Initiator side
```typescript
const result = await ctx.tradeWith(otherId, {
  items: [itemId1, itemId2],
  credits: 5000,
  beginTimeoutMs: 10_000,
  acceptTimeoutMs: 30_000,
  verifyTimeoutMs: 30_000,
});
// { completed: true } or { completed: false, abortReason: 'no-begin' | 'aborted' | 'no-verify' | 'no-complete' }
```

#### Recipient side
```typescript
const result = await ctx.acceptIncomingTrade({
  items: [returnItemId],
  credits: 2500,
  decline: false,         // true to reject
  requestTimeoutMs: 5_000,
});
```

Real example — group bounty split (3 members get 20k each):
```typescript
const perMember = Math.floor(60_000 / 3);
for (const memberId of memberIds) {
  const result = await ctx.tradeWith(memberId, { credits: perMember });
  if (!result.completed) console.log(`failed: ${result.abortReason}`);
}
```

Gotchas: range ~10m enforced server-side. Recipient can decline. Bind-on-pickup items are rejected at AddItem.

### Missions

Mission terminal templates match `/terminal_mission|mission_terminal/i`. Real examples: `shared_terminal_mission_destroy.iff`, `_combat.iff`, `_artisan.iff`.

#### The flow

```typescript
// 1. Find terminal + walk
const terminal = findNearestByTemplate(ctx, /terminal_mission/i, {
  typeTag: ObjectTypeTags.TANO, maxRadiusM: 120,
});

// 2. Request list (fire-and-forget; MISO baselines arrive async)
ctx.requestMissionList(terminal.id, { flags: 0 });
await ctx.wait(2_000);

// 3. Browse + pick
const ranked = ctx.missions.active.sort((a, b) => b.payout - a.payout);
const pick = ranked[0];
ctx.acceptMission(pick.id, terminal.id);

// 4. Navigate to waypoint
await ctx.navigate(pick.location);

// 5. Complete (combat or interact)
if (/destroy|bounty|hunt/.test(pick.type)) {
  ctx.combat.autoLoot = true;
  await ctx.combat.attackingNearest({ timeoutMs: 60_000 });
}

// 6. Server detects completion → MISO falls out of ctx.missions.active
// OR ctx.abortMission(pick.id) to bail
```

`ctx.missions` view:
```typescript
ctx.missions.active                       // Mission[]
ctx.missions.findByCategory(/destroy|hunt/i)
ctx.missions.bestPayout()                 // Mission | undefined
```

`Mission` shape:
```typescript
{
  id: NetworkId,
  type: 'destroy' | 'recon' | 'deliver' | 'bounty' | 'survey' | 'crafting' | 'musician' | 'dancer' | 'hunting',
  payout: number,
  location: Vector3,
  target: string,        // server template name
  description: string,
}
```

Real missions you'd see:
- "Destroy 5 desert demons" — type=destroy, payout=4500, waypoint (3401, -4900) Tatooine
- "Hunt the bandit Karkun" — type=bounty, payout=8000
- "Deliver datadisk to Captain Bren" — type=deliver, payout=2500
- "Survey 3 mineral deposits" — type=survey, payout=3200

### NPC Conversation

Server pushes prose + menu options as paired ObjController subtypes; you pick an index; server advances.

Wire (server pushes the trio):
- `CM_npcConversationMessage(223)` — prose
- `CM_npcConversationResponses(224)` — menu options
- `CM_npcConversationStop(222)` — conversation end

You drive via special useAbility commands:
- `useAbility('npcConversationStart', npcId, '<starter> <name>')` — opens conversation
- `useAbility('npcConversationStop', 0n, '')` — closes
- `useAbility('npcConversationSelect', 0n, String(index))` — pick option N

API:
```typescript
ctx.talkTo(npcId);                                              // starts
const prompt = await ctx.waitForNpcDialog({ timeoutMs: 5000 }); // { npcMessage, options[] }
ctx.selectDialog(0);                                            // pick option 0
ctx.endConversation();
```

High-level walker:
```typescript
const finalPrompt = await ctx.npc.converse(npcId, ['job', 'combat', /confirm/i, 0]);
// path items: string substring match (case-insensitive), regex, or index
```

`ctx.npc.lastDialog` carries the most recent state.

### SUI dialogs

SUI = Server UI. Server pushes a page definition; client renders; user interacts; client replies.

Messages:
- `SuiCreatePageMessage` — open
- `SuiUpdatePageMessage` — mutate widgets in-place
- `SuiForceClosePage` — server closes
- `SuiEventNotification` — client reply

```typescript
const page = await ctx.waitForSui({ timeoutMs: 5_000 });
// { pageId, title, pageName, commands, associatedObjectId, ... }

ctx.respondToSui(page.pageId, 0, ['some_return_value']);  // event 0 = OK
```

Auto-responder:
```typescript
const unsub = ctx.sui.autoRespond(
  (page) => /are you sure/i.test(page.title),
  'ok',  // or { eventType: 0, returnList: [] }
);
// later unsub();
```

`ctx.sui.active` — readonly list of open SUI pages.

### Bazaar / commodities

Terminal template: `object/tangible/terminal/shared_terminal_bazaar.iff`.

```typescript
// Browse
const listings = await ctx.browseBazaar(terminalId, {
  searchType: AuctionSearchType.ByAll,
  locationSearchType: AuctionLocationSearch.Galaxy,
  textFilterAll: 'Carbosteel',
  minPrice: 1000,
  maxPrice: 100_000,
});

// Each AuctionListing: { itemId, itemName, itemType, buyNowPrice, highBid, sellerName, expiryTime, description, ... }
```

Buy:
```typescript
ctx.send(new AcceptAuctionMessage(auctionId));  // instant-buy
ctx.bidOn(auctionId, 15_000, 20_000);           // bid 15k, auto-rebid up to 20k
ctx.retrieveBazaarItem(terminalId, itemId);     // claim won item
```

Sell:
```typescript
const result = await ctx.listForSale(terminalId, itemId, {
  price: 10_000,
  durationHours: 24,
  description: 'Excellent quality',
  instantSale: true,         // false for bidding-only
});
// { success, auctionId, resultCode, errorReason }

ctx.cancelMyListing(auctionId);
```

Get details:
```typescript
const details = await ctx.getAuctionDetails(auctionId);
```

Real bazaar listings you'd see (illustrative):
- "Survey Tool v3" listed by MasterSmith, buy-now 5000c
- "Carbosteel Ingot" (stack of 5000) listed by ResourceCorp, buy-now 25000c
- "DL-44 Blaster" listed by CrimsonSkyfall, buy-now 15000c, high bid 12000c

### Common gotchas

- **Trade aborts on movement** (>10m).
- **Bind-on-pickup items rejected** at AddItem.
- **MISO baselines are async** — wait 1-2s after `requestMissionList` before reading `ctx.missions.active`.
- **NPC start/stop go through useAbility, NOT direct subtypes** — subtypes have `allowFromClient=false`.
- **SUI pageIds are server-assigned** — never hardcode.
- **Bazaar terminal id is the container.** Pass the terminal's NetworkId, not the planet/region.
- **Captured live for `TsLive01`:** zero terminals in baseline range, zero missions in datapad. To run mission flows you must walk to a starport area and let the terminals come into baseline.

### Quick recipes

```typescript
// Trade 5k credits
await ctx.tradeWith(buddyId, { credits: 5000 });

// Accept top-payout mission
ctx.requestMissionList(terminalId);
await ctx.wait(2000);
const m = ctx.missions.bestPayout();
if (m) ctx.acceptMission(m.id, terminalId);

// NPC dialog walker
await ctx.npc.converse(npcId, ['accept', 'combat', 'yes']);

// Auto-confirm any "Are you sure?" SUI
ctx.sui.autoRespond((p) => /confirm|are you sure/i.test(p.title), 'ok');

// Bazaar instant-buy
const listings = await ctx.browseBazaar(terminalId, { textFilterAll: 'Cortosis', maxPrice: 10_000 });
if (listings[0]) ctx.send(new AcceptAuctionMessage(listings[0].itemId));

// Bazaar list
await ctx.listForSale(terminalId, itemId, { price: 10_000, durationHours: 24, instantSale: true });

// Bid
ctx.bidOn(auctionId, 15_000, 20_000);

// Mission flow
const m = ctx.missions.bestPayout();
if (m && /destroy|hunt/.test(m.type)) {
  await ctx.navigate(m.location);
  ctx.combat.autoLoot = true;
  while (ctx.missions.active.some(x => x.id === m.id)) {
    await ctx.combat.attackingNearest({ maxRadiusM: 20, ability: 'attack', timeoutMs: 5_000 });
  }
}
```

### See also

- [Chapter 11](#chapter-11-combat-abilities-and-the-command-queue) — combat for destroy missions
- [Chapter 5](#chapter-5-travel-planet-hopping-with-shuttles) — interplanetary mission chains
- [Chapter 10](#chapter-10-resources-survey-and-crafting) — crafting + bazaar resource sales
- `src/messages/game/trade/` — 9 SecureTrade message classes
- `src/messages/game/sui/` — SUI page + command variants
- `src/messages/game/commodities/` — 16 bazaar messages
- `scripts/examples/group-hunt-expedition.ts` — tradeWith
- `scripts/examples/mission-marathon.ts` — full mission loop
- `scripts/examples/bazaar-arbitrage-fleet.ts` — bazaar
- `scripts/examples/surveyor-bazaar.ts` — listForSale

---

## Chapter 14: Operating at scale: fleets, persistence, and the engine

You've mastered single-character scripts. This chapter is the operational depth: running N characters in parallel, persistent state across sessions, wire-drift detection, lifecycle mechanics.

### Fleet operations

A **Fleet** is N independent `SwgClient` instances run in parallel. Each has its own UDP socket, its own character, its own ScriptContext. They share NOTHING by default. Shared state must be passed via closure into the per-character `ScenarioFn` factories.

```typescript
const fleet = new Fleet({ loginServer: { host: '10.254.0.253', port: 44453 } });
const result = await fleet.run(configs, { staggerMs: 300, maxConcurrent: 5 });
// FleetResult { outcomes: FleetOutcome[], summary: FleetSummary }
```

`FleetClientConfig`:
```typescript
{
  account: string;
  characterName?: string;
  clusterName?: string;
  planet?: string;
  profession?: string;
  script?: ScenarioFn;
  holdZonedInMs?: number;
  skipGameStage?: boolean;  // run Stages 1+2 only; skip zone-in
}
```

**Stagger matters.** Don't launch N characters in the same millisecond — the connection server's accept queue gets overwhelmed. Use `staggerMs: 300+`. For 10+ char fleets, set `maxConcurrent: 5` to keep load reasonable.

### Two-phase NetworkId pre-resolve (THE coordination pattern)

Most fleet scenarios need each character to know the OTHER characters' `NetworkId` (leader inviting members, members detecting invites, bodyguard tracking VIP). But NetworkIds are only known AFTER Stages 1+2 complete.

**Solution: Phase 1 lookup fleet with `skipGameStage: true`**.

```typescript
// Phase 1: resolve all NetworkIds
const lookupConfigs = [
  { account: 'tslive10', characterName: 'Leader', skipGameStage: true },
  { account: 'tslive11', characterName: 'Member1', skipGameStage: true },
  { account: 'tslive12', characterName: 'Member2', skipGameStage: true },
];
const lookup = await fleet.run(lookupConfigs, { staggerMs: 100 });
const leaderId = lookup.outcomes[0]?.lifecycleResult?.character.networkId;
const memberIds = lookup.outcomes.slice(1).map(o => o.lifecycleResult?.character.networkId);

// Phase 2: real scenario fleet with ids closure-captured
const realConfigs = [
  { account: 'tslive10', characterName: 'Leader', script: makeLeaderScenario(memberIds) },
  { account: 'tslive11', characterName: 'Member1', script: makeMemberScenario(leaderId) },
  { account: 'tslive12', characterName: 'Member2', script: makeMemberScenario(leaderId) },
];
const result = await fleet.run(realConfigs, { staggerMs: 300 });
```

The canonical reference is `src/scenarios/group-trade.ts`. Both `scripts/examples/group-hunt-expedition.ts:327` and `reactive-bodyguard-fleet.ts:325` follow this pattern.

### Shared closure state

Between Phase-2 scenarios, share a JS object captured via closure:

```typescript
interface SharedState {
  flagged: FlaggedListing[];
  pendingRetrieve: PendingRetrieve[];
  retrieved: PendingRetrieve[];
}
const shared: SharedState = { flagged: [], pendingRetrieve: [], retrieved: [] };

const scoutScenario: ScenarioFn = async (ctx) => {
  while (true) {
    const listings = await ctx.browseBazaar(terminalId);
    shared.flagged = listings.filter(isCheap);
    await ctx.wait(30_000);
  }
};

const buyerScenario: ScenarioFn = async (ctx) => {
  while (true) {
    for (const item of shared.flagged) {
      await ctx.buyNow(item.id);
      shared.flagged = shared.flagged.filter(x => x.id !== item.id);
      shared.pendingRetrieve.push({ itemId: item.id });
    }
    await ctx.wait(1500);
  }
};

const configs = [
  { account: 'scout', characterName: 'Scout', script: scoutScenario },
  { account: 'buyer', characterName: 'Buyer', script: buyerScenario },
];
```

WARNING: shared state is NOT thread-safe. TypeScript can't detect races. In Node, single-threaded mutations are atomic as long as you don't `await` mid-mutation. For complex queue logic, use immutable updates.

See `scripts/examples/bazaar-arbitrage-fleet.ts:95` for a full shared-state example.

### `runFleet` helper

```typescript
import { runFleet, formatJson } from './scripts/examples/_lib.js';

const { summary, result } = await runFleet(args, configs, { staggerMs: 300 });
console.log(formatJson(summary, args.pretty));
process.exit(summary.ok ? 0 : 1);
```

Stable JSON shape.

### FleetSummary

```typescript
{
  totalClients, succeeded, failed,
  totalElapsedMs, cumulativeElapsedMs,
  totalUpdateTransformsSent,
  messageCounts: Record<string, { sent, recv }>,
  clientsWithErrorMessage,
  errorMessages: string[],
}
```

### CharacterPool: persistent reuse

Every fresh-character lifecycle leaks a timestamped character. The pool reuses pre-created ones.

```typescript
const pool = new CharacterPool();
// Reads ~/.swg-ts-client/character-pool.json (lockfile-protected)

await pool.add('ci-test-1', 'TsChar1', { planet: 'mos_eisley' });

const { character, release } = await pool.checkout({
  leaseMs: 10 * 60 * 1000,
  leasedBy: `pid-${process.pid}`,
  require: (c) => c.proven === true,
});

try {
  await client.fullLifecycle({ account: character.account, characterName: character.characterName });
  await pool.markProven(character.account);
} finally {
  await release();
}
```

Other operations:
- `pool.checkoutMany(count, opts)` — atomic multi-checkout
- `pool.markProven(account)` — flag as successfully zoned
- `pool.sweepExpired()` — reclaim timed-out leases
- `pool.list()` — snapshot

CLI:
```bash
swg-ts-cli pool stock --count=10  # pre-stock 10 chars
```

Env vars:
```bash
CI_USE_POOL=1                     # tests pull from pool
CI_REUSE_ACCOUNT=tslive10         # pin one (forces serial)
CI_REUSE_CHARACTER=TsChar1
```

### Admin allowlist

`tslive01..tslive20` are hardcoded in `~/code/swg-main/dsrc/.../admin/stella_admin.tab`. These bypass the player-tutorial character-creation cap — `canCreateRegularCharacter=true` always. CI scenarios hardcode these accounts.

### Capture + replay

Detect wire drift when server submodules bump.

```typescript
// Capture once after a known-good build
const result = await captureLifecycle({
  loginServer: { host: '10.254.0.253', port: 44453 },
  account: 'ci-test',
  characterName: 'TsTest',
  holdZonedInMs: 5_000,
});
await writeTranscript(result.events, '/tmp/baseline.ndjson');

// Replay after a bump
const captured = await readTranscript('/tmp/baseline.ndjson');
const replay = await replay({
  loginServer: { host: '10.254.0.253', port: 44453 },
  account: 'ci-test',
  characterName: 'TsTest',
  capture: captured,
  pacing: 'asFast',     // or 'asCaptured' (honor original timing)
  compare: 'count',     // multiset (recommended for live)
});
if (!replay.succeeded) console.error('drift:', replay.missing);
```

Pacing:
- `'asFast'` — sends back-to-back. CI-friendly.
- `'asCaptured'` — honor original delays.

Compare:
- `'names'` — strict order. Brittle on live (neighbor traffic varies).
- `'count'` — multiset totals. Recommended for live testing.

CLI:
```bash
pnpm cli capture --output=/tmp/baseline.ndjson
pnpm cli replay --input=/tmp/baseline.ndjson --pacing=asFast --compare=count
```

### Reconnect verify

Persistence regression detection.

```typescript
const result = await reconnectVerify({
  loginServer: { host: '10.254.0.253', port: 44453 },
  account: 'ci-test',
  characterName: 'TsTest',
  mutate: async (ctx) => {
    await ctx.walkTo({ x: 100, z: -200 });
  },
  observe: async (ctx) => {
    await ctx.wait(1000);
  },
  expectedDrift: ['playedTime'],
  postSettleMs: 2000,
});
if (!result.succeeded) console.error('persistence regression:', result.unexpectedDrift);
```

Runs two `fullLifecycle` passes, snapshots both, diffs.

### ScriptContext lifecycle

After Stages 1+2, GameStage runs zone-in, then your `ScenarioFn` is called with a fully-populated `ctx`. Views start empty and populate as wire messages arrive:

- `ctx.character.ready` — first CREO baseline
- `ctx.inventory.ready` — first inventory containment messages
- `ctx.world` — empty initially, fills during baseline flood

The dispatcher loop runs continuously underneath. Views update in place. Your scenario READS views; it doesn't poll the wire.

### Cooperative cancellation: `ctx.signal`

```typescript
const deadline = Date.now() + totalMs;
while (Date.now() < deadline && !ctx.signal.aborted) {
  // do work
  await ctx.wait(1000);
}
```

Every built-in async primitive checks `ctx.signal`. Custom loops are YOUR responsibility.

### Soft failures: `ctx.fail`

```typescript
ctx.fail('inventory not ready after 30s');
// Logs + pushes to ctx.scriptResult.assertionFailures.
// Does NOT throw. Scenario can continue or return cleanly.
```

### Graceful shutdown

```typescript
await ctx.logout();  // sends LogoutMessage, brief settle, orchestrator closes socket
```

If you don't call it, the orchestrator does it for you when your scenario returns/throws.

### Raw dispatcher escape hatch

```typescript
ctx.dispatcher.send(new MyCustomMessage(arg1));
const response = await ctx.dispatcher.waitFor(MyResponseMessage, { timeoutMs: 5000 });
```

Most scenarios never need this. Reach for it when no helper exists for your wire path.

### JSON summary contract

```typescript
async function main() {
  const args = parseCommonArgs(process.argv.slice(2));
  const { summary, lifecycle } = await runScenario(args, myScenario);
  summary.extra = { bossKilled: outcome.bossKilled, unitsHarvested: outcome.unitsHarvested };
  console.log(formatJson(summary, args.pretty));
  process.exit(summary.ok ? 0 : 1);
}
```

`ScenarioSummary` shape:
```typescript
{
  ok: boolean,
  host, account, character,
  durationMs, zonedInAt, baselineObjectCount,
  sendsCount, scriptElapsedMs, didLogout,
  scriptError?: string,
  assertionFailures: string[],
  serverErrorMessage: boolean,
  stages: { login, connection, game, logout },
  messageCounts: Record<string, { send, recv }>,
  extra?: Record<string, unknown>,
}
```

### Common gotchas

- **Stagger too low** → connection server overwhelmed → some chars never auth. Use 300+ ms.
- **Shared state races.** TS doesn't catch them. Don't `await` mid-mutation.
- **Pool leases** — always `release()` in finally.
- **NetworkId pre-resolve timing** — Phase 1 must complete before Phase 2 constructors run.
- **Replay 'names' too brittle for live.** Use 'count'.
- **`ctx.signal` is YOUR responsibility** in custom loops. Built-ins handle it.
- **Teleport ack** — built-in movement primitives auto-ack; raw `ctx.send` does not.

### Quick recipes

```typescript
// Run 3 in parallel
await fleet.run([
  { account: 'a1', characterName: 'C1', script: s1 },
  { account: 'a2', characterName: 'C2', script: s2 },
  { account: 'a3', characterName: 'C3', script: s3 },
], { staggerMs: 300, maxConcurrent: 3 });

// Two-phase pre-resolve
const lookup = await fleet.run(lookupConfigs, { staggerMs: 100 });
const ids = lookup.outcomes.map(o => o.lifecycleResult?.character.networkId);
const realConfigs = configs.map((cfg, i) => ({ ...cfg, script: makeScenario(ids, i) }));
await fleet.run(realConfigs, { staggerMs: 300 });

// Capture + replay drift detection
const cap = await captureLifecycle({ ... });
await writeTranscript(cap.events, 'baseline.ndjson');
// later:
const events = await readTranscript('baseline.ndjson');
const r = await replay({ capture: events, compare: 'count' });
if (!r.succeeded) console.error(r.missing);

// Verify persistence
const r = await reconnectVerify({ mutate: async (ctx) => ctx.walkTo({ x: 100, z: -200 }), expectedDrift: ['playedTime'] });

// Honor signal
while (Date.now() < deadline && !ctx.signal.aborted) { await ctx.wait(1000); }

// Use pool
const { character, release } = await pool.checkout();
try { /* test */ } finally { await release(); }
```

### See also

- `src/client/fleet.ts` — Fleet impl
- `src/client/character-pool.ts` — Pool impl
- `src/client/replay.ts` — capture + replay
- `src/client/reconnect-harness.ts` — reconnect verify
- `src/client/script/context.ts` — ScriptContext lifecycle, signal, fail
- `src/scenarios/group-trade.ts` — canonical pre-resolve reference
- `scripts/examples/group-hunt-expedition.ts:327` — two-phase pattern
- `scripts/examples/bazaar-arbitrage-fleet.ts:95` — shared closure state
- `scripts/examples/_lib.ts` — `runFleet`, `runScenario`, `ScenarioSummary`

---

*End of handbook. For the typed API references, see [`views-reference.md`](views-reference.md) and [`actions-reference.md`](actions-reference.md). For lifecycle internals, see [`lifecycle.md`](lifecycle.md). For wire-byte spec, see [`wire-spec.md`](wire-spec.md). The raw live capture used in the "Captured live:" callouts is at [`handbook-snapshot.json`](handbook-snapshot.json); the capture script is at [`../scripts/capture-handbook-data.ts`](../scripts/capture-handbook-data.ts) — run it with `LIVE=1 pnpm exec tsx scripts/capture-handbook-data.ts` to refresh against the current cluster state.*
