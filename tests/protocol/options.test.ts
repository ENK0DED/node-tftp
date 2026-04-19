import { describe, expect, test } from 'bun:test';

import { tftp } from '../helpers.js';

describe('createOptions (client)', () => {
  test('default values use RFC-sized timeout negotiation', () => {
    const options = tftp.createOptions({}, 'client');

    expect(options.address).toBe('localhost');
    expect(options.port).toBe(69);
    expect(options.retries).toBe(3);
    expect(options.extensions).toEqual({ blksize: 1468, rollover: 0, timeout: 3, windowsize: 4 });
    expect(options.extensionsString).toEqual({ blksize: '1468', rollover: '0', timeout: '3', windowsize: '4' });
    expect(options.extensionsLength).toBe(54);
  });

  test('honours user-provided extension values', () => {
    const options = tftp.createOptions({ blockSize: 1024, host: '10.0.0.1', port: 6969, retries: 7, timeout: 5, windowSize: 8 }, 'client');

    expect(options).toMatchObject({
      address: '10.0.0.1',
      extensions: { blksize: 1024, rollover: 0, timeout: 5, windowsize: 8 },
      extensionsString: { blksize: '1024', rollover: '0', timeout: '5', windowsize: '8' },
      port: 6969,
      retries: 7,
    });
  });

  test('clamps an out-of-range windowSize back to the safe default', () => {
    const options = tftp.createOptions({ windowSize: 100_000 }, 'client');
    expect(options.extensions.windowsize).toBe(4);
  });

  test('clamps an invalid blockSize back to the safe default', () => {
    const tooSmall = tftp.createOptions({ blockSize: 4 }, 'client');
    const tooLarge = tftp.createOptions({ blockSize: 100_000 }, 'client');
    expect(tooSmall.extensions.blksize).toBe(1468);
    expect(tooLarge.extensions.blksize).toBe(1468);
  });

  test('sanitises non-positive numeric inputs (port, retries)', () => {
    const options = tftp.createOptions({ port: 0, retries: -3 }, 'client');
    expect(options.port).toBeGreaterThanOrEqual(1);
    expect(options.retries).toBeGreaterThanOrEqual(1);
  });

  test('extensionsLength matches the formula `48 + |blksize| + |timeout| + |windowsize|`', () => {
    const options = tftp.createOptions({ blockSize: 1500, timeout: 200, windowSize: 12 }, 'client');
    const expected = 48 + String(options.extensions.blksize).length + String(options.extensions.timeout).length + String(options.extensions.windowsize).length;
    expect(options.extensionsLength).toBe(expected);
  });

  test('clamps invalid timeout values back to the RFC-safe default', () => {
    expect(tftp.createOptions({ timeout: 0 }, 'client').extensions.timeout).toBe(3);
    expect(tftp.createOptions({ timeout: 500 }, 'client').extensions.timeout).toBe(3);
  });
});

describe('createOptions (server)', () => {
  test('adds server-only options on top of the base', () => {
    const options = tftp.createOptions({ root: '/srv/tftp' }, 'server');
    expect(options.root).toBe('/srv/tftp');
  });

  test('default root is "."', () => {
    expect(tftp.createOptions({}, 'server').root).toBe('.');
  });

  test('forwards denyGET / denyPUT flags as-is', () => {
    const options = tftp.createOptions({ denyGET: true, denyPUT: false }, 'server');
    expect(options.denyGET).toBe(true);
    expect(options.denyPUT).toBe(false);
  });
});
