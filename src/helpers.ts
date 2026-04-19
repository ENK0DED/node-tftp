import type { Socket } from 'node:dgram';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';

import type { ErrorWithCode, TransferSource } from '../types/index.js';

/**
 * Promise-wrapped `socket.send`.  We don't use `util.promisify` because
 * `dgram.Socket#send` has eight overloads, several of which `promisify`'s
 * type machinery picks the wrong one of, and writing the resulting cast is
 * uglier than the explicit constructor below.
 */
// oxlint-disable-next-line eslint/max-params
export const sendOnSocket = async (socket: Socket, buffer: Buffer, port: number, address: string): Promise<void> => {
  // oxlint-disable-next-line eslint-plugin-promise/avoid-new
  await new Promise<void>((resolve, reject) => {
    socket.send(buffer, 0, buffer.length, port, address, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
};

/**
 * Wrap an arbitrary thrown value into an `Error` instance.  Used everywhere
 * we surface a thrown value through the public API or Node stream events.
 */
export const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/** Same as {@link toError}, but typed as `ErrorWithCode` for ergonomic `.code` reads. */
export const toErrorWithCode = (error: unknown): ErrorWithCode => toError(error) as ErrorWithCode;

/**
 * Bind `socket` to (`port`, `address`) and resolve once the socket emits
 * `'listening'`.  If the bind fails, reject with the corresponding `'error'`
 * event.
 *
 * Implementation note: we race two `events.once` calls so that whichever
 * event fires first wins, and abort the other listener so we never leak
 * handlers.  Without the AbortControllers a failed bind would leave the
 * `'listening'` once-listener attached for the lifetime of the (now-broken)
 * socket — Node's docs for `events.once` recommend this pattern explicitly.
 */
const waitForSocketError = async (socket: Socket, signal: AbortSignal): Promise<never> => {
  const [bindError] = await once(socket, 'error', { signal });
  throw bindError;
};

export const waitForSocketBind = async (socket: Socket, port: number, address?: string): Promise<void> => {
  const listeningController = new AbortController();
  const errorController = new AbortController();
  const listening = once(socket, 'listening', { signal: listeningController.signal });
  const error = waitForSocketError(socket, errorController.signal);

  socket.bind(port, address);

  try {
    await Promise.race([listening, error]);
  } finally {
    listeningController.abort();
    errorController.abort();
  }
};

/**
 * Best-effort `unlink`.  By default swallows `ENOENT` (the file was already
 * gone) but surfaces every other error.  When `swallowAll` is `true`, every
 * error is silently ignored — used during abort cleanup where there is nobody
 * to surface the cleanup error to.
 */
export const safeUnlink = async (path: string, swallowAll = false): Promise<void> => {
  try {
    await unlink(path);
  } catch (error) {
    if (!swallowAll && toErrorWithCode(error).code !== 'ENOENT') {
      throw error;
    }
  }
};

/**
 * Resolve a {@link TransferSource} (file path, buffer, or readable stream)
 * into a `{ size, stream }` pair ready for piping into a TFTP transfer.
 *
 * Used by both the client and server to normalize upload sources.
 */
export const resolveSource = async (
  source: TransferSource,
  options: { highWaterMark?: number; size?: number | null } = {},
): Promise<{ size: number; stream: Readable }> => {
  if (typeof source === 'string') {
    const stats = await stat(source);

    if (stats.isDirectory()) {
      throw new Error('The local file is a directory');
    }

    return { size: stats.size, stream: createReadStream(source, { highWaterMark: options.highWaterMark }) };
  }

  if (source instanceof Uint8Array) {
    const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source);
    return { size: buffer.length, stream: Readable.from([buffer]) };
  }

  if (!(source instanceof Readable)) {
    throw new Error('Unsupported transfer source');
  }

  if (options.size === undefined || options.size === null) {
    throw new Error('Missing size for stream source');
  }

  return { size: options.size, stream: source };
};

/** No-op function used as a default callback placeholder. */
export const noop = () => undefined;
