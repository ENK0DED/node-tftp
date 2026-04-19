import { describe, expect, test } from 'bun:test';

import { tftp } from '../helpers.js';

describe('normalizeFilename', () => {
  test('normalises relative segments while preserving the final relative path', () => {
    const cases = ['file.bin', 'sub/file.bin', './file.bin', 'a/./b/c', 'a/b/../c'];
    expect(cases.map((input) => tftp.normalizeFilename(input))).toEqual(['file.bin', 'sub/file.bin', 'file.bin', 'a/b/c', 'a/c']);
  });

  test('rejects paths trying to escape the root with `..`', () => {
    for (const input of ['../etc/passwd', '../../foo', '..']) {
      expect(() => tftp.normalizeFilename(input)).toThrow();
    }
  });

  test('preserves absolute ASCII paths for interoperable remote filenames', () => {
    expect(tftp.normalizeFilename('/tmp/file.bin')).toBe('/tmp/file.bin');
  });

  test('rejects multibyte filenames', () => {
    expect(() => tftp.normalizeFilename('naïve.txt')).toThrow(/multibyte/);
  });

  test('preserves nested ASCII path segments unchanged', () => {
    expect(tftp.normalizeFilename('foo/bar/baz.bin')).toBe('foo/bar/baz.bin');
  });
});
