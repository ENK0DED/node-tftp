import { describe, expect, test } from 'bun:test';

import { tftp } from '../helpers.js';

describe('opcodes', () => {
  test('numbers match the TFTP specification', () => {
    expect(tftp.opcodes).toMatchObject({ ACK: 4, DATA: 3, ERROR: 5, OACK: 6, RRQ: 1, WRQ: 2 });
  });
});
