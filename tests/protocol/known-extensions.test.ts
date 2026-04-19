import { describe, expect, test } from 'bun:test';

import { EXPECTED_EXTENSIONS, tftp } from '../helpers.js';

describe('known TFTP extensions table', () => {
  test('lists the well-known TFTP extension names', () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect((Object.keys(tftp.knownExtensions) as (keyof typeof tftp.knownExtensions)[]).toSorted()).toEqual(EXPECTED_EXTENSIONS);
  });

  test('marks every entry as truthy', () => {
    for (const key of EXPECTED_EXTENSIONS) {
      expect(tftp.knownExtensions[key]).toBe(true);
    }
  });
});
