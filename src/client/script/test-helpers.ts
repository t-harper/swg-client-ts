/**
 * Test helpers — a minimal fake dispatcher that records sends without
 * touching a real UDP socket, plus a `createFakeContext()` shortcut.
 */

import { encodeMessage } from '../../messages/base.js';
import type { GameNetworkMessage } from '../../messages/interface.js';
import type { NetworkId, SceneStart, Vector3 } from '../../types.js';
import type { MessageDispatcher } from '../dispatcher.js';
import { type ScriptContext, createScriptContext } from './context.js';

export interface FakeContext {
  ctx: ScriptContext;
  /** Every message handed to `dispatcher.send()` (or `ctx.send()`), in order. */
  sent: GameNetworkMessage[];
  /** The raw encoded bytes for each send, parallel to `sent`. */
  sentBytes: Uint8Array[];
  /** Abort the script context's signal (for cancellation tests). */
  abort: () => void;
}

interface FakeContextOptions {
  startPosition?: Vector3;
  startYaw?: number;
  playerNetworkId?: NetworkId;
}

export function createFakeContext(opts: FakeContextOptions = {}): FakeContext {
  const sent: GameNetworkMessage[] = [];
  const sentBytes: Uint8Array[] = [];

  const fakeDispatcher = {
    send(msg: GameNetworkMessage): void {
      sent.push(msg);
      sentBytes.push(encodeMessage(msg));
    },
    waitFor<T extends GameNetworkMessage>(): Promise<T> {
      return new Promise(() => {
        // never resolves — tests that need waitFor should mock it separately
      });
    },
    onMessage(): () => void {
      return () => {
        // no-op
      };
    },
    onAny(): () => void {
      return () => {
        // no-op
      };
    },
    handleAppMessage(): void {
      // no-op
    },
    cancelAllWaiters(): void {
      // no-op
    },
    transcript: [],
    stageLabel: 'test',
  } as unknown as MessageDispatcher;

  const abortController = new AbortController();
  const sceneStart: SceneStart = {
    playerNetworkId: opts.playerNetworkId ?? 0x1234n,
    sceneName: 'tatooine',
    startPosition: opts.startPosition ?? { x: 0, y: 0, z: 0 },
    startYaw: opts.startYaw ?? 0,
    templateName: 'object/creature/player/human_male.iff',
    serverTimeSeconds: 0n,
    serverEpoch: 0,
    disableWorldSnapshot: false,
  };

  const ctx = createScriptContext({
    dispatcher: fakeDispatcher,
    sceneStart,
    signal: abortController.signal,
  });

  return {
    ctx,
    sent,
    sentBytes,
    abort: () => abortController.abort(),
  };
}
