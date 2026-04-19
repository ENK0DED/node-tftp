import { describe, expect, test } from 'bun:test';

import { allocPort, tftp } from '../helpers.js';

describe('package public surface', () => {
  test('package entry exposes Client and Server constructors', () => {
    expect(typeof tftp.Client).toBe('function');
    expect(typeof tftp.Server).toBe('function');
  });

  test('Client instance has all transfer methods', () => {
    const client = new tftp.Client({ host: '127.0.0.1', port: allocPort() });

    for (const method of ['get', 'put', 'asyncGet', 'asyncPut']) {
      // @ts-expect-error because we're accessing the methods dynamically
      expect(typeof client[method]).toBe('function');
    }
  });

  test('Server instance has listen and close', async () => {
    const server = new tftp.Server({ host: '127.0.0.1', port: allocPort(), root: '.' });

    expect(typeof server.listen).toBe('function');
    expect(typeof server.close).toBe('function');

    await server.listen();
    await server.close();
  });
});
