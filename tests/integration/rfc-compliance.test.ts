import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createSocket } from 'node:dgram';
import type { RemoteInfo, Socket } from 'node:dgram';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';

import { sendOnSocket, waitForSocketBind } from '../../src/helpers.js';
import { allocPortRange, buildRequestPacket, captureError, readTransfer, startServer, tftp } from '../helpers.js';

const allocPort = allocPortRange(2);
const fixture = Buffer.from('ok');
// oxlint-disable-next-line init-declarations
let scratchRoot: string;
// oxlint-disable-next-line init-declarations
let serverRoot: string;

const bindSocket = async (socket: Socket, port: number) => {
  await waitForSocketBind(socket, port, '127.0.0.1');
  return socket;
};

const closeSocket = async (socket: Socket) => {
  await promisify(socket.close.bind(socket))();
};

const receiveMessage = async (socket: Socket, timeoutMs = 2000): Promise<{ message: Buffer; rinfo: RemoteInfo }> =>
  // oxlint-disable-next-line promise/avoid-new
  new Promise((resolve, reject) => {
    // oxlint-disable-next-line prefer-const, init-declarations
    let timer: ReturnType<typeof setTimeout>;

    const onMessage = (message: Buffer, rinfo: RemoteInfo) => {
      clearTimeout(timer);
      resolve({ message, rinfo });
    };

    timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for UDP message'));
    }, timeoutMs);

    socket.once('message', onMessage);
  });

const createDrainSink = () =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

const safeClose = async (server: { close(): Promise<void> }) => {
  try {
    await server.close();
  } catch {
    // Protocol-level errors from raw UDP tests are expected.
  }
};

beforeAll(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), 'tftp-rfc-tests-'));
  serverRoot = join(scratchRoot, 'server');
  await mkdir(serverRoot, { recursive: true });
  await writeFile(join(serverRoot, 'small.bin'), fixture);
});

afterAll(async () => {
  if (scratchRoot) {
    await rm(scratchRoot, { force: true, recursive: true });
  }
});

describe('client RFC compliance', () => {
  test('retransmits RRQ when the initial request is lost', async () => {
    const port = allocPort();
    const requestSocket = await bindSocket(createSocket('udp4'), port);
    const transferSocket = await bindSocket(createSocket('udp4'), 0);
    const client = new tftp.Client({ host: '127.0.0.1', port, retries: 2, timeout: 1, windowSize: 1 });

    try {
      const transfer = client.get('lost-request.bin');
      const closed = once(transfer, 'close');
      const first = await receiveMessage(requestSocket);
      expect(tftp.packets.rrq.deserialize(first.message).file).toBe('lost-request.bin');

      const second = await receiveMessage(requestSocket, 1500);
      expect(Buffer.compare(second.message, first.message)).toBe(0);

      await sendOnSocket(transferSocket, tftp.packets.oack.serialize({ timeout: 1, tsize: fixture.length }), second.rinfo.port, second.rinfo.address);

      const ack0 = await receiveMessage(transferSocket);
      expect(tftp.packets.ack.deserialize(ack0.message).block).toBe(0);

      await sendOnSocket(transferSocket, tftp.packets.data.serialize(1, fixture), second.rinfo.port, second.rinfo.address);

      const ack1 = await receiveMessage(transferSocket);
      expect(tftp.packets.ack.deserialize(ack1.message).block).toBe(1);

      const body = await readTransfer(transfer.body);
      await closed;
      expect(Buffer.compare(body, fixture)).toBe(0);
    } finally {
      await closeSocket(transferSocket);
      await closeSocket(requestSocket);
    }
  });

  test('acknowledges RRQ OACK with ACK block 0 and completes the transfer', async () => {
    const port = allocPort();
    const requestSocket = await bindSocket(createSocket('udp4'), port);
    const transferSocket = await bindSocket(createSocket('udp4'), 0);
    const client = new tftp.Client({ blockSize: 1024, host: '127.0.0.1', port, timeout: 7, windowSize: 1 });

    try {
      const transfer = client.get('small.bin');
      const closed = once(transfer, 'close');
      const { message, rinfo } = await receiveMessage(requestSocket);
      const rrq = tftp.packets.rrq.deserialize(message);
      expect(rrq.extensions).toMatchObject({ blksize: 1024, timeout: 7, tsize: 0, windowsize: 1 });

      await sendOnSocket(
        transferSocket,
        tftp.packets.oack.serialize({ blksize: 1024, timeout: 7, tsize: fixture.length, windowsize: 1 }),
        rinfo.port,
        rinfo.address,
      );

      const ack0 = await receiveMessage(transferSocket);
      expect(tftp.packets.ack.deserialize(ack0.message).block).toBe(0);

      await sendOnSocket(transferSocket, tftp.packets.data.serialize(1, fixture), rinfo.port, rinfo.address);

      const ack1 = await receiveMessage(transferSocket);
      expect(tftp.packets.ack.deserialize(ack1.message).block).toBe(1);

      const body = await readTransfer(transfer.body);
      await closed;
      expect(Buffer.compare(body, fixture)).toBe(0);
    } finally {
      await closeSocket(transferSocket);
      await closeSocket(requestSocket);
    }
  });

  test('accepts mixed-case OACK option names', async () => {
    const port = allocPort();
    const requestSocket = await bindSocket(createSocket('udp4'), port);
    const transferSocket = await bindSocket(createSocket('udp4'), 0);
    const client = new tftp.Client({ blockSize: 1024, host: '127.0.0.1', port, timeout: 7, windowSize: 1 });

    try {
      const transfer = client.get('mixed-case-oack.bin');
      const closed = once(transfer, 'close');
      const statsPromise = once(transfer, 'stats');
      const { rinfo } = await receiveMessage(requestSocket);
      await sendOnSocket(
        transferSocket,
        tftp.packets.oack.serialize({ BLKSIZE: 1024, TImEOut: 7, TSiZe: fixture.length, WINdowSize: 1 }),
        rinfo.port,
        rinfo.address,
      );

      const ack0 = await receiveMessage(transferSocket);
      expect(tftp.packets.ack.deserialize(ack0.message).block).toBe(0);

      await sendOnSocket(transferSocket, tftp.packets.data.serialize(1, fixture), rinfo.port, rinfo.address);

      const ack1 = await receiveMessage(transferSocket);
      expect(tftp.packets.ack.deserialize(ack1.message).block).toBe(1);

      const [stats] = await statsPromise;
      const body = await readTransfer(transfer.body);
      await closed;
      expect(stats).toMatchObject({ blockSize: 1024, size: fixture.length, timeout: 7, windowSize: 1 });
      expect(Buffer.compare(body, fixture)).toBe(0);
    } finally {
      await closeSocket(transferSocket);
      await closeSocket(requestSocket);
    }
  });

  test('matches custom OACK option names case-insensitively', async () => {
    const port = allocPort();
    const requestSocket = await bindSocket(createSocket('udp4'), port);
    const transferSocket = await bindSocket(createSocket('udp4'), 0);
    const client = new tftp.Client({ host: '127.0.0.1', port, timeout: 5 });

    try {
      const transfer = client.get('custom-option.bin', { userExtensions: { 'X-Trace': 'please' } });
      const closed = once(transfer, 'close');
      const statsPromise = once(transfer, 'stats');
      const { rinfo } = await receiveMessage(requestSocket);
      await sendOnSocket(transferSocket, tftp.packets.oack.serialize({ TImEOut: 5, TSiZe: fixture.length, 'x-trace': 'enabled' }), rinfo.port, rinfo.address);

      const ack0 = await receiveMessage(transferSocket);
      expect(tftp.packets.ack.deserialize(ack0.message).block).toBe(0);

      await sendOnSocket(transferSocket, tftp.packets.data.serialize(1, fixture), rinfo.port, rinfo.address);
      await receiveMessage(transferSocket);

      const [stats] = await statsPromise;
      const body = await readTransfer(transfer.body);
      await closed;
      expect(stats.userExtensions).toEqual({ 'x-trace': 'enabled' });
      expect(Buffer.compare(body, fixture)).toBe(0);
    } finally {
      await closeSocket(transferSocket);
      await closeSocket(requestSocket);
    }
  });

  test('rejects duplicate OACK options with error code 8', async () => {
    const port = allocPort();
    const requestSocket = await bindSocket(createSocket('udp4'), port);
    const transferSocket = await bindSocket(createSocket('udp4'), 0);
    const client = new tftp.Client({ host: '127.0.0.1', port, timeout: 5 });

    try {
      const failure = captureError(client.asyncGet('duplicate-oack.bin', createDrainSink()));

      const { rinfo } = await receiveMessage(requestSocket);
      const duplicateOack = Buffer.from('\u0000\u0006timeout\u00005\u0000TIMEOUT\u00005\u0000tsize\u00002\u0000', 'binary');
      await sendOnSocket(transferSocket, duplicateOack, rinfo.port, rinfo.address);

      const errorReply = await receiveMessage(transferSocket);
      expect(tftp.packets.error.deserialize(errorReply.message).code).toBe(8);
      const failureResult = await failure;
      expect(failureResult?.message.toLowerCase()).toContain('denied');
    } finally {
      await closeSocket(transferSocket);
      await closeSocket(requestSocket);
    }
  });

  test('starts WRQ data flow with DATA block 1 after an OACK', async () => {
    const port = allocPort();
    const requestSocket = await bindSocket(createSocket('udp4'), port);
    const transferSocket = await bindSocket(createSocket('udp4'), 0);
    const client = new tftp.Client({ blockSize: 1024, host: '127.0.0.1', port, timeout: 7, windowSize: 1 });

    try {
      const upload = client.asyncPut(fixture, 'upload.bin', { size: fixture.length });
      const { message, rinfo } = await receiveMessage(requestSocket);
      const wrq = tftp.packets.wrq.deserialize(message, false);
      expect(wrq.extensions).toMatchObject({ blksize: 1024, timeout: 7, tsize: fixture.length, windowsize: 1 });

      await sendOnSocket(
        transferSocket,
        tftp.packets.oack.serialize({ blksize: 1024, timeout: 7, tsize: fixture.length, windowsize: 1 }),
        rinfo.port,
        rinfo.address,
      );

      const data1 = await receiveMessage(transferSocket);
      const packet = tftp.packets.data.deserialize(data1.message, 1024);
      expect(packet.block).toBe(1);
      expect(Buffer.compare(packet.data, fixture)).toBe(0);

      await sendOnSocket(transferSocket, tftp.packets.ack.serialize(1), rinfo.port, rinfo.address);
      await upload;
    } finally {
      await closeSocket(transferSocket);
      await closeSocket(requestSocket);
    }
  });

  test('rejects unrequested OACK options with error code 8', async () => {
    const port = allocPort();
    const requestSocket = await bindSocket(createSocket('udp4'), port);
    const transferSocket = await bindSocket(createSocket('udp4'), 0);
    const client = new tftp.Client({ host: '127.0.0.1', port, timeout: 5 });

    try {
      const failure = captureError(client.asyncGet('bad.bin', createDrainSink()));

      const { rinfo } = await receiveMessage(requestSocket);
      await sendOnSocket(
        transferSocket,
        tftp.packets.oack.serialize({ blksize: 512, rogue: '1', timeout: 5, tsize: fixture.length, windowsize: 1 }),
        rinfo.port,
        rinfo.address,
      );

      const errorReply = await receiveMessage(transferSocket);
      expect(tftp.packets.error.deserialize(errorReply.message).code).toBe(8);
      const failureResult = await failure;
      expect(failureResult?.message.toLowerCase()).toContain('denied');
    } finally {
      await closeSocket(transferSocket);
      await closeSocket(requestSocket);
    }
  });

  test('rejects OACK timeout values that do not exactly match the request', async () => {
    const port = allocPort();
    const requestSocket = await bindSocket(createSocket('udp4'), port);
    const transferSocket = await bindSocket(createSocket('udp4'), 0);
    const client = new tftp.Client({ host: '127.0.0.1', port, timeout: 5 });

    try {
      const failure = captureError(client.asyncGet('bad-timeout.bin', createDrainSink()));

      const { rinfo } = await receiveMessage(requestSocket);
      await sendOnSocket(transferSocket, tftp.packets.oack.serialize({ timeout: 6, tsize: fixture.length }), rinfo.port, rinfo.address);

      const errorReply = await receiveMessage(transferSocket);
      expect(tftp.packets.error.deserialize(errorReply.message).code).toBe(8);
      const failureResult = await failure;
      expect(failureResult?.message.toLowerCase()).toContain('denied');
    } finally {
      await closeSocket(transferSocket);
      await closeSocket(requestSocket);
    }
  });

  test('retries without options after an ERROR code 8 response', async () => {
    const port = allocPort();
    const requestSocket = await bindSocket(createSocket('udp4'), port);
    const transferSocket = await bindSocket(createSocket('udp4'), 0);
    const client = new tftp.Client({ blockSize: 1024, host: '127.0.0.1', port, timeout: 7, windowSize: 4 });

    try {
      const transfer = client.get('retry.bin');
      const closed = once(transfer, 'close');
      const first = await receiveMessage(requestSocket);
      expect(tftp.packets.rrq.deserialize(first.message).extensions).not.toBeNull();

      await sendOnSocket(requestSocket, tftp.packets.error.serialize(tftp.errors.EDENY), first.rinfo.port, first.rinfo.address);

      const second = await receiveMessage(requestSocket);
      expect(tftp.packets.rrq.deserialize(second.message).extensions).toBeNull();

      await sendOnSocket(transferSocket, tftp.packets.data.serialize(1, fixture), second.rinfo.port, second.rinfo.address);

      const ack1 = await receiveMessage(transferSocket);
      expect(tftp.packets.ack.deserialize(ack1.message).block).toBe(1);

      const body = await readTransfer(transfer.body);
      await closed;
      expect(Buffer.compare(body, fixture)).toBe(0);
    } finally {
      await closeSocket(transferSocket);
      await closeSocket(requestSocket);
    }
  });

  test('sends ETID for packets that arrive from the wrong transfer port', async () => {
    const port = allocPort();
    const requestSocket = await bindSocket(createSocket('udp4'), port);
    const transferSocket = await bindSocket(createSocket('udp4'), 0);
    const rogueSocket = await bindSocket(createSocket('udp4'), 0);
    const client = new tftp.Client({ host: '127.0.0.1', port, timeout: 5 });

    try {
      const transfer = client.get('wrong-tid.bin');
      const closed = once(transfer, 'close');
      const { rinfo } = await receiveMessage(requestSocket);
      await sendOnSocket(transferSocket, tftp.packets.oack.serialize({ timeout: 5, tsize: fixture.length }), rinfo.port, rinfo.address);

      const ack0 = await receiveMessage(transferSocket);
      expect(tftp.packets.ack.deserialize(ack0.message).block).toBe(0);

      await sendOnSocket(rogueSocket, tftp.packets.data.serialize(1, Buffer.from('evil')), ack0.rinfo.port, ack0.rinfo.address);

      const wrongTidError = await receiveMessage(rogueSocket);
      const parsedError = tftp.packets.error.deserialize(wrongTidError.message);
      expect(parsedError.code).toBe(5);
      expect(parsedError.message).toBe(tftp.errors.ETID.message);

      await sendOnSocket(transferSocket, tftp.packets.data.serialize(1, fixture), rinfo.port, rinfo.address);

      const ack1 = await receiveMessage(transferSocket);
      expect(tftp.packets.ack.deserialize(ack1.message).block).toBe(1);

      const body = await readTransfer(transfer.body);
      await closed;
      expect(Buffer.compare(body, fixture)).toBe(0);
    } finally {
      await closeSocket(rogueSocket);
      await closeSocket(transferSocket);
      await closeSocket(requestSocket);
    }
  });

  test('retransmits ACK block 0 when the first DATA packet is lost after OACK', async () => {
    const port = allocPort();
    const requestSocket = await bindSocket(createSocket('udp4'), port);
    const transferSocket = await bindSocket(createSocket('udp4'), 0);
    const client = new tftp.Client({ host: '127.0.0.1', port, retries: 2, timeout: 1 });

    try {
      const transfer = client.get('lost-first-data.bin');
      const closed = once(transfer, 'close');
      const { rinfo } = await receiveMessage(requestSocket);
      await sendOnSocket(transferSocket, tftp.packets.oack.serialize({ timeout: 1, tsize: fixture.length }), rinfo.port, rinfo.address);

      const firstAck0 = await receiveMessage(transferSocket);
      expect(tftp.packets.ack.deserialize(firstAck0.message).block).toBe(0);

      const secondAck0 = await receiveMessage(transferSocket, 1500);
      expect(tftp.packets.ack.deserialize(secondAck0.message).block).toBe(0);

      await sendOnSocket(transferSocket, tftp.packets.data.serialize(1, fixture), rinfo.port, rinfo.address);

      const ack1 = await receiveMessage(transferSocket);
      expect(tftp.packets.ack.deserialize(ack1.message).block).toBe(1);

      const body = await readTransfer(transfer.body);
      await closed;
      expect(Buffer.compare(body, fixture)).toBe(0);
    } finally {
      await closeSocket(transferSocket);
      await closeSocket(requestSocket);
    }
  });

  test('retransmits DATA when the server does not acknowledge a PUT block', async () => {
    const port = allocPort();
    const requestSocket = await bindSocket(createSocket('udp4'), port);
    const transferSocket = await bindSocket(createSocket('udp4'), 0);
    const client = new tftp.Client({ host: '127.0.0.1', port, retries: 2, timeout: 1 });

    try {
      const upload = client.asyncPut(fixture, 'lost-put-ack.bin', { size: fixture.length });
      const { message, rinfo } = await receiveMessage(requestSocket);
      expect(tftp.packets.wrq.deserialize(message, false).file).toBe('lost-put-ack.bin');

      await sendOnSocket(transferSocket, tftp.packets.oack.serialize({ timeout: 1, tsize: fixture.length }), rinfo.port, rinfo.address);

      const firstData = await receiveMessage(transferSocket);
      const firstPacket = tftp.packets.data.deserialize(firstData.message, 512);
      expect(firstPacket.block).toBe(1);
      expect(Buffer.compare(firstPacket.data, fixture)).toBe(0);

      const secondData = await receiveMessage(transferSocket, 1500);
      const secondPacket = tftp.packets.data.deserialize(secondData.message, 512);
      expect(secondPacket.block).toBe(1);
      expect(Buffer.compare(secondPacket.data, fixture)).toBe(0);

      await sendOnSocket(transferSocket, tftp.packets.ack.serialize(1), rinfo.port, rinfo.address);
      await upload;
    } finally {
      await closeSocket(transferSocket);
      await closeSocket(requestSocket);
    }
  });
});

describe('server RFC compliance', () => {
  test('accepts mixed-case request option names', async () => {
    const port = allocPort();
    const clientSocket = await bindSocket(createSocket('udp4'), 0);
    const server = await startServer({ port, root: serverRoot });

    try {
      await sendOnSocket(
        clientSocket,
        buildRequestPacket(tftp.opcodes.RRQ, 'small.bin', 'octet', { BLKSIZE: '1024', TImEOut: '7', TSiZe: '0', WINdowSize: '1' }),
        port,
        '127.0.0.1',
      );

      const oack = await receiveMessage(clientSocket);
      expect(tftp.packets.oack.deserialize(oack.message)).toMatchObject({ blksize: '1024', timeout: '7', tsize: String(fixture.length), windowsize: '1' });

      await sendOnSocket(clientSocket, tftp.packets.ack.serialize(0), oack.rinfo.port, oack.rinfo.address);
      const data1 = await receiveMessage(clientSocket);
      expect(tftp.packets.data.deserialize(data1.message, 1024).block).toBe(1);
      await sendOnSocket(clientSocket, tftp.packets.ack.serialize(1), data1.rinfo.port, data1.rinfo.address);
    } finally {
      await server.close().catch(() => undefined);
      await closeSocket(clientSocket);
    }
  });

  test('rejects duplicate request options with error code 8', async () => {
    const port = allocPort();
    const clientSocket = await bindSocket(createSocket('udp4'), 0);
    const server = await startServer({ port, root: serverRoot });

    try {
      await sendOnSocket(clientSocket, buildRequestPacket(tftp.opcodes.RRQ, 'small.bin', 'octet', { TIMEOUT: '5', timeout: '5' }), port, '127.0.0.1');
      const errorReply = await receiveMessage(clientSocket);
      const parsedError = tftp.packets.error.deserialize(errorReply.message);
      expect(parsedError.code).toBe(8);
      expect(parsedError.message).toBe(tftp.errors.EDENY.message);
    } finally {
      await server.close();
      await closeSocket(clientSocket);
    }
  });

  test.each(['netascii', 'mail'])('rejects unsupported "%s" transfer mode', async (mode) => {
    const port = allocPort();
    const clientSocket = await bindSocket(createSocket('udp4'), 0);
    const server = await startServer({ port, root: serverRoot });

    try {
      await sendOnSocket(clientSocket, buildRequestPacket(tftp.opcodes.RRQ, 'small.bin', mode), port, '127.0.0.1');
      const errorReply = await receiveMessage(clientSocket);
      const parsedError = tftp.packets.error.deserialize(errorReply.message);
      expect(parsedError.code).toBe(0);
      expect(parsedError.message).toBe(tftp.errors.EBADMODE.message);
    } finally {
      await server.close();
      await closeSocket(clientSocket);
    }
  });

  test('retransmits OACK when ACK block 0 is lost', async () => {
    const port = allocPort();
    const clientSocket = await bindSocket(createSocket('udp4'), 0);
    const server = await startServer({ port, root: serverRoot });

    try {
      const options = tftp.createOptions({ timeout: 1 }, 'client');
      await sendOnSocket(clientSocket, tftp.packets.rrq.serialize('small.bin', options), port, '127.0.0.1');

      const firstOack = await receiveMessage(clientSocket);
      expect(tftp.packets.oack.deserialize(firstOack.message)).toMatchObject({ timeout: '1', tsize: String(fixture.length) });

      const secondOack = await receiveMessage(clientSocket, 1500);
      expect(Buffer.compare(secondOack.message, firstOack.message)).toBe(0);

      await sendOnSocket(clientSocket, tftp.packets.ack.serialize(0), firstOack.rinfo.port, firstOack.rinfo.address);

      const data1 = await receiveMessage(clientSocket);
      const packet = tftp.packets.data.deserialize(data1.message, 512);
      expect(packet.block).toBe(1);
      expect(Buffer.compare(packet.data, fixture)).toBe(0);

      await sendOnSocket(clientSocket, tftp.packets.ack.serialize(1), data1.rinfo.port, data1.rinfo.address);
    } finally {
      await server.close();
      await closeSocket(clientSocket);
    }
  });

  test('echoes timeout in OACK exactly as requested', async () => {
    const port = allocPort();
    const clientSocket = await bindSocket(createSocket('udp4'), 0);
    const server = await startServer({ port, root: serverRoot });

    try {
      const options = tftp.createOptions({ blockSize: 1024, timeout: 7, windowSize: 1 }, 'client');
      await sendOnSocket(clientSocket, tftp.packets.rrq.serialize('small.bin', options), port, '127.0.0.1');

      const oack = await receiveMessage(clientSocket);
      expect(tftp.packets.oack.deserialize(oack.message)).toMatchObject({ blksize: '1024', timeout: '7', tsize: String(fixture.length), windowsize: '1' });

      await sendOnSocket(clientSocket, tftp.packets.ack.serialize(0), oack.rinfo.port, oack.rinfo.address);

      const data1 = await receiveMessage(clientSocket);
      const packet = tftp.packets.data.deserialize(data1.message, 1024);
      expect(packet.block).toBe(1);
      expect(Buffer.compare(packet.data, fixture)).toBe(0);

      await sendOnSocket(clientSocket, tftp.packets.ack.serialize(1), data1.rinfo.port, data1.rinfo.address);
    } finally {
      await server.close();
      await closeSocket(clientSocket);
    }
  });

  test('aborts WRQ uploads that exceed the negotiated tsize', async () => {
    const port = allocPort();
    const clientSocket = await bindSocket(createSocket('udp4'), 0);
    const server = await startServer({ port, root: serverRoot });

    try {
      await sendOnSocket(clientSocket, buildRequestPacket(tftp.opcodes.WRQ, 'oversized.bin', 'octet', { timeout: '1', tsize: '1' }), port, '127.0.0.1');

      const oack = await receiveMessage(clientSocket);
      expect(tftp.packets.oack.deserialize(oack.message)).toMatchObject({ timeout: '1', tsize: '1' });

      await sendOnSocket(clientSocket, tftp.packets.data.serialize(1, Buffer.from('ab')), oack.rinfo.port, oack.rinfo.address);

      const errorReply = await receiveMessage(clientSocket);
      const parsedError = tftp.packets.error.deserialize(errorReply.message);
      expect(parsedError.code).toBe(0);
      expect(parsedError.message).toBe(tftp.errors.EFBIG.message);
    } finally {
      await safeClose(server);
      await closeSocket(clientSocket);
    }
  });

  test('sends ETID for packets that arrive from the wrong transfer port', async () => {
    const port = allocPort();
    const clientSocket = await bindSocket(createSocket('udp4'), 0);
    const rogueSocket = await bindSocket(createSocket('udp4'), 0);
    const server = await startServer({ port, root: serverRoot });

    try {
      await sendOnSocket(clientSocket, tftp.packets.rrq.serialize('small.bin'), port, '127.0.0.1');

      const data1 = await receiveMessage(clientSocket);
      const packet = tftp.packets.data.deserialize(data1.message, 512);
      expect(packet.block).toBe(1);

      await sendOnSocket(rogueSocket, tftp.packets.ack.serialize(1), data1.rinfo.port, data1.rinfo.address);

      const wrongTidError = await receiveMessage(rogueSocket);
      const parsedError = tftp.packets.error.deserialize(wrongTidError.message);
      expect(parsedError.code).toBe(5);
      expect(parsedError.message).toBe(tftp.errors.ETID.message);

      await sendOnSocket(clientSocket, tftp.packets.ack.serialize(1), data1.rinfo.port, data1.rinfo.address);
    } finally {
      await server.close();
      await closeSocket(rogueSocket);
      await closeSocket(clientSocket);
    }
  });

  test('retransmits DATA when the client does not acknowledge a GET block', async () => {
    const port = allocPort();
    const clientSocket = await bindSocket(createSocket('udp4'), 0);
    const server = await startServer({ port, root: serverRoot });

    try {
      const options = tftp.createOptions({ timeout: 1 }, 'client');
      await sendOnSocket(clientSocket, tftp.packets.rrq.serialize('small.bin', options), port, '127.0.0.1');

      const oack = await receiveMessage(clientSocket);
      await sendOnSocket(clientSocket, tftp.packets.ack.serialize(0), oack.rinfo.port, oack.rinfo.address);

      const firstData = await receiveMessage(clientSocket);
      const firstPacket = tftp.packets.data.deserialize(firstData.message, 512);
      expect(firstPacket.block).toBe(1);
      expect(Buffer.compare(firstPacket.data, fixture)).toBe(0);

      const secondData = await receiveMessage(clientSocket, 1500);
      const secondPacket = tftp.packets.data.deserialize(secondData.message, 512);
      expect(secondPacket.block).toBe(1);
      expect(Buffer.compare(secondPacket.data, fixture)).toBe(0);

      await sendOnSocket(clientSocket, tftp.packets.ack.serialize(1), firstData.rinfo.port, firstData.rinfo.address);
    } finally {
      await server.close();
      await closeSocket(clientSocket);
    }
  });
});
