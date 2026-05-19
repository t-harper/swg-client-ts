/**
 * `.stf` (localized string table) reader.
 *
 * # Format note
 *
 * Despite living in `src/iff/`, a `.stf` file is **not** an SOE IFF — it's a
 * flat little-endian binary blob with a 5-byte header (`magic + version`)
 * followed by two arrays:
 *
 *   1. The string table — `numEntries` records of `{ id, sourceCrc, wideStr }`.
 *   2. The name lookup table — `numEntries` records of `{ id, narrowStr }`,
 *      where `narrowStr` is the script-facing key (e.g. `"declared_residence"`).
 *
 * It lives next to the IFF reader because callers consume both kinds of
 * SWG data assets from the same import surface.
 *
 * # C++ ground truth
 *
 *   - `~/code/swg-main/src/external/ours/library/localization/src/shared/LocalizedStringTable.cpp`
 *     — `LocalizedStringTable::load_0000` (line ~141) and `load_0001` (line ~230);
 *       both share the same shape, the version byte is the only signal.
 *       The magic constant `0xabcd` is defined as `magic_type = long` at line ~80
 *       (the type is `long`, which is 32-bit on the original Win32 client ABI).
 *   - `~/code/swg-main/src/external/ours/library/localization/src/shared/LocalizedString.cpp`
 *     — `LocalizedString::load_0000` (line ~178) and `load_0001` (line ~233);
 *       both read `[u32 id][u32 crcOrTime][u32 buflen][buflen * u16 chars]`.
 *       v0 has an unused timestamp word; v1 carries `sourceCrc` in the same
 *       slot. We don't expose either value (callers want key→value only).
 *   - `~/code/swg-main/src/external/ours/library/unicode/src/shared/Unicode.h:28`
 *     — `unicode_char_t = unsigned short` (16-bit, UTF-16 LE on disk).
 *
 * # Wire layout
 *
 * Bytes 0..3: `magic` (u32 LE) — must be 0x0000abcd
 * Byte  4:    `version` (u8) — 0 or 1
 * Bytes 5..8: `nextUniqueId` (u32 LE) — informational, kept on the table
 * Bytes 9..12: `numEntries` (u32 LE)
 *
 * Then `numEntries` string records, each:
 *   `[u32 LE id][u32 LE crcOrTime][u32 LE wideLen][wideLen * u16 LE chars]`
 *
 * Then `numEntries` name records, each:
 *   `[u32 LE id][u32 LE narrowLen][narrowLen bytes ASCII]`
 *
 * # Verified against
 *
 *   - `tests/fixtures/stf-hair-lookat-en.stf` — 1 entry, `default → "hair"`.
 *   - `tests/fixtures/stf-pvp-factions-en.stf` — 3 entries, all ASCII.
 *   - `tests/fixtures/stf-chat-format-abbrevs-ja.stf` — 1 entry, wide chars
 *     in the value (Japanese katakana / kanji).
 */

/**
 * Parsed contents of one `.stf` file — a flat key → localized string map.
 * The order of entries is the on-disk order so callers can re-emit
 * deterministically.
 */
export interface StfTable {
  /**
   * Language code from the IFF metadata (e.g. `'en'`). The C++ file format
   * does NOT carry a language code — the language is implicit in the file
   * path (`string/<lang>/<file>.stf`). Callers that need to remember the
   * language should set it themselves; the bare reader leaves this empty.
   */
  language: string;
  /** key → string. Empty for missing entries. Insertion order matches on-disk. */
  entries: ReadonlyMap<string, string>;
}

/** Sentinel magic value — `LocalizedStringTable::ms_MAGIC` (Win32 `long` = u32 LE). */
const STF_MAGIC = 0xabcd;
const HEADER_SIZE = 5; // u32 magic + u8 version
const TABLE_HEADER_SIZE = 8; // u32 nextUniqueId + u32 numEntries

/**
 * Parse a `.stf` file from raw bytes. Throws on malformed input — never
 * returns null (callers handle file-not-found at the asset-loader layer).
 *
 * The returned table's `language` is always the empty string; the file
 * format itself doesn't carry the language code (it's implicit in the
 * `string/<lang>/<file>.stf` path), so callers that care should set it
 * after parsing.
 */
export function parseStf(bytes: Uint8Array): StfTable {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes.byteLength < HEADER_SIZE) {
    throw new Error(
      `parseStf: truncated header — expected at least ${HEADER_SIZE} bytes, got ${bytes.byteLength}`,
    );
  }

  const magic = view.getUint32(0, /* littleEndian */ true);
  if (magic !== STF_MAGIC) {
    throw new Error(
      `parseStf: bad magic 0x${magic.toString(16).padStart(8, '0')} (expected 0x0000abcd)`,
    );
  }

  const version = view.getUint8(4);
  if (version !== 0 && version !== 1) {
    throw new Error(`parseStf: unsupported version ${version} (expected 0 or 1)`);
  }

  if (bytes.byteLength < HEADER_SIZE + TABLE_HEADER_SIZE) {
    throw new Error(
      `parseStf: truncated table header — expected at least ${HEADER_SIZE + TABLE_HEADER_SIZE} bytes, got ${bytes.byteLength}`,
    );
  }

  // `nextUniqueId` is informational and not exposed; we still read it to
  // advance the cursor and to validate the structure.
  void view.getUint32(HEADER_SIZE, true);
  const numEntries = view.getUint32(HEADER_SIZE + 4, true);

  // Bound the entry count against the buffer size: every entry is at minimum
  // (4 id + 4 crc + 4 len) = 12 bytes in the string table plus (4 id + 4 len)
  // = 8 bytes in the name table = 20 bytes per entry. This catches a
  // corrupted-header denial-of-service before we allocate gigabytes.
  const minTableBytes = numEntries * 20;
  if (numEntries > 0 && minTableBytes > bytes.byteLength - HEADER_SIZE - TABLE_HEADER_SIZE) {
    throw new Error(
      `parseStf: numEntries=${numEntries} exceeds available bytes (file has ${bytes.byteLength} bytes total)`,
    );
  }

  let off = HEADER_SIZE + TABLE_HEADER_SIZE;

  // ── String table: id → wide string ────────────────────────────────────
  const idToValue = new Map<number, string>();
  for (let i = 0; i < numEntries; ++i) {
    if (off + 12 > bytes.byteLength) {
      throw new Error(
        `parseStf: truncated string record ${i} at offset ${off} (need 12 header bytes)`,
      );
    }
    const id = view.getUint32(off, true);
    off += 4;
    // crcOrTime: discarded — v0 has `dummy_time`, v1 has `sourceCrc`. We
    // don't surface either to callers.
    off += 4;
    const wideLen = view.getUint32(off, true);
    off += 4;
    const wideBytes = wideLen * 2;
    if (off + wideBytes > bytes.byteLength) {
      throw new Error(
        `parseStf: truncated wide string in record ${i} (id=${id}) — wanted ${wideBytes} bytes at offset ${off}, only ${bytes.byteLength - off} remain`,
      );
    }
    let value = '';
    for (let j = 0; j < wideLen; ++j) {
      value += String.fromCharCode(view.getUint16(off, true));
      off += 2;
    }
    if (idToValue.has(id)) {
      throw new Error(`parseStf: duplicate string id ${id}`);
    }
    idToValue.set(id, value);
  }

  // ── Name table: id → narrow key ───────────────────────────────────────
  // Preserve on-disk order for deterministic emit.
  const entries = new Map<string, string>();
  for (let i = 0; i < numEntries; ++i) {
    if (off + 8 > bytes.byteLength) {
      throw new Error(
        `parseStf: truncated name record ${i} at offset ${off} (need 8 header bytes)`,
      );
    }
    const id = view.getUint32(off, true);
    off += 4;
    const narrowLen = view.getUint32(off, true);
    off += 4;
    if (off + narrowLen > bytes.byteLength) {
      throw new Error(
        `parseStf: truncated narrow name in record ${i} (id=${id}) — wanted ${narrowLen} bytes at offset ${off}, only ${bytes.byteLength - off} remain`,
      );
    }
    let key = '';
    for (let j = 0; j < narrowLen; ++j) {
      key += String.fromCharCode(view.getUint8(off));
      off += 1;
    }
    const value = idToValue.get(id);
    if (value === undefined) {
      throw new Error(
        `parseStf: name record ${i} references unknown string id ${id} (key="${key}")`,
      );
    }
    if (entries.has(key)) {
      throw new Error(`parseStf: duplicate name "${key}"`);
    }
    entries.set(key, value);
  }

  return { language: '', entries };
}
