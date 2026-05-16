import { describe, expect, it } from 'vitest';
import { ReadIterator } from '../../archive/read-iterator.js';
import { ClientOpenContainerMessage } from '../../messages/game/client-open-container.js';
import {
  CLIENT_TO_AUTH_SERVER_FLAGS,
  CM_COMMAND_QUEUE_ENQUEUE,
  CommandQueueEnqueue,
  hashCommand,
} from '../../messages/game/command-queue/index.js';
import { HeartBeat } from '../../messages/game/heart-beat.js';
import { LogoutMessage } from '../../messages/game/logout-message.js';
import { ObjControllerMessage } from '../../messages/game/obj-controller-message.js';
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

describe('ScriptContext: combat / command-queue primitives', () => {
  it('useAbility sends one ObjControllerMessage with the right CM subtype and inner enqueue', () => {
    const playerId = 0x100n;
    const { ctx, sent } = createFakeContext({ playerNetworkId: playerId });
    const seq = ctx.useAbility('attack', 0x42n);
    expect(seq).toBe(1);
    expect(sent.length).toBe(1);
    const wrapped = sent[0];
    expect(wrapped).toBeInstanceOf(ObjControllerMessage);
    const obj = wrapped as ObjControllerMessage;
    expect(obj.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    expect(obj.flags).toBe(CLIENT_TO_AUTH_SERVER_FLAGS);
    expect(obj.networkId).toBe(playerId);

    const inner = CommandQueueEnqueue.unpack(new ReadIterator(obj.data));
    expect(inner.sequenceId).toBe(1);
    expect(inner.commandHash).toBe(hashCommand('attack'));
    expect(inner.targetId).toBe(0x42n);
    expect(inner.params).toBe('');
  });

  it('useAbility increments the sequence counter (separate from movement)', () => {
    const { ctx } = createFakeContext();
    expect(ctx.useAbility('attack', 0x42n)).toBe(1);
    expect(ctx.useAbility('attack', 0x42n)).toBe(2);
    expect(ctx.useAbility('prone')).toBe(3);
    // Movement sequence should be untouched.
    expect(ctx.nextSequenceNumber()).toBe(1);
  });

  it('useAbility defaults targetId to 0n (NO_TARGET) and params to ""', () => {
    const { ctx, sent } = createFakeContext();
    ctx.useAbility('prone');
    const inner = CommandQueueEnqueue.unpack(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    expect(inner.targetId).toBe(0n);
    expect(inner.params).toBe('');
  });

  it('useAbility passes custom params through (e.g. ability arguments)', () => {
    const { ctx, sent } = createFakeContext();
    ctx.useAbility('macro', 0n, 'some-args');
    const inner = CommandQueueEnqueue.unpack(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    expect(inner.params).toBe('some-args');
  });

  it('attackTarget is sugar for useAbility("attack", target)', () => {
    const { ctx, sent } = createFakeContext();
    ctx.attackTarget(0xc0den);
    const inner = CommandQueueEnqueue.unpack(
      new ReadIterator((sent[0] as ObjControllerMessage).data),
    );
    expect(inner.commandHash).toBe(hashCommand('attack'));
    expect(inner.targetId).toBe(0xc0den);
  });

  it('changePosture maps friendly names to server command names', () => {
    const { ctx, sent } = createFakeContext();
    ctx.changePosture('standing');
    ctx.changePosture('crouched');
    ctx.changePosture('prone');
    ctx.changePosture('sitting');
    const expectedCommands = ['stand', 'crouch', 'prone', 'sit'];
    for (let i = 0; i < 4; i++) {
      const m = sent[i];
      if (!(m instanceof ObjControllerMessage)) throw new Error('not ObjControllerMessage');
      const inner = CommandQueueEnqueue.unpack(new ReadIterator(m.data));
      expect(inner.commandHash).toBe(hashCommand(expectedCommands[i] as string));
      // No target for postures.
      expect(inner.targetId).toBe(0n);
    }
  });

  it('nextCommandSequence returns sequential values starting from 1', () => {
    const { ctx } = createFakeContext();
    expect(ctx.nextCommandSequence()).toBe(1);
    expect(ctx.nextCommandSequence()).toBe(2);
    expect(ctx.nextCommandSequence()).toBe(3);
  });

  it('combat sends count toward sendsCount', async () => {
    const { ctx } = createFakeContext();
    const result = await runScript(async (c) => {
      c.attackTarget(0x42n);
      c.attackTarget(0x42n);
      c.changePosture('prone');
    }, ctx);
    expect(result.sendsCount).toBe(3);
  });
});
