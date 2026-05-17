/**
 * Minimal local IFF reader — enough to walk down to the PTAT DATA chunk and
 * pull a handful of primitives out. Scoped JUST to what the terrain helpers
 * need; anything beyond `enterForm` / `enterChunk` / a few read methods is
 * out of scope here.
 *
 * TODO(post-merge): a parallel agent is building a full IFF parser at
 * `src/iff/`. After merge, dedupe to use the shared module
 * (`tagFromString` / `tagToString` in `src/iff/iff-tag.ts` already exists).
 *
 * Format reminder (from `~/code/swg-main/.../sharedFile/.../Iff.cpp`):
 *
 *   block = [u32 BE tag][u32 BE blockLength][...blockLength bytes payload]
 *
 *   - if tag === 'FORM', the payload starts with another [u32 BE subTag]
 *     and the remaining bytes are nested IFF blocks.
 *   - otherwise the payload is a chunk: opaque bytes the caller decodes
 *     according to the chunk's tag-defined schema.
 *
 * Primitive encoding inside chunks (per `Iff::read_*`):
 *
 *   - `read_int32`  : signed 32-bit, **little-endian** (despite the BE block
 *                     header — the on-disk chunk data uses host LE since the
 *                     C++ implementation casts the raw bytes through
 *                     `memcpy(&value, p, 4)` without `ntohl`).
 *   - `read_float`  : 32-bit IEEE-754 little-endian.
 *   - `read_string` : NUL-terminated C string, ASCII.
 *
 * Note: only the FORM/chunk *header* tag+length pair is big-endian; the chunk
 * *payload* (numbers, strings) is whatever the chunk's serializer wrote,
 * which for SOE's chunks is host-LE.
 */

const TAG_LENGTH = 4;
const FORM_TAG_BE_BYTES = [0x46, 0x4f, 0x52, 0x4d] as const; // 'F','O','R','M'

/** A frame on the IFF descent stack. */
interface Frame {
  /** Tag of the enclosing block (for diagnostics + sanity checks). */
  readonly tag: number;
  /** True if this is a FORM (sub-tag already consumed); false for a chunk. */
  readonly isForm: boolean;
  /** Absolute offset in the file where this block's *payload* starts. */
  readonly payloadStart: number;
  /** Absolute offset where this block's payload ends (= payloadStart + length). */
  readonly payloadEnd: number;
  /** For FORM frames: the sub-tag that names the FORM type (e.g. 'PTAT'). */
  readonly subTag?: number;
}

/**
 * Pack a 1-4 ASCII char string into a 32-bit tag (high byte = first char).
 * Right-pads with ASCII space (0x20) to match C++ `TAG2`/`TAG3` macros.
 *
 * Mirrors `src/iff/iff-tag.ts#tagFromString` — duplicated locally so this
 * module has zero cross-module deps until the post-merge cleanup.
 */
export function packTag(s: string): number {
  let result = 0;
  for (let i = 0; i < TAG_LENGTH; ++i) {
    const ch = i < s.length ? s.charCodeAt(i) : 0x20;
    if (ch < 0 || ch > 0x7f) {
      throw new RangeError(
        `packTag: non-ASCII char 0x${ch.toString(16)} at index ${i} of ${JSON.stringify(s)}`,
      );
    }
    result = ((result << 8) | ch) >>> 0;
  }
  return result >>> 0;
}

/** Format a tag back to its 4-char ASCII representation for error messages. */
export function unpackTag(tag: number): string {
  let out = '';
  for (let i = 0; i < TAG_LENGTH; ++i) {
    const ch = (tag >>> ((TAG_LENGTH - 1 - i) * 8)) & 0xff;
    out += ch >= 0x20 && ch <= 0x7e ? String.fromCharCode(ch) : '?';
  }
  return out;
}

/**
 * Minimal forward-only IFF reader. Construct with the full file buffer,
 * then use `enterForm` / `enterChunk` to descend, and call the typed
 * `read*` methods to pull primitives out of the current chunk.
 *
 * NOT thread-safe (single internal cursor). NOT a full re-implementation of
 * SOE's `Iff` class — no insert support, no parse-time validation, no
 * optional-form lookahead. Just what `readTrnMetadata` needs.
 */
export class MinimalIff {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private readonly stack: Frame[] = [];
  /** Cursor inside the *current* chunk's payload (only meaningful when top frame is a chunk). */
  private chunkCursor = 0;

  constructor(buf: ArrayBuffer | Uint8Array) {
    if (buf instanceof Uint8Array) {
      this.bytes = buf;
      this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    } else {
      this.bytes = new Uint8Array(buf);
      this.view = new DataView(buf);
    }
    // The root "frame" is a synthetic FORM covering the whole file — same
    // model the C++ Iff uses, where descent starts by entering the top FORM.
    this.stack.push({
      tag: 0,
      isForm: true,
      payloadStart: 0,
      payloadEnd: this.bytes.byteLength,
    });
  }

  /**
   * Descend into the next FORM block. If `expectedSubTag` is given, throws
   * unless the FORM's sub-tag matches. Returns the sub-tag actually read.
   */
  enterForm(expectedSubTag?: string): number {
    const parent = this.top();
    const blockOffset = this.nextBlockOffset();
    const { tag, length, payloadStart } = this.readBlockHeader(blockOffset);
    if (tag !== packTag('FORM')) {
      throw new Error(
        `enterForm: expected FORM at offset 0x${blockOffset.toString(16)} but found '${unpackTag(tag)}'`,
      );
    }
    // FORM payload begins with a 4-byte sub-tag, then nested blocks.
    if (length < 4) {
      throw new Error(`enterForm: FORM block too short for sub-tag (length=${length})`);
    }
    const subTag = this.view.getUint32(payloadStart, false); // BE
    if (expectedSubTag !== undefined && subTag !== packTag(expectedSubTag)) {
      throw new Error(
        `enterForm: expected sub-tag '${expectedSubTag}' but found '${unpackTag(subTag)}'`,
      );
    }
    const payloadEnd = payloadStart + length;
    if (payloadEnd > parent.payloadEnd) {
      throw new Error(
        `enterForm: FORM extends past parent (payloadEnd=${payloadEnd}, parentEnd=${parent.payloadEnd})`,
      );
    }
    this.stack.push({
      tag,
      isForm: true,
      // Skip the sub-tag itself; nested blocks start AFTER it.
      payloadStart: payloadStart + 4,
      payloadEnd,
      subTag,
    });
    return subTag;
  }

  /**
   * Descend into the next chunk block. If `expectedTag` is given, throws
   * unless the chunk's tag matches.
   */
  enterChunk(expectedTag?: string): number {
    const parent = this.top();
    const blockOffset = this.nextBlockOffset();
    const { tag, length, payloadStart } = this.readBlockHeader(blockOffset);
    if (expectedTag !== undefined && tag !== packTag(expectedTag)) {
      throw new Error(
        `enterChunk: expected '${expectedTag}' at offset 0x${blockOffset.toString(16)} but found '${unpackTag(tag)}'`,
      );
    }
    if (tag === packTag('FORM')) {
      throw new Error(
        `enterChunk: '${unpackTag(tag)}' at offset 0x${blockOffset.toString(16)} is a FORM, not a chunk`,
      );
    }
    const payloadEnd = payloadStart + length;
    if (payloadEnd > parent.payloadEnd) {
      throw new Error(
        `enterChunk: chunk extends past parent (payloadEnd=${payloadEnd}, parentEnd=${parent.payloadEnd})`,
      );
    }
    this.stack.push({ tag, isForm: false, payloadStart, payloadEnd });
    this.chunkCursor = payloadStart;
    return tag;
  }

  /** Pop the current FORM frame. */
  exitForm(): void {
    const top = this.top();
    if (!top.isForm) {
      throw new Error(`exitForm: current frame is a chunk ('${unpackTag(top.tag)}')`);
    }
    if (this.stack.length === 1) {
      throw new Error('exitForm: cannot pop synthetic root frame');
    }
    this.stack.pop();
  }

  /** Pop the current chunk frame. */
  exitChunk(): void {
    const top = this.top();
    if (top.isForm) {
      throw new Error(`exitChunk: current frame is a FORM ('${unpackTag(top.tag)}')`);
    }
    this.stack.pop();
    this.chunkCursor = 0;
  }

  /** Read a signed 32-bit int (little-endian per Iff::read_int32). */
  readInt32(): number {
    this.assertChunk('readInt32');
    this.ensureRemaining(4);
    const v = this.view.getInt32(this.chunkCursor, true);
    this.chunkCursor += 4;
    return v;
  }

  /** Read a 32-bit IEEE-754 float (little-endian per Iff::read_float). */
  readFloat32(): number {
    this.assertChunk('readFloat32');
    this.ensureRemaining(4);
    const v = this.view.getFloat32(this.chunkCursor, true);
    this.chunkCursor += 4;
    return v;
  }

  /**
   * Read a NUL-terminated ASCII string from the current chunk. The C++
   * `Iff::read_string` is exactly this — `\0` terminator, no length prefix.
   */
  readCString(): string {
    this.assertChunk('readCString');
    const top = this.top();
    let nul = -1;
    for (let i = this.chunkCursor; i < top.payloadEnd; ++i) {
      if (this.bytes[i] === 0) {
        nul = i;
        break;
      }
    }
    if (nul < 0) {
      throw new Error(
        `readCString: no NUL terminator found before chunk end (offset 0x${this.chunkCursor.toString(16)})`,
      );
    }
    const out = new TextDecoder('latin1').decode(this.bytes.subarray(this.chunkCursor, nul));
    this.chunkCursor = nul + 1;
    return out;
  }

  /** Bytes left in the current chunk (== 0 means fully consumed). */
  chunkBytesRemaining(): number {
    this.assertChunk('chunkBytesRemaining');
    return this.top().payloadEnd - this.chunkCursor;
  }

  /** The sub-tag of the top-most FORM frame (e.g. 'PTAT'). */
  currentFormSubTag(): number {
    const top = this.top();
    if (!top.isForm || top.subTag === undefined) {
      throw new Error('currentFormSubTag: current frame is not a FORM');
    }
    return top.subTag;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private top(): Frame {
    const f = this.stack[this.stack.length - 1];
    if (f === undefined) throw new Error('IFF stack underflow');
    return f;
  }

  private assertChunk(method: string): void {
    if (this.top().isForm) {
      throw new Error(`${method}: current frame is a FORM, not a chunk`);
    }
  }

  private ensureRemaining(n: number): void {
    if (this.chunkBytesRemaining() < n) {
      throw new Error(
        `chunk underflow: need ${n} bytes but only ${this.chunkBytesRemaining()} remain`,
      );
    }
  }

  /**
   * Offset where the *next* block (FORM or chunk) inside the current frame
   * begins. We don't keep an explicit per-frame "next" cursor because the
   * descent pattern only ever reads one block per frame entry — but we DO
   * support sequential enterForm/enterChunk calls within the same parent,
   * which means after an exit we need to remember where the just-popped
   * frame ended. We track that via `payloadEnd` of the previously-popped
   * frame: simpler to just maintain a per-frame cursor on the parent.
   *
   * Implementation: when a child is pushed, the parent's "next block offset"
   * advances to `child.payloadEnd`. When a child is popped, the parent's
   * cursor sits at `child.payloadEnd` (= the next block's start). We model
   * this by mutating the parent's payloadStart? No — easier: keep a parallel
   * map of "next-block cursor" keyed by stack depth.
   *
   * For the metadata reader's read pattern (just `enterForm > enterForm >
   * enterChunk DATA` once) we don't need sequential same-level reads, so
   * keep this implementation simple: next block starts at the parent's
   * `payloadStart` if no child has been entered yet, otherwise at the
   * previously-entered child's `payloadEnd`. We track the per-parent cursor
   * lazily.
   */
  private parentCursors = new WeakMap<Frame, { next: number }>();

  private nextBlockOffset(): number {
    const parent = this.top();
    let cursor = this.parentCursors.get(parent);
    if (cursor === undefined) {
      cursor = { next: parent.payloadStart };
      this.parentCursors.set(parent, cursor);
    }
    return cursor.next;
  }

  /** Read 8-byte BE header (tag + length) and bump parent's cursor. */
  private readBlockHeader(at: number): { tag: number; length: number; payloadStart: number } {
    if (at + 8 > this.top().payloadEnd) {
      throw new Error(
        `readBlockHeader: truncated header at offset 0x${at.toString(16)} (only ${
          this.top().payloadEnd - at
        } bytes left in parent)`,
      );
    }
    const tag = this.view.getUint32(at, false); // BE
    const length = this.view.getUint32(at + 4, false); // BE
    const payloadStart = at + 8;
    // Bump parent cursor past this whole block so the next enter* call lands
    // on the following sibling.
    const cursor = this.parentCursors.get(this.top());
    if (cursor !== undefined) {
      cursor.next = payloadStart + length;
    }
    return { tag, length, payloadStart };
  }

  /**
   * Confirms the first 4 file bytes are `FORM`. Useful for early validation
   * before descending — if this fails the file is not IFF at all.
   */
  hasFormHeader(): boolean {
    if (this.bytes.byteLength < 4) return false;
    for (let i = 0; i < 4; ++i) {
      if (this.bytes[i] !== FORM_TAG_BE_BYTES[i]) return false;
    }
    return true;
  }
}
