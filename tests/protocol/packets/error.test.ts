import { describe, expect, test } from 'bun:test';

import { tftp } from '../../helpers.js';

describe('error packets', () => {
  test('serialise produces the RFC1350 wire bytes for an RFC1350 error', () => {
    const obj = { code: 1, message: 'File not found' };
    const buffer = tftp.packets.error.serialize(obj);

    expect(buffer).toEqual(Buffer.from('\u0000\u0005\u0000\u0001File not found\u0000', 'binary'));
    // ERROR layout: opcode(2) | code(2) | message(N) | NUL(1)
    expect(buffer.length).toBe(2 + 2 + obj.message.length + 1);
    expect(buffer.readUInt16BE(0)).toBe(tftp.opcodes.ERROR);
    expect(buffer.readUInt16BE(2)).toBe(1);
    expect(buffer[buffer.length - 1]).toBe(0);
  });

  test('serialise produces bytes for a custom message (code 0)', () => {
    const obj = { code: 0, message: 'Custom transient failure' };
    expect(tftp.packets.error.serialize(obj)).toEqual(Buffer.from('\u0000\u0005\u0000\u0000Custom transient failure\u0000', 'binary'));
  });

  test('deserialise returns the decoded {code, message} pair', () => {
    const buffer = tftp.packets.error.serialize({ code: 5, message: 'Unknown transfer ID' });
    const output = tftp.packets.error.deserialize(buffer);
    expect(output.code).toBe(5);
    expect(output.message).toBe('Unknown transfer ID');
  });

  test('handles the special "code 0 with no description" form', () => {
    // Spec edge-case: a 4-byte ERROR packet with code 0 means "no description"
    const buffer = Buffer.from([0, 5, 0, 0]);
    expect(tftp.packets.error.deserialize(buffer)).toEqual({ code: 0, message: '' });
  });
});
