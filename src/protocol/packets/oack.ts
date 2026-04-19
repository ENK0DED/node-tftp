import type { OackPacket, OackWritableExtensions } from '../../../types/index.js';
import { EDENY } from '../errors.js';
import { opcodes } from '../utils.js';
import { readString } from './read-string.js';

export const oack = {
  deserialize: (buffer: Buffer): OackPacket => {
    const extensions: OackPacket = {};
    const o = { offset: 2 };

    while (o.offset < buffer.length) {
      const key = readString(buffer, o).toLowerCase();

      if (key in extensions) {
        throw EDENY;
      }

      extensions[key] = readString(buffer, o);
    }

    return extensions;
  },
  serialize: (extensions: OackWritableExtensions) => {
    // Pre-stringify values once so we can both size the buffer and write it
    // in a single pass without re-allocating.
    const entries: [string, string][] = [];
    let bytes = 2;

    for (const [key, value] of Object.entries(extensions)) {
      const normalizedKey = key.toLowerCase();
      const stringValue = String(value);
      bytes += 2 + normalizedKey.length + stringValue.length;
      entries.push([normalizedKey, stringValue]);
    }

    // Every byte (header + each key + NUL + each value + NUL) is written
    // below, so allocUnsafe is safe.
    const buffer = Buffer.allocUnsafe(bytes);
    buffer.writeUInt16BE(opcodes.OACK, 0);

    let offset = 2;

    for (const [key, value] of entries) {
      offset += buffer.write(key, offset, 'ascii');
      buffer[offset] = 0;
      offset += 1;
      offset += buffer.write(value, offset, 'ascii');
      buffer[offset] = 0;
      offset += 1;
    }

    return buffer;
  },
};
