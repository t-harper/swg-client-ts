/**
 * test-building-navs — stress-test ctx.navigate against several Mos Eisley
 * interiors. Logs in as an admin (godmode flag only — no position warps),
 * walks to each building anchor, calls
 * ctx.navigate({ buildingId, cellName: '' }), reports the resulting
 * ctx.location.cell. Used to catch regressions in the walk-only cell-entry
 * path against buildings of varying portal-layout complexity.
 *
 * Buildings tested (Tatooine):
 *   1. cantina           — OID 1082874  @ (3432, -4819)  (single-cell entry baseline)
 *   2. starport           — OID 1106368  @ (3619, -4801)  (ticket-collector lobby)
 *   3. hospital (medcen)  — OID 9655494  @ (3529, -4753)  (multi-cell with beds)
 *
 * For the hospital case, after navigate succeeds the bot:
 *   - scans the cell for TANO objects with `templateName` matching /bed/i
 *   - walks to the nearest one's cell-local position
 *   - issues `sitServer` (player command)
 *   - re-reads posture from CREO baseline to confirm sitting
 *
 * Usage:
 *   pnpm tsx scripts/test-building-navs.ts
 *     [--user=tslive11] [--character=NavTester]
 *     [--only=cantina|starport|medcen]
 */

import { ObjectTypeTags, SwgClient } from '../src/index.js';
import { adminGodModeOn } from './build-city/admin.js';

interface Target {
  name: string;
  buildingId: bigint;
  worldX: number;
  worldZ: number;
  scanForBeds?: boolean;
}

const TARGETS: Target[] = [
  { name: 'cantina', buildingId: 1082874n, worldX: 3432, worldZ: -4819 },
  { name: 'starport', buildingId: 1106368n, worldX: 3619, worldZ: -4801 },
  { name: 'medcen', buildingId: 9655494n, worldX: 3529, worldZ: -4753, scanForBeds: true },
];

interface Args {
  host: string;
  port: number;
  user: string;
  character: string;
  only: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {
    host: '10.254.0.253',
    port: 44453,
    user: 'tslive11',
    character: 'NavTester',
    only: null,
  };
  for (const a of argv) {
    const m = /^--([\w-]+)=(.*)$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'host') out.host = v;
    else if (k === 'port') out.port = Number(v);
    else if (k === 'user') out.user = v;
    else if (k === 'character') out.character = v;
    else if (k === 'only') out.only = v;
  }
  return out;
}

function log(m: string): void {
  process.stderr.write(`[nav-test] ${m}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const client = new SwgClient({ loginServer: { host: args.host, port: args.port } });
  const results: Array<{ name: string; pass: boolean; detail: string }> = [];

  await client.fullLifecycle({
    account: args.user,
    characterName: args.character,
    planet: 'mos_eisley',
    holdZonedInMs: 2_000,
    script: async (ctx) => {
      await ctx.wait(2_500);
      await adminGodModeOn(ctx);

      for (const target of TARGETS) {
        if (args.only !== null && args.only !== target.name) continue;

        log(`==== ${target.name} (oid=${target.buildingId}) ====`);
        try {
          // Walk to the building anchor — NO admin warps.
          const pos = ctx.location.position;
          const dist = Math.hypot(target.worldX - pos.x, target.worldZ - pos.z);
          log(`  walking ${dist.toFixed(0)}m to (${target.worldX}, ${target.worldZ})`);
          await ctx.walkTo({ x: target.worldX, z: target.worldZ });
          await ctx.wait(2_500); // let baseline flood for the building's cells

          // Navigate into the building.
          await ctx.navigate(
            { buildingId: target.buildingId, cellName: '' },
            { useMount: 'never' },
          );

          const cell = ctx.location.cell;
          if (cell === null || cell.buildingId !== target.buildingId) {
            const detail =
              cell === null ? 'still outdoors' : `wrong building ${cell.buildingId.toString()}`;
            log(`  ✗ ${target.name}: navigate returned but ${detail}`);
            results.push({ name: target.name, pass: false, detail });
            continue;
          }

          log(`  ✓ ${target.name}: inside cell ${cell.cellNumber} (${cell.cellName || 'public'})`);

          // Med center bonus: find a bed, walk to it, sit on it.
          if (target.scanForBeds) {
            const playerId = ctx.sceneStart.playerNetworkId;
            const player = ctx.world.get(playerId);
            const playerCellId = player?.containerId ?? 0n;

            const beds: Array<{
              id: bigint;
              templateName: string;
              x: number;
              z: number;
              y: number;
            }> = [];
            for (const obj of ctx.world.objects()) {
              if (obj.containerId !== playerCellId) continue;
              if (obj.typeId !== ObjectTypeTags.TANO) continue;
              const tpl = obj.templateName ?? '';
              if (!/bed/i.test(tpl)) continue;
              beds.push({
                id: obj.id,
                templateName: tpl,
                x: obj.position.x,
                y: obj.position.y,
                z: obj.position.z,
              });
            }

            if (beds.length === 0) {
              log(`  (no bed found in cell ${cell.cellNumber}; trying sit anyway)`);
            } else {
              log(`  found ${beds.length} bed(s) in cell:`);
              for (const b of beds.slice(0, 3)) {
                log(
                  `    - ${b.templateName} at (${b.x.toFixed(2)}, ${b.y.toFixed(2)}, ${b.z.toFixed(2)})`,
                );
              }
              // Walk to the nearest bed.
              const first = beds[0];
              if (first === undefined)
                throw new Error('unreachable — guarded by beds.length check');
              log(`  walking to bed at cell-local (${first.x.toFixed(2)}, ${first.z.toFixed(2)})`);
              try {
                await ctx.walkToCell(playerCellId, { x: first.x, y: first.y, z: first.z });
              } catch (err) {
                log(`  walkToCell failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }

            // Sit.
            ctx.useAbility('sitServer');
            await ctx.wait(2_000);

            const posture = ctx.character.posture;
            const sat = posture === 'sitting';
            log(`  ${sat ? '✓' : '✗'} posture after sit: ${posture ?? 'unknown'}`);
            results.push({
              name: `${target.name}-bedsit`,
              pass: sat,
              detail: `posture=${posture ?? 'unknown'}, beds=${beds.length}`,
            });
            // Stand up so the next target isn't sat down.
            ctx.useAbility('stand');
            await ctx.wait(500);
          }

          results.push({ name: target.name, pass: true, detail: `cell=${cell.cellNumber}` });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`  ✗ ${target.name}: ${msg}`);
          results.push({ name: target.name, pass: false, detail: msg });
        }
      }

      await ctx.logout();
    },
  });

  log('==== summary ====');
  for (const r of results) {
    log(`  ${r.pass ? '✓' : '✗'} ${r.name}: ${r.detail}`);
  }
  const failures = results.filter((r) => !r.pass);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
