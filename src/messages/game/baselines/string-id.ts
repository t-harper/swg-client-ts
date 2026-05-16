/**
 * `StringId` codec — a reference to a localized string in some string table.
 * On the wire it's a triple of `(table, textIndex, text)`.
 *
 * Wire layout (matches C++ `Archive::put(target, StringId)`):
 *   [std::string  table]       — the .stf table filename (relative path, no extension)
 *   [u32          textIndex]   — a lookup hint that lets clients avoid a hash;
 *                                "potentially problematic" per the C++ comment, so it's
 *                                usually 0 in baselines (set on first localize() call).
 *   [std::string  text]        — the entry name within the table
 *
 * A typical example from the game: `{ table: 'first_names', textIndex: 0, text: 'A_Heroic' }`
 * or `{ table: 'obj_n', textIndex: 0, text: 'ship_capital_corellian_corvette_pilot' }`.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/external/ours/library/localizationArchive/src/shared/StringIdArchive.cpp
 *   /home/tharper/code/swg-main/src/external/ours/library/localization/src/shared/StringId.h
 */

import type { IByteStream, ICodec, IReadIterator } from '../../../archive/interface.js';
import { readStdString, writeStdString } from '../../../archive/string.js';

export interface StringIdValue {
  /** Table name (e.g. `'first_names'`, `'obj_n'`). */
  table: string;
  /**
   * Lookup hint set by the server's first `localize()` call. Usually 0 in
   * baselines; treat as informational only.
   */
  textIndex: number;
  /** Entry name within the table. */
  text: string;
}

/** Static "invalid" / empty StringId — both table and text are empty. */
export const EMPTY_STRING_ID: StringIdValue = { table: '', textIndex: 0, text: '' };

export const StringIdCodec: ICodec<StringIdValue> = {
  encode(stream: IByteStream, value: StringIdValue): void {
    writeStdString(stream, value.table);
    stream.writeU32(value.textIndex);
    writeStdString(stream, value.text);
  },
  decode(iter: IReadIterator): StringIdValue {
    const table = readStdString(iter);
    const textIndex = iter.readU32();
    const text = readStdString(iter);
    return { table, textIndex, text };
  },
};
