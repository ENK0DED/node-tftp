import { EBADMSG } from '../errors.js';

/**
 * Read a NUL-terminated string out of `buffer`, advancing `obj.offset` past
 * the terminator. Throws `EBADMSG` if the terminator is missing.
 *
 * The earlier implementation iterated byte-by-byte and built the string
 * through `String.fromCharCode`, which on long extension strings (and on the
 * filename) was several times slower than delegating to Buffer's native
 * decoder.
 *
 * IMPORTANT: we decode as `latin1` (a.k.a. `binary`), not `ascii`.  TFTP
 * filenames go through `normalizeFilename`, which compares
 * `Buffer.byteLength(str)` to `str.length` to reject multi-byte payloads —
 * this only works when bytes ≥ 0x80 are preserved as the corresponding U+00XX
 * code point, which is exactly what `fromCharCode(byte)` and
 * `Buffer.toString('latin1')` both do.  `'ascii'` instead masks the high bit
 * and would silently flatten a UTF-8 filename into garbled 7-bit ASCII,
 * breaking the multibyte check.
 */
export const readString = (buffer: Buffer, obj: { offset: number }) => {
  const start = obj.offset;
  const limit = buffer.length;
  let end = start;

  while (end < limit && buffer[end] !== 0) {
    end += 1;
  }

  if (end === limit) {
    throw EBADMSG;
  }

  obj.offset = end + 1;
  return buffer.toString('latin1', start, end);
};
