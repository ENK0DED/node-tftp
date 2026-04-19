import type { TFTPError } from '../errors.js';
import { opcodes } from '../utils.js';
import { readString } from './read-string.js';

export const error = {
  deserialize: (buffer: Buffer): Omit<TFTPError, 'name'> => {
    const code = buffer.readUInt16BE(2);
    // Errors with code 0 and no description
    return { code, message: code === 0 && buffer.length === 4 ? '' : readString(buffer, { offset: 4 }) };
  },
  serialize: (obj: Omit<TFTPError, 'name'>) => {
    // 4 header bytes + the message body + 1 NUL terminator are all written
    // below, so allocUnsafe is safe.
    const buffer = Buffer.allocUnsafe(obj.message.length + 5);
    buffer.writeUInt16BE(opcodes.ERROR, 0);
    buffer.writeUInt16BE(obj.code, 2);
    buffer.write(obj.message, 4, 'ascii');
    buffer[buffer.length - 1] = 0;
    return buffer;
  },
};
