#!/usr/bin/env node
/**
 * One-off cleanup: enumerate structures in the test city and destroy all
 * non-cityhall ones via admin console. Used to clear leftover houses from
 * prior failed `build-city --mode=mvp` runs that polluted the city footprint
 * with rejected placements.
 *
 * Usage:
 *   pnpm tsx bin/cleanup-city.ts --host=10.254.0.253 --planet=naboo --x=2800 --z=-2800
 *
 * Defaults match build-city's mvpLayout CITY_CENTER on naboo.
 */

import { ObjectTypeTags, SwgClient } from '../src/index.js';
import { adminConsole, adminGodModeOn, adminPlanetWarp } from '../scripts/build-city/admin.js';

interface Args {
  host: string;
  port: number;
  planet: string;
  x: number;
  z: number;
  radiusBufferM: number;
  account: string;
  character: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    host: '10.254.0.253',
    port: 44453,
    planet: 'naboo',
    x: 2800,
    z: -2800,
    radiusBufferM: 200,
    account: 'swg',
    character: 'Swg',
    dryRun: false,
  };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const val = eq < 0 ? 'true' : arg.slice(eq + 1);
    switch (key) {
      case 'host': a.host = val; break;
      case 'port': a.port = Number.parseInt(val, 10); break;
      case 'planet': a.planet = val; break;
      case 'x': a.x = Number.parseFloat(val); break;
      case 'z': a.z = Number.parseFloat(val); break;
      case 'radius-buffer': a.radiusBufferM = Number.parseFloat(val); break;
      case 'account': a.account = val; break;
      case 'character': a.character = val; break;
      case 'dry-run': a.dryRun = val === 'true' || val === ''; break;
      default:
        process.stderr.write(`unknown flag --${key}\n`);
        process.exit(2);
    }
  }
  return a;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  process.stderr.write(
    `[cleanup-city] host=${args.host} planet=${args.planet} center=(${args.x},${args.z}) dryRun=${args.dryRun}\n`,
  );

  const client = new SwgClient({ loginServer: { host: args.host, port: args.port } });

  let destroyed = 0;
  let kept = 0;
  let failed = 0;

  await client.fullLifecycle({
    account: args.account,
    characterName: args.character,
    planet: 'mos_eisley',
    holdZonedInMs: 120_000,
    script: async (ctx) => {
      await ctx.wait(1500);
      await adminGodModeOn(ctx);

      // Warp to the cleanup area so the WorldModel populates with nearby
      // BUIOs. Going via planetwarp avoids needing a city to enumerate
      // through — useful when the city itself has auto-decayed (no
      // citizens, no maintenance) but its leftover structures persist.
      process.stderr.write(`[cleanup-city] warping to ${args.planet} (${args.x}, ${args.z})\n`);
      await adminPlanetWarp(ctx, args.planet, args.x, 0, args.z);
      // Allow the baseline flood to populate the WorldModel.
      await ctx.wait(5_000);

      const here = ctx.position();
      const buildings = ctx.world.toArray().filter((o) => {
        if (o.typeId !== ObjectTypeTags.BUIO) return false;
        const dx = o.position.x - here.x;
        const dz = o.position.z - here.z;
        const d2 = dx * dx + dz * dz;
        return d2 <= args.radiusBufferM * args.radiusBufferM;
      });
      process.stderr.write(
        `[cleanup-city] found ${buildings.length} BUIOs within ${args.radiusBufferM}m of player\n`,
      );

      for (const b of buildings) {
        const tpl = b.templateName ?? '';
        const isCityhall = /cityhall/i.test(tpl);
        const tplShort = tpl.split('/').pop() ?? '<no-template>';
        if (isCityhall) {
          process.stderr.write(`  KEEP cityhall oid=${b.id.toString()} tpl=${tplShort}\n`);
          kept++;
          continue;
        }
        const dx = b.position.x - here.x;
        const dz = b.position.z - here.z;
        const dist = Math.hypot(dx, dz).toFixed(1);
        if (args.dryRun) {
          process.stderr.write(
            `  [dry-run] would destroy oid=${b.id.toString()} tpl=${tplShort} dist=${dist}m\n`,
          );
          continue;
        }
        try {
          const reply = await adminConsole(ctx, `object destroy ${b.id.toString()}`);
          process.stderr.write(
            `  DESTROYED oid=${b.id.toString()} tpl=${tplShort} dist=${dist}m reply="${reply.slice(0, 80).trim()}"\n`,
          );
          destroyed++;
          await ctx.wait(200);
        } catch (err) {
          process.stderr.write(
            `  FAILED to destroy oid=${b.id.toString()}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          failed++;
        }
      }

      process.stderr.write(`[cleanup-city] kept=${kept} destroyed=${destroyed} failed=${failed}\n`);
      await ctx.logout();
    },
  });

  process.stdout.write(
    `${JSON.stringify({ ok: failed === 0, kept, destroyed, failed }, null, 2)}\n`,
  );
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
