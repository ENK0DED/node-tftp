/**
 * Shared test helpers.
 *
 * The suite targets the code shipped from `src/`.
 *
 * These helpers keep protocol- and integration-level tests concise by
 * centralizing the imported public surface and a few shared fixtures.
 */
import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { buffer as readBuffer } from 'node:stream/consumers';
import { setTimeout } from 'node:timers/promises';

import { Client, Server } from '../src/index.js';
import { errors, wrap } from '../src/protocol/errors.js';
import { packets } from '../src/protocol/packets/index.js';
import { readString } from '../src/protocol/packets/read-string.js';
import type { ClientOptions } from '../src/protocol/utils.js';
import { opcodes, knownExtensions, normalizeFilename, createOptions } from '../src/protocol/utils.js';

const ERROR_NAMES = [
  'ENOENT',
  'EACCESS',
  'ENOSPC',
  'EBADOP',
  'ETID',
  'EEXIST',
  'ENOUSER',
  'EDENY',
  'ESOCKET',
  'EBADMSG',
  'EABORT',
  'EFBIG',
  'ETIME',
  'EBADMODE',
  'EBADNAME',
  'EIO',
  'ENOGET',
  'ENOPUT',
  'ERBIG',
  'ECONPUT',
  'ECURPUT',
  'ECURGET',
] as const;
type ErrorName = (typeof ERROR_NAMES)[number];

/**
 * Allocate a UDP port number that is unique-ish per worker and per call so
 * that multiple integration tests can run in the same process without
 * stomping on each other.  Linux assigns ephemeral ports starting from
 * `ip_local_port_range`; we stay below that to keep tests reproducible
 * regardless of system tuning.
 */
let portCounter = 0;
const PORT_BASE = 41_069;
const allocPort = () => {
  const port = PORT_BASE + (portCounter % 1024);
  portCounter += 1;
  return port;
};

/**
 * Variant of {@link allocPort} for test files that may run **concurrently**
 * with the main transfer suite under Bun's per-file worker model.  Each
 * worker has its own module instance — and therefore its own counter — so a
 * fresh `allocPort()` from a second file would happily reuse the same ports
 * as the first.  We segregate by giving each cooperating test file its own
 * disjoint 1024-port window above the default suite's range.
 */
const allocPortRange = (bias: number) => {
  let counter = 0;
  return () => {
    const port = PORT_BASE + bias * 1024 + (counter % 1024);
    counter += 1;
    return port;
  };
};

/**
 * Create a minimal `ClientOptions` object that satisfies the type signatures
 * accepted by both `wrq.serialize` and `rrq.serialize`.  Tests that need
 * specific extension values can spread over the result.
 */
const baseClientOptions = (): ClientOptions => ({
  address: 'localhost',
  extensions: { blksize: 1468, rollover: 0, timeout: 3, windowsize: 4 },
  // 48 + len('1468') + len('3') + len('4') = 48 + 4 + 1 + 1 = 54
  extensionsLength: 54,
  extensionsString: { blksize: '1468', rollover: '0', timeout: '3', windowsize: '4' },
  port: 69,
  retries: 3,
});

const readTransfer = async (source: Readable) => readBuffer(source);

const captureError = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return error as Error;
  }
};

const readWhenComplete = async (path: string, expectedLength: number): Promise<Buffer> => {
  let last = Buffer.alloc(0);

  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      last = await readFile(path);
    } catch {
      await setTimeout(50);
      continue;
    }

    if (last.length === expectedLength) {
      return last;
    }

    await setTimeout(50);
  }

  return last;
};

// oxlint-disable-next-line eslint/max-params
const buildRequestPacket = (op: number, file: string, mode: string, extensions: Record<string, string> = {}) => {
  const bytes = 2 + file.length + 1 + mode.length + 1 + Object.entries(extensions).reduce((total, [key, value]) => total + key.length + value.length + 2, 0);
  const buffer = Buffer.alloc(bytes);
  buffer.writeUInt16BE(op, 0);

  let cursor = 2;
  buffer.write(file, cursor, 'ascii');
  cursor += file.length;
  buffer[cursor] = 0;
  cursor += 1;
  buffer.write(mode, cursor, 'ascii');
  cursor += mode.length;
  buffer[cursor] = 0;
  cursor += 1;

  for (const [key, value] of Object.entries(extensions)) {
    buffer.write(key, cursor, 'ascii');
    cursor += key.length;
    buffer[cursor] = 0;
    cursor += 1;
    buffer.write(value, cursor, 'ascii');
    cursor += value.length;
    buffer[cursor] = 0;
    cursor += 1;
  }

  return buffer;
};

type StartServerOptions = {
  denyGET?: boolean;
  denyPUT?: boolean;
  port: number;
  root: string;
  windowSize?: number;
};

const startServer = async (options: StartServerOptions) => {
  const server = new Server({ ...options, host: '127.0.0.1' });
  await server.listen();
  return server;
};

const ALL_ERROR_NAMES: ErrorName[] = [...ERROR_NAMES];
const EXPECTED_EXTENSIONS = ['blksize', 'rollover', 'timeout', 'tsize', 'windowsize'] as (keyof typeof tftp.knownExtensions)[];

const tftp = { Client, Server, createOptions, errors, knownExtensions, normalizeFilename, opcodes, packets, readString, wrap };

export type { ErrorName };
export {
  ALL_ERROR_NAMES,
  EXPECTED_EXTENSIONS,
  allocPort,
  allocPortRange,
  baseClientOptions,
  buildRequestPacket,
  captureError,
  readTransfer,
  readWhenComplete,
  startServer,
  tftp,
};
