import { describe, expect, test } from 'bun:test';

import { ALL_ERROR_NAMES, tftp } from '../helpers.js';

describe('error catalogue', () => {
  test('exposes the full set of names on the protocol error catalogue', () => {
    for (const name of ALL_ERROR_NAMES) {
      expect(tftp.errors[name]).toBeDefined();
    }
  });

  test.each(ALL_ERROR_NAMES)('%s entry has the expected code, name and message shape', (name) => {
    const entry = tftp.errors[name];
    expect(typeof entry.code).toBe('number');
    expect(entry.name).toBe(name);
    expect(typeof entry.message).toBe('string');
  });

  test('the TFTP RFC error codes (1..8) are reserved by the expected names', () => {
    const rfcNames: [number, string][] = [
      [1, 'ENOENT'],
      [2, 'EACCESS'],
      [3, 'ENOSPC'],
      [4, 'EBADOP'],
      [5, 'ETID'],
      [6, 'EEXIST'],
      [7, 'ENOUSER'],
      [8, 'EDENY'],
    ];

    for (const [code, name] of rfcNames) {
      expect((tftp.errors as Record<string, { code: number }>)[name].code).toBe(code);
    }
  });

  test('wrap() resolves a known message back to its numeric code', () => {
    const { message } = tftp.errors.ENOENT;
    expect(tftp.wrap(message)).toEqual({ code: 1, message, name: undefined });
  });

  test('wrap() defaults to code 0 for unknown messages', () => {
    const unknown = 'totally-unknown-error-message-xyz';
    expect(tftp.wrap(unknown).code).toBe(0);
  });
});

describe('error exposure on the public package entry', () => {
  test('package entry exposes error code objects ({code,name,message})', () => {
    for (const name of ALL_ERROR_NAMES) {
      const entry = tftp.errors[name];
      expect(entry).toBeDefined();
      expect(entry.code).toBe(tftp.errors[name].code);
      expect(entry.name).toBe(name);
      expect(entry.message).toBe(tftp.errors[name].message);
    }
  });
});
