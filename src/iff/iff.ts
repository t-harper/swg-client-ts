/**
 * TypeScript port of the SOE `Iff` container parser + writer.
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedFile/src/shared/Iff.{h,cpp}
 *
 * # Wire format
 *
 * Every block (FORM or chunk) on disk is:
 *
 *     [u32 BE tag] [u32 BE blockLength] [blockLength bytes of body]
 *
 * Where:
 *   - For a CHUNK, the body is the raw chunk payload (`blockLength` bytes
 *     of arbitrary data — usually little-endian primitives).
 *   - For a FORM, the body is `[u32 BE formType] [child blocks ...]`, so the
 *     children together occupy `blockLength - 4` bytes.
 *
 * Multi-byte values inside CHUNK bodies are LITTLE-ENDIAN (x86 native;
 * sometimes called `Iff` "chunk data"). Only the block framing — tag and
 * length — uses big-endian. This is the most common foot-gun.
 *
 * # No padding
 *
 * Despite the lineage from EA's classic IFF (which pads to 2-byte
 * boundaries), SOE's `Iff.cpp::adjustDataAsNeeded` does NOT insert
 * alignment pad bytes — block sizes are exact. We match the C++ exactly,
 * since reading back a SOE file with EA-style padding logic would
 * mis-frame every subsequent block.
 *
 * # API shape
 *
 * The C++ class is a single object that does both read and write, with an
 * `inChunk` boolean controlling which method set is valid at any moment.
 * We split that into two classes for type safety:
 *
 *   - `Iff` — read-only navigator (enterForm / enterChunk / read_*).
 *   - `IffWriter` — write-only builder (insertForm / insertChunk / write_*).
 *
 * The split avoids the C++ class's "method called in wrong state" runtime
 * errors and makes the read API completely free of mutation. Internally
 * `IffWriter.toBytes()` produces bytes that `Iff.fromBytes()` will parse,
 * so the round-trip works.
 */
import { readFileSync } from 'node:fs';
import { TAG_FORM, tagFromString, tagToString } from './iff-tag.js';

// ============================================================================
// Constants — match Iff.cpp
// ============================================================================

/** Size on disk of a tag (4 bytes, BE u32). */
const TAG_SIZE = 4;
/** Size on disk of a block-length field (4 bytes, BE u32). */
const LENGTH_SIZE = 4;
/** Header size for either FORM or chunk: tag + length. */
const BLOCK_HEADER_SIZE = TAG_SIZE + LENGTH_SIZE;
/** A FORM additionally carries the inner "form type" tag right after the length. */
const FORM_TYPE_TAG_SIZE = TAG_SIZE;
/** Total overhead a FORM adds beyond its child block bytes. */
const FORM_OVERHEAD = BLOCK_HEADER_SIZE + FORM_TYPE_TAG_SIZE;

// ============================================================================
// Iff — read-side navigator
// ============================================================================

/**
 * One frame on the navigation stack.
 *
 * Matches the C++ `Iff::Stack` struct (Iff.h:56-61):
 *   - `start`  — absolute byte offset into `data` where THIS block's body
 *                 starts. For the root frame, `start = 0` and the body is
 *                 the whole file. For a FORM frame, `start` is just past
 *                 the FORM's `[tag][length][formType]` header — i.e. the
 *                 first byte of the first child block. For a CHUNK frame
 *                 it is just past `[tag][length]`.
 *   - `length` — body length in bytes (what `getLength()` returned, minus
 *                 the 4-byte inner form-type tag for FORM frames).
 *   - `used`   — bytes consumed within the body so far (read cursor).
 */
interface Frame {
  start: number;
  length: number;
  used: number;
}

/**
 * Read-only navigator for SOE IFF data.
 *
 * # Quick tour
 *
 * ```ts
 * const iff = Iff.fromFile('local_machine_options.iff');
 * iff.enterForm('OPTN');
 * iff.enterForm('0003');
 * iff.enterChunk('FLT ');
 * const value = iff.readF32();
 * iff.exitChunk();
 * iff.exitForm();
 * iff.exitForm();
 * ```
 *
 * # Errors
 *
 * Every navigation method throws synchronously on mismatch. C++ calls
 * `Fatal()` (process-killer) — we just throw, since this is a tool.
 *
 * Read methods throw on EOF. Use `getChunkLengthLeft()` to check first
 * if you might be at the end of a chunk.
 */
export class Iff {
  private readonly data: Uint8Array;
  /** DataView over `data.buffer` at the right offset — used to read BE/LE primitives. */
  private readonly view: DataView;
  /**
   * Stack of frames, depth-first. `stack[0]` is the root frame (the whole
   * file). `stack[stackDepth]` is the currently active frame.
   */
  private readonly stack: Frame[];
  /** Index of the currently active frame in `stack`. */
  private stackDepth: number;
  /**
   * True while we're "inside" a chunk's body (i.e. the active frame is a
   * chunk frame). Some operations (enterForm, getNumberOfBlocksLeft) are
   * invalid in this state. Mirrors C++ `Iff::inChunk`.
   */
  private inChunk: boolean;
  /** Optional source path, used only in error messages. */
  private readonly source: string;

  private constructor(data: Uint8Array, source: string) {
    this.data = data;
    // Wrap `data` in a DataView. Buffer.from / Uint8Array can be backed by a
    // larger ArrayBuffer with a non-zero byteOffset; we must respect that.
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.source = source;
    // The root frame's "body" is the entire file. `used=0` means we have
    // not yet entered the top-level block.
    this.stack = [{ start: 0, length: data.byteLength, used: 0 }];
    this.stackDepth = 0;
    this.inChunk = false;
  }

  /**
   * Return the active frame. Internal invariant: `stackDepth` is always a
   * valid index into `stack` because `stack.length === stackDepth + 1` by
   * construction (we push before incrementing, pop after decrementing).
   * This indirection exists to keep the `noUncheckedIndexedAccess` rule
   * happy without sprinkling `!` everywhere.
   */
  private currentFrame(): Frame {
    const f = this.stack[this.stackDepth];
    if (f === undefined) {
      // Should be unreachable — kept as a defensive guard rather than `!`.
      throw new Error(`Iff[${this.source}]: corrupt navigation stack`);
    }
    return f;
  }

  /** Return the frame at a specific depth (used by parent-frame access in `exitForm`/`exitChunk`). */
  private frameAt(depth: number): Frame {
    const f = this.stack[depth];
    if (f === undefined) {
      throw new Error(`Iff[${this.source}]: corrupt navigation stack at depth ${depth}`);
    }
    return f;
  }

  /** Build an `Iff` over an in-memory buffer (no copy — caller must not mutate). */
  static fromBytes(bytes: Uint8Array, source = '<bytes>'): Iff {
    return new Iff(bytes, source);
  }

  /** Build an `Iff` by reading the file synchronously from disk. */
  static fromFile(path: string): Iff {
    const buf = readFileSync(path);
    // Buffer extends Uint8Array; wrap it directly.
    return new Iff(buf, path);
  }

  /** Raw underlying bytes (read-only). */
  getRawData(): Uint8Array {
    return this.data;
  }

  /** Total byte length. */
  getRawDataSize(): number {
    return this.data.byteLength;
  }

  /** True if the active frame is a FORM and the cursor is at its body's start (or anywhere inside, not at end). */
  // (We don't expose isCurrentForm/isCurrentChunk in the obvious way — see the methods on the *next* block, below.)

  // ----------------------------------------------------------------------
  // Inspecting the NEXT child block (the one the cursor is about to read)
  // ----------------------------------------------------------------------

  /**
   * True if the cursor is sitting at a FORM block (i.e. the next thing to
   * enter is a FORM). False for a data chunk or at EOF — use
   * `atEndOfForm()` to disambiguate the latter.
   */
  isCurrentForm(): boolean {
    return this.getFirstTagAtCursor() === TAG_FORM;
  }

  /** True if the cursor is sitting at a data chunk (next thing is a chunk). */
  isCurrentChunk(): boolean {
    return !this.atEndOfForm() && this.getFirstTagAtCursor() !== TAG_FORM;
  }

  /**
   * The user-meaningful tag of the block at the cursor:
   *   - For a FORM, the inner form-type tag (e.g. `"OPTN"`, not `"FORM"`).
   *   - For a chunk, the chunk's own tag (e.g. `"FLT "`).
   *
   * Throws if at end of form.
   */
  getCurrentName(): string {
    const first = this.getFirstTagAtCursor();
    if (first === TAG_FORM) {
      return tagToString(this.getSecondTagAtCursor());
    }
    return tagToString(first);
  }

  /**
   * The body-length of the block at the cursor (i.e. the value that was in
   * the block's `[length]` field on disk). For a FORM this includes the
   * 4-byte inner form-type tag; for a chunk it is just the payload size.
   */
  getCurrentLength(): number {
    return this.getLengthAtCursor(0);
  }

  /** True if no more child blocks remain in the active frame. */
  atEndOfForm(): boolean {
    const f = this.currentFrame();
    return f.used >= f.length;
  }

  /**
   * Count how many child blocks are still unread in the active frame.
   * Invalid while inside a chunk.
   */
  getNumberOfBlocksLeft(): number {
    if (this.inChunk) {
      this.fatal('getNumberOfBlocksLeft called while inside a chunk');
    }
    const f = this.currentFrame();
    let count = 0;
    let offset = 0;
    while (f.used + offset < f.length) {
      const len = this.getLengthAtCursor(offset);
      offset += len + BLOCK_HEADER_SIZE;
      count += 1;
    }
    return count;
  }

  // ----------------------------------------------------------------------
  // FORM navigation
  // ----------------------------------------------------------------------

  /**
   * Descend into the FORM at the cursor.
   *
   * If `expectedTag` is supplied, throws unless the form's inner type tag
   * matches. After entering, the cursor sits at the first child block.
   */
  enterForm(expectedTag?: string): void {
    if (this.inChunk) {
      this.fatal('enterForm called while inside a chunk');
    }
    if (this.atEndOfForm()) {
      this.fatal(`enterForm(${expectedTag ?? '?'}) called at end of form`);
    }
    if (!this.isCurrentForm()) {
      this.fatal(
        `enterForm(${expectedTag ?? '?'}): current block is a chunk (${this.getCurrentName()}), not a form`,
      );
    }
    if (expectedTag !== undefined) {
      const actualTag = tagToString(this.getSecondTagAtCursor());
      if (actualTag !== expectedTag) {
        this.fatal(`enterForm(${expectedTag}) but found form '${actualTag}'`);
      }
    }
    // Push a new frame whose body starts past the [FORM][len][type] header
    // and is `bodyLen - 4` bytes long (the -4 is the inner type tag, which
    // is conceptually part of the header, not the children).
    const f = this.currentFrame();
    const bodyLen = this.getLengthAtCursor(0);
    this.stack.push({
      start: f.start + f.used + FORM_OVERHEAD,
      length: bodyLen - FORM_TYPE_TAG_SIZE,
      used: 0,
    });
    this.stackDepth += 1;
  }

  /** Descend into the next FORM without validating its tag; returns the inner tag. */
  enterAnyForm(): string {
    if (!this.isCurrentForm()) {
      this.fatal(`enterAnyForm: current block is a chunk (${this.getCurrentName()}), not a form`);
    }
    const name = tagToString(this.getSecondTagAtCursor());
    this.enterForm();
    return name;
  }

  /**
   * Ascend from the current FORM back to its parent. The parent's cursor
   * advances past the FORM we just exited.
   *
   * If `expectedTag` is supplied, throws unless the form being exited
   * matches — useful for catching enter/exit mismatches early.
   */
  exitForm(expectedTag?: string): void {
    if (this.stackDepth === 0) {
      this.fatal('exitForm called at root');
    }
    if (this.inChunk) {
      this.fatal('exitForm called while inside a chunk');
    }
    if (expectedTag !== undefined) {
      const parent = this.frameAt(this.stackDepth - 1);
      // The form's inner-type tag lives 4 bytes before the body start of
      // our current frame (parent.start + parent.used + 8 + 0 == our.start - 4).
      const tagOffset = parent.start + parent.used + BLOCK_HEADER_SIZE;
      const actual = tagToString(this.readU32BE(tagOffset));
      if (actual !== expectedTag) {
        this.fatal(`exitForm(${expectedTag}) but inside form '${actual}'`);
      }
    }
    const f = this.currentFrame();
    const parent = this.frameAt(this.stackDepth - 1);
    parent.used += f.length + FORM_OVERHEAD;
    this.stack.pop();
    this.stackDepth -= 1;
  }

  // ----------------------------------------------------------------------
  // CHUNK navigation
  // ----------------------------------------------------------------------

  /**
   * Descend into the data chunk at the cursor.
   *
   * If `expectedTag` is supplied, throws unless the chunk's tag matches.
   * After entering, `read*` methods consume from the chunk body.
   */
  enterChunk(expectedTag?: string): void {
    if (this.inChunk) {
      this.fatal('enterChunk called while already inside a chunk');
    }
    if (this.atEndOfForm()) {
      this.fatal(`enterChunk(${expectedTag ?? '?'}) called at end of form`);
    }
    if (this.isCurrentForm()) {
      this.fatal(`enterChunk(${expectedTag ?? '?'}): current block is a form, not a chunk`);
    }
    if (expectedTag !== undefined) {
      const actualTag = tagToString(this.getFirstTagAtCursor());
      if (actualTag !== expectedTag) {
        this.fatal(`enterChunk(${expectedTag}) but found chunk '${actualTag}'`);
      }
    }
    const f = this.currentFrame();
    const bodyLen = this.getLengthAtCursor(0);
    this.stack.push({
      start: f.start + f.used + BLOCK_HEADER_SIZE,
      length: bodyLen,
      used: 0,
    });
    this.stackDepth += 1;
    this.inChunk = true;
  }

  /** Ascend from the current chunk; cursor advances past it in the parent. */
  exitChunk(expectedTag?: string): void {
    if (!this.inChunk) {
      this.fatal('exitChunk called while not in a chunk');
    }
    if (expectedTag !== undefined) {
      const parent = this.frameAt(this.stackDepth - 1);
      // Chunk's tag lives at parent.start + parent.used (i.e. just before our body).
      const tagOffset = parent.start + parent.used;
      const actual = tagToString(this.readU32BE(tagOffset));
      if (actual !== expectedTag) {
        this.fatal(`exitChunk(${expectedTag}) but inside chunk '${actual}'`);
      }
    }
    const f = this.currentFrame();
    const parent = this.frameAt(this.stackDepth - 1);
    parent.used += f.length + BLOCK_HEADER_SIZE;
    this.stack.pop();
    this.stackDepth -= 1;
    this.inChunk = false;
  }

  /**
   * How many bytes of the current chunk's body remain unread.
   * Throws if not in a chunk.
   */
  getChunkLengthLeft(): number {
    if (!this.inChunk) {
      this.fatal('getChunkLengthLeft called while not in a chunk');
    }
    const f = this.currentFrame();
    return f.length - f.used;
  }

  /** Total byte length of the current chunk's body. */
  getChunkLengthTotal(): number {
    if (!this.inChunk) {
      this.fatal('getChunkLengthTotal called while not in a chunk');
    }
    return this.currentFrame().length;
  }

  // ----------------------------------------------------------------------
  // Tree-walk helpers
  // ----------------------------------------------------------------------

  /**
   * Iterate the children of the active frame. For each child the handler
   * receives the child's tag (form-type for FORMs, chunk-tag for chunks)
   * and a flag identifying which kind. The handler is responsible for
   * either entering+exiting the block itself or letting `forEachBlock`
   * skip past it — if the cursor hasn't moved when the handler returns,
   * `forEachBlock` will advance past the block automatically.
   */
  forEachBlock(handler: (tag: string, kind: 'form' | 'chunk') => void): void {
    if (this.inChunk) {
      this.fatal('forEachBlock called while inside a chunk');
    }
    while (!this.atEndOfForm()) {
      const f = this.currentFrame();
      const startUsed = f.used;
      const kind: 'form' | 'chunk' = this.isCurrentForm() ? 'form' : 'chunk';
      const name = this.getCurrentName();

      handler(name, kind);

      if (f.used === startUsed) {
        // Handler didn't consume the block — skip it.
        const len = this.getLengthAtCursor(0);
        f.used += len + BLOCK_HEADER_SIZE;
      }
    }
  }

  /**
   * Convenience: same as `forEachBlock` but only fires for data chunks.
   * The handler is invoked with the chunk's tag and is expected to either
   * (a) call `enterChunk()`/`exitChunk()` itself, or (b) leave the cursor
   * alone and we'll skip past the chunk.
   */
  forEachChunk(handler: (tag: string) => void): void {
    this.forEachBlock((tag, kind) => {
      if (kind === 'chunk') handler(tag);
    });
  }

  // ----------------------------------------------------------------------
  // Read primitives — LE for chunk data (matches C++ x86 native reads)
  // ----------------------------------------------------------------------

  readU8(): number {
    const off = this.advanceInChunk(1);
    return this.view.getUint8(off);
  }

  readI8(): number {
    const off = this.advanceInChunk(1);
    return this.view.getInt8(off);
  }

  readU16(): number {
    const off = this.advanceInChunk(2);
    return this.view.getUint16(off, /* littleEndian */ true);
  }

  readI16(): number {
    const off = this.advanceInChunk(2);
    return this.view.getInt16(off, true);
  }

  readU32(): number {
    const off = this.advanceInChunk(4);
    return this.view.getUint32(off, true);
  }

  readI32(): number {
    const off = this.advanceInChunk(4);
    return this.view.getInt32(off, true);
  }

  readU64(): bigint {
    const off = this.advanceInChunk(8);
    return this.view.getBigUint64(off, true);
  }

  readI64(): bigint {
    const off = this.advanceInChunk(8);
    return this.view.getBigInt64(off, true);
  }

  readF32(): number {
    const off = this.advanceInChunk(4);
    return this.view.getFloat32(off, true);
  }

  readF64(): number {
    const off = this.advanceInChunk(8);
    return this.view.getFloat64(off, true);
  }

  readBool(): boolean {
    return this.readU8() !== 0;
  }

  /**
   * Read `n` raw bytes from the current chunk (advances the cursor).
   * Returns a copy (so the caller can keep it past further reads).
   */
  readBytes(n: number): Uint8Array {
    const off = this.advanceInChunk(n);
    return this.data.slice(off, off + n);
  }

  /**
   * Read a NUL-terminated C string (matches C++ `read_stdstring()`).
   *
   * Reads bytes until the first 0x00, returns the string before the
   * terminator (decoded as Latin-1 / 8-bit so we don't mangle any bytes
   * in the rare case the file has high-byte content), advances the cursor
   * past the terminator. Throws if EOF before NUL.
   */
  readString(): string {
    if (!this.inChunk) {
      this.fatal('readString called while not in a chunk');
    }
    const f = this.currentFrame();
    const start = f.start + f.used;
    const end = f.start + f.length;
    let nulOff = -1;
    for (let i = start; i < end; ++i) {
      if (this.data[i] === 0) {
        nulOff = i;
        break;
      }
    }
    if (nulOff === -1) {
      this.fatal('readString: hit end of chunk before NUL terminator');
    }
    const out = decodeLatin1(this.data, start, nulOff);
    f.used += nulOff - start + 1; // +1 for the NUL
    return out;
  }

  /**
   * Read a Unicode::String (matches C++ `read_unicodeString()`):
   *   [i32 LE count] [count * u16 LE codepoints]
   *
   * The codepoints are UTF-16 code units (the C++ Unicode::String is a
   * `std::basic_string<unsigned short>`).
   */
  readWideString(): string {
    const count = this.readI32();
    if (count < 0) {
      this.fatal(`readWideString: negative count ${count}`);
    }
    let out = '';
    for (let i = 0; i < count; ++i) {
      out += String.fromCharCode(this.readU16());
    }
    return out;
  }

  // ----------------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------------

  /**
   * Bump the chunk frame's `used` by `n` and return the absolute byte
   * offset where the just-consumed bytes live. Throws if `n` would
   * overflow the chunk.
   */
  private advanceInChunk(n: number): number {
    if (!this.inChunk) {
      this.fatal('attempt to read primitive while not inside a chunk');
    }
    const f = this.currentFrame();
    if (f.used + n > f.length) {
      this.fatal(`chunk read overflow: wanted ${n} bytes but ${f.length - f.used} remain in chunk`);
    }
    const off = f.start + f.used;
    f.used += n;
    return off;
  }

  /** Read the [tag] of the block at `frame.start + frame.used + offset`. */
  private getFirstTagAtCursor(offset = 0): number {
    const f = this.currentFrame();
    if (f.length - f.used - offset < BLOCK_HEADER_SIZE) {
      this.fatal(
        `read overflow: only ${f.length - f.used - offset} bytes available for next block header`,
      );
    }
    return this.readU32BE(f.start + f.used + offset);
  }

  /** Read the [length] field of the block at offset. */
  private getLengthAtCursor(offset: number): number {
    const f = this.currentFrame();
    if (f.length - f.used - offset < BLOCK_HEADER_SIZE) {
      this.fatal('read overflow: not enough bytes for block length');
    }
    return this.readU32BE(f.start + f.used + offset + TAG_SIZE);
  }

  /** Read the inner form-type tag (the [tag] that follows [FORM][len]). Only valid when current block is a FORM. */
  private getSecondTagAtCursor(): number {
    const f = this.currentFrame();
    if (f.length - f.used < BLOCK_HEADER_SIZE + TAG_SIZE) {
      this.fatal('read overflow: not enough bytes for form inner-type tag');
    }
    return this.readU32BE(f.start + f.used + BLOCK_HEADER_SIZE);
  }

  /** Unconditional big-endian u32 read at absolute offset. */
  private readU32BE(off: number): number {
    return this.view.getUint32(off, /* littleEndian */ false);
  }

  /**
   * Throw a formatted error.
   *
   * Includes the source name + a `/`-joined breadcrumb of the form/chunk
   * tags we're nested inside. Matches C++ `Iff::formatLocation`.
   */
  private fatal(message: string): never {
    const path = this.locationString();
    throw new Error(`Iff[${this.source}${path ? `/${path}` : ''}]: ${message}`);
  }

  /** Slash-joined names of every form/chunk we're currently inside, like `OPTN/0003/FLT `. */
  private locationString(): string {
    const segs: string[] = [];
    for (let d = 1; d <= this.stackDepth; ++d) {
      // The block at depth d started at stack[d-1].start + (stack[d-1].used - (stack[d].length + overhead)).
      // Reconstruct the tag by reading back from the start of frame d.
      const frame = this.frameAt(d);
      // For a FORM, the inner tag is the 4 bytes immediately before frame.start.
      // For a chunk, the chunk's tag is 8 bytes before frame.start ([tag][len]).
      // We can disambiguate by looking at the bytes 12 before frame.start: if
      // those are 'FORM' we're a form frame; else we're a chunk frame.
      if (frame.start >= FORM_OVERHEAD) {
        const maybeForm = this.readU32BE(frame.start - FORM_OVERHEAD);
        if (maybeForm === TAG_FORM) {
          segs.push(tagToString(this.readU32BE(frame.start - TAG_SIZE)));
          continue;
        }
      }
      // Chunk frame: tag is BLOCK_HEADER_SIZE before our body.
      if (frame.start >= BLOCK_HEADER_SIZE) {
        segs.push(tagToString(this.readU32BE(frame.start - BLOCK_HEADER_SIZE)));
      }
    }
    return segs.join('/');
  }
}

// ============================================================================
// IffWriter — write-side builder
// ============================================================================

/**
 * One open block on the writer stack.
 *
 *   - `kind` — `form` or `chunk`.
 *   - `lengthOffset` — absolute byte offset of this block's `[length]`
 *                       field in `buf`. We back-patch it on `exit*()`.
 *   - `bodyStart` — absolute byte offset where this block's body begins
 *                    (just past `[tag][length]` for chunks, or just past
 *                    `[tag][length][formType]` for forms). We compute the
 *                    block's body length on exit as `buf.length - bodyStart`.
 */
interface WriterFrame {
  kind: 'form' | 'chunk';
  lengthOffset: number;
  bodyStart: number;
  /** Tag of this block, kept for friendlier error messages. */
  tag: number;
}

/**
 * Write-side builder. Produces bytes that `Iff.fromBytes()` will parse.
 *
 * # Usage
 *
 * ```ts
 * const w = new IffWriter()
 *   .insertForm('OPTN')
 *     .insertForm('0003')
 *       .insertChunk('FLT ').writeU32(0).writeF32(1.0).exitChunk()
 *     .exitForm()
 *   .exitForm();
 * const bytes = w.toBytes();
 * ```
 *
 * Most methods are chainable.
 */
export class IffWriter {
  /**
   * Backing buffer. We append to the end via `pushBytes`. Sizes are
   * back-patched on `exitChunk()` / `exitForm()`.
   *
   * Using a Node `Uint8Array` + DataView + manual growth (rather than
   * piggybacking on `ByteStream`) because we need BIG-endian writes for
   * tags and lengths, and `ByteStream` is LE-only.
   */
  private buf: Uint8Array;
  private view: DataView;
  private pos: number;
  private readonly stack: WriterFrame[];

  constructor(initialCapacity = 256) {
    const cap = Math.max(initialCapacity, 16);
    this.buf = new Uint8Array(cap);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.pos = 0;
    this.stack = [];
  }

  /** Materialize the constructed IFF as a copy of the used portion. */
  toBytes(): Uint8Array {
    if (this.stack.length !== 0) {
      const openTags = this.stack.map((f) => `${f.kind}=${tagToString(f.tag)}`).join('/');
      throw new Error(`IffWriter.toBytes(): ${this.stack.length} unclosed block(s): ${openTags}`);
    }
    return this.buf.slice(0, this.pos);
  }

  // ----------------------------------------------------------------------
  // FORM
  // ----------------------------------------------------------------------

  /**
   * Open a new FORM with the given inner type. Emits the `FORM` tag, a
   * placeholder length (back-patched on `exitForm`), and the inner
   * type tag. Subsequent `insertForm` / `insertChunk` calls add children.
   */
  insertForm(typeTag: string): this {
    this.ensureNotInChunk('insertForm');
    const tag = tagFromString(typeTag);
    // [FORM][len placeholder][inner tag]
    this.ensureCapacity(FORM_OVERHEAD);
    this.writeU32BE(TAG_FORM);
    const lengthOffset = this.pos;
    this.writeU32BE(0); // placeholder
    this.writeU32BE(tag); // inner type tag
    const bodyStart = this.pos;
    this.stack.push({ kind: 'form', lengthOffset, bodyStart, tag });
    return this;
  }

  /**
   * Close the most-recently-opened FORM and back-patch its size.
   *
   * The size we write is `bytes-since-bodyStart + 4` (for the inner type
   * tag) — i.e. the same definition used by `Iff::getLength()` on read.
   */
  exitForm(): this {
    const f = this.stack.pop();
    if (!f) {
      throw new Error('IffWriter.exitForm(): no open block');
    }
    if (f.kind !== 'form') {
      throw new Error(`IffWriter.exitForm(): top is a chunk '${tagToString(f.tag)}', not a form`);
    }
    // Body length on disk INCLUDES the 4-byte inner type tag (matches C++).
    const bodyBytes = this.pos - f.bodyStart;
    const lengthField = bodyBytes + FORM_TYPE_TAG_SIZE;
    // Back-patch the length placeholder.
    this.view.setUint32(f.lengthOffset, lengthField >>> 0, /* littleEndian */ false);
    return this;
  }

  // ----------------------------------------------------------------------
  // CHUNK
  // ----------------------------------------------------------------------

  /**
   * Open a new data chunk. Emits the chunk tag and a placeholder length
   * (back-patched on `exitChunk`). After this, the `write*` methods
   * append to the chunk body.
   */
  insertChunk(chunkTag: string): this {
    this.ensureNotInChunk('insertChunk');
    const tag = tagFromString(chunkTag);
    this.ensureCapacity(BLOCK_HEADER_SIZE);
    this.writeU32BE(tag);
    const lengthOffset = this.pos;
    this.writeU32BE(0); // placeholder
    const bodyStart = this.pos;
    this.stack.push({ kind: 'chunk', lengthOffset, bodyStart, tag });
    return this;
  }

  /** Close the current chunk and back-patch its length. */
  exitChunk(): this {
    const f = this.stack.pop();
    if (!f) {
      throw new Error('IffWriter.exitChunk(): no open block');
    }
    if (f.kind !== 'chunk') {
      throw new Error(`IffWriter.exitChunk(): top is a form '${tagToString(f.tag)}', not a chunk`);
    }
    const bodyBytes = this.pos - f.bodyStart;
    this.view.setUint32(f.lengthOffset, bodyBytes >>> 0, false);
    return this;
  }

  // ----------------------------------------------------------------------
  // Chunk-body primitive writes — LE
  // ----------------------------------------------------------------------

  writeU8(v: number): this {
    this.ensureInChunk('writeU8');
    this.ensureCapacity(1);
    this.view.setUint8(this.pos, v & 0xff);
    this.pos += 1;
    return this;
  }

  writeI8(v: number): this {
    this.ensureInChunk('writeI8');
    this.ensureCapacity(1);
    this.view.setInt8(this.pos, ((v << 24) >> 24) | 0);
    this.pos += 1;
    return this;
  }

  writeU16(v: number): this {
    this.ensureInChunk('writeU16');
    this.ensureCapacity(2);
    this.view.setUint16(this.pos, v & 0xffff, true);
    this.pos += 2;
    return this;
  }

  writeI16(v: number): this {
    this.ensureInChunk('writeI16');
    this.ensureCapacity(2);
    this.view.setInt16(this.pos, ((v << 16) >> 16) | 0, true);
    this.pos += 2;
    return this;
  }

  writeU32(v: number): this {
    this.ensureInChunk('writeU32');
    this.ensureCapacity(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }

  writeI32(v: number): this {
    this.ensureInChunk('writeI32');
    this.ensureCapacity(4);
    this.view.setInt32(this.pos, v | 0, true);
    this.pos += 4;
    return this;
  }

  writeU64(v: bigint): this {
    this.ensureInChunk('writeU64');
    this.ensureCapacity(8);
    this.view.setBigUint64(this.pos, BigInt.asUintN(64, v), true);
    this.pos += 8;
    return this;
  }

  writeI64(v: bigint): this {
    this.ensureInChunk('writeI64');
    this.ensureCapacity(8);
    this.view.setBigInt64(this.pos, BigInt.asIntN(64, v), true);
    this.pos += 8;
    return this;
  }

  writeF32(v: number): this {
    this.ensureInChunk('writeF32');
    this.ensureCapacity(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  writeF64(v: number): this {
    this.ensureInChunk('writeF64');
    this.ensureCapacity(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }

  writeBool(v: boolean): this {
    return this.writeU8(v ? 1 : 0);
  }

  /** Append raw bytes verbatim. */
  writeBytes(b: Uint8Array): this {
    this.ensureInChunk('writeBytes');
    this.ensureCapacity(b.byteLength);
    this.buf.set(b, this.pos);
    this.pos += b.byteLength;
    return this;
  }

  /**
   * Write a NUL-terminated C string (matches C++ `insertChunkString(const char*)`).
   *
   * Strings are written as Latin-1 (one byte per code point) so they
   * round-trip byte-for-byte with `Iff.readString()`. Throws if any code
   * point exceeds 0xff — high characters belong in `writeWideString`.
   */
  writeString(s: string): this {
    this.ensureInChunk('writeString');
    this.ensureCapacity(s.length + 1);
    for (let i = 0; i < s.length; ++i) {
      const c = s.charCodeAt(i);
      if (c > 0xff) {
        throw new RangeError(
          `writeString: char code 0x${c.toString(16)} at index ${i} exceeds 0xff (use writeWideString)`,
        );
      }
      this.view.setUint8(this.pos, c);
      this.pos += 1;
    }
    this.view.setUint8(this.pos, 0);
    this.pos += 1;
    return this;
  }

  /**
   * Write a Unicode::String (matches C++ `insertChunkString(const Unicode::String&)`):
   *   [i32 LE count] [count * u16 LE]
   *
   * The count is the number of UTF-16 code units (not bytes), matching
   * `Unicode::String::size()`.
   */
  writeWideString(s: string): this {
    this.ensureInChunk('writeWideString');
    const count = s.length;
    this.ensureCapacity(4 + count * 2);
    this.view.setInt32(this.pos, count | 0, true);
    this.pos += 4;
    for (let i = 0; i < count; ++i) {
      this.view.setUint16(this.pos, s.charCodeAt(i), true);
      this.pos += 2;
    }
    return this;
  }

  // ----------------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------------

  /** Append a BE u32 without any chunk-state checks (used for tags + lengths). */
  private writeU32BE(v: number): void {
    this.view.setUint32(this.pos, v >>> 0, false);
    this.pos += 4;
  }

  private ensureCapacity(needed: number): void {
    const required = this.pos + needed;
    if (required <= this.buf.byteLength) return;
    let newCap = this.buf.byteLength;
    while (newCap < required) {
      newCap = newCap < 4096 ? newCap * 2 + needed : newCap + Math.max(needed, newCap >> 1);
    }
    const grown = new Uint8Array(newCap);
    grown.set(this.buf.subarray(0, this.pos), 0);
    this.buf = grown;
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }

  private ensureInChunk(method: string): void {
    const top = this.stack[this.stack.length - 1];
    if (!top || top.kind !== 'chunk') {
      throw new Error(`IffWriter.${method}: must be called inside an open chunk`);
    }
  }

  private ensureNotInChunk(method: string): void {
    const top = this.stack[this.stack.length - 1];
    if (top && top.kind === 'chunk') {
      throw new Error(
        `IffWriter.${method}: cannot be called inside an open chunk '${tagToString(top.tag)}'`,
      );
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Decode a Latin-1 / 8-bit run as a JS string. Each byte is mapped to its
 * Unicode code point directly. We deliberately don't use TextDecoder('utf-8')
 * here because the C++ writes 8-bit C strings that may contain bytes that
 * are not valid UTF-8.
 */
function decodeLatin1(data: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; ++i) {
    // `start..end` is a window inside `data` validated by the caller; a
    // missing byte here would be a bug, not a normal error case.
    const b = data[i];
    if (b === undefined) {
      throw new RangeError(`decodeLatin1: out-of-range read at offset ${i}`);
    }
    out += String.fromCharCode(b);
  }
  return out;
}
