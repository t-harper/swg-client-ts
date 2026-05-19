import { SwgClient } from '../src/index.js';
import { adminConsole, adminGodModeOn } from './build-city/admin.js';

const client = new SwgClient({ loginServer: { host: '10.254.0.253', port: 44453 } });
await client.fullLifecycle({
  account: 'tslive08',
  characterName: 'ModTest',
  planet: 'mos_eisley',
  holdZonedInMs: 10_000,
  script: async (ctx) => {
    await ctx.wait(2_000);
    await adminGodModeOn(ctx);
    const oid = ctx.sceneStart.playerNetworkId.toString();
    console.log('myOid=' + oid);
    console.log('--- BEFORE grant ---');
    console.log(await adminConsole(ctx, 'skill getSkillMods ' + oid, { timeoutMs: 5_000 }));
    console.log('--- granting (with oid arg) ---');
    console.log(await adminConsole(ctx, 'skill grantSkillMod expertise_buff_duration_line_me_enhance 1200 ' + oid, { timeoutMs: 5_000 }));
    console.log('--- granting (WITHOUT oid arg, self-target) ---');
    console.log(await adminConsole(ctx, 'skill grantSkillMod expertise_healing_line_me_heal 25', { timeoutMs: 5_000 }));
    await ctx.wait(500);
    console.log('--- AFTER grant (filtered): ---');
    const after = await adminConsole(ctx, 'skill getSkillMods ' + oid, { timeoutMs: 5_000 });
    for (const line of after.split('\n')) {
      if (/expertise|healing|buff_dur|me_enhance/.test(line)) console.log(line);
    }
    await ctx.logout();
  },
});
