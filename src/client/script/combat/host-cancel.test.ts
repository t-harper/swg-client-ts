import { describe, expect, it } from 'vitest';

import { ABORT_ERROR_NAME, createHostCancelGate } from './host-cancel.js';

describe('createHostCancelGate', () => {
  it('runs the host fn with a fresh child signal that is initially not aborted', async () => {
    const scriptController = new AbortController();
    const gate = createHostCancelGate({ scriptSignal: scriptController.signal });
    const signals: AbortSignal[] = [];
    await gate.runHostOperation(async (signal) => {
      signals.push(signal);
      expect(signal.aborted).toBe(false);
    });
    expect(signals).toHaveLength(1);
  });

  it('abortCurrent aborts the in-flight host op with AbortError name', async () => {
    const scriptController = new AbortController();
    const gate = createHostCancelGate({ scriptSignal: scriptController.signal });
    const observed: Array<{ aborted: boolean; reason: string }> = [];
    const opPromise = gate.runHostOperation(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          observed.push({
            aborted: signal.aborted,
            reason: (signal.reason as Error)?.name ?? 'no-name',
          });
          resolve();
        });
      });
    });
    // Tick once so the abort handler attaches.
    await new Promise((r) => setImmediate(r));
    gate.abortCurrent();
    await opPromise;
    expect(observed).toHaveLength(1);
    expect(observed[0]?.aborted).toBe(true);
    expect(observed[0]?.reason).toBe(ABORT_ERROR_NAME);
  });

  it('recycleAfterEngagement gives the next op a fresh non-aborted signal', async () => {
    const scriptController = new AbortController();
    const gate = createHostCancelGate({ scriptSignal: scriptController.signal });

    const firstOp = gate.runHostOperation(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve());
      });
    });
    await new Promise((r) => setImmediate(r));
    gate.abortCurrent();
    await firstOp;

    gate.recycleAfterEngagement();
    let secondSignalAborted: boolean | null = null;
    await gate.runHostOperation(async (signal) => {
      secondSignalAborted = signal.aborted;
    });
    expect(secondSignalAborted).toBe(false);
  });

  it('aborts the host op when the script signal aborts', async () => {
    const scriptController = new AbortController();
    const gate = createHostCancelGate({ scriptSignal: scriptController.signal });
    let observed: boolean | null = null;
    const opPromise = gate.runHostOperation(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          observed = signal.aborted;
          resolve();
        });
      });
    });
    await new Promise((r) => setImmediate(r));
    scriptController.abort();
    await opPromise;
    expect(observed).toBe(true);
    expect(gate.disposed).toBe(true);
  });

  it('throws AbortError synchronously when called after dispose', async () => {
    const scriptController = new AbortController();
    const gate = createHostCancelGate({ scriptSignal: scriptController.signal });
    gate.dispose();
    let caught: Error | null = null;
    try {
      await gate.runHostOperation(async () => {});
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.name).toBe(ABORT_ERROR_NAME);
  });

  it('dispose is idempotent and is a no-op after script abort', () => {
    const scriptController = new AbortController();
    scriptController.abort();
    const gate = createHostCancelGate({ scriptSignal: scriptController.signal });
    expect(gate.disposed).toBe(true);
    gate.dispose();
    expect(gate.disposed).toBe(true);
  });

  it('abortCurrent is a no-op after dispose', () => {
    const scriptController = new AbortController();
    const gate = createHostCancelGate({ scriptSignal: scriptController.signal });
    gate.dispose();
    expect(() => gate.abortCurrent()).not.toThrow();
  });

  it('abortCurrent twice in a row aborts only once (no duplicate calls)', async () => {
    const scriptController = new AbortController();
    const gate = createHostCancelGate({ scriptSignal: scriptController.signal });
    const observed: number[] = [];
    const opPromise = gate.runHostOperation(async (signal) => {
      signal.addEventListener('abort', () => observed.push(1));
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve());
      });
    });
    await new Promise((r) => setImmediate(r));
    gate.abortCurrent();
    gate.abortCurrent();
    await opPromise;
    expect(observed).toEqual([1]);
  });
});
