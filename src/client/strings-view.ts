/**
 * StringsView — `ctx.strings` on `ScriptContext`. A thin, stateless wrapper
 * that delegates every lookup to the shared `Knowledge.strings` KB (the
 * process-wide STF table cache).
 *
 * SWG ships localized text as IFF "string table" files under
 * `string/<lang>/<file>.stf`. Wire messages refer to entries by `(file, key)`
 * pairs (chat oob fields, system messages, dialog responses, error chat).
 * The real Windows client loads the table once and resolves on demand; we
 * mirror that — one parse per STF file across the entire process, shared by
 * every `ScriptContext`.
 *
 * The view exposes two entry points: `resolve(file, key)` for single-token
 * lookup, and `resolveFile(file)` for the whole table. Either returns `null`
 * if the file or key isn't present (we deliberately distinguish "missing"
 * from "errored" — propagate the throw on real I/O failures so callers can
 * see the underlying issue).
 *
 * The view holds no state of its own — failed loads are cached (or not)
 * according to the underlying `StringKB` impl's policy. There's no detach
 * handle because there are no subscriptions.
 */

import type { Knowledge } from './knowledge.js';

/**
 * Live STF resolver exposed on `ctx.strings`. Delegates to the shared
 * `Knowledge.strings` KB; the view itself is purely a convenience wrapper
 * with `@file:key` shorthand parsing.
 */
export interface StringsView {
  /**
   * Resolve `(file, key)` to the localized string. Returns `null` if the
   * file or key isn't present.
   *
   * Accepts the in-game `@file:key` shorthand as the first argument with
   * `key` omitted — `resolve('@city/city:declared_residence')` is equivalent
   * to `resolve('city/city', 'declared_residence')`. If both forms are used
   * (i.e. an `@file:key` token AND an explicit `key` arg), the explicit
   * `key` wins.
   *
   * Throws if called with a bare file name and no `:` separator and no
   * explicit `key`. Silent empty-key resolution would be a footgun — STFs
   * use empty keys legitimately for the file's "default" entry and we don't
   * want a caller's typo (`resolve('city/city')` instead of
   * `resolve('city/city', 'declared_residence')`) to silently return that.
   */
  resolve(fileOrToken: string, key?: string): Promise<string | null>;

  /**
   * Resolve a full STF file as a `Map<key, string>`. Returns `null` if the
   * file isn't available. The leading `@` (in-game token form) is stripped
   * if present.
   */
  resolveFile(file: string): Promise<ReadonlyMap<string, string> | null>;
}

export interface StringsViewOptions {
  /**
   * Shared knowledge base — provides the STF file cache. In production this
   * is `defaultKnowledge` (one instance per process); tests construct a fresh
   * `new KnowledgeImpl({ strings: { loadFile, ... } })` to inject loader
   * overrides, or pass a hand-rolled `Knowledge` with a mock `strings`.
   */
  knowledge: Knowledge;
}

/**
 * Build a `StringsView`. The view itself holds no state — every call passes
 * straight through to `opts.knowledge.strings`. Multiple views sharing the
 * same `Knowledge` also share the STF cache.
 */
export function createStringsView(opts: StringsViewOptions): StringsView {
  return {
    async resolve(fileOrToken: string, key?: string): Promise<string | null> {
      const { file: parsedFile, key: parsedKey } = parseToken(fileOrToken);
      // Explicit `key` arg wins over the parsed key from a `@file:key` token.
      const effectiveKey = key ?? parsedKey;
      if (effectiveKey === undefined) {
        throw new Error(
          `StringsView.resolve: missing key — pass an explicit second arg or use the '@file:key' shorthand (got '${fileOrToken}')`,
        );
      }
      return opts.knowledge.strings.resolve(parsedFile, effectiveKey);
    },
    async resolveFile(file: string): Promise<ReadonlyMap<string, string> | null> {
      // resolveFile only cares about the file portion — strip the @ prefix
      // and ignore any `:key` suffix if the caller pasted a full token.
      const { file: parsedFile } = parseToken(file);
      return opts.knowledge.strings.resolveFile(parsedFile);
    },
  };
}

/**
 * Parse a `@file:key` shorthand. Strips the leading `@` if present and
 * splits on the first `:`. Returns `{ file, key: undefined }` if no `:` is
 * found (the caller is expected to supply `key` explicitly in that case).
 */
function parseToken(raw: string): { file: string; key: string | undefined } {
  const stripped = raw.startsWith('@') ? raw.slice(1) : raw;
  const colon = stripped.indexOf(':');
  if (colon === -1) return { file: stripped, key: undefined };
  return { file: stripped.slice(0, colon), key: stripped.slice(colon + 1) };
}
