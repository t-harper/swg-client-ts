import { describe, expect, it } from 'vitest';
import { CmdSceneReady } from '../../messages/game/cmd-scene-ready.js';
import { HeartBeat } from '../../messages/game/heart-beat.js';
import { LogoutMessage } from '../../messages/game/logout-message.js';
import { runScript } from './context.js';
import { createFakeContext } from './test-helpers.js';

describe('expectWithin', () => {
  it('resolves with the message when a matching one arrives', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    const p = ctx.expectWithin(HeartBeat, 1_000);
    // Schedule the recv on the next macrotask so the waiter is registered first.
    setTimeout(() => simulateRecv(new HeartBeat()), 5);
    const m = await p;
    expect(m).toBeInstanceOf(HeartBeat);
  });

  it('rejects with "Timed out after Nms waiting for X" when no match arrives', async () => {
    const { ctx } = createFakeContext();
    await expect(ctx.expectWithin(HeartBeat, 30)).rejects.toThrow(
      /Timed out after 30ms waiting for HeartBeat/,
    );
  });

  it('soft mode resolves to the message on success (not undefined)', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    const p = ctx.expectWithin(HeartBeat, 1_000, { soft: true });
    setTimeout(() => simulateRecv(new HeartBeat()), 5);
    const m = await p;
    expect(m).toBeInstanceOf(HeartBeat);
  });

  it('soft mode resolves to undefined on timeout instead of throwing', async () => {
    const { ctx } = createFakeContext();
    const m = await ctx.expectWithin(HeartBeat, 30, { soft: true });
    expect(m).toBeUndefined();
  });

  it('predicate filters matching messages', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    // Pretend we only want a HeartBeat that satisfies a predicate; the first
    // recv should NOT match and we'll fall through to the second.
    let counter = 0;
    const p = ctx.expectWithin(HeartBeat, 200, {
      predicate: () => {
        counter++;
        return counter === 2;
      },
    });
    setTimeout(() => {
      simulateRecv(new HeartBeat()); // counter=1, no match
      simulateRecv(new HeartBeat()); // counter=2, match
    }, 5);
    const m = await p;
    expect(m).toBeInstanceOf(HeartBeat);
    expect(counter).toBe(2);
  });
});

describe('expectAbsent', () => {
  it('resolves after the window if no matching message arrives', async () => {
    const { ctx } = createFakeContext();
    const t0 = Date.now();
    await ctx.expectAbsent(HeartBeat, 40);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });

  it('throws if a matching message arrives during the window', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    const p = ctx.expectAbsent(HeartBeat, 200);
    setTimeout(() => simulateRecv(new HeartBeat()), 10);
    await expect(p).rejects.toThrow(/Expected no HeartBeat within 200ms/);
  });

  it('ignores non-matching messages', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    const p = ctx.expectAbsent(HeartBeat, 50);
    // A LogoutMessage is not a HeartBeat — should NOT trip the assertion.
    setTimeout(() => simulateRecv(new LogoutMessage()), 5);
    await expect(p).resolves.toBeUndefined();
  });

  it('predicate filter — non-matching predicate keeps the window healthy', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    // Predicate rejects everything → the assertion still passes.
    const p = ctx.expectAbsent(HeartBeat, 50, { predicate: () => false });
    setTimeout(() => simulateRecv(new HeartBeat()), 5);
    await expect(p).resolves.toBeUndefined();
  });
});

describe('expectAfter', () => {
  it('runs the trigger first then waits for the matching follow-up', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext();
    let triggerFired = false;
    const p = ctx.expectAfter(
      () => {
        triggerFired = true;
        ctx.send(new HeartBeat()); // trigger sends a HeartBeat
        // After "the server" sees the trigger, schedule a response.
        setTimeout(() => simulateRecv(new CmdSceneReady()), 5);
      },
      CmdSceneReady,
      { withinMs: 200 },
    );
    const m = await p;
    expect(triggerFired).toBe(true);
    expect(m).toBeInstanceOf(CmdSceneReady);
    expect(sent.length).toBe(1);
    expect(sent[0]).toBeInstanceOf(HeartBeat);
  });

  it('rejects when the follow-up never arrives (hard mode)', async () => {
    const { ctx } = createFakeContext();
    const p = ctx.expectAfter(
      () => {
        /* no follow-up */
      },
      CmdSceneReady,
      { withinMs: 30 },
    );
    await expect(p).rejects.toThrow(/Timed out after 30ms waiting for CmdSceneReady/);
  });

  it('soft mode resolves to undefined on timeout', async () => {
    const { ctx } = createFakeContext();
    const m = await ctx.expectAfter(
      () => {
        /* no follow-up */
      },
      CmdSceneReady,
      { withinMs: 30, soft: true },
    );
    expect(m).toBeUndefined();
  });

  it('supports async triggers (Promise return)', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    const p = ctx.expectAfter(
      async () => {
        await new Promise<void>((r) => setTimeout(r, 5));
        simulateRecv(new HeartBeat());
      },
      HeartBeat,
      { withinMs: 200 },
    );
    const m = await p;
    expect(m).toBeInstanceOf(HeartBeat);
  });
});

describe('ctx.fail()', () => {
  it('populates assertionFailures synchronously and does not throw', async () => {
    const { ctx } = createFakeContext();
    expect(ctx.assertionFailures()).toEqual([]);
    ctx.fail('the thing did not happen');
    expect(ctx.assertionFailures()).toEqual(['the thing did not happen']);
    // Run an empty scenario to confirm fail() is not throwing in any sense.
    const result = await runScript(async (c) => {
      c.fail('another reason');
    }, ctx);
    expect(result.error).toBeUndefined();
    expect(result.assertionFailures).toContain('the thing did not happen');
    expect(result.assertionFailures).toContain('another reason');
  });
});

describe('ScriptResult.assertionFailures', () => {
  it('is always present and empty when nothing failed', async () => {
    const { ctx } = createFakeContext();
    const result = await runScript(async () => {
      /* no-op scenario */
    }, ctx);
    expect(result.assertionFailures).toEqual([]);
    expect(Array.isArray(result.assertionFailures)).toBe(true);
  });

  it('accumulates both fail() and soft expectWithin timeouts', async () => {
    const { ctx } = createFakeContext();
    const result = await runScript(async (c) => {
      c.fail('reason-one');
      const m = await c.expectWithin(HeartBeat, 20, { soft: true });
      expect(m).toBeUndefined();
      c.fail('reason-two');
    }, ctx);
    expect(result.error).toBeUndefined();
    expect(result.assertionFailures).toEqual([
      'reason-one',
      'Timed out after 20ms waiting for HeartBeat',
      'reason-two',
    ]);
  });

  it('hard expectWithin timeout populates error, not assertionFailures', async () => {
    const { ctx } = createFakeContext();
    const result = await runScript(async (c) => {
      await c.expectWithin(HeartBeat, 20);
    }, ctx);
    expect(result.error).toMatch(/Timed out after 20ms waiting for HeartBeat/);
    expect(result.assertionFailures).toEqual([]);
  });

  it('expectAbsent failure surfaces as a hard error (in ScriptResult.error)', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    const result = await runScript(async (c) => {
      const p = c.expectAbsent(HeartBeat, 200);
      setTimeout(() => simulateRecv(new HeartBeat()), 5);
      await p;
    }, ctx);
    expect(result.error).toMatch(/Expected no HeartBeat within 200ms/);
    expect(result.assertionFailures).toEqual([]);
  });

  it('soft expectAfter timeout is captured into assertionFailures', async () => {
    const { ctx } = createFakeContext();
    const result = await runScript(async (c) => {
      const m = await c.expectAfter(
        () => {
          /* no follow-up */
        },
        CmdSceneReady,
        { withinMs: 20, soft: true },
      );
      expect(m).toBeUndefined();
    }, ctx);
    expect(result.error).toBeUndefined();
    expect(result.assertionFailures).toEqual([
      'Timed out after 20ms waiting for CmdSceneReady after trigger',
    ]);
  });
});

describe('simulateRecv', () => {
  it('fulfills a waiter when an injected message matches', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    const p = ctx.waitForMessage(HeartBeat, { timeoutMs: 500 });
    simulateRecv(new HeartBeat());
    await expect(p).resolves.toBeInstanceOf(HeartBeat);
  });

  it('ignores messages whose type CRC does not match a waiter', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    const p = ctx.waitForMessage(CmdSceneReady, { timeoutMs: 30 });
    simulateRecv(new HeartBeat()); // wrong type — does not fulfil
    await expect(p).rejects.toThrow(/Timed out/);
  });
});
