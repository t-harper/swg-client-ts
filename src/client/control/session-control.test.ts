import { describe, expect, it } from 'vitest';
import { createSessionControl } from './session-control.js';

describe('SessionControl — directive machine', () => {
  it('starts in run', () => {
    const sc = createSessionControl();
    expect(sc.directive).toBe('run');
    expect(sc.shouldKeepRunning()).toBe(true);
    expect(sc.isPaused()).toBe(false);
    expect(sc.isTerminal()).toBe(false);
  });

  it('pause then resume', () => {
    const sc = createSessionControl();
    sc.request('paused');
    expect(sc.directive).toBe('paused');
    expect(sc.isPaused()).toBe(true);
    expect(sc.shouldKeepRunning()).toBe(true);
    sc.request('run');
    expect(sc.directive).toBe('run');
  });

  it('reload stops the loop; resetToRun clears it', () => {
    const sc = createSessionControl();
    sc.request('reload');
    expect(sc.directive).toBe('reload');
    expect(sc.shouldKeepRunning()).toBe(false);
    sc.resetToRun();
    expect(sc.directive).toBe('run');
  });

  it('stop is terminal and sticky', () => {
    const sc = createSessionControl();
    sc.request('stop', 'bye');
    expect(sc.directive).toBe('stop');
    expect(sc.isTerminal()).toBe(true);
    expect(sc.reason).toBe('bye');
    sc.request('reload');
    expect(sc.directive).toBe('stop'); // terminal — reload ignored
    sc.resetToRun();
    expect(sc.directive).toBe('stop'); // terminal — not reset
  });

  it('resume cannot cancel a pending reload', () => {
    const sc = createSessionControl();
    sc.request('reload');
    sc.request('run');
    expect(sc.directive).toBe('reload');
  });

  it('pause only takes effect from run', () => {
    const sc = createSessionControl();
    sc.request('reload');
    sc.request('paused');
    expect(sc.directive).toBe('reload');
  });

  it('onChange fires on every transition', () => {
    const sc = createSessionControl();
    const seen: string[] = [];
    sc.onChange((d) => seen.push(d));
    sc.request('paused');
    sc.request('run');
    expect(seen).toEqual(['paused', 'run']);
  });

  it('waitForChange resolves on the next request', async () => {
    const sc = createSessionControl();
    const p = sc.waitForChange();
    sc.request('reload');
    expect(await p).toBe('reload');
  });
});

describe('SessionControl — named actions', () => {
  it('registers, lists, invokes, and unregisters', async () => {
    const sc = createSessionControl();
    const off = sc.registerAction('ping', () => 'pong');
    expect(sc.listActions()).toEqual(['ping']);
    expect(await sc.invokeAction('ping')).toBe('pong');
    off();
    expect(sc.listActions()).toEqual([]);
    await expect(sc.invokeAction('ping')).rejects.toThrow(/no action/);
  });

  it('passes args and awaits async action functions', async () => {
    const sc = createSessionControl();
    sc.registerAction('echo', async (a) => a?.value);
    expect(await sc.invokeAction('echo', { value: 42 })).toBe(42);
  });

  it('clearActions drops every action so a reload starts clean', async () => {
    const sc = createSessionControl();
    sc.registerAction('a', () => 1);
    sc.registerAction('b', () => 2);
    expect(sc.listActions()).toEqual(['a', 'b']);
    sc.clearActions();
    expect(sc.listActions()).toEqual([]);
    await expect(sc.invokeAction('a')).rejects.toThrow(/no action/);
    // A re-imported scenario re-registers its own (possibly different) set.
    sc.registerAction('a', () => 'fresh');
    expect(sc.listActions()).toEqual(['a']);
    expect(await sc.invokeAction('a')).toBe('fresh');
  });
});
