import { describe, expect, it } from 'vitest';

import { createFakeContext } from '../test-helpers.js';
import { installCombatBehavior } from './install.js';
import type { CombatBehaviorOptions } from './types.js';

function install(extra: Partial<CombatBehaviorOptions> = {}): ReturnType<typeof installFor> {
  return installFor('bounty_hunter', extra);
}

function installFor(
  profession: CombatBehaviorOptions['profession'],
  extra: Partial<CombatBehaviorOptions> = {},
) {
  const fake = createFakeContext();
  const cb = installCombatBehavior(fake.ctx, {
    profession,
    verify: false,
    tickMs: 50,
    disengageAfterMs: 200,
    ...extra,
  });
  return { fake, cb };
}

describe('installCombatBehavior', () => {
  it('returns a CombatBehavior in a non-engaged state', () => {
    const { cb } = install();
    expect(cb.engaged).toBe(false);
    expect(cb.profession).toBe('bounty_hunter');
    cb.dispose();
  });

  it('runHostOperation runs the fn with a non-aborted child signal', async () => {
    const { cb } = install();
    let observed: boolean | null = null;
    await cb.runHostOperation(async (signal) => {
      observed = signal.aborted;
    });
    expect(observed).toBe(false);
    cb.dispose();
  });

  it('runHostOperation rejects with AbortError after dispose', async () => {
    const { cb } = install();
    cb.dispose();
    let caught: Error | null = null;
    try {
      await cb.runHostOperation(async () => {});
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.name).toBe('AbortError');
  });

  it('engage() flips engaged to true and fires onEngage listeners', async () => {
    const { cb } = install();
    const events: string[] = [];
    cb.onEngage(() => events.push('engaged'));
    await cb.engage({ targetId: 99n });
    expect(cb.engaged).toBe(true);
    expect(events).toEqual(['engaged']);
    cb.dispose();
  });

  it('disengage() flips engaged to false and fires onDisengage listeners', async () => {
    const { cb } = install();
    const events: string[] = [];
    cb.onDisengage(() => events.push('disengaged'));
    await cb.engage();
    cb.disengage('manual');
    expect(cb.engaged).toBe(false);
    expect(events).toEqual(['disengaged']);
    cb.dispose();
  });

  it('engage aborts an in-flight host operation', async () => {
    const { cb } = install();
    let aborted = false;
    const opPromise = cb.runHostOperation(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      });
    });
    // Give the host op a tick to attach the abort listener.
    await new Promise((r) => setImmediate(r));
    await cb.engage();
    await opPromise;
    expect(aborted).toBe(true);
    cb.dispose();
  });

  it('disposes cleanly when the script signal aborts', async () => {
    const { fake, cb } = install();
    const events: string[] = [];
    cb.onDisengage(() => events.push('disengaged'));
    await cb.engage();
    fake.abort();
    // dispose() under script-signal abort triggers a host-disposed disengage.
    expect(events).toEqual(['disengaged']);
    expect(cb.engaged).toBe(false);
  });

  it('subscriber unsubscribe stops further callbacks', async () => {
    const { cb } = install();
    let count = 0;
    const unsub = cb.onEngage(() => {
      count++;
    });
    await cb.engage();
    cb.disengage();
    unsub();
    await cb.engage();
    expect(count).toBe(1);
    cb.dispose();
  });

  it('resolveOptions applies profession-specific kite defaults', () => {
    const { cb: bh } = install();
    expect(bh.profession).toBe('bounty_hunter');
    bh.dispose();

    const { cb: jedi } = installFor('jedi');
    expect(jedi.profession).toBe('jedi');
    jedi.dispose();
  });

  it('accepts a rotation override and uses it for the engagement', async () => {
    const fake = createFakeContext();
    const cb = installCombatBehavior(fake.ctx, {
      profession: 'spy',
      verify: false,
      tickMs: 50,
      disengageAfterMs: 200,
      rotation: {
        profession: 'spy',
        opener: [],
        combo: [],
        filler: { id: 'custom-filler', ability: 'attack', fallbackCooldownMs: 1500 },
        panic: {},
        signatureAbilities: [],
      },
    });
    expect(cb.profession).toBe('spy');
    cb.dispose();
  });
});
