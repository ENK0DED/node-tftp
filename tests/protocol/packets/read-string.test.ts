import { describe, expect, test } from 'bun:test';

import { tftp } from '../../helpers.js';

const buf = (s: string) => Buffer.from(`${s}\u0000`, 'ascii');

describe('readString', () => {
  test('reads a single NUL-terminated ASCII string and advances the cursor', () => {
    const buffer = buf('hello');
    const offset = { offset: 0 };
    expect(tftp.readString(buffer, offset)).toBe('hello');
    expect(offset.offset).toBe(buffer.length);
  });

  test('reads multiple successive strings sharing one cursor', () => {
    const buffer = Buffer.concat([buf('octet'), buf('blksize'), buf('1024')]);
    const offset = { offset: 0 };
    const expectedSequence = ['octet', 'blksize', '1024'];

    for (const expected of expectedSequence) {
      expect(tftp.readString(buffer, offset)).toBe(expected);
    }

    expect(offset.offset).toBe(buffer.length);
  });

  test('throws EBADMSG when the string is not NUL-terminated', () => {
    const buffer = Buffer.from('truncated', 'ascii');
    expect(() => tftp.readString(buffer, { offset: 0 })).toThrow();
  });

  test('returns an empty string when the cursor sits on a terminator', () => {
    const buffer = Buffer.from([0x00, 0x41, 0x00]);
    const offset = { offset: 0 };
    expect(tftp.readString(buffer, offset)).toBe('');
    expect(offset.offset).toBe(1);
  });
});
