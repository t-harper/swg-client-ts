# SWG asset staging

This directory holds **runtime asset files** the swg-ts-client may load to support advanced features (terrain sampling, lookups, etc.). Asset binaries are **gitignored** — never committed.

## What goes here

| Path | Purpose | How to get it |
|---|---|---|
| `assets/swgsource_3.0.tre` | Master SWG asset archive — feeds the TRE reader for cross-planet terrain lookups. | Copy from `/home/tharper/code/swg-main/dist/prebuilt/swgsource_3.0.tre` (or your SWG asset distribution). |
| `assets/terrain/<planet>.trn` | Per-planet extracted terrain manifests (faster than going through the TRE). | Copy from `/home/tharper/code/swg-main/serverdata/terrain/<planet>.trn`. |

## Why both?

The TRE reader (`src/tre/`) can extract any file from a `.tre` archive at runtime. But the prebuilt `swgsource_3.0.tre` shipped with SWG-Source only contains a partial terrain set (e.g. dathomir). Most servers extract `.trn` files separately into a flat layout under `serverdata/terrain/`.

The terrain asset loader (`src/terrain/asset-loader.ts`) checks both sources in priority order:

1. `<cwd>/assets/terrain/<planet>.trn` (extracted-here)
2. `<cwd>/../swg-main/serverdata/terrain/<planet>.trn` (sibling-repo, common dev setup)
3. The configured TRE archive (`SWG_TRE_PATH` env, `<cwd>/assets/*.tre`, sibling-repo prebuilt)

## Minimum required for the build-city scripts

To run `scripts/build-city/` (the player-city builder) with terrain-aware coordinate selection, you need at minimum:

```bash
mkdir -p assets/terrain
cp /home/tharper/code/swg-main/serverdata/terrain/naboo.trn assets/terrain/
```

For multi-planet support, copy any other planet's `.trn` you intend to build on. Or set `SWG_TRE_PATH=/path/to/your.tre` and use the TRE-archive fallback.
