import { describe, expect, test } from 'bun:test';

import { tftp } from '../../helpers.js';

describe('ack packets', () => {
  test.each([0, 1, 100, 32_767, 65_535])('serialise(block=%d) produces the RFC1350 wire format', (block) => {
    const buffer = tftp.packets.ack.serialize(block);
    // oxlint-disable-next-line no-bitwise
    expect(buffer).toEqual(Buffer.from([0, tftp.opcodes.ACK, block >> 8, block & 0xff]));
  });

  test('the wire format is exactly 4 bytes: opcode (4) + block', () => {
    const buffer = tftp.packets.ack.serialize(7);
    expect(buffer.length).toBe(4);
    expect(buffer.readUInt16BE(0)).toBe(tftp.opcodes.ACK);
    expect(buffer.readUInt16BE(2)).toBe(7);
  });

  test('deserialise returns the decoded block number', () => {
    const buffer = Buffer.from([0, tftp.opcodes.ACK, 0, 42]);
    expect(tftp.packets.ack.deserialize(buffer)).toEqual({ block: 42 });
  });

  test('deserialise round-trips through serialise', () => {
    for (const block of [0, 1, 65_535]) {
      const buffer = tftp.packets.ack.serialize(block);
      expect(tftp.packets.ack.deserialize(buffer)).toEqual({ block });
    }
  });
});
