import { describe, expect, it } from 'vitest';
import { ClientOpenContainerMessage } from '../../messages/game/client-open-container.js';
import { HeartBeat } from '../../messages/game/heart-beat.js';
import { LogoutMessage } from '../../messages/game/logout-message.js';
import { didScriptLogout, runScript } from './context.js';
import { createFakeContext } from './test-helpers.js';

describe('ScriptContext', () => {
  it('wait() resolves after the requested delay', async () => {
    const { ctx } = createFakeContext();
    const t0 = Date.now();
    await ctx.wait(80);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(60); // allow some scheduler slack
  });

  it('wait() rejects when the signal aborts', async () => {
    const { ctx, abort } = createFakeContext();
    const p = ctx.wait(10_000);
    setTimeout(() => abort(), 20);
    await expect(p).rejects.toThrow(/aborted/);
  });

  it('openPlayerInventory sends ClientOpenContainerMessage(player, "inventory")', () => {
    const playerId = 0x42n;
    const { ctx, sent } = createFakeContext({ playerNetworkId: playerId });
    ctx.openPlayerInventory();
    expect(sent.length).toBe(1);
    const m = sent[0];
    expect(m).toBeInstanceOf(ClientOpenContainerMessage);
    const c = m as ClientOpenContainerMessage;
    expect(c.containerId).toBe(playerId);
    expect(c.slot).toBe('inventory');
  });

  it('openContainer with explicit slot works', () => {
    const { ctx, sent } = createFakeContext();
    ctx.openContainer(0xabcn, 'bank_1');
    const c = sent[0] as ClientOpenContainerMessage;
    expect(c.slot).toBe('bank_1');
    expect(c.containerId).toBe(0xabcn);
  });

  it('closeContainer emits nothing on the wire', () => {
    const { ctx, sent } = createFakeContext();
    ctx.closeContainer(0x42n);
    expect(sent).toHaveLength(0);
  });

  it('send() escape hatch counts toward sendsCount', async () => {
    const { ctx } = createFakeContext();
    const result = await runScript(async (c) => {
      c.send(new HeartBeat());
      c.send(new HeartBeat());
    }, ctx);
    expect(result.sendsCount).toBe(2);
    expect(result.didLogout).toBe(false);
  });

  it('logout() sends LogoutMessage and marks didLogout', async () => {
    const { ctx, sent } = createFakeContext();
    const result = await runScript(async (c) => {
      await c.logout();
    }, ctx);
    expect(sent.some((m) => m instanceof LogoutMessage)).toBe(true);
    expect(result.didLogout).toBe(true);
    expect(didScriptLogout(ctx)).toBe(true);
  });

  it('runScript captures thrown errors instead of rethrowing', async () => {
    const { ctx } = createFakeContext();
    const result = await runScript(async () => {
      throw new Error('boom');
    }, ctx);
    expect(result.error).toBe('boom');
  });
});
