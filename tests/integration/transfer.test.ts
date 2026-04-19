import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { buffer as readBuffer } from 'node:stream/consumers';
import { setTimeout } from 'node:timers/promises';

import type { GetTransfer } from '../../src/index.js';
import { allocPort, captureError, readTransfer, readWhenComplete, startServer, tftp } from '../helpers.js';

const fixtures = { empty: Buffer.alloc(0), large: Buffer.alloc(60_000, 0x37), multiBlock: Buffer.alloc(5000, 0xab), small: Buffer.from('hello, world\n') };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const fixtureKeys = Object.keys(fixtures) as (keyof typeof fixtures)[];

const exactMultipleFixture = Buffer.alloc(64 * 1024, 0x42);

// oxlint-disable-next-line init-declarations
let scratchRoot: string;
// oxlint-disable-next-line init-declarations
let serverRoot: string;
// oxlint-disable-next-line init-declarations
let clientRoot: string;

const waitForSettledError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch {
    // Some error-path tests only need to ensure the follow-up rejection is drained.
  }
};

const withWorkingDirectory = async <T>(directory: string, run: () => Promise<T>) => {
  const previousDirectory = process.cwd();
  process.chdir(directory);

  try {
    return await run();
  } finally {
    process.chdir(previousDirectory);
  }
};

const drainTransfer = async (transfer: Readable) => readBuffer(transfer);

const readTransferAndDrainDone = async (transfer: GetTransfer) => {
  const closed = once(transfer, 'close');

  try {
    await readTransfer(transfer.body);
  } finally {
    await waitForSettledError(closed);
  }
};

const splitPayload = (payload: Buffer, splitAt: number) => Readable.from([payload.subarray(0, splitAt), payload.subarray(splitAt)]);

const splitPayloadAfterSignal = (firstChunk: Buffer, signal: Promise<void>, secondChunk: Buffer) => {
  const stream = new Readable({
    read() {
      // Chunks are pushed by the setup below.
    },
  });

  const pushRemainingChunk = async () => {
    try {
      await signal;
      stream.push(secondChunk);
      // oxlint-disable-next-line unicorn/no-null
      stream.push(null);
    } catch (error: unknown) {
      stream.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  };

  stream.push(firstChunk);
  // oxlint-disable-next-line no-void
  void pushRemainingChunk();
  return stream;
};

beforeAll(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), 'tftp-tests-'));
  serverRoot = join(scratchRoot, 'server');
  clientRoot = join(scratchRoot, 'client');
  await mkdir(serverRoot, { recursive: true });
  await mkdir(clientRoot, { recursive: true });
  await mkdir(join(serverRoot, 'subdir'), { recursive: true });

  for (const [name, contents] of Object.entries(fixtures)) {
    await writeFile(join(serverRoot, `${name}.bin`), contents);
    await writeFile(join(clientRoot, `${name}.bin`), contents);
  }

  await writeFile(join(serverRoot, 'exact-multiple.bin'), exactMultipleFixture);
  await writeFile(join(clientRoot, 'exact-multiple.bin'), exactMultipleFixture);
});

afterAll(async () => {
  if (scratchRoot) {
    await rm(scratchRoot, { force: true, recursive: true });
  }
});

describe('stream-first client/server transfers', () => {
  test.each(fixtureKeys)('default serve downloads "%s.bin" intact', async (name) => {
    const port = allocPort();
    const server = await startServer({ port, root: serverRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });
    const localPath = join(clientRoot, `get-${name}.bin`);

    try {
      await client.asyncGet(`${name}.bin`, localPath);
      const actual = await readFile(localPath);
      const expected = fixtures[name];
      expect(Buffer.compare(actual, expected)).toBe(0);
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test.each(fixtureKeys)('default serve uploads "%s.bin" intact', async (name) => {
    const port = allocPort();
    const writeRoot = join(scratchRoot, `uploads-${name}`);
    await mkdir(writeRoot, { recursive: true });
    const server = await startServer({ port, root: writeRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });
    const remote = `up-${name}.bin`;

    try {
      await client.asyncPut(join(clientRoot, `${name}.bin`), remote);
      const expected = fixtures[name];
      const written = await readWhenComplete(join(writeRoot, remote), expected.length);
      expect(Buffer.compare(written, expected)).toBe(0);
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test('asyncGet defaults the destination to the remote path and still accepts options only as the third argument', async () => {
    const port = allocPort();
    const server = await startServer({ port, root: serverRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      await withWorkingDirectory(clientRoot, async () => {
        await client.asyncGet('small.bin', undefined, { userExtensions: { trace: 'download' } });
        const actual = await readFile('small.bin');
        expect(Buffer.compare(actual, fixtures.small)).toBe(0);
      });
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test('asyncPut defaults the remote path to the local path and still accepts options only as the third argument', async () => {
    const port = allocPort();
    const writeRoot = join(scratchRoot, 'same-name-upload');
    await mkdir(writeRoot, { recursive: true });
    const server = await startServer({ port, root: writeRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      await withWorkingDirectory(clientRoot, async () => {
        await client.asyncPut('small.bin', undefined, { userExtensions: { trace: 'upload' } });
      });

      const actual = await readWhenComplete(join(writeRoot, 'small.bin'), fixtures.small.length);
      expect(Buffer.compare(actual, fixtures.small)).toBe(0);
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test('get exposes stats, stream body, done, and events', async () => {
    const port = allocPort();
    const server = await startServer({ port, root: serverRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      const transfer = client.get('small.bin');
      let emittedStats = false;
      let emittedDone = false;

      transfer.on('stats', () => {
        emittedStats = true;
      });

      transfer.on('done', () => {
        emittedDone = true;
      });

      const closed = once(transfer, 'close');
      const [stats] = await once(transfer, 'stats');
      const actual = await readTransfer(transfer.body);
      await closed;

      expect(stats.size).toBe(fixtures.small.length);
      expect(Buffer.compare(actual, fixtures.small)).toBe(0);
      expect(emittedStats).toBeTrue();
      expect(emittedDone).toBeTrue();
    } finally {
      await server.close();
    }
  });

  test('client.get supports writable stream destinations', async () => {
    const port = allocPort();
    const server = await startServer({ port, root: serverRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });
    let actual = Buffer.alloc(0);

    try {
      const chunks: Buffer[] = [];

      await client.asyncGet(
        'small.bin',
        new Writable({
          final(callback) {
            actual = Buffer.concat(chunks);
            callback();
          },
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
        }),
      );

      expect(Buffer.compare(actual, fixtures.small)).toBe(0);
    } finally {
      await server.close();
    }
  });

  test('put sends stream sources', async () => {
    const port = allocPort();
    const writeRoot = join(scratchRoot, 'iterable-put');
    await mkdir(writeRoot, { recursive: true });
    const server = await startServer({ port, root: writeRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });
    const payload = Buffer.from('streamed payload');

    try {
      const transfer = client.put('iterable.bin', { size: payload.length });
      // oxlint-disable-next-line init-declarations
      let transferStats: { size: number | null } | undefined;

      transfer.on('stats', (stats) => {
        transferStats = stats;
      });

      await transfer.send(splitPayload(payload, 4));

      const written = await readWhenComplete(join(writeRoot, 'iterable.bin'), payload.length);
      expect(transferStats?.size).toBe(payload.length);
      expect(Buffer.compare(written, payload)).toBe(0);
    } finally {
      await server.close();
    }
  });

  test('manual request iteration can answer GET requests from in-memory data', async () => {
    const port = allocPort();

    const server = new tftp.Server({ host: '127.0.0.1', port, root: serverRoot, windowSize: 1 }, async (request) => {
      if (request.method === 'GET') {
        request.setUserExtensions({ trace: 'enabled' });
        await request.respond(Buffer.from('manual response'));
        return;
      }

      request.abort('Unexpected PUT');
    });
    await server.listen();

    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      const transfer = client.get('manual.txt');
      const closed = once(transfer, 'close');
      const actual = await readTransfer(transfer.body);
      await closed;
      expect(actual.toString()).toBe('manual response');
    } finally {
      await server.close();
    }
  });

  test('manual request iteration can inspect PUT bodies', async () => {
    const port = allocPort();
    const uploads: Buffer[] = [];
    const payload = Buffer.from('manual upload');

    const server = new tftp.Server({ host: '127.0.0.1', port, root: serverRoot, windowSize: 1 }, async (request) => {
      if (request.method === 'PUT') {
        uploads.push(await request.readAll());
        return;
      }

      request.abort('Unexpected GET');
    });
    await server.listen();

    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      await client.asyncPut(payload, 'manual-upload.bin');
      expect(uploads).toHaveLength(1);
      expect(Buffer.compare(uploads[0], payload)).toBe(0);
    } finally {
      await server.close();
    }
  });

  test('server requests expose GET metadata and progress events', async () => {
    const port = allocPort();
    const payload = Buffer.from('manual progress response');
    const progressSnapshots: { bytesTransferred: number; size: number | null }[] = [];
    let actual = Buffer.alloc(0);

    const server = new tftp.Server({ host: '127.0.0.1', port, root: serverRoot, windowSize: 1 }, async (request) => {
      expect(request.method).toBe('GET');
      expect(request.file).toBe('progress-get.bin');
      expect(request.stats.remoteAddress).toBe('127.0.0.1');
      expect(request.stats.remotePort).toBeGreaterThan(0);
      // oxlint-disable-next-line unicorn/no-null
      expect(request.progress).toEqual({ bytesTransferred: 0, size: null });

      request.on('progress', (progress) => {
        progressSnapshots.push(progress);
      });

      await request.respond(splitPayload(payload, 7), { size: payload.length });
    });
    await server.listen();

    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });
    const chunks: Buffer[] = [];

    try {
      await client.asyncGet(
        'progress-get.bin',
        new Writable({
          final(callback) {
            actual = Buffer.concat(chunks);
            callback();
          },
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
        }),
      );

      expect(Buffer.compare(actual, payload)).toBe(0);
      expect(progressSnapshots.length).toBeGreaterThan(0);
      expect(
        progressSnapshots.every((progress, index) => index === 0 || progress.bytesTransferred >= progressSnapshots[index - 1].bytesTransferred),
      ).toBeTrue();
      expect(progressSnapshots.at(-1)).toEqual({ bytesTransferred: payload.length, size: payload.length });
    } finally {
      await server.close();
    }
  });

  test('server requests expose PUT metadata and progress events', async () => {
    const port = allocPort();
    const payload = Buffer.from('manual progress upload');
    const progressSnapshots: { bytesTransferred: number; size: number | null }[] = [];
    const uploads: Buffer[] = [];

    const server = new tftp.Server({ host: '127.0.0.1', port, root: serverRoot, windowSize: 1 }, async (request) => {
      expect(request.method).toBe('PUT');
      expect(request.file).toBe('progress-put.bin');
      expect(request.stats.remoteAddress).toBe('127.0.0.1');
      expect(request.stats.remotePort).toBeGreaterThan(0);
      expect(request.progress).toEqual({ bytesTransferred: 0, size: payload.length });

      request.on('progress', (progress) => {
        progressSnapshots.push(progress);
      });

      uploads.push(await request.readAll());
    });
    await server.listen();

    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      await client.asyncPut(splitPayload(payload, 6), 'progress-put.bin', { size: payload.length });

      expect(uploads).toHaveLength(1);
      expect(Buffer.compare(uploads[0], payload)).toBe(0);
      expect(progressSnapshots.length).toBeGreaterThan(0);
      expect(
        progressSnapshots.every((progress, index) => index === 0 || progress.bytesTransferred >= progressSnapshots[index - 1].bytesTransferred),
      ).toBeTrue();
      expect(progressSnapshots.at(-1)).toEqual({ bytesTransferred: payload.length, size: payload.length });
    } finally {
      await server.close();
    }
  });

  test('windowed GET still round-trips a large file', async () => {
    const port = allocPort();
    const server = await startServer({ port, root: serverRoot, windowSize: 4 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 4 });
    const localPath = join(clientRoot, 'windowed-large.bin');

    try {
      await client.asyncGet('large.bin', localPath);
      const actual = await readFile(localPath);
      expect(Buffer.compare(actual, fixtures.large)).toBe(0);
    } finally {
      await server.close();
    }
  });

  test('server request handlers can abort GET transfers', async () => {
    const port = allocPort();
    const server = new tftp.Server({ host: '127.0.0.1', port, root: serverRoot, windowSize: 1 }, async (request) => {
      request.abort('Cancelled by test');
    });
    await server.listen();
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      const transfer = client.get('small.bin');
      const closed = once(transfer, 'close');
      const error = await captureError(drainTransfer(transfer.body));

      expect(error).toBeDefined();
      expect(error?.message.toLowerCase()).toContain('cancelled');
      await closed;
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test('put can be aborted mid-transfer', async () => {
    const port = allocPort();
    const writeRoot = join(scratchRoot, 'abort-put');
    await mkdir(writeRoot, { recursive: true });
    const server = await startServer({ port, root: writeRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });
    const firstChunk = Buffer.alloc(2048, 0xaa);
    const secondChunk = Buffer.alloc(2048, 0xbb);
    let releaseSecondChunk!: () => void; // oxlint-disable-line init-declarations
    // oxlint-disable-next-line promise/avoid-new
    const waitForSecondChunk = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });

    try {
      const transfer = client.put('abort-put.bin', { size: firstChunk.length + secondChunk.length });
      const sending = captureError(transfer.send(splitPayloadAfterSignal(firstChunk, waitForSecondChunk, secondChunk)));

      await setTimeout(20);
      transfer.close('Cancelled by test');
      releaseSecondChunk();

      const error = await sending;
      expect(error).toBeDefined();
      expect(['abort', 'premature close'].some((fragment) => error?.message.toLowerCase().includes(fragment))).toBeTrue();
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test('exact-block-size files still transfer in both directions', async () => {
    const port = allocPort();
    const writeRoot = join(scratchRoot, 'exact-multiple');
    await mkdir(writeRoot, { recursive: true });
    await writeFile(join(writeRoot, 'exact-multiple.bin'), exactMultipleFixture);
    const server = await startServer({ port, root: writeRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });
    const localPath = join(clientRoot, 'exact-download.bin');

    try {
      await client.asyncGet('exact-multiple.bin', localPath);
      const downloaded = await readFile(localPath);
      expect(Buffer.compare(downloaded, exactMultipleFixture)).toBe(0);

      await client.asyncPut(join(clientRoot, 'exact-multiple.bin'), 'exact-upload.bin');
      const uploaded = await readWhenComplete(join(writeRoot, 'exact-upload.bin'), exactMultipleFixture.length);
      expect(Buffer.compare(uploaded, exactMultipleFixture)).toBe(0);
    } finally {
      await server.close();
    }
  });

  test('denyGET and denyPUT still reject requests', async () => {
    const getPort = allocPort();
    const denyGetServer = await startServer({ denyGET: true, port: getPort, root: serverRoot, windowSize: 1 });
    const denyGetClient = new tftp.Client({ host: '127.0.0.1', port: getPort });

    try {
      const transfer = denyGetClient.get('small.bin');
      const error = await captureError(readTransferAndDrainDone(transfer));
      expect(error).toBeDefined();
      expect(error?.message).toContain('Cannot GET files');
    } finally {
      await denyGetServer.close();
    }

    const putPort = allocPort();
    const denyPutRoot = join(scratchRoot, 'deny-put');
    await mkdir(denyPutRoot, { recursive: true });
    const denyPutServer = await startServer({ denyPUT: true, port: putPort, root: denyPutRoot, windowSize: 1 });
    const denyPutClient = new tftp.Client({ host: '127.0.0.1', port: putPort });

    try {
      const error = await captureError(denyPutClient.asyncPut(Buffer.from('denied'), 'deny-put.bin'));
      expect(error).toBeDefined();
      expect(error?.message).toContain('Cannot PUT files');
    } finally {
      await denyPutServer.close();
    }
  });

  test('absolute paths outside the root are rejected without stopping the server', async () => {
    const port = allocPort();

    const server = new tftp.Server({ host: '127.0.0.1', port, root: serverRoot, windowSize: 1 }, async (request) => {
      if (request.file === '/etc/passwd') {
        const error = await captureError(request.method === 'GET' ? request.respond() : request.saveTo());
        expect(error?.message.toLowerCase()).toContain('upper levels');
        return;
      }

      if (request.method === 'GET') {
        await request.respond();
        return;
      }

      await request.saveTo();
    });
    await server.listen();

    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });
    const localPath = join(clientRoot, 'absolute-guard-get.bin');
    const payload = Buffer.from('still alive');

    try {
      const getTransfer = client.get('/etc/passwd');
      const getError = await captureError(readTransferAndDrainDone(getTransfer));
      expect(getError?.message.toLowerCase()).toContain('invalid filename');

      const putError = await captureError(client.asyncPut(payload, '/etc/passwd', { size: payload.length }));
      expect(putError?.message.toLowerCase()).toContain('invalid filename');

      await client.asyncGet('small.bin', localPath);
      expect(Buffer.compare(await readFile(localPath), fixtures.small)).toBe(0);

      await client.asyncPut(payload, 'safe.bin', { size: payload.length });
      expect(Buffer.compare(await readWhenComplete(join(serverRoot, 'safe.bin'), payload.length), payload)).toBe(0);
    } finally {
      await server.close();
    }
  });

  test('directory reads still map to an RFC-safe I/O error', async () => {
    const port = allocPort();
    const server = await startServer({ port, root: serverRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      const transfer = client.get('subdir');
      const error = await captureError(readTransferAndDrainDone(transfer));
      expect(error).toBeDefined();
      expect(error?.message).toContain('I/O error');
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test('windowed PUT still round-trips a large file', async () => {
    const port = allocPort();
    const writeRoot = join(scratchRoot, 'windowed-put');
    await mkdir(writeRoot, { recursive: true });
    const server = await startServer({ port, root: writeRoot, windowSize: 4 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 4 });
    const remote = 'windowed-large.bin';

    try {
      await client.asyncPut(join(clientRoot, 'large.bin'), remote);
      const written = await readWhenComplete(join(writeRoot, remote), fixtures.large.length);
      expect(Buffer.compare(written, fixtures.large)).toBe(0);
    } finally {
      await server.close();
    }
  });

  test('IPv6 loopback transfers work for GET and PUT', async () => {
    const port = allocPort();
    const writeRoot = join(scratchRoot, 'ipv6');
    await mkdir(writeRoot, { recursive: true });
    await writeFile(join(writeRoot, 'small.bin'), fixtures.small);
    const server = new tftp.Server({ host: '::1', port, root: writeRoot, windowSize: 1 });
    await server.listen();
    const client = new tftp.Client({ host: '::1', port, windowSize: 1 });

    try {
      const transfer = client.get('small.bin');
      const closed = once(transfer, 'close');
      const actual = await readTransfer(transfer.body);
      await closed;
      expect(Buffer.compare(actual, fixtures.small)).toBe(0);

      const payload = Buffer.from('ipv6 upload');
      await client.asyncPut(payload, 'ipv6-upload.bin');
      const written = await readWhenComplete(join(writeRoot, 'ipv6-upload.bin'), payload.length);
      expect(Buffer.compare(written, payload)).toBe(0);
    } finally {
      await server.close();
    }
  });

  test('server.close() surfaces handler failures after draining tasks', async () => {
    const port = allocPort();
    const server = new tftp.Server({ host: '127.0.0.1', port, root: serverRoot, windowSize: 1 }, async () => {
      throw new Error('Intentional handler failure');
    });
    await server.listen();
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      await captureError(client.asyncGet('small.bin', join(clientRoot, 'handler-fail.bin')));

      const closeError = await captureError(server.close());
      expect(closeError).toBeDefined();
      expect(closeError?.message).toBe('Intentional handler failure');
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test('PutTransfer.close() before sending emits close without a stream', async () => {
    const port = allocPort();
    const server = await startServer({ port, root: serverRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      const transfer = client.put('never-sent.bin', { size: 10 });
      let closeFired = false;

      transfer.on('close', () => {
        closeFired = true;
      });

      transfer.close();
      expect(closeFired).toBeTrue();
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test('PutTransfer.close(error) before sending emits abort then close', async () => {
    const port = allocPort();
    const server = await startServer({ port, root: serverRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      const transfer = client.put('never-sent.bin', { size: 10 });
      let abortFired = false;
      let closeFired = false;

      transfer.on('abort', () => {
        abortFired = true;
      });

      transfer.on('close', () => {
        closeFired = true;
      });

      transfer.close(new Error('Early abort'));
      expect(abortFired).toBeTrue();
      expect(closeFired).toBeTrue();
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test('PutTransfer.body throws when size is not configured', async () => {
    const port = allocPort();
    const server = await startServer({ port, root: serverRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      const transfer = client.put('no-size.bin');
      expect(() => transfer.body).toThrow('Missing size');
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test('asyncPut rejects when the source path is a directory', async () => {
    const port = allocPort();
    const writeRoot = join(scratchRoot, 'dir-source');
    await mkdir(writeRoot, { recursive: true });
    const server = await startServer({ port, root: writeRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      const error = await captureError(client.asyncPut(serverRoot, 'dir-upload.bin'));
      expect(error).toBeDefined();
      expect(error?.message).toContain('directory');
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test('server request body is undefined for GET and localPath resolves correctly', async () => {
    const port = allocPort();
    let getBody: unknown = 'sentinel';
    let getLocalPath = '';

    const server = new tftp.Server({ host: '127.0.0.1', port, root: serverRoot, windowSize: 1 }, async (request) => {
      if (request.method === 'GET') {
        getBody = request.body;
        getLocalPath = request.localPath;
        await request.respond(Buffer.from('ok'));
        return;
      }

      await request.saveTo();
    });
    await server.listen();

    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      const transfer = client.get('small.bin');
      const closed = once(transfer, 'close');
      await drainTransfer(transfer.body);
      await closed;

      expect(getBody).toBeUndefined();
      expect(getLocalPath).toContain('small.bin');
    } finally {
      await server.close();
    }
  });

  test('custom handler returns ENOENT for a non-existent file', async () => {
    const port = allocPort();
    let handlerCalled = false;

    const server = new tftp.Server({ host: '127.0.0.1', port, root: serverRoot, windowSize: 1 }, async (request) => {
      handlerCalled = true;

      if (request.method === 'GET' && request.file === 'does-not-exist.bin') {
        request.abort('File not found');
        return;
      }

      await (request.method === 'GET' ? request.respond() : request.saveTo());
    });
    await server.listen();

    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      const transfer = client.get('does-not-exist.bin');
      const error = await captureError(readTransferAndDrainDone(transfer));
      expect(error).toBeDefined();
      expect(error?.message).toContain('File not found');
      expect(handlerCalled).toBeTrue();
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test('respond with a source stream that errors surfaces the stream error', async () => {
    const port = allocPort();

    const server = new tftp.Server({ host: '127.0.0.1', port, root: serverRoot, windowSize: 1 }, async (request) => {
      if (request.method !== 'GET') {
        request.abort('Unexpected PUT');
        return;
      }

      const broken = new Readable({
        read() {
          process.nextTick(() => {
            this.destroy(new Error('Source stream failure'));
          });
        },
      });

      const handlerError = await captureError(request.respond(broken, { size: 100 }));
      expect(handlerError).toBeDefined();
      expect(handlerError?.message).toContain('Source stream failure');
    });
    await server.listen();

    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      const transfer = client.get('broken-stream.bin');
      await captureError(readTransferAndDrainDone(transfer));
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test('asyncPut rejects when remote is omitted for a non-path source', async () => {
    const port = allocPort();
    const server = await startServer({ port, root: serverRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      const error = await captureError(client.asyncPut(Buffer.from('data')));
      expect(error).toBeDefined();
      expect(error?.message).toContain('Missing remote destination');
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test('asyncGet rejects when destination is an existing directory', async () => {
    const port = allocPort();
    const server = await startServer({ port, root: serverRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      const error = await captureError(client.asyncGet('small.bin', scratchRoot));
      expect(error).toBeDefined();
      expect(error?.message).toContain('directory');
    } finally {
      await waitForSettledError(server.close());
    }
  });

  test('server can be restarted with listen() after close() without duplicate handlers', async () => {
    const port = allocPort();
    const server = await startServer({ port, root: serverRoot, windowSize: 1 });
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    const transfer1 = client.get('small.bin');
    const closed1 = once(transfer1, 'close');
    const data1 = await readTransfer(transfer1.body);
    await closed1;
    expect(Buffer.compare(data1, fixtures.small)).toBe(0);
    await server.close();

    await server.listen();
    const transfer2 = client.get('small.bin');
    const closed2 = once(transfer2, 'close');
    const data2 = await readTransfer(transfer2.body);
    await closed2;
    expect(Buffer.compare(data2, fixtures.small)).toBe(0);
    expect(server.listenerCount('request')).toBe(1);

    await server.close();
  });
});
