/**
 * SWG/SOE CRC32 implementation.
 *
 * Maps directly to:
 *   /home/tharper/code/swg-main/src/external/3rd/library/udplibrary/UdpLibrary.cpp
 *   `UdpMisc::Crc32(buffer, bufferLen, encryptValue)` (lines 4146-4209).
 *
 * Uses the standard zlib CRC-32 lookup table (polynomial 0xEDB88320) but the
 * initial value 0xffffffff is first scrambled with the 4 little-endian bytes of
 * `encryptValue` before consuming the actual buffer.
 *
 * The crc is appended to every encrypted SOE packet, big-endian. The number of
 * bytes appended is `crcBytes` (1..4), so on receive we drop the low N bytes of
 * the 32-bit crc value, big-endian.
 */

/** Standard CRC-32 lookup table (polynomial 0xEDB88320), used by zlib & UdpLibrary. */
const CRC32_TABLE: ReadonlyArray<number> = (() => {
  const table = new Array<number>(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Compute the SWG-style CRC32 of `buffer`, scrambling the seed with
 * `encryptValue` first (little-endian byte order).
 *
 * Returns a uint32 (0..0xFFFFFFFF).
 */
export function crc32(buffer: Uint8Array, encryptValue: number): number {
  let crc = 0xffffffff;

  // Mix the 4 bytes of encryptValue into the seed (little-endian: LSB first)
  // Matches lines 4194-4197 of UdpLibrary.cpp.
  const ev = encryptValue >>> 0;
  for (let shift = 0; shift < 32; shift += 8) {
    const b = (ev >>> shift) & 0xff;
    const tableIdx = (crc ^ b) & 0xff;
    const tableVal = CRC32_TABLE[tableIdx];
    if (tableVal === undefined) throw new Error('crc32 table lookup failed (impossible)');
    crc = (((crc >>> 8) & 0x00ffffff) ^ tableVal) >>> 0;
  }

  // Now run the actual buffer bytes
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    if (b === undefined) throw new Error('crc32 buffer index undefined (impossible)');
    const tableIdx = (crc ^ b) & 0xff;
    const tableVal = CRC32_TABLE[tableIdx];
    if (tableVal === undefined) throw new Error('crc32 table lookup failed (impossible)');
    crc = (((crc >>> 8) & 0x00ffffff) ^ tableVal) >>> 0;
  }

  // Final bitwise NOT, then mask to uint32
  return ~crc >>> 0;
}

/**
 * Append the low `crcBytes` bytes of `crc32(buffer, encryptValue)` to `buffer`
 * (big-endian), returning a new array.
 *
 * Matches UdpLibrary.cpp lines 2518-2546 (PutValue16/24/32 are big-endian).
 */
export function appendCrc(buffer: Uint8Array, encryptValue: number, crcBytes: number): Uint8Array {
  if (crcBytes < 0 || crcBytes > 4) {
    throw new RangeError(`crcBytes must be 0..4, got ${crcBytes}`);
  }
  const crc = crc32(buffer, encryptValue);
  const out = new Uint8Array(buffer.length + crcBytes);
  out.set(buffer, 0);
  switch (crcBytes) {
    case 0:
      break;
    case 1:
      out[buffer.length] = crc & 0xff;
      break;
    case 2:
      out[buffer.length] = (crc >>> 8) & 0xff;
      out[buffer.length + 1] = crc & 0xff;
      break;
    case 3:
      out[buffer.length] = (crc >>> 16) & 0xff;
      out[buffer.length + 1] = (crc >>> 8) & 0xff;
      out[buffer.length + 2] = crc & 0xff;
      break;
    case 4:
      out[buffer.length] = (crc >>> 24) & 0xff;
      out[buffer.length + 1] = (crc >>> 16) & 0xff;
      out[buffer.length + 2] = (crc >>> 8) & 0xff;
      out[buffer.length + 3] = crc & 0xff;
      break;
  }
  return out;
}

/**
 * Verify that the last `crcBytes` of `packet` match the expected CRC of
 * `packet[:-crcBytes]` under `encryptValue`. Returns true if OK.
 *
 * If `crcBytes == 0`, always returns true.
 */
export function verifyCrc(packet: Uint8Array, encryptValue: number, crcBytes: number): boolean {
  if (crcBytes === 0) return true;
  if (crcBytes < 0 || crcBytes > 4) {
    throw new RangeError(`crcBytes must be 0..4, got ${crcBytes}`);
  }
  if (packet.length < crcBytes) return false;

  const bodyLen = packet.length - crcBytes;
  const body = packet.subarray(0, bodyLen);
  const expected = crc32(body, encryptValue);

  // Compare low `crcBytes` bytes, big-endian
  let mask = 0;
  switch (crcBytes) {
    case 1:
      mask = 0xff;
      break;
    case 2:
      mask = 0xffff;
      break;
    case 3:
      mask = 0xffffff;
      break;
    case 4:
      mask = 0xffffffff;
      break;
  }
  let actual = 0;
  for (let i = 0; i < crcBytes; i++) {
    const b = packet[bodyLen + i];
    if (b === undefined) return false;
    actual = ((actual << 8) | b) >>> 0;
  }
  return (expected & mask) >>> 0 === (actual & mask) >>> 0;
}
