#!/usr/bin/env node
/**
 * gen-wire-docs — emit a markdown reference for every registered top-level
 * GameNetworkMessage + every ObjController subtype.
 *
 * Run via `pnpm tsx scripts/gen-wire-docs.ts` (no args). Writes to
 * `docs/wire-reference.md`. Intended to run BEFORE `pnpm typedoc` in CI so
 * the docs portal picks up the latest wire-format coverage.
 *
 * Strategy:
 *   1. Import `src/index.js` for the side effects (every message module
 *      self-registers with `messageRegistry` / `objControllerRegistry`).
 *   2. Walk the registries.
 *   3. For every entry, locate its source file under `src/messages/**` and
 *      lift the leading JSDoc comment so we can show a one-liner.
 *   4. Emit two markdown tables (top-level + ObjController), sorted by name.
 *
 * The output is checked-in idempotent: nothing depends on the host's clock,
 * filesystem ordering, etc. — only on the source tree + registries.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Side-effect: every concrete message + obj-controller subtype registers
// itself on import. Using src/index.js ensures we pick up the whole tree.
import '../src/index.js';
import { objControllerRegistry } from '../src/messages/game/obj-controller/registry.js';
import { messageRegistry } from '../src/messages/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const MESSAGES_ROOT = join(REPO_ROOT, 'src', 'messages');
const OUT_FILE = join(REPO_ROOT, 'docs', 'wire-reference.md');

interface SourceIndex {
  /** Map from className → { filePath, leadingJsDoc }. */
  byName: Map<string, { filePath: string; leadingJsDoc: string | null }>;
  /** Map from `kind` (the obj-controller subtype string) → same value. */
  byKind: Map<string, { filePath: string; leadingJsDoc: string | null }>;
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.')) continue;
    const full = join(root, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Read the first leading comment block at the top of a file (before any
 * non-import code). Handles both JSDoc-style (slash-star-star) blocks and a
 * run of single-line comments. Used as the one-liner description.
 */
function extractFileLeadJsDoc(content: string): string | null {
  // Strip a #! shebang if any.
  const noShebang = content.startsWith('#!') ? content.slice(content.indexOf('\n') + 1) : content;
  const block = noShebang.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (block && block[1] !== undefined) {
    return cleanBlockComment(block[1]);
  }
  // Try a run of leading // comments.
  const lines = noShebang.replace(/^﻿/, '').split('\n');
  const collected: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (collected.length > 0) break;
      continue;
    }
    if (trimmed.startsWith('//')) {
      collected.push(trimmed.replace(/^\/\/\s?/, ''));
      continue;
    }
    break;
  }
  if (collected.length === 0) return null;
  return cleanLines(collected);
}

function cleanBlockComment(raw: string): string {
  return cleanLines(raw.split('\n').map((line) => line.replace(/^\s*\*\s?/, '')));
}

function cleanLines(lines: string[]): string {
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Index every source file under `src/messages/**` by:
 *  - any `class Foo extends GameNetworkMessage` declaration
 *  - any `kind: '<string>'` declaration that's likely an ObjController subtype
 *
 * The match doesn't have to be exhaustive — registries provide the real source
 * of truth. This index just exists to bind a registered name back to a comment.
 */
function buildSourceIndex(): SourceIndex {
  const files = listSourceFiles(MESSAGES_ROOT);
  const byName = new Map<string, { filePath: string; leadingJsDoc: string | null }>();
  const byKind = new Map<string, { filePath: string; leadingJsDoc: string | null }>();
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const lead = extractFileLeadJsDoc(content);

    // GameNetworkMessage subclasses — name pulled from the static messageName
    // assignment, the class declaration, or a defineMessageMeta(...) call.
    const classNames = new Set<string>();
    for (const m of content.matchAll(/class\s+(\w+)\s+extends\s+GameNetworkMessage/g)) {
      if (m[1] !== undefined) classNames.add(m[1]);
    }
    const messageNameRe =
      /static\s+(?:override\s+)?readonly\s+messageName\s*=\s*(?:META\.messageName|['"]([^'"]+)['"])/g;
    for (const m of content.matchAll(messageNameRe)) {
      if (m[1] !== undefined) classNames.add(m[1]);
    }
    for (const m of content.matchAll(/defineMessageMeta\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (m[1] !== undefined) classNames.add(m[1]);
    }
    // GenericValueTypeMessage variants — name is the first arg. Allow
    // nested generics in the type parameter (e.g. `<Set<string>>`).
    const genericValueRe = /defineGenericValueTypeMessage(?:<[^(]+>)?\(\s*['"]([^'"]+)['"]/g;
    for (const m of content.matchAll(genericValueRe)) {
      if (m[1] !== undefined) classNames.add(m[1]);
    }
    for (const name of classNames) {
      if (!byName.has(name)) {
        byName.set(name, { filePath: file, leadingJsDoc: lead });
      }
    }

    // ObjController subtype `kind` strings. Two declaration styles:
    //   { kind: 'NetUpdateTransform', ... }       — inline literal
    //   { kind: NetUpdateTransformKind, ... }     — named const declared above
    // For the named-const case we also look for the const definition in the
    // same file (the convention everywhere under obj-controller/).
    const namedKinds = new Map<string, string>();
    const kindConstRe = /export\s+const\s+(\w+Kind)\s*=\s*['"]([A-Za-z_][\w]*)['"]\s*as\s*const/g;
    for (const m of content.matchAll(kindConstRe)) {
      const constName = m[1];
      const value = m[2];
      if (constName !== undefined && value !== undefined) {
        namedKinds.set(constName, value);
      }
    }
    const kindRe = /kind\s*:\s*(?:['"]([A-Za-z_][\w]*)['"]|(\w+Kind))/g;
    for (const m of content.matchAll(kindRe)) {
      const literal = m[1];
      const named = m[2];
      const kind = literal ?? (named !== undefined ? namedKinds.get(named) : undefined);
      if (kind !== undefined && !byKind.has(kind)) {
        byKind.set(kind, { filePath: file, leadingJsDoc: lead });
      }
    }
  }
  return { byName, byKind };
}

function summarizeDoc(doc: string | null, fallback: string): string {
  if (doc === null || doc === '') return fallback;
  // Use the first sentence — period-terminated or em-dash terminated.
  const stop = doc.search(/[.!?](?:\s|$)/);
  const sentence = stop === -1 ? doc : doc.slice(0, stop + 1);
  return sentence.length > 240 ? `${sentence.slice(0, 237)}…` : sentence;
}

function mdEscape(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function hex32(n: number): string {
  return `0x${(n >>> 0).toString(16).padStart(8, '0')}`;
}

function relPath(p: string): string {
  return relative(REPO_ROOT, p).replaceAll('\\', '/');
}

function renderTopLevelTable(index: SourceIndex): string {
  const rows: Array<{ name: string; crc: number; src: string; doc: string }> = [];
  for (const [crc, decoder] of messageRegistry.entries()) {
    const meta = index.byName.get(decoder.messageName);
    const src = meta ? relPath(meta.filePath) : '';
    const doc = summarizeDoc(meta?.leadingJsDoc ?? null, '');
    rows.push({ name: decoder.messageName, crc, src, doc });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  lines.push(`Total registered: **${rows.length}**`);
  lines.push('');
  lines.push('| Message | CRC | Source | Notes |');
  lines.push('|---|---|---|---|');
  for (const r of rows) {
    const srcCell = r.src ? `\`${r.src}\`` : '';
    lines.push(`| \`${r.name}\` | \`${hex32(r.crc)}\` | ${srcCell} | ${mdEscape(r.doc)} |`);
  }
  return lines.join('\n');
}

function renderSubtypeTable(index: SourceIndex): string {
  const rows: Array<{ kind: string; id: number; src: string; doc: string }> = [];
  for (const [id, decoder] of objControllerRegistry.entries()) {
    const meta = index.byKind.get(decoder.kind);
    const src = meta ? relPath(meta.filePath) : '';
    const doc = summarizeDoc(meta?.leadingJsDoc ?? null, '');
    rows.push({ kind: decoder.kind, id, src, doc });
  }
  rows.sort((a, b) => a.id - b.id);
  const lines: string[] = [];
  lines.push(`Total registered: **${rows.length}**`);
  lines.push('');
  lines.push('| Subtype | CM id | Source | Notes |');
  lines.push('|---|---|---|---|');
  for (const r of rows) {
    const srcCell = r.src ? `\`${r.src}\`` : '';
    lines.push(`| \`${r.kind}\` | \`${r.id}\` | ${srcCell} | ${mdEscape(r.doc)} |`);
  }
  return lines.join('\n');
}

function render(): string {
  const index = buildSourceIndex();
  const generatedAt = new Date().toISOString().slice(0, 10);
  return [
    '---',
    'title: Wire-message reference',
    '---',
    '',
    '# Wire-message reference',
    '',
    'Auto-generated from the live `messageRegistry` and `objControllerRegistry`.',
    'Regenerated on every CI build via `scripts/gen-wire-docs.ts` (see',
    '`.github/workflows/docs.yml`). Do not edit by hand.',
    '',
    `_Indexed at ${generatedAt}._`,
    '',
    '## Top-level GameNetworkMessages',
    '',
    'Every concrete `GameNetworkMessage` subclass registered with the global',
    '`messageRegistry`. The on-wire dispatch is by CRC (`constcrc(messageName)`);',
    'the registry is populated as a side effect of importing each module.',
    '',
    renderTopLevelTable(index),
    '',
    '## ObjController subtypes',
    '',
    'Decoders for the trailer of `ObjControllerMessage`. Each entry maps a',
    '`GameControllerMessage` enum value (`CM_*` from',
    '`/home/tharper/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/GameControllerMessage.def`)',
    'to a kind-tagged decoder. Unmodeled subtypes land as opaque trailer bytes',
    'with a diagnostic `subtypeCrcHex`.',
    '',
    renderSubtypeTable(index),
    '',
    '## Adding a new message',
    '',
    'Recipe lives in [`adding-a-message.md`](./adding-a-message.md). Short version:',
    '',
    '1. Find the C++ class under `~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/...`.',
    '2. Count `addVariable()` calls in the ctor (each one is a payload field; `varCount = 1 + N`).',
    '3. Create the matching `src/messages/{login,connection,game}/<kebab-name>.ts`.',
    '4. Round-trip-test it against a captured golden-byte fixture.',
    '',
    'For ObjController subtypes the file lives under `src/messages/game/obj-controller/`',
    'and registers via `registerObjControllerSubtype({ kind, subtypeId, encode, decode })`.',
    '',
  ].join('\n');
}

function main(): void {
  const out = render();
  writeFileSync(OUT_FILE, out, 'utf8');
  process.stderr.write(`Wrote ${relPath(OUT_FILE)}\n`);

  const quickref = renderScriptContextQuickref();
  const quickrefPath = join(REPO_ROOT, 'docs', 'scripting-quickref.md');
  writeFileSync(quickrefPath, quickref, 'utf8');
  process.stderr.write(`Wrote ${relPath(quickrefPath)}\n`);

  const cookbook = renderScenariosCookbook();
  const cookbookPath = join(REPO_ROOT, 'docs', 'scripting-cookbook.md');
  writeFileSync(cookbookPath, cookbook, 'utf8');
  process.stderr.write(`Wrote ${relPath(cookbookPath)}\n`);
}

main();

/**
 * Cheap top-level parser for the `ScriptContext` interface members. We
 * intentionally avoid pulling in the full TypeScript compiler — TypeDoc
 * already does the deep typed extraction for the API site. This helper
 * just produces a quick-scan table for the front-page quickref.
 */
interface ParsedMember {
  doc: string;
  category: string;
  signature: string;
  /** True for `readonly foo: T;` (field-style), false for method-style. */
  isField: boolean;
}

function parseScriptContextMembers(): ParsedMember[] {
  const file = join(REPO_ROOT, 'src', 'client', 'script', 'context.ts');
  const content = readFileSync(file, 'utf8');
  const ifaceStart = content.search(/^export interface ScriptContext\s*\{/m);
  if (ifaceStart === -1) {
    throw new Error('Could not find `export interface ScriptContext {` in context.ts');
  }
  const after = content.slice(ifaceStart);
  let braceDepth = 0;
  let bodyStart = -1;
  let bodyEnd = -1;
  for (let i = 0; i < after.length; i++) {
    const ch = after[i];
    if (ch === '{') {
      if (braceDepth === 0) bodyStart = i + 1;
      braceDepth++;
    } else if (ch === '}') {
      braceDepth--;
      if (braceDepth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }
  if (bodyStart < 0 || bodyEnd < 0) {
    throw new Error('Could not find ScriptContext body braces');
  }
  const body = after.slice(bodyStart, bodyEnd);
  return extractInterfaceMembers(body);
}

/**
 * Token-walk an interface body and return one record per member declaration.
 * Handles nested `{}` (e.g. `opts?: { foo?: number }`), nested generics
 * (e.g. `Promise<Map<NetworkId, T[]>>`), category separators (`// --- Foo ---`),
 * and leading JSDoc blocks attached to each member.
 */
function extractInterfaceMembers(body: string): ParsedMember[] {
  const members: ParsedMember[] = [];
  let i = 0;
  let category = 'Core';
  let pendingDoc = '';
  while (i < body.length) {
    // Skip whitespace.
    while (i < body.length) {
      const c = body[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        i++;
      } else {
        break;
      }
    }
    if (i >= body.length) break;

    // Block comment — capture as pending doc.
    if (body.startsWith('/**', i)) {
      const end = body.indexOf('*/', i + 3);
      if (end === -1) break;
      pendingDoc = cleanBlockComment(body.slice(i + 3, end));
      i = end + 2;
      continue;
    }
    if (body.startsWith('/*', i)) {
      const end = body.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }

    // Line comment — category marker or filler.
    if (body.startsWith('//', i)) {
      const eol = body.indexOf('\n', i);
      const line = body.slice(i + 2, eol === -1 ? body.length : eol).trim();
      const cat = line.match(/^---\s*(.+?)\s*(?:primitives)?\s*---$/i);
      if (cat && cat[1] !== undefined) {
        category = cat[1]
          .replace(/\bprimitives\b/i, '')
          .trim()
          .replace(/^\w/, (c) => c.toUpperCase());
        if (category === '') category = 'Core';
      }
      i = eol === -1 ? body.length : eol + 1;
      continue;
    }

    // Member declaration — walk to its terminator (`;` at depth 0).
    // We track `{}` and `()` depth; angle-bracket depth is too ambiguous in
    // TypeScript (`=>` looks like `>`, `<` could be a comparison) so we
    // ignore it. The interface body never has a `;` inside an object-literal
    // type's body without a balancing `}`, so this is sufficient.
    const startIdx = i;
    let braceDepth = 0;
    let parenDepth = 0;
    while (i < body.length) {
      const c = body[i];
      const next = body[i + 1];
      if (c === '/' && next === '/') {
        i = body.indexOf('\n', i);
        if (i === -1) i = body.length;
        continue;
      }
      if (c === '/' && next === '*') {
        const end = body.indexOf('*/', i + 2);
        if (end === -1) {
          i = body.length;
          break;
        }
        i = end + 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        // skip strings (rare inside signatures but defensive)
        const quote = c;
        i++;
        while (i < body.length && body[i] !== quote) {
          if (body[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      if (c === '{') braceDepth++;
      else if (c === '}') braceDepth--;
      else if (c === '(') parenDepth++;
      else if (c === ')') parenDepth--;
      else if (c === ';' && braceDepth === 0 && parenDepth === 0) {
        const signature = body.slice(startIdx, i).trim();
        if (signature !== '') {
          const compact = signature.replace(/\s+/g, ' ').replace(/\s+,/g, ',');
          const isField = !/[\(]/.test(compact.split(':')[0] ?? '');
          members.push({
            doc: pendingDoc,
            category,
            signature: compact,
            isField,
          });
        }
        pendingDoc = '';
        i++;
        break;
      }
      i++;
    }
    if (i >= body.length) break;
  }
  return members;
}

function renderScriptContextQuickref(): string {
  const members = parseScriptContextMembers();
  // Group by category for the section headers.
  const buckets = new Map<string, ParsedMember[]>();
  for (const m of members) {
    const bucket = buckets.get(m.category) ?? [];
    bucket.push(m);
    buckets.set(m.category, bucket);
  }
  const categoryOrder = Array.from(buckets.keys());

  const lines: string[] = [];
  lines.push('---');
  lines.push('title: Scripting quickref');
  lines.push('---');
  lines.push('');
  lines.push('# `ScriptContext` quickref');
  lines.push('');
  lines.push(
    'Auto-generated from the `ScriptContext` interface in `src/client/script/context.ts`. Every method, sugar query, and always-on view a script can call during the zoned-in dwell. For the typed API (parameters, return types, `@example` blocks), see [ScriptContext](../interfaces/index.ScriptContext.html).',
  );
  lines.push('');
  lines.push(
    'A scenario is a plain async function: `(ctx: ScriptContext) => Promise<void>`. The orchestrator runs it in place of the `holdZonedInMs` sleep at `src/client/game-stage.ts`; the script may finish before the hold elapses or run until logout.',
  );
  lines.push('');
  lines.push('```ts');
  lines.push("import { SwgClient, type ScenarioFn } from '@swg/ts-client';");
  lines.push('');
  lines.push('const myScenario: ScenarioFn = async (ctx) => {');
  lines.push('  await ctx.walkTo({ x: -100, z: 50 }, { speed: 5 });');
  lines.push('  ctx.openPlayerInventory();');
  lines.push('  await ctx.wait(1_000);');
  lines.push('  await ctx.logout();');
  lines.push('};');
  lines.push('');
  lines.push(
    "const client = new SwgClient({ loginServer: { host: '10.254.0.253', port: 44453 } });",
  );
  lines.push('await client.fullLifecycle({');
  lines.push("  account: 'ci-test', characterName: 'TsTest', script: myScenario,");
  lines.push('});');
  lines.push('```');
  lines.push('');
  lines.push('## Always-on views');
  lines.push('');
  lines.push(
    'Reactive snapshots kept current by the dispatcher loop — no polling, no transcript walking. Read them at any time inside a scenario:',
  );
  lines.push('');
  lines.push('| View | Type | Purpose |');
  lines.push('|---|---|---|');
  lines.push(
    '| `ctx.world` | [`WorldModel`](../classes/index.WorldModel.html) | Live `Map<NetworkId, WorldObject>` populated by the baseline flood; updated by deltas + transforms + containment changes + scene-destroy. |',
  );
  lines.push(
    "| `ctx.character` | [`CharacterSheet`](../interfaces/index.CharacterSheet.html) | Live view of the player's CREO + PLAY baselines (HAM, posture, skills, cash, bank, group, level, etc.). |",
  );
  lines.push(
    '| `ctx.inventory` | [`InventoryView`](../interfaces/index.InventoryView.html) | Auto-opened at zone-in. `items`, `findByTemplate(re)`, `findById(id)`, `ready`. |',
  );
  lines.push(
    '| `ctx.datapad` | [`DatapadView`](../interfaces/index.DatapadView.html) | Auto-opened at zone-in. `vehicles()`, `pets()`, `waypoints()`, `missions()`. |',
  );
  lines.push(
    '| `ctx.world` sugar — `findNearest(typeId, opts?)` | `WorldObject \\| undefined` | Nearest `WorldObject` matching the IFF tag; defaults to excluding self. |',
  );
  lines.push(
    '| `ctx.world` sugar — `nearestHostile(opts?)` | `WorldObject \\| undefined` | Nearest CREO with `inCombat=true`. Auto-targeting for combat scripts. |',
  );
  lines.push(
    '| `ctx.world` sugar — `findInContainer(id)` | `WorldObject[]` | Every object currently parented to `id`. |',
  );
  lines.push(
    '| `ctx.world` sugar — `playersInRange(r)` | `WorldObject[]` | Sorted PLAY objects within `r` meters of the player. |',
  );
  lines.push('');

  for (const category of categoryOrder) {
    const bucket = buckets.get(category);
    if (!bucket || bucket.length === 0) continue;
    lines.push(`## ${category}`);
    lines.push('');
    lines.push('| Member | Description |');
    lines.push('|---|---|');
    for (const m of bucket) {
      const sigCell = `\`${truncate(formatSignatureForTable(m.signature), 90)}\``;
      const doc = summarizeDoc(m.doc, '');
      lines.push(`| ${sigCell} | ${mdEscape(doc)} |`);
    }
    lines.push('');
  }

  lines.push('## Escape hatches');
  lines.push('');
  lines.push(
    '* `ctx.send(msg)` — fire any `GameNetworkMessage` directly (e.g. one not yet wrapped by a helper). Counted in `scriptResult.sendsCount`.',
  );
  lines.push('* `ctx.dispatcher` — raw `MessageDispatcher` for advanced wait-for-pattern flows.');
  lines.push(
    '* `ctx.signal` — the `AbortSignal` the orchestrator will fire on lifecycle teardown. Every async primitive checks it.',
  );
  lines.push('');
  return lines.join('\n');
}

function formatSignatureForTable(sig: string): string {
  // Strip leading `readonly ` for compactness in the table.
  return sig.replace(/^readonly\s+/, '');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function renderScenariosCookbook(): string {
  const file = join(REPO_ROOT, 'src', 'scenarios', 'index.ts');
  const content = readFileSync(file, 'utf8');
  // Extract each `export const NAME: ScenarioFactory = ...` with the
  // *immediately* preceding JSDoc block (only whitespace allowed between
  // them — otherwise we'd accidentally pick up the file header).
  //
  // To prevent the engine from extending an opening `/**` across an
  // intermediate `*/` (which would slurp the entire file header into our
  // capture), we forbid `*/` inside the capture: each `*` must be followed
  // by a non-`/`, OR a non-`*` precedes the `/`. The simplest way to enforce
  // that is "any char that isn't `*`" + "or `*` not followed by `/`".
  const factoryRe =
    /\/\*\*((?:[^*]|\*(?!\/))*?)\*\/[ \t]*\n[ \t]*export\s+const\s+(\w+)\s*:\s*ScenarioFactory/g;
  const factories: Array<{ name: string; doc: string }> = [];
  for (const fm of content.matchAll(factoryRe)) {
    const docRaw = fm[1] ?? '';
    const name = fm[2] ?? '';
    if (name) factories.push({ name, doc: jsdocBlockToParagraphs(docRaw) });
  }
  // Build the cli-name map from `scenarios: Record<...> = { ... }`.
  // Entries are either `'walk-line': walkLine` (quoted key with hyphen)
  // or bare-key shorthand like `dwell` (which means `'dwell': dwell`).
  const mapMatch = content.match(/export const scenarios:\s*Record<[^>]+>\s*=\s*\{([\s\S]*?)\};/);
  const cliByFactory = new Map<string, string>();
  if (mapMatch && mapMatch[1] !== undefined) {
    const body = mapMatch[1];
    // Split entries on commas (entries don't contain nested objects here).
    for (const rawEntry of body.split(',')) {
      const entry = rawEntry.trim();
      if (entry === '') continue;
      const quoted = entry.match(/^['"]([\w-]+)['"]\s*:\s*(\w+)\s*$/);
      if (quoted && quoted[1] !== undefined && quoted[2] !== undefined) {
        cliByFactory.set(quoted[2], quoted[1]);
        continue;
      }
      const colon = entry.match(/^(\w+)\s*:\s*(\w+)\s*$/);
      if (colon && colon[1] !== undefined && colon[2] !== undefined) {
        cliByFactory.set(colon[2], colon[1]);
        continue;
      }
      const bare = entry.match(/^(\w+)\s*$/);
      if (bare && bare[1] !== undefined) {
        cliByFactory.set(bare[1], bare[1]);
      }
    }
  }

  const lines: string[] = [];
  lines.push('---');
  lines.push('title: Scripting cookbook');
  lines.push('---');
  lines.push('');
  lines.push('# Bundled scenarios');
  lines.push('');
  lines.push(
    "Every entry in `src/scenarios/index.ts` registered with the CLI's `--script=<name>` flag. Each row is a `ScenarioFactory` — a function that accepts a `Record<string,string>` of CLI args and returns a `ScenarioFn`.",
  );
  lines.push('');
  lines.push('Invoke: `pnpm cli zone --script=<cli-name> [--script-arg=key=value]...`.');
  lines.push('');
  // Only three factories are individually re-exported from src/index.ts
  // (the rest live behind the `scenarios` map). Cross-link to the typed
  // page only for those — for the others, link to the source file directly.
  const exportedFactories = new Set(['groupTradeScenario', 'rideVehicle', 'bazaarSnipe']);
  for (const f of factories) {
    const cliName = cliByFactory.get(f.name) ?? f.name;
    lines.push(`## \`${cliName}\``);
    lines.push('');
    if (exportedFactories.has(f.name)) {
      lines.push(`Factory: [\`${f.name}\`](../variables/index.${f.name}.html)`);
    } else {
      lines.push(
        `Factory: \`${f.name}\` (registered in the [\`scenarios\`](../variables/index.scenarios.html) map; not individually re-exported from \`src/index.ts\`).`,
      );
    }
    lines.push('');
    lines.push(formatJsDocAsMarkdown(f.doc));
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Convert a JSDoc block into a paragraph-friendly markdown segment.
 * Preserves blank-line paragraph breaks; strips the leading `*` on each
 * line but otherwise leaves indentation intact so markdown code blocks
 * and bullet lists render correctly.
 */
function formatJsDocAsMarkdown(doc: string): string {
  if (doc === '') return '_(no description)_';
  return doc;
}

function jsdocBlockToParagraphs(raw: string): string {
  // Strip the leading `*` on each line, preserving paragraph breaks.
  const lines = raw.split('\n').map((line) => {
    const m = line.match(/^\s*\*\s?(.*)$/);
    return m ? (m[1] ?? '') : line.trim();
  });
  // Trim leading/trailing empty lines.
  while (lines.length > 0 && (lines[0] ?? '').trim() === '') lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
  return lines.join('\n');
}
