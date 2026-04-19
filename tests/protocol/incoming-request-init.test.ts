import { describe, expect, test } from 'bun:test';
import type { RemoteInfo, Socket } from 'node:dgram';

import { createReader } from '../../src/protocol/reader.js';
import { Helper } from '../../src/protocol/request.js';
import { createOptions } from '../../src/protocol/utils.js';
import { createWriter } from '../../src/protocol/writer.js';
import { IncomingRequest } from '../../src/streams/server/incoming-request.js';
import type { SocketFamily } from '../../types/index.js';

const remoteInfo: RemoteInfo = { address: '127.0.0.1', family: 'IPv4', port: 1069, size: 4 };

const captureStartError = async (request: { onError: (error: Error) => void; start: () => Promise<void> }) => {
  const deferred = Promise.withResolvers<Error>();
  request.onError = (error) => deferred.resolve(error);
  await request.start();
  return deferred.promise;
};

const createArgs = (): ConstructorParameters<typeof IncomingRequest>[0] => ({
  globalOptions: createOptions({}, 'server'),
  helper: new Helper(remoteInfo, 4 as SocketFamily),
  // oxlint-disable-next-line unicorn/no-null
  message: { extensions: null, file: 'fixture.bin', userExtensions: {} },
});

class FailingReader extends createReader(IncomingRequest) {
  // oxlint-disable-next-line class-methods-use-this
  async bindSocketAndContinue(_socket: Socket) {
    throw new Error('reader init failed');
  }
}

class FailingWriter extends createWriter(IncomingRequest) {
  // oxlint-disable-next-line class-methods-use-this
  async bindSocketAndContinue(_socket: Socket) {
    throw new Error('writer init failed');
  }
}

describe('IncomingRequest startup', () => {
  test('reader start forwards async init failures through onError', async () => {
    const reader = new FailingReader({ ...createArgs(), reader: true });
    const error = await captureStartError(reader);
    expect(error.message).toBe('reader init failed');
  });

  test('writer start forwards async init failures through onError', async () => {
    const writer = new FailingWriter(createArgs());
    const error = await captureStartError(writer);
    expect(error.message).toBe('writer init failed');
  });
});
