import { SwgClient } from '../src/index.js';
import { adminConsole, adminGodModeOn } from './build-city/admin.js';

const targetOid = process.argv[2] ?? '';
if (!targetOid) {
  console.error('usage: pnpm tsx scripts/inspect-skills.ts <oid>');
  process.exit(2);
}

const client = new SwgClient({ loginServer: { host: '10.254.0.253', port: 44453 } });
await client.fullLifecycle({
  account: 'tslive07',
  characterName: 'Inspector',
  planet: 'mos_eisley',
  holdZonedInMs: 5_000,
  script: async (ctx) => {
    await ctx.wait(2_000);
    await adminGodModeOn(ctx);
    await ctx.wait(500);
    console.log('=== skill getSkillList ' + targetOid + ' ===');
    const skills = await adminConsole(ctx, 'skill getSkillList ' + targetOid, { timeoutMs: 8_000 });
    console.log(skills);
    console.log('=== skill getCommandList ' + targetOid + ' ===');
    const cmds = await adminConsole(ctx, 'skill getCommandList ' + targetOid, { timeoutMs: 8_000 });
    console.log(cmds);
    console.log('=== skill getSkillMods ' + targetOid + ' ===');
    const mods = await adminConsole(ctx, 'skill getSkillMods ' + targetOid, { timeoutMs: 8_000 });
    console.log(mods);
    await ctx.logout();
  },
});
