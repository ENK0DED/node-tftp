import path from 'node:path';

import type { ExtensionStrings } from '../../types/index.js';
import { MAX_BLOCK_SIZE, MAX_WINDOW_SIZE, MIN_BLOCK_SIZE } from './constants.js';

const UNSIGNED_INTEGER = /^\d+$/;

const sanitizeNumber = (n: number): number => {
  const integer = Math.trunc(n);
  return integer < 1 ? 1 : integer;
};

/**
 * Parse a string as an unsigned integer, returning `undefined` when the
 * value is not a valid non-negative safe integer.
 */
export const parseUnsignedInteger = (value: string): number | undefined => {
  if (!UNSIGNED_INTEGER.test(value)) {
    return undefined;
  }

  const numericValue = Number(value);
  return Number.isSafeInteger(numericValue) ? numericValue : undefined;
};

export const knownExtensions = { blksize: true, rollover: true, timeout: true, tsize: true, windowsize: true } as const;

// oxlint-disable-next-line sort-keys
export const opcodes = { RRQ: 1, WRQ: 2, DATA: 3, ACK: 4, ERROR: 5, OACK: 6 } as const;

export const normalizeFilename = (filename: string) => {
  const normalizedFilename = path.normalize(filename);

  // Check for invalid access
  if (normalizedFilename.startsWith('..')) {
    throw new Error('The path of the filename cannot point to upper levels');
  }

  // Multibytes characters are not allowed
  if (Buffer.byteLength(normalizedFilename) > normalizedFilename.length) {
    throw new Error('The filename cannot contain multibyte characters');
  }

  return normalizedFilename;
};

export const resolvePathWithinRoot = (root: string, filename: string) => {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, filename);
  const relativePath = path.relative(resolvedRoot, resolvedPath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('The path of the filename cannot point to upper levels');
  }

  return resolvedPath;
};

export type OptionsType = 'client' | 'server';

/**
 * Options accepted by the {@link Client} constructor.
 */
export type ClientOptionsInput = {
  /** Server host name or IP address. Defaults to `localhost`. */
  host?: string;
  /** Server UDP port. Defaults to `69`. */
  port?: number;
  /** Requested `blksize` value. Defaults to `1468`. */
  blockSize?: number;
  /** Requested `windowsize` value. Defaults to `4`. */
  windowSize?: number;
  /** Maximum retransmission attempts. Defaults to `3`. */
  retries?: number;
  /** Requested retransmission timeout in seconds. Defaults to `3`. */
  timeout?: number;
};

/**
 * Options accepted by the {@link Server} constructor.
 */
export type ServerOptionsInput = ClientOptionsInput & {
  /** Filesystem root used by the default request handler. Defaults to `.`. */
  root?: string;
  /** Reject incoming `GET` requests when set. */
  denyGET?: boolean;
  /** Reject incoming `PUT` requests when set. */
  denyPUT?: boolean;
};

type BaseOptions = {
  address: string;
  port: number;
  retries: number;
  extensions: { blksize: number; rollover: 0 | 1; timeout: number; windowsize: number };
  extensionsString: ExtensionStrings;
  extensionsLength: number;
};

export type ClientOptions = BaseOptions;

type ServerOnlyOptions = { root: string; denyGET?: boolean; denyPUT?: boolean };

export type ServerOptions = ClientOptions & ServerOnlyOptions;

const isServerOptionsInput = (type: OptionsType, _opts: ClientOptionsInput | ServerOptionsInput): _opts is ServerOptionsInput => type === 'server';

const createBaseOptions = (opts: ClientOptionsInput = {}): ClientOptions => {
  const options: ClientOptions = {
    address: opts.host ?? 'localhost',
    extensions: { blksize: 0, rollover: 0, timeout: 0, windowsize: 0 },
    extensionsLength: 0,
    extensionsString: { blksize: '', rollover: '', timeout: '', windowsize: '' },
    // Use `||` (not `??`) so that falsy inputs (0, NaN) fall back to the
    // documented defaults.
    port: sanitizeNumber(opts.port || 69),
    retries: sanitizeNumber(opts.retries || 3),
  };

  // Default window size 4: https://github.com/joyent/node/issues/6696
  let windowSize = sanitizeNumber(opts.windowSize || 4);
  if (windowSize > MAX_WINDOW_SIZE) {
    windowSize = 4;
  }

  // Maximum block size before IP packet fragmentation on Ethernet networks
  let blockSize = sanitizeNumber(opts.blockSize || 1468);
  if (blockSize < MIN_BLOCK_SIZE || blockSize > MAX_BLOCK_SIZE) {
    blockSize = 1468;
  }

  let timeout = sanitizeNumber(opts.timeout || 3);
  if (timeout > 255) {
    timeout = 3;
  }

  options.extensions = {
    blksize: blockSize,
    // This option is not strictly required because it is not necessary when receiving a file and it is only used to inform the server
    // when sending a file. Most servers won't care about it and will simply ignore it.
    rollover: 0,
    timeout,
    windowsize: windowSize,
  };

  options.extensionsString = { blksize: blockSize.toString(), rollover: '0', timeout: timeout.toString(), windowsize: windowSize.toString() };

  let extensionsLength = 0;

  for (const [key, value] of Object.entries(options.extensionsString)) {
    extensionsLength += key.length + 1 + value.length + 1;
  }

  // tsize key overhead (key + NUL + NUL); value length is added by rrq/wrq serializers.
  extensionsLength += 7; // 'tsize'.length + 2
  options.extensionsLength = extensionsLength;

  return options;
};

export function createOptions(opts: ClientOptionsInput | undefined, type: 'client'): ClientOptions;
export function createOptions(opts: ServerOptionsInput | undefined, type: 'server'): ServerOptions;
export function createOptions(opts: ClientOptionsInput | ServerOptionsInput | undefined, type: OptionsType): ClientOptions | ServerOptions {
  const resolvedOptions = opts ?? {};
  const options = createBaseOptions(resolvedOptions);
  return isServerOptionsInput(type, resolvedOptions)
    ? { ...options, denyGET: resolvedOptions.denyGET, denyPUT: resolvedOptions.denyPUT, root: resolvedOptions.root ?? '.' }
    : options;
}
