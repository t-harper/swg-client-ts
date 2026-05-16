/**
 * Unit tests for the replay harness.
 *
 * Stub-driven (no live server required):
 *   - `replayScenario` decodes captured send bytes, re-encodes them, and
 *     verifies the encoded bytes match the original (lossless round-trip).
 *   - `replayScenario` skips events before CmdSceneReady, calls `ctx.logout()`
 *     for captured LogoutMessage events, and otherwise calls `ctx.send()`.
 *   - `replayScenario(pacing='asCaptured')` waits between events.
 *   - `compareNames` produces correct missing/unexpected sets for both
 *     strategies.
 */
import { describe, expect, it } from 'vitest';

import { encodeMessage } from '../messages/base.js';
import { CmdSceneReady } from '../messages/game/cmd-scene-ready.js';
import { HeartBeat } from '../messages/game/heart-beat.js';
import { LogoutMessage } from '../messages/game/logout-message.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import type { MessageDispatcher } from './dispatcher.js';
import { type ReplayScriptContext, compareNames, replayScenario } from './replay.js';
import type { CapturedEvent } from './transcript-io.js';

// Side-effect: register message decoders we exercise.
import '../messages/game/cmd-scene-ready.js';
import '../messages/game/heart-beat.js';
import '../messages/game/logout-message.js';

interface RecordedSend {
  name: string;
  bytes: Uint8Array;
}

function makeStubContext(): {
  ctx: ReplayScriptContext;
  sends: RecordedSend[];
  waits: number[];
  logoutCalls: { current: number };
} {
  const sends: RecordedSend[] = [];
  const waits: number[] = [];
  const logoutCalls = { current: 0 };
  const controller = new AbortController();
  const ctx: ReplayScriptContext = {
    dispatcher: {} as MessageDispatcher,
    signal: controller.signal,
    send(msg: GameNetworkMessage) {
      const ctor = msg.constructor as unknown as { messageName: string };
      sends.push({ name: ctor.messageName, bytes: encodeMessage(msg) });
    },
    wait(ms) {
      waits.push(ms);
      return Promise.resolve();
    },
    logout: async () => {
      logoutCalls.current++;
    },
  };
  return { ctx, sends, waits, logoutCalls };
}

describe('replayScenario', () => {
  it('decodes captured send bytes back to typed messages and re-sends them', async () => {
    const heartBeat = new HeartBeat();
    const sceneReady = new CmdSceneReady();
    const capture: CapturedEvent[] = [
      // Pre-scene-ready sends are skipped
      {
        direction: 'send',
        messageName: 'CmdSceneReady',
        typeCrc: CmdSceneReady.typeCrc,
        payload: encodeMessage(sceneReady),
        at: 100,
      },
      // Post-scene-ready sends are replayed
      {
        direction: 'send',
        messageName: 'HeartBeat',
        typeCrc: HeartBeat.typeCrc,
        payload: encodeMessage(heartBeat),
        at: 200,
      },
      {
        direction: 'send',
        messageName: 'HeartBeat',
        typeCrc: HeartBeat.typeCrc,
        payload: encodeMessage(heartBeat),
        at: 300,
      },
    ];

    const scenario = replayScenario({ capture });
    const stub = makeStubContext();
    await scenario(stub.ctx);

    // Both HeartBeats were sent, CmdSceneReady was NOT re-sent.
    expect(stub.sends.map((s) => s.name)).toEqual(['HeartBeat', 'HeartBeat']);
    // Re-encoded bytes match the original captured payload (round-trip).
    expect(Array.from(stub.sends[0]?.bytes ?? new Uint8Array())).toEqual(
      Array.from(encodeMessage(heartBeat)),
    );
    expect(Array.from(stub.sends[1]?.bytes ?? new Uint8Array())).toEqual(
      Array.from(encodeMessage(heartBeat)),
    );
    // 'asFast' pacing (default) — no waits between sends
    expect(stub.waits).toEqual([]);
  });

  it('LogoutMessage triggers ctx.logout() not ctx.send()', async () => {
    const capture: CapturedEvent[] = [
      {
        direction: 'send',
        messageName: 'CmdSceneReady',
        typeCrc: CmdSceneReady.typeCrc,
        payload: encodeMessage(new CmdSceneReady()),
        at: 100,
      },
      {
        direction: 'send',
        messageName: 'LogoutMessage',
        typeCrc: LogoutMessage.typeCrc,
        payload: encodeMessage(new LogoutMessage()),
        at: 200,
      },
    ];
    const scenario = replayScenario({ capture });
    const stub = makeStubContext();
    await scenario(stub.ctx);
    expect(stub.logoutCalls.current).toBe(1);
    expect(stub.sends.length).toBe(0); // logout did not also call send()
  });

  it("'asCaptured' pacing introduces waits matching the captured deltas", async () => {
    const capture: CapturedEvent[] = [
      {
        direction: 'send',
        messageName: 'CmdSceneReady',
        typeCrc: CmdSceneReady.typeCrc,
        payload: encodeMessage(new CmdSceneReady()),
        at: 1000,
      },
      {
        direction: 'send',
        messageName: 'HeartBeat',
        typeCrc: HeartBeat.typeCrc,
        payload: encodeMessage(new HeartBeat()),
        at: 1500,
      },
      {
        direction: 'send',
        messageName: 'HeartBeat',
        typeCrc: HeartBeat.typeCrc,
        payload: encodeMessage(new HeartBeat()),
        at: 1750,
      },
    ];
    const scenario = replayScenario({ capture, pacing: 'asCaptured' });
    const stub = makeStubContext();
    await scenario(stub.ctx);
    // First post-CmdSceneReady event has no prevAt — no wait
    // Second event: 1750 - 1500 = 250
    expect(stub.waits).toEqual([250]);
  });

  it('falls back to all sends when no CmdSceneReady is in the capture', async () => {
    const capture: CapturedEvent[] = [
      {
        direction: 'send',
        messageName: 'HeartBeat',
        typeCrc: HeartBeat.typeCrc,
        payload: encodeMessage(new HeartBeat()),
        at: 100,
      },
    ];
    const scenario = replayScenario({ capture });
    const stub = makeStubContext();
    await scenario(stub.ctx);
    expect(stub.sends.map((s) => s.name)).toEqual(['HeartBeat']);
  });

  it('skips captured sends with unknown CRC (returns null from decode)', async () => {
    // Construct a fake payload with a bogus CRC the registry won't know.
    const bogusPayload = new Uint8Array([0x01, 0x00, 0xef, 0xbe, 0xad, 0xde]);
    const capture: CapturedEvent[] = [
      {
        direction: 'send',
        messageName: 'CmdSceneReady',
        typeCrc: CmdSceneReady.typeCrc,
        payload: encodeMessage(new CmdSceneReady()),
        at: 100,
      },
      {
        direction: 'send',
        messageName: '<crc:0xdeadbeef>',
        typeCrc: 0xdeadbeef,
        payload: bogusPayload,
        at: 200,
      },
      {
        direction: 'send',
        messageName: 'HeartBeat',
        typeCrc: HeartBeat.typeCrc,
        payload: encodeMessage(new HeartBeat()),
        at: 300,
      },
    ];
    const scenario = replayScenario({ capture });
    const stub = makeStubContext();
    await scenario(stub.ctx);
    // Bogus was skipped, HeartBeat was sent
    expect(stub.sends.map((s) => s.name)).toEqual(['HeartBeat']);
  });

  it('aborts immediately if signal is aborted', async () => {
    const capture: CapturedEvent[] = [
      {
        direction: 'send',
        messageName: 'CmdSceneReady',
        typeCrc: CmdSceneReady.typeCrc,
        payload: encodeMessage(new CmdSceneReady()),
        at: 100,
      },
      {
        direction: 'send',
        messageName: 'HeartBeat',
        typeCrc: HeartBeat.typeCrc,
        payload: encodeMessage(new HeartBeat()),
        at: 200,
      },
    ];
    const scenario = replayScenario({ capture });
    const stub = makeStubContext();
    // Replace the signal with an already-aborted one
    (stub.ctx as unknown as { signal: AbortSignal }).signal = AbortSignal.abort();
    await scenario(stub.ctx);
    expect(stub.sends.length).toBe(0);
  });
});

describe('compareNames', () => {
  describe("strategy='names'", () => {
    it('reports missing names that never appear in observed', () => {
      const { missing, unexpected } = compareNames(['A', 'B', 'C'], ['A', 'C'], 'names');
      expect(missing).toEqual(['B']);
      expect(unexpected).toEqual([]);
    });

    it('reports unexpected names that appear in observed but not expected', () => {
      const { missing, unexpected } = compareNames(['A'], ['X', 'A', 'Y'], 'names');
      expect(missing).toEqual([]);
      expect(unexpected.sort()).toEqual(['X', 'Y']);
    });

    it('respects ordering — expected B before A fails if observed has them reversed', () => {
      const { missing, unexpected } = compareNames(['B', 'A'], ['A', 'B'], 'names');
      // The 'B' is consumed; then 'A' must come AFTER 'B' in observed, but it doesn't
      // (the 'A' at index 0 was before 'B' at index 1). So 'A' is missing.
      expect(missing).toEqual(['A']);
      expect(unexpected).toEqual(['A']);
    });

    it('handles duplicates correctly in ordered mode', () => {
      // Expected: A, A, B  observed: A, A, B (perfect)
      let result = compareNames(['A', 'A', 'B'], ['A', 'A', 'B'], 'names');
      expect(result.missing).toEqual([]);
      expect(result.unexpected).toEqual([]);
      // Expected: A, A, B  observed: A, B, A
      // First A consumed at obs[0], second A must come after — obs[2] is A.
      // Cursor advances to 3. Then B must be at >= 3 — not present, missing.
      // obs[1] (B) was unconsumed → unexpected.
      result = compareNames(['A', 'A', 'B'], ['A', 'B', 'A'], 'names');
      expect(result.missing).toEqual(['B']);
      expect(result.unexpected).toEqual(['B']);
    });
  });

  describe("strategy='count'", () => {
    it('reports missing when an expected name is undercount in observed', () => {
      const { missing, unexpected } = compareNames(['A', 'A', 'B'], ['A', 'B'], 'count');
      expect(missing).toEqual(['A']);
      expect(unexpected).toEqual([]);
    });

    it('reports unexpected when observed has more occurrences than expected', () => {
      const { missing, unexpected } = compareNames(['A'], ['A', 'A', 'B'], 'count');
      expect(missing).toEqual([]);
      expect(unexpected.sort()).toEqual(['A', 'B']);
    });

    it('order does not matter for count strategy', () => {
      const { missing, unexpected } = compareNames(['A', 'B'], ['B', 'A'], 'count');
      expect(missing).toEqual([]);
      expect(unexpected).toEqual([]);
    });
  });
});
