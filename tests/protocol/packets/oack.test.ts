import { describe, expect, test } from 'bun:test';

import { tftp } from '../../helpers.js';

describe('oack packets', () => {
  test('serialise produces the expected bytes for a typical extension set', () => {
    const extensions = { blksize: 1468, timeout: 3000, tsize: 12_345, windowsize: 4 };
    const buffer = tftp.packets.oack.serialize(extensions);
    expect(buffer).toEqual(Buffer.from('\u0000\u0006blksize\u00001468\u0000timeout\u00003000\u0000tsize\u000012345\u0000windowsize\u00004\u0000', 'binary'));
    expect(buffer.readUInt16BE(0)).toBe(tftp.opcodes.OACK);
  });

  test('serialise emits empty OACK (just opcode) for an empty extension set', () => {
    const buffer = tftp.packets.oack.serialize({});
    expect(buffer).toEqual(Buffer.from([0, tftp.opcodes.OACK]));
    expect(buffer.length).toBe(2);
  });

  test('deserialise returns key/value strings', () => {
    const extensions = { blksize: 1024, timeout: 1500, windowsize: 8 };
    const buffer = tftp.packets.oack.serialize(extensions);
    expect(tftp.packets.oack.deserialize(buffer)).toEqual({ blksize: '1024', timeout: '1500', windowsize: '8' });
  });

  test('deserialise yields string values (not numeric) — round trip', () => {
    const buffer = tftp.packets.oack.serialize({ blksize: 512, timeout: 1000 });
    const out = tftp.packets.oack.deserialize(buffer);
    expect(out.blksize).toBe('512');
    expect(out.timeout).toBe('1000');
  });

  test('user extensions survive a serialise/deserialise round trip', () => {
    const extensions = { blksize: 1024, custom: 'value-123' };
    const buffer = tftp.packets.oack.serialize(extensions);
    expect(tftp.packets.oack.deserialize(buffer)).toEqual({ blksize: '1024', custom: 'value-123' });
  });

  test('deserialise normalises mixed-case option names to lowercase', () => {
    const buffer = Buffer.from('\u0000\u0006BLKSIZE\u00001024\u0000TimeOut\u00007\u0000X-Custom\u0000ok\u0000', 'binary');
    expect(tftp.packets.oack.deserialize(buffer)).toEqual({ blksize: '1024', timeout: '7', 'x-custom': 'ok' });
  });

  test('deserialise rejects duplicate option names case-insensitively', () => {
    const buffer = Buffer.from('\u0000\u0006blksize\u00001024\u0000BLKSIZE\u00002048\u0000', 'binary');
    expect(() => tftp.packets.oack.deserialize(buffer)).toThrow();
  });
});
