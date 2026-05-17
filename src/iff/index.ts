/**
 * IFF (Interchange File Format) parser + writer for SOE / SWG data files.
 *
 * See `iff.ts` for the wire-format walkthrough. Quick summary:
 *
 *   - `Iff.fromBytes(bytes)` / `Iff.fromFile(path)` — open a file or buffer
 *      for read-side navigation via `enterForm` / `enterChunk` / `read*`.
 *   - `new IffWriter()` — build a new IFF programmatically with
 *      `insertForm` / `insertChunk` / `write*`. `toBytes()` returns the
 *      fully-formed buffer ready to write to disk (or feed back to
 *      `Iff.fromBytes()` for round-tripping).
 *
 * Most SWG data files are IFFs: `.iff` data tables, `.trn` terrain,
 * `.cdf`, `.dsc`, etc.
 */
export { Iff, IffWriter } from './iff.js';
export { tag, tagFromString, tagToString, TAG_FORM } from './iff-tag.js';
