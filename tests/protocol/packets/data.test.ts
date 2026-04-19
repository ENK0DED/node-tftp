import { describe, expect, test } from 'bun:test';

import { tftp } from '../../helpers.js';

const sampleData = (size: number, fill = 0x41) => Buffer.alloc(size, fill);

describe('data packets', () => {
  test.each([0, 1, 16, 512, 1468])('serialise produces the expected wire bytes for %d-byte payloads', (size) => {
    const block = 5;
    const payload = sampleData(size);
    const buffer = tftp.packets.data.serialize(block, payload);
    expect(buffer).toEqual(Buffer.concat([Buffer.from([0, tftp.opcodes.DATA, 0, block]), payload]));
    // Empty payload still emits the 4-byte header
    expect(buffer.length).toBe(size === 0 ? 4 : 4 + size);
  });

  test('header layout is opcode (3) followed by big-endian block number', () => {
    const buffer = tftp.packets.data.serialize(1234, sampleData(2));
    expect(buffer.readUInt16BE(0)).toBe(tftp.opcodes.DATA);
    expect(buffer.readUInt16BE(2)).toBe(1234);
  });

  test('deserialise returns the decoded {block, data}', () => {
    const block = 9;
    const payload = sampleData(64, 0x55);
    const buffer = tftp.packets.data.serialize(block, payload);
    expect(tftp.packets.data.deserialize(buffer, 512)).toEqual({ block, data: payload });
  });

  test('rejects payloads that exceed the negotiated blockSize', () => {
    const buffer = tftp.packets.data.serialize(1, sampleData(513));
    expect(() => tftp.packets.data.deserialize(buffer, 512)).toThrow();
  });
});
