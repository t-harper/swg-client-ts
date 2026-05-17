/**
 * SUI auto-responder engine.
 *
 * Tracks the set of currently-displayed SUI pages and lets scripts register
 * standing handlers that match against `SuiPageData` and fire a
 * `SuiEventNotification` reply automatically.
 *
 * Wire path:
 *   - Server pushes `SuiCreatePageMessage` to open a dialog (banker, vendor,
 *     "are you sure?" confirm, "you found X" notification, etc).
 *   - Server pushes `SuiUpdatePageMessage` to mutate widgets on an existing
 *     page (rare in practice — most flows close + re-open).
 *   - Server pushes `SuiForceClosePage` to drop a page from the client side.
 *   - Client replies with `SuiEventNotification(pageId, eventType, returnList)`
 *     identifying which subscribed event fired + what to send back.
 *
 * Usage from a script:
 *
 *   const unsub = ctx.sui.autoRespond(
 *     (page) => /found a rare/.test(page.pageName),
 *     'ok',
 *   );
 *   // ...later
 *   unsub();
 *
 *   // Inspect what's currently open
 *   for (const p of ctx.sui.active) {
 *     console.log(p.pageId, p.title);
 *   }
 *
 * The engine is hung off the dispatcher's `onMessage` for the three SUI
 * server-push messages. Multiple handlers can be registered; the first one
 * whose `predicate` returns `true` wins for a given page event.
 */

import type { MessageDispatcher } from './dispatcher.js';
import { SuiCreatePageMessage } from '../messages/game/sui/sui-create-page-message.js';
import { SuiEventNotification } from '../messages/game/sui/sui-event-notification.js';
import { SuiForceClosePage } from '../messages/game/sui/sui-force-close-page.js';
import { SuiUpdatePageMessage } from '../messages/game/sui/sui-update-page-message.js';
import type { SuiPageData } from '../messages/game/sui/sui-page-data.js';
import type { NetworkId, Vector3 } from '../types.js';

/**
 * Currently-displayed SUI page surfaced via `ctx.sui.active`. A thin
 * projection over `SuiPageData` that pulls out the conventional "title"
 * widget (`setProperty` on `Prompt.lblPrompt` / `cmp.title.Text` etc.) when
 * present so quick predicates can match by visible text without walking the
 * full command list.
 */
export interface SuiPage {
  /** Server-assigned page id; echoed back via `SuiEventNotification.pageId`. */
  pageId: number;
  /**
   * Best-effort dialog title — the first `setProperty` value targeting a
   * widget whose name suggests a title/prompt. Empty when nothing matches.
   *
   * Heuristic: looks at `setProperty` commands and picks the first that hits
   * `Prompt.lblPrompt`, `cmp.title`, `cmp.prompt`, `title`, or `prompt`
   * (case-insensitive). Falls back to the first `setProperty` value when no
   * known widget name matches.
   */
  title: string;
  /** Full command list — useful for predicates that need to inspect widget data. */
  commands: readonly SuiPageData['commands'][number][];
  /** The object the dialog is associated with (e.g. banker NetworkId). */
  associatedObject: NetworkId;
  /** Associated world location (sentinel: Vector::maxXYZ when unused). */
  associatedLocation: Readonly<Vector3>;
  /** Server-side page-name string (e.g. `'banker.main'`, `'Script.systemMessage'`). */
  pageName: string;
}

/**
 * A canned response shape OR a fully-specified reply. `'ok'` and `'cancel'`
 * map to the conventional `subscribedEventIndex` values used by the
 * banker/vendor/confirm dialogs (event 0 = OK / accept, event 1 = Cancel).
 */
export type SuiAutoResponse =
  | 'ok'
  | 'cancel'
  | { eventType: number; returnList: readonly string[] };

/**
 * Standing handler — a predicate + a response. Registered via
 * `SuiAutoResponder.register(predicate, response)`.
 */
export interface SuiAutoHandler {
  predicate: (page: SuiPageData) => boolean;
  response: SuiAutoResponse;
}

/**
 * Engine instance. One per script context lifetime. Detached during
 * `runScript` cleanup so no SUI auto-responders leak across script runs.
 */
export class SuiAutoResponder {
  private readonly handlers: SuiAutoHandler[] = [];
  private readonly _active = new Map<number, SuiPage>();
  private readonly unsubscribers: Array<() => void> = [];
  private detached = false;

  constructor(private readonly dispatcher: MessageDispatcher) {
    this.unsubscribers.push(
      dispatcher.onMessage(SuiCreatePageMessage, (m) => this.handleCreate(m.pageData)),
    );
    this.unsubscribers.push(
      dispatcher.onMessage(SuiUpdatePageMessage, (m) => this.handleUpdate(m.pageData)),
    );
    this.unsubscribers.push(
      dispatcher.onMessage(SuiForceClosePage, (m) => this.handleClose(m.clientPageId)),
    );
  }

  /**
   * Register a standing handler. First handler whose `predicate` returns
   * `true` for a given page event wins. Returns an unsubscribe fn.
   */
  register(
    predicate: (page: SuiPageData) => boolean,
    response: SuiAutoResponse,
  ): () => void {
    const handler: SuiAutoHandler = { predicate, response };
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  /** Read-only view of currently-displayed pages. */
  get active(): readonly SuiPage[] {
    return Array.from(this._active.values());
  }

  /** Drop all registered handlers and unsubscribe from the dispatcher. Idempotent. */
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    for (const u of this.unsubscribers.splice(0)) {
      try {
        u();
      } catch {
        // swallow
      }
    }
    this.handlers.length = 0;
    this._active.clear();
  }

  private handleCreate(pageData: SuiPageData): void {
    if (this.detached) return;
    this._active.set(pageData.pageId, summarizePage(pageData));
    this.tryAutoRespond(pageData);
  }

  private handleUpdate(pageData: SuiPageData): void {
    if (this.detached) return;
    // Update wasn't always preceded by a Create in our local cache (we may
    // have been attached late). Either way, just refresh the cached entry.
    this._active.set(pageData.pageId, summarizePage(pageData));
    this.tryAutoRespond(pageData);
  }

  private handleClose(pageId: number): void {
    if (this.detached) return;
    this._active.delete(pageId);
  }

  private tryAutoRespond(pageData: SuiPageData): void {
    for (const h of this.handlers) {
      let matched = false;
      try {
        matched = h.predicate(pageData);
      } catch {
        continue;
      }
      if (!matched) continue;
      const reply = resolveResponse(h.response);
      this.dispatcher.send(
        new SuiEventNotification(pageData.pageId, reply.eventType, reply.returnList),
      );
      // First match wins — stop walking handlers.
      return;
    }
  }
}

function resolveResponse(
  r: SuiAutoResponse,
): { eventType: number; returnList: readonly string[] } {
  if (r === 'ok') return { eventType: 0, returnList: [] };
  if (r === 'cancel') return { eventType: 1, returnList: [] };
  return { eventType: r.eventType, returnList: r.returnList };
}

/**
 * Project a `SuiPageData` into a `SuiPage` summary. Pulls a best-effort
 * title out of the command list; preserves the full command list for
 * predicate inspection.
 */
function summarizePage(pageData: SuiPageData): SuiPage {
  let title = '';
  let firstSetPropertyValue = '';

  // Widgets whose properties commonly carry the visible dialog title.
  // Compare case-insensitively against `targetWidget`. The `propertyName`
  // is usually `'Text'` or `'LocalText'`.
  const TITLE_WIDGETS = new Set([
    'prompt.lblprompt',
    'cmp.title',
    'cmp.prompt',
    'title',
    'prompt',
  ]);

  for (const c of pageData.commands) {
    if (c.type !== 'setProperty') continue;
    if (firstSetPropertyValue === '') firstSetPropertyValue = c.propertyValue;
    const widget = c.targetWidget.toLowerCase();
    if (TITLE_WIDGETS.has(widget) && c.propertyValue !== '') {
      title = c.propertyValue;
      break;
    }
  }

  if (title === '') {
    title = firstSetPropertyValue;
  }

  return {
    pageId: pageData.pageId,
    title,
    commands: pageData.commands,
    associatedObject: pageData.associatedObjectId,
    associatedLocation: pageData.associatedLocation,
    pageName: pageData.pageName,
  };
}
