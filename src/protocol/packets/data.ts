import { EBADMSG } from '../errors.js';
import { opcodes } from '../utils.js';

export const data = {
  deserialize: (buffer: Buffer, blockSize: number) => {
    const dataBuffer = buffer.subarray(4);

    if (dataBuffer.length > blockSize) {
      throw EBADMSG;
    }

    return { block: buffer.readUInt16BE(2), data: dataBuffer };
  },
  serialize: (block: number, dataBuffer: Buffer) => {
    // The header (4 bytes) plus the entire data payload are written below,
    // so Buffer.allocUnsafe is safe and skips the per-block memset of up to
    // 65 KiB that Buffer.alloc would do.
    const buffer = Buffer.allocUnsafe(4 + dataBuffer.length);

    buffer.writeUInt16BE(opcodes.DATA, 0);
    buffer.writeUInt16BE(block, 2);

    if (dataBuffer.length) {
      dataBuffer.copy(buffer, 4);
    }

    return buffer;
  },
};
