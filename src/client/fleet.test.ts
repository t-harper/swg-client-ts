/**
 * Unit tests for Fleet. The real SwgClient is replaced with a configurable
 * fake (via `clientFactory`) so no UDP sockets are opened — these are pure
 * orchestration tests.
 */
import { describe, expect, it } from 'vitest';

import { type CharacterInfo, CharacterType, type ClusterInfo, ClusterStatus } from '../types.js';
import type { TranscriptEvent } from './dispatcher.js';
import { Fleet, type FleetClientConfig, type FleetOptions, type FleetRunOptions } from './fleet.js';
import type {
  FullLifecycleOptions,
  LifecycleResult,
  SwgClient,
  SwgClientOptions,
} from './swg-client.js';

interface FakeScript {
  account: string;
  delayMs?: number;
  fail?: Error;
  transcriptOverride?: TranscriptEvent[];
  receivedErrorMessage?: boolean;
}

function makeCluster(name: string): ClusterInfo {
  return {
    id: 1,
    name,
    timeZone: 0,
    connectionServerAddress: '127.0.0.1',
    connectionServerPort: 44463,
    status: ClusterStatus.Up,
  };
}

function makeCharacter(name: string): CharacterInfo {
  return {
    networkId: 42n,
    name,
    objectTemplateId: 0,
    clusterId: 1,
    characterType: CharacterType.Normal,
  };
}

function makeTranscriptEvent(name: string, direction: 'send' | 'recv', at = 0): TranscriptEvent {
  if (direction === 'send') {
    return { direction: 'send', messageName: name, typeCrc: 0, bytes: 0, at };
  }
  return { direction: 'recv', messageName: name, typeCrc: 0, bytes: 0, at, decoded: null };
}

function makeLifecycle(opts: {
  account: string;
  transcript?: TranscriptEvent[];
  receivedErrorMessage?: boolean;
}): LifecycleResult {
  const cluster = makeCluster('swg');
  const character = makeCharacter(`${opts.account}-char`);
  return {
    stages: { login: 1, connection: 1, game: 1, logout: 0 },
    clusters: [cluster],
    chosenCluster: cluster,
    character,
    characterWasCreated: false,
    baselineObjectCount: 1,
    zonedInAt: new Date(0),
    logoutAt: new Date(0),
    transcript: opts.transcript ?? [],
    stationId: 1,
    receivedErrorMessage: opts.receivedErrorMessage ?? false,
  };
}

/**
 * Build a Fleet whose client factory returns a fake whose `fullLifecycle`
 * looks up its behavior in the provided script map by `account`.
 */
function fleetWithFakes(
  scripts: FakeScript[],
  overrides: Partial<FleetOptions> = {},
): {
  fleet: Fleet;
  openCount: () => number;
  concurrent: () => number;
  peakConcurrent: () => number;
} {
  const byAccount = new Map<string, FakeScript>(scripts.map((s) => [s.account, s]));
  let openCount = 0;
  let concurrent = 0;
  let peak = 0;

  const factory = (loginServer: SwgClientOptions): SwgClient => {
    void loginServer;
    openCount++;
    const fake = {
      async fullLifecycle(o: FullLifecycleOptions): Promise<LifecycleResult> {
        concurrent++;
        if (concurrent > peak) peak = concurrent;
        try {
          const script = byAccount.get(o.account);
          if (script === undefined) {
            throw new Error(`No fake script for ${o.account}`);
          }
          if (script.delayMs !== undefined && script.delayMs > 0) {
            await new Promise<void>((res) => {
              const t = setTimeout(res, script.delayMs);
              t.unref?.();
            });
          }
          if (script.fail !== undefined) throw script.fail;
          return makeLifecycle({
            account: script.account,
            transcript: script.transcriptOverride,
            receivedErrorMessage: script.receivedErrorMessage,
          });
        } finally {
          concurrent--;
        }
      },
    } as unknown as SwgClient;
    return fake;
  };

  const fleet = new Fleet({
    loginServer: { host: '127.0.0.1', port: 44453 },
    clientFactory: factory,
    ...overrides,
  });
  return {
    fleet,
    openCount: () => openCount,
    concurrent: () => concurrent,
    peakConcurrent: () => peak,
  };
}

function configs(...accounts: string[]): FleetClientConfig[] {
  return accounts.map((account) => ({ account, characterName: `${account}-char` }));
}

describe('Fleet', () => {
  it('runs all clients in parallel by default', async () => {
    const accounts = ['a', 'b', 'c', 'd', 'e'];
    const { fleet, peakConcurrent } = fleetWithFakes(
      accounts.map((a) => ({ account: a, delayMs: 25 })),
    );

    const result = await fleet.run(configs(...accounts));
    expect(result.outcomes).toHaveLength(5);
    expect(result.summary.totalClients).toBe(5);
    expect(result.summary.succeeded).toBe(5);
    expect(result.summary.failed).toBe(0);
    // All 5 should have been in flight at the same time.
    expect(peakConcurrent()).toBe(5);
  });

  it('preserves outcome order matching input order', async () => {
    const accounts = ['alpha', 'bravo', 'charlie', 'delta'];
    const { fleet } = fleetWithFakes(
      // Stagger fake delays so completion order != launch order
      accounts.map((a, i) => ({ account: a, delayMs: (accounts.length - i) * 10 })),
    );
    const result = await fleet.run(configs(...accounts));
    expect(result.outcomes.map((o) => o.config.account)).toEqual(accounts);
  });

  it('caps concurrency with maxConcurrent', async () => {
    const accounts = ['a', 'b', 'c', 'd', 'e', 'f'];
    const { fleet, peakConcurrent } = fleetWithFakes(
      accounts.map((a) => ({ account: a, delayMs: 30 })),
    );
    const result = await fleet.run(configs(...accounts), { maxConcurrent: 2 });
    expect(result.summary.succeeded).toBe(6);
    // Should never have more than 2 in flight at once.
    expect(peakConcurrent()).toBeLessThanOrEqual(2);
    expect(peakConcurrent()).toBeGreaterThanOrEqual(1);
  });

  it('staggers launches by staggerMs', async () => {
    const accounts = ['a', 'b', 'c'];
    const { fleet } = fleetWithFakes(accounts.map((a) => ({ account: a, delayMs: 1 })));
    const opts: FleetRunOptions = { staggerMs: 40 };
    const start = Date.now();
    await fleet.run(configs(...accounts), opts);
    const elapsed = Date.now() - start;
    // 3 launches at 0, 40, 80 ms — plus the trailing fake delay. Expect at least ~80ms.
    expect(elapsed).toBeGreaterThanOrEqual(75);
  });

  it('captures per-client errors without aborting the rest', async () => {
    const { fleet } = fleetWithFakes([
      { account: 'good-1', delayMs: 5 },
      { account: 'bad-1', delayMs: 5, fail: new Error('boom-1') },
      { account: 'good-2', delayMs: 5 },
      { account: 'bad-2', delayMs: 5, fail: new Error('boom-2') },
    ]);
    const result = await fleet.run(configs('good-1', 'bad-1', 'good-2', 'bad-2'));
    expect(result.summary.totalClients).toBe(4);
    expect(result.summary.succeeded).toBe(2);
    expect(result.summary.failed).toBe(2);

    expect(result.outcomes[0]?.error).toBeUndefined();
    expect(result.outcomes[0]?.lifecycleResult).toBeDefined();
    expect(result.outcomes[1]?.error?.message).toBe('boom-1');
    expect(result.outcomes[1]?.lifecycleResult).toBeUndefined();
    expect(result.outcomes[2]?.lifecycleResult).toBeDefined();
    expect(result.outcomes[3]?.error?.message).toBe('boom-2');

    expect(result.summary.errorMessages).toEqual(['boom-1', 'boom-2']);
  });

  it('coerces non-Error throws into Error', async () => {
    const { fleet } = fleetWithFakes([
      // We bypass typescript by forcing a string-like rejection.
      { account: 'x', fail: 'string-thrown' as unknown as Error },
    ]);
    const result = await fleet.run(configs('x'));
    expect(result.summary.failed).toBe(1);
    expect(result.outcomes[0]?.error).toBeInstanceOf(Error);
    expect(result.outcomes[0]?.error?.message).toBe('string-thrown');
  });

  it('aggregates per-message-name counts across clients', async () => {
    const t1: TranscriptEvent[] = [
      makeTranscriptEvent('LoginClientId', 'send'),
      makeTranscriptEvent('LoginEnumCluster', 'recv'),
      makeTranscriptEvent('UpdateTransformMessage', 'send'),
      makeTranscriptEvent('UpdateTransformMessage', 'send'),
    ];
    const t2: TranscriptEvent[] = [
      makeTranscriptEvent('LoginClientId', 'send'),
      makeTranscriptEvent('UpdateTransformMessage', 'send'),
      makeTranscriptEvent('LoginEnumCluster', 'recv'),
      makeTranscriptEvent('ErrorMessage', 'recv'),
    ];

    const { fleet } = fleetWithFakes([
      { account: 'a', transcriptOverride: t1 },
      { account: 'b', transcriptOverride: t2, receivedErrorMessage: true },
    ]);
    const result = await fleet.run(configs('a', 'b'));

    expect(result.summary.messageCounts.LoginClientId).toEqual({ sent: 2, recv: 0 });
    expect(result.summary.messageCounts.LoginEnumCluster).toEqual({ sent: 0, recv: 2 });
    expect(result.summary.messageCounts.UpdateTransformMessage).toEqual({ sent: 3, recv: 0 });
    expect(result.summary.messageCounts.ErrorMessage).toEqual({ sent: 0, recv: 1 });
    expect(result.summary.totalUpdateTransformsSent).toBe(3);
    expect(result.summary.clientsWithErrorMessage).toBe(1);
  });

  it('summary totalElapsedMs is the max, cumulative is the sum', async () => {
    const { fleet } = fleetWithFakes([
      { account: 'short', delayMs: 10 },
      { account: 'long', delayMs: 60 },
    ]);
    const result = await fleet.run(configs('short', 'long'));
    expect(result.summary.totalElapsedMs).toBeGreaterThanOrEqual(50);
    expect(result.summary.cumulativeElapsedMs).toBeGreaterThanOrEqual(
      result.summary.totalElapsedMs,
    );
  });

  it('opens a fresh SwgClient instance per config', async () => {
    const { fleet, openCount } = fleetWithFakes([
      { account: 'a' },
      { account: 'b' },
      { account: 'c' },
    ]);
    await fleet.run(configs('a', 'b', 'c'));
    expect(openCount()).toBe(3);
  });

  it('forwards all config fields including `script` to fullLifecycle', async () => {
    let captured: FullLifecycleOptions | undefined;
    const factory = (): SwgClient =>
      ({
        async fullLifecycle(o: FullLifecycleOptions): Promise<LifecycleResult> {
          captured = o;
          return makeLifecycle({ account: o.account });
        },
      }) as unknown as SwgClient;

    const fleet = new Fleet({
      loginServer: { host: '127.0.0.1', port: 44453 },
      clientFactory: factory,
    });

    const noop = async (): Promise<void> => {};
    await fleet.run([
      {
        account: 'alpha',
        characterName: 'AlphaChar',
        password: 'pw',
        clusterName: 'swg',
        planet: 'mos_eisley',
        profession: 'jedi',
        holdZonedInMs: 1234,
        skipGameStage: true,
        script: noop,
      },
    ]);
    expect(captured).toBeDefined();
    expect(captured?.account).toBe('alpha');
    expect(captured?.characterName).toBe('AlphaChar');
    expect(captured?.password).toBe('pw');
    expect(captured?.clusterName).toBe('swg');
    expect(captured?.planet).toBe('mos_eisley');
    expect(captured?.profession).toBe('jedi');
    expect(captured?.holdZonedInMs).toBe(1234);
    expect(captured?.skipGameStage).toBe(true);
    // `script` is forwarded now that FullLifecycleOptions accepts it.
    expect(captured?.script).toBe(noop);
  });

  it('handles an empty config list', async () => {
    const { fleet } = fleetWithFakes([]);
    const result = await fleet.run([]);
    expect(result.outcomes).toHaveLength(0);
    expect(result.summary.totalClients).toBe(0);
    expect(result.summary.succeeded).toBe(0);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.totalElapsedMs).toBe(0);
  });

  it('handles a single-client run', async () => {
    const { fleet } = fleetWithFakes([{ account: 'solo', delayMs: 5 }]);
    const result = await fleet.run(configs('solo'));
    expect(result.outcomes).toHaveLength(1);
    expect(result.summary.succeeded).toBe(1);
  });
});
