/**
 * In-process coordination primitives for the build-city Fleet phases.
 *
 * The orchestrator runs phases sequentially, and within a phase each Fleet
 * launches N scenarios in parallel. Scenarios within a single Fleet don't
 * need to synchronize with each other (each character does its own work at
 * its own pace), but they all need to wait until their PREREQUISITE phase
 * completed.
 *
 * Cross-phase coordination is handled by state.json (persistent — survives
 * orchestrator crashes). Within-phase coordination can use these in-process
 * barriers if needed for future scenarios that DO need to wait for siblings.
 */

/**
 * Simple count-down latch. Created with `expected` count; each `signal()`
 * call decrements; `wait()` resolves when count hits zero.
 *
 * Example: leader waits for N invitees to signal-ready before issuing the
 * next batch command.
 */
export class CountdownLatch {
  private remaining: number;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];

  constructor(expected: number) {
    if (expected < 0) throw new Error(`CountdownLatch: expected must be ≥0 (got ${expected})`);
    this.remaining = expected;
  }

  /** Decrement the count. If it reaches zero, resolve all waiters. */
  signal(): void {
    if (this.remaining <= 0) return;
    this.remaining--;
    if (this.remaining === 0) {
      const drained = this.waiters.splice(0);
      for (const w of drained) {
        if (w.timer !== null) clearTimeout(w.timer);
        w.resolve();
      }
    }
  }

  /** Force-resolve to zero immediately, releasing all waiters. */
  release(): void {
    this.remaining = 0;
    const drained = this.waiters.splice(0);
    for (const w of drained) {
      if (w.timer !== null) clearTimeout(w.timer);
      w.resolve();
    }
  }

  /**
   * Wait for the count to hit zero. Resolves immediately if already at zero.
   * Rejects on timeout.
   */
  wait(timeoutMs?: number): Promise<void> {
    if (this.remaining === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => {
              const idx = this.waiters.findIndex((w) => w.resolve === resolve);
              if (idx >= 0) this.waiters.splice(idx, 1);
              reject(new Error(`CountdownLatch.wait timed out after ${timeoutMs}ms; remaining=${this.remaining}`));
            }, timeoutMs)
          : null;
      timer?.unref?.();
      this.waiters.push({ resolve, reject, timer });
    });
  }

  /** Read the current remaining count (for diagnostics). */
  get count(): number {
    return this.remaining;
  }
}

/**
 * One-shot gate. `open()` releases all waiters; subsequent waiters resolve
 * immediately. Used as "phase prerequisite met" signal.
 */
export class Gate {
  private opened = false;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];

  open(): void {
    if (this.opened) return;
    this.opened = true;
    const drained = this.waiters.splice(0);
    for (const w of drained) {
      if (w.timer !== null) clearTimeout(w.timer);
      w.resolve();
    }
  }

  fail(err: Error): void {
    const drained = this.waiters.splice(0);
    for (const w of drained) {
      if (w.timer !== null) clearTimeout(w.timer);
      w.reject(err);
    }
  }

  wait(timeoutMs?: number): Promise<void> {
    if (this.opened) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => {
              const idx = this.waiters.findIndex((w) => w.resolve === resolve);
              if (idx >= 0) this.waiters.splice(idx, 1);
              reject(new Error(`Gate.wait timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      timer?.unref?.();
      this.waiters.push({ resolve, reject, timer });
    });
  }

  get isOpen(): boolean {
    return this.opened;
  }
}

/**
 * Limit concurrency on an arbitrary async operation. Like p-limit. Used to
 * cap parallel admin commands so we don't overflow the SOE socket.
 */
export class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (max <= 0) throw new Error(`Semaphore: max must be > 0 (got ${max})`);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  private release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }
}
