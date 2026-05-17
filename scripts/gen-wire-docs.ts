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

  // ScriptContext is parsed once and fed to three doc renderers — the slim
  // quickref landing page, the full views reference, and the full actions
  // reference. The portal nav lists views + actions as top-level sections.
  const members = parseScriptContextMembers();

  const quickref = renderScriptContextQuickref();
  const quickrefPath = join(REPO_ROOT, 'docs', 'scripting-quickref.md');
  writeFileSync(quickrefPath, quickref, 'utf8');
  process.stderr.write(`Wrote ${relPath(quickrefPath)}\n`);

  const views = renderViewsReference(members);
  const viewsPath = join(REPO_ROOT, 'docs', 'views-reference.md');
  writeFileSync(viewsPath, views, 'utf8');
  process.stderr.write(`Wrote ${relPath(viewsPath)}\n`);

  const actions = renderActionsReference(members);
  const actionsPath = join(REPO_ROOT, 'docs', 'actions-reference.md');
  writeFileSync(actionsPath, actions, 'utf8');
  process.stderr.write(`Wrote ${relPath(actionsPath)}\n`);

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

/**
 * Pull the member name out of a parsed interface signature.
 *
 *   `readonly world: WorldModel`         → `world`
 *   `walkTo(target: { ... }, ...)`       → `walkTo`
 *   `survey: SurveyCallable`             → `survey`
 *   `expectWithin<T extends ...>(...)`   → `expectWithin`
 *
 * Returns the empty string if the signature can't be parsed (should never
 * happen for a valid ScriptContext member).
 */
function memberName(sig: string): string {
  const stripped = sig.replace(/^readonly\s+/, '');
  const m = stripped.match(/^([A-Za-z_$][\w$]*)/);
  return m?.[1] ?? '';
}

/**
 * True if a member is a "sugar query" — a `findNearest` / `nearestHostile`
 * / `findInContainer` / `playersInRange` style method that scripts treat as
 * read-only world inspection (no wire send). These belong in the views
 * reference even though they're declared as methods on the interface.
 */
function isWorldSugarQuery(name: string): boolean {
  return (
    name === 'findNearest' ||
    name === 'nearestHostile' ||
    name === 'findInContainer' ||
    name === 'playersInRange' ||
    name === 'position' ||
    name === 'yaw' ||
    name === 'cellPosition' ||
    name === 'parentCell' ||
    name === 'mountedSpeedCap'
  );
}

/**
 * Members that scripts treat as escape hatches / raw infra rather than
 * always-on views. They show up at the bottom of the quickref + views page
 * with a one-liner explaining the role.
 */
function isEscapeHatchField(name: string): boolean {
  return name === 'dispatcher' || name === 'sceneStart' || name === 'signal';
}

interface MemberSplit {
  views: ParsedMember[];
  actions: ParsedMember[];
  escapeHatches: ParsedMember[];
}

/**
 * Split parsed ScriptContext members into views (field-style + the few
 * read-only sugar methods), actions (everything that issues wire traffic
 * or mutates state), and escape hatches (`dispatcher`, `sceneStart`,
 * `signal`).
 *
 * The split is intentionally pragmatic — methods like `findNearest` are
 * declared with parens but behave like view sugar, so they go in views.
 * Methods that issue wire traffic always go in actions.
 */
function splitMembers(members: ParsedMember[]): MemberSplit {
  const views: ParsedMember[] = [];
  const actions: ParsedMember[] = [];
  const escapeHatches: ParsedMember[] = [];
  for (const m of members) {
    const name = memberName(m.signature);
    if (isEscapeHatchField(name)) {
      escapeHatches.push(m);
      continue;
    }
    if (m.isField || isWorldSugarQuery(name)) {
      views.push(m);
      continue;
    }
    actions.push(m);
  }
  return { views, actions, escapeHatches };
}

/**
 * Render a member's JSDoc block as a markdown paragraph. Preserves blank-
 * line paragraph breaks; collapses runs of intra-paragraph whitespace.
 * Returns `_(no description)_` for undocumented members so the table still
 * has a description cell.
 */
function memberDocBlock(doc: string): string {
  if (doc === '') return '_(no description)_';
  // The `cleanBlockComment` pass already joined lines with single spaces.
  // Reflow the doc into ~80-char wrapped paragraphs split on `   - ` bullets
  // since the source JSDoc inlines bullet lists with leading whitespace.
  //
  // For the markdown rendering we keep it simple: just return the cleaned
  // single-paragraph text. The typed API site cross-link below the member
  // table carries the full multi-paragraph doc for anyone who needs it.
  return doc;
}

function renderScriptContextQuickref(): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('title: Scripting quickref');
  lines.push('---');
  lines.push('');
  lines.push('# Scripting quickref');
  lines.push('');
  lines.push(
    'A scenario is a plain async function: `(ctx: ScriptContext) => Promise<void>`. The orchestrator runs it in place of the `holdZonedInMs` sleep at `src/client/game-stage.ts`; the script may finish before the hold elapses or run until logout.',
  );
  lines.push('');
  lines.push('```ts');
  lines.push("import { SwgClient, type ScenarioFn } from '@swg/ts-client';");
  lines.push('');
  lines.push('const myScenario: ScenarioFn = async (ctx) => {');
  lines.push('  // Always-on views: read live state any time, no polling.');
  lines.push('  if (ctx.character.health < 200) await ctx.logout();');
  lines.push("  const target = ctx.nearestHostile({ maxRadiusM: 40 });");
  lines.push('');
  lines.push('  // Actions: drive wire traffic.');
  lines.push('  await ctx.walkTo({ x: -100, z: 50 }, { speed: 5 });');
  lines.push('  if (target) await ctx.combat.attackingNearest({ timeoutMs: 30_000 });');
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
  lines.push('## Where to look');
  lines.push('');
  lines.push(
    '- **[Always-on views](./views-reference.md)** — every `ctx.*` field a script can read at any time. Reactive snapshots kept current by the dispatcher loop; no polling required.',
  );
  lines.push(
    '- **[Actions](./actions-reference.md)** — every method on `ScriptContext`, grouped by category (movement, combat, chat, crafting, survey, missions, vehicles, SUI, NPC, trade, bazaar).',
  );
  lines.push(
    '- **[Scripting cookbook](./scripting-cookbook.md)** — every bundled scenario in `src/scenarios/` with its CLI name and full JSDoc.',
  );
  lines.push(
    '- **[Wire-message reference](./wire-reference.md)** — every registered `GameNetworkMessage` + `ObjController` subtype, with CRCs and source paths.',
  );
  lines.push(
    '- **[ScriptContext API](../interfaces/index.ScriptContext.html)** — the typed interface with parameters, return types, and any `@example` blocks.',
  );
  lines.push('');
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

function renderViewsReference(members: ParsedMember[]): string {
  const split = splitMembers(members);
  const generatedAt = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push('---');
  lines.push('title: Always-on views');
  lines.push('---');
  lines.push('');
  lines.push('# Always-on views');
  lines.push('');
  lines.push(
    'Reactive snapshots kept current by the dispatcher loop — read at any time inside a scenario, no polling, no transcript walking. Pinned to the player at zone-in and auto-detached at logout.',
  );
  lines.push('');
  lines.push(
    'Auto-generated from the `readonly` fields and read-only sugar queries on the `ScriptContext` interface in `src/client/script/context.ts`. For the typed API (parameter shapes, return types, full JSDoc), see [ScriptContext](../interfaces/index.ScriptContext.html).',
  );
  lines.push('');
  lines.push(`_Indexed at ${generatedAt}._`);
  lines.push('');

  // Render each view as a full subsection (name + signature + multi-paragraph
  // doc) instead of cramming into a truncated table. Views are the most
  // important surface; readers should see the full docs without clicking.
  for (const m of split.views) {
    const name = memberName(m.signature);
    if (name === '') continue;
    lines.push(`## ctx.${name}`);
    lines.push('');
    lines.push('```ts');
    lines.push(formatSignatureForCodeBlock(m.signature));
    lines.push('```');
    lines.push('');
    lines.push(memberDocBlock(m.doc));
    lines.push('');
  }

  if (split.escapeHatches.length > 0) {
    lines.push('## Escape hatches');
    lines.push('');
    lines.push(
      'Raw infrastructure handles for scripts that need to bypass the high-level helpers.',
    );
    lines.push('');
    for (const m of split.escapeHatches) {
      const name = memberName(m.signature);
      lines.push(`### ctx.${name}`);
      lines.push('');
      lines.push('```ts');
      lines.push(formatSignatureForCodeBlock(m.signature));
      lines.push('```');
      lines.push('');
      const doc = m.doc === '' ? defaultEscapeHatchDoc(name) : memberDocBlock(m.doc);
      lines.push(doc);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function defaultEscapeHatchDoc(name: string): string {
  switch (name) {
    case 'dispatcher':
      return 'Raw `MessageDispatcher` for advanced wait-for-pattern flows. Subscribe to inbound messages directly, query the live transcript, or install custom handlers.';
    case 'sceneStart':
      return "Decoded `CmdStartScene` envelope for the current zone-in (player NetworkId, planet name, server epoch, etc.). Captured at zone-in; doesn't update mid-script.";
    case 'signal':
      return 'The `AbortSignal` the orchestrator fires on lifecycle teardown. Every async primitive checks it; pass it to your own `fetch` / `setTimeout` / etc. for cooperative cancellation.';
    default:
      return '_(no description)_';
  }
}

function renderActionsReference(members: ParsedMember[]): string {
  const split = splitMembers(members);
  // Group actions by category (driven by the `// --- xxx ---` separators in
  // context.ts) so the page is scannable.
  const buckets = new Map<string, ParsedMember[]>();
  for (const m of split.actions) {
    const bucket = buckets.get(m.category) ?? [];
    bucket.push(m);
    buckets.set(m.category, bucket);
  }
  const generatedAt = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push('---');
  lines.push('title: Actions');
  lines.push('---');
  lines.push('');
  lines.push('# Actions');
  lines.push('');
  lines.push(
    'Every callable method on `ScriptContext` — movement, chat, combat, crafting, survey, missions, vehicles, SUI dialogs, NPC conversation, trade, and bazaar. Each action issues real wire traffic (or queues it via the command-queue subsystem); side-effects update the always-on views automatically.',
  );
  lines.push('');
  lines.push(
    'Auto-generated from the method declarations on the `ScriptContext` interface in `src/client/script/context.ts`. Category headings track the `// --- xxx ---` separators in the source. For the typed API (parameter shapes, return types, full JSDoc, `@example` blocks), see [ScriptContext](../interfaces/index.ScriptContext.html).',
  );
  lines.push('');
  lines.push(`_Indexed at ${generatedAt}._`);
  lines.push('');

  // "Core" actions (the ones declared before the first `// --- ... ---`
  // separator: send, wait, walkTo, walkCircle, walkToCell, navigate,
  // openContainer, openPlayerInventory, closeContainer, logout, etc.) are
  // the universal primitives and deserve to lead.
  const coreOrder = ['Core'];
  // Then the rest in declaration order.
  const restOrder: string[] = [];
  for (const cat of buckets.keys()) {
    if (!coreOrder.includes(cat)) restOrder.push(cat);
  }
  const categoryOrder = [...coreOrder, ...restOrder];
  for (const category of categoryOrder) {
    const bucket = buckets.get(category);
    if (!bucket || bucket.length === 0) continue;
    lines.push(`## ${category}`);
    lines.push('');
    for (const m of bucket) {
      const name = memberName(m.signature);
      if (name === '') continue;
      lines.push(`### ctx.${name}`);
      lines.push('');
      lines.push('```ts');
      lines.push(formatSignatureForCodeBlock(m.signature));
      lines.push('```');
      lines.push('');
      lines.push(memberDocBlock(m.doc));
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Re-flow a compacted (single-line) ScriptContext member signature into a
 * readable, line-wrapped form suitable for an inline ```ts code block.
 * The parsed signatures are space-collapsed by `extractInterfaceMembers`;
 * for tightly-wrapped multi-line method signatures we keep the parameter
 * list intact but insert a break at each top-level comma when the line
 * exceeds ~80 columns. Inline object-literal types stay on one line — they
 * rarely need a break and breaking them up is harder than it's worth.
 */
function formatSignatureForCodeBlock(sig: string): string {
  if (sig.length <= 90) return sig;
  // Find the first top-level `(` ... matching `)` and try to wrap commas
  // inside it.
  const open = sig.indexOf('(');
  if (open === -1) return sig;
  let depth = 0;
  let close = -1;
  for (let i = open; i < sig.length; i++) {
    const c = sig[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return sig;
  const head = sig.slice(0, open + 1);
  const tail = sig.slice(close);
  const inner = sig.slice(open + 1, close);
  // Split inner on commas at depth 0 (mirror the brace/paren tracker used
  // in the interface body walker; angle brackets are too ambiguous so we
  // skip them).
  const parts: string[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '{') braceDepth++;
    else if (c === '}') braceDepth--;
    else if (c === '(') parenDepth++;
    else if (c === ')') parenDepth--;
    else if (c === ',' && braceDepth === 0 && parenDepth === 0) {
      parts.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(inner.slice(start).trim());
  // Strip empty parts (e.g. from a trailing comma in the source signature).
  const filtered = parts.filter((p) => p !== '');
  if (filtered.length <= 1) return sig;
  return `${head}\n  ${filtered.join(',\n  ')},\n${tail}`;
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
