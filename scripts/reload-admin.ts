import { SwgClient } from '../src/index.js';
import { adminGodModeOn, adminReloadAdminTable } from './build-city/admin.js';

const client = new SwgClient({ loginServer: { host: '10.254.0.253', port: 44453 } });
await client.fullLifecycle({
  account: 'tslive06',
  characterName: 'Reloader',
  planet: 'mos_eisley',
  holdZonedInMs: 5_000,
  script: async (ctx) => {
    await ctx.wait(2_000);
    await adminGodModeOn(ctx);
    await ctx.wait(500);
    console.log(await adminReloadAdminTable(ctx));
    await ctx.logout();
  },
});
