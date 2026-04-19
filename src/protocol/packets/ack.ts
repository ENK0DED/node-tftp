import { opcodes } from '../utils.js';

export const ack = {
  deserialize: (buffer: Buffer) => ({ block: buffer.readUInt16BE(2) }),
  serialize: (block: number) => {
    // All 4 bytes are written below, so the zero-fill from Buffer.alloc is
    // wasted work — Buffer.allocUnsafe pulls from a pre-allocated pool and
    // avoids both the malloc and the memset.
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt16BE(opcodes.ACK, 0);
    buffer.writeUInt16BE(block, 2);
    return buffer;
  },
};
