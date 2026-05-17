/**
 * NPC conversation helpers — a state-machine wrapper over the four primitive
 * methods on `ScriptContext` (`talkTo` / `waitForNpcDialog` / `selectDialog` /
 * `endConversation`).
 *
 * Two public entry points:
 *
 *   1. `runNpcConversation(ctx, npcId, path)` — drive a known dialog tree
 *      end-to-end by either option labels (matched against the responses
 *      menu text, case-insensitive substring match) or option indices.
 *      Returns the final NPC prose for inspection.
 *
 *   2. `installNpcDialogTracker(ctx, sink)` — install a passive listener that
 *      keeps `ctx.npc.lastDialog` current. Called once at script context
 *      construction; cleaned up during `runScript` teardown.
 *
 * The dialog tree is driven by the server's responses menu — we don't have
 * any client-side knowledge of the tree shape; each `waitForNpcDialog`
 * returns the current prompt + the menu of choices, and we match the next
 * path entry against them. Throws if any step's path entry doesn't match an
 * available option (with the available options included in the error).
 *
 * Wire: see `~/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CreatureObject_npcConversation.cpp`
 *   - Server pushes `CM_npcConversationMessage(223)` carrying the prompt.
 *   - Server pushes `CM_npcConversationResponses(224)` carrying the menu.
 *   - Client replies with `useAbility('npcConversationSelect', 0n, String(idx))`
 *     to pick the Nth option.
 */

import type { ScriptContext } from './script/context.js';
import { NpcConversationMessageKind } from '../messages/game/npc/npc-conversation-message.js';
import { NpcConversationResponsesKind } from '../messages/game/npc/npc-conversation-responses.js';
import { StopNpcConversationKind } from '../messages/game/npc/stop-npc-conversation.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import { ObjControllerSubtypeIds } from '../messages/game/obj-controller/registry.js';
import type { NetworkId } from '../types.js';

/**
 * What `ctx.npc.lastDialog` exposes — the most recent NPC dialog state the
 * dispatcher has heard about. `null` until the first prompt arrives.
 */
export interface LastNpcDialog {
  /** The NPC's current prompt text. */
  text: string;
  /** Menu option strings; `[]` when the prompt is an auto-advance. */
  options: readonly string[];
}

/**
 * Internal mutable cache for `ctx.npc.lastDialog`. The `NpcConverseTracker`
 * owns it; `ScriptContext.npc.lastDialog` returns a snapshot getter.
 */
export interface NpcDialogSink {
  /** Most-recent dialog; `null` until the first prompt arrives. */
  get value(): LastNpcDialog | null;
  /** Reset the cache (used at detach + at conversation-stop). */
  clear(): void;
}

/**
 * Tracker — passive listener that pairs prompt + responses into
 * `LastNpcDialog` and keeps the sink current.
 *
 * The server emits a prompt (CM_npcConversationMessage) addressed to the
 * player; immediately after, a companion responses message
 * (CM_npcConversationResponses) carries the menu. We hold onto the prompt
 * text in a buffer and flush a fresh `LastNpcDialog` whenever responses
 * arrive — or on a short timeout if responses don't come (auto-advance
 * prompts have an empty menu). At conversation-stop the cache is cleared.
 */
export class NpcConverseTracker {
  private readonly unsubscribers: Array<() => void> = [];
  private detached = false;
  /** Internal cache backing `ctx.npc.lastDialog`. */
  private _value: LastNpcDialog | null = null;
  /** Buffered prompt text — flushed on responses or on auto-advance timeout. */
  private pendingPrompt: string | null = null;
  /** Timer that flushes an unpaired prompt as `{text, options: []}`. */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pairWindowMs: number;

  /**
   * Public read-only sink — `ScriptContext.npc.lastDialog` reads from this.
   */
  readonly sink: NpcDialogSink;

  constructor(
    ctx: ScriptContext,
    opts: { pairWindowMs?: number } = {},
  ) {
    this.pairWindowMs = opts.pairWindowMs ?? 250;
    const self = this;
    this.sink = {
      get value() {
        return self._value;
      },
      clear() {
        self._value = null;
      },
    };

    const playerId = ctx.sceneStart.playerNetworkId;

    this.unsubscribers.push(
      ctx.dispatcher.onMessage(ObjControllerMessage, (m) => {
        if (this.detached) return;
        if (m.networkId !== playerId) return;
        if (
          m.message === ObjControllerSubtypeIds.CM_npcConversationMessage &&
          m.decodedSubtype?.kind === NpcConversationMessageKind
        ) {
          const data = m.decodedSubtype.data as { npcMessage: string };
          this.bufferPrompt(data.npcMessage);
          return;
        }
        if (
          m.message === ObjControllerSubtypeIds.CM_npcConversationResponses &&
          m.decodedSubtype?.kind === NpcConversationResponsesKind
        ) {
          const data = m.decodedSubtype.data as { responses: readonly string[] };
          this.flushWithResponses(data.responses);
          return;
        }
        if (
          m.message === ObjControllerSubtypeIds.CM_npcConversationStop &&
          m.decodedSubtype?.kind === StopNpcConversationKind
        ) {
          this.clearAll();
          return;
        }
      }),
    );
  }

  private bufferPrompt(text: string): void {
    // If we already had a buffered prompt without responses, flush it as
    // auto-advance (options: []) before buffering the new one — otherwise
    // we'd lose history.
    if (this.pendingPrompt !== null) {
      this.flushBuffered([]);
    }
    this.pendingPrompt = text;
    this.scheduleFlush();
  }

  private flushBuffered(responses: readonly string[]): void {
    if (this.pendingPrompt === null) return;
    const prompt = this.pendingPrompt;
    this.pendingPrompt = null;
    this.cancelFlush();
    this._value = { text: prompt, options: [...responses] };
  }

  private flushWithResponses(responses: readonly string[]): void {
    if (this.pendingPrompt !== null) {
      this.flushBuffered(responses);
      return;
    }
    // Responses arrived without a buffered prompt — update only the options
    // on the most-recent value (the prompt is whatever the user last saw).
    if (this._value !== null) {
      this._value = { text: this._value.text, options: [...responses] };
    } else {
      this._value = { text: '', options: [...responses] };
    }
  }

  private scheduleFlush(): void {
    this.cancelFlush();
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushBuffered([]);
    }, this.pairWindowMs);
    this.flushTimer.unref?.();
  }

  private cancelFlush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private clearAll(): void {
    this.cancelFlush();
    this.pendingPrompt = null;
    this._value = null;
  }

  /** Stop listening + clear state. Idempotent. */
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.cancelFlush();
    for (const u of this.unsubscribers.splice(0)) {
      try {
        u();
      } catch {
        // swallow
      }
    }
    this._value = null;
    this.pendingPrompt = null;
  }
}

/**
 * Run a known NPC conversation path end-to-end. `path` is a series of
 * option selectors — either string labels (matched case-insensitively as
 * substrings of the responses-menu text) OR numeric indices.
 *
 * For each step:
 *   1. `waitForNpcDialog` — wait for the next prompt + responses pair.
 *   2. Resolve the next path entry against the available options.
 *   3. `selectDialog(matchedIndex)` — submit the pick.
 *
 * When `path` is exhausted: one final `waitForNpcDialog` is awaited to
 * capture the closing prose, then `endConversation` is sent.
 *
 * Throws (does NOT soft-fail) when any path step doesn't match an
 * available option — the error message includes the failing path entry +
 * the available options, so the caller can fix the script.
 *
 * Returns the final NPC prose text for inspection.
 */
export async function runNpcConversation(
  ctx: ScriptContext,
  npcId: NetworkId,
  path: ReadonlyArray<string | number>,
  opts: { timeoutMs?: number; pairWindowMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const pairWindowMs = opts.pairWindowMs ?? 250;
  const waitOpts: { timeoutMs: number; pairWindowMs: number } = {
    timeoutMs,
    pairWindowMs,
  };

  ctx.talkTo(npcId);

  let finalPrompt = '';

  for (let step = 0; step < path.length; step++) {
    const dialog = await ctx.waitForNpcDialog(waitOpts);
    finalPrompt = dialog.prompt;
    const selector = path[step] as string | number;

    const idx = resolveOptionIndex(selector, dialog.options);
    if (idx === -1) {
      throw new Error(
        `runNpcConversation: step ${step + 1}/${path.length} selector ${describeSelector(selector)} ` +
          `did not match any of [${dialog.options.map((o) => JSON.stringify(o)).join(', ')}] ` +
          `(prompt was ${JSON.stringify(dialog.prompt)})`,
      );
    }
    ctx.selectDialog(idx);
  }

  // After the last selectDialog, wait for the closing prose (best-effort —
  // an "End conversation" path may not produce a final prompt). Then send
  // the stop so the server's state machine cleans up either way.
  try {
    const closing = await ctx.waitForNpcDialog(waitOpts);
    finalPrompt = closing.prompt;
  } catch {
    // No closing prompt arrived in the window — fine, the NPC just ended.
  }

  ctx.endConversation();
  return finalPrompt;
}

/**
 * Map a path selector to an option index. Numeric selectors are returned
 * verbatim (clamped: out-of-range yields -1). String selectors do a
 * case-insensitive substring match against each option; the first match
 * wins.
 *
 * Returns -1 when no match is found.
 */
function resolveOptionIndex(
  selector: string | number,
  options: readonly string[],
): number {
  if (typeof selector === 'number') {
    if (selector < 0 || selector >= options.length) return -1;
    return selector | 0;
  }
  const needle = selector.toLowerCase();
  for (let i = 0; i < options.length; i++) {
    const candidate = (options[i] ?? '').toLowerCase();
    if (candidate.includes(needle)) return i;
  }
  return -1;
}

function describeSelector(s: string | number): string {
  return typeof s === 'number' ? `index ${s}` : `label ${JSON.stringify(s)}`;
}
