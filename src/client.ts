import { lookup } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type {
  GetTransferOptions,
  PutTransferOptions,
  SizedPutTransferOptions,
  SocketFamily,
  TransferDestination,
  TransferSource,
  TransferStats,
} from '../types/index.js';
import { resolveSource, safeUnlink, toError, toErrorWithCode } from './helpers.js';
import { EIO } from './protocol/errors.js';
import type { ClientOptions, ClientOptionsInput } from './protocol/utils.js';
import { createOptions, normalizeFilename } from './protocol/utils.js';
import type { ClientRuntime } from './streams/client/client-request.js';
import { GetStream } from './streams/client/get-stream.js';
import { PutStream } from './streams/client/put-stream.js';

type TransferEvents = {
  abort: [];
  close: [];
  done: [];
  stats: [stats: TransferStats];
};

const awaitTransferClose = async (transfer: EventEmitter<TransferEvents>): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new
  new Promise((resolve, reject) => {
    transfer.once('close', resolve);
    transfer.once('abort', () => {
      reject(new Error('Transfer aborted'));
    });
  });

const resolveClientRuntime = async (address: string): Promise<ClientRuntime> => {
  try {
    const { address: resolvedAddress, family } = await lookup(address);

    if (family !== 4 && family !== 6) {
      throw new Error(`Unsupported IP family "${family}"`);
    }

    return { address: resolvedAddress, family: family as SocketFamily };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unsupported IP family')) {
      throw error;
    }

    throw new Error(`Cannot resolve the domain name "${address}"`, { cause: error });
  }
};

type StreamWithTransferEvents = {
  on(event: 'abort' | 'close', listener: () => void): unknown;
  on(event: 'stats', listener: (stats: TransferStats) => void): unknown;
};

class BaseTransfer extends EventEmitter<TransferEvents> {
  protected aborted = false;

  protected bindStreamEvents(stream: StreamWithTransferEvents) {
    stream.on('abort', () => {
      this.aborted = true;
      this.emit('abort');
    });

    stream.on('close', () => {
      if (!this.aborted) {
        this.emit('done');
      }

      this.emit('close');
    });

    stream.on('stats', (stats: TransferStats) => {
      this.emit('stats', stats);
    });
  }
}

/**
 * Stream-oriented download handle returned by {@link Client.get}.
 *
 * Use this lower-level API when you want to read from the remote file
 * yourself, observe transfer lifecycle events, or close the transfer
 * independently from piping it into a destination.
 *
 * Events:
 * - `stats`: emitted once the negotiated {@link TransferStats} are available
 * - `done`: emitted after a successful transfer completion
 * - `abort`: emitted when the transfer is aborted
 * - `close`: emitted when the underlying transfer stream closes
 */
export class GetTransfer extends BaseTransfer {
  private readonly stream: GetStream;

  constructor(stream: GetStream) {
    super();
    this.stream = stream;
    this.bindStreamEvents(stream);
  }

  /** Readable body stream for the remote file contents. */
  get body(): Readable {
    return this.stream;
  }

  /**
   * Close the transfer.
   *
   * Without an argument this is a clean close. When called with an error
   * argument the transfer is aborted and the `abort` event fires before
   * `close`.
   */
  close(error?: unknown) {
    if (error !== undefined) {
      this.stream.abort(error);
    } else {
      this.stream.close();
    }
  }
}

/**
 * Stream-oriented upload handle returned by {@link Client.put}.
 *
 * Use this lower-level API when you want to stream upload data manually,
 * observe transfer lifecycle events, or close the transfer independently
 * from the convenience {@link Client.asyncPut} wrapper.
 *
 * Events:
 * - `stats`: emitted once the negotiated {@link TransferStats} are available
 * - `done`: emitted after a successful transfer completion
 * - `abort`: emitted when the transfer is aborted
 * - `close`: emitted when the underlying transfer stream closes
 */
export class PutTransfer extends BaseTransfer {
  private readonly clientRuntime: Promise<ClientRuntime>;
  private readonly highWaterMark: number | undefined;
  private readonly options: ClientOptions;
  private readonly putOptions: PutTransferOptions;
  private readonly remote: string;
  private sent = false;
  private stream: PutStream | undefined = undefined;

  // oxlint-disable-next-line eslint/max-params
  constructor(remote: string, options: ClientOptions, putOptions: PutTransferOptions, clientRuntime: Promise<ClientRuntime>) {
    super();
    this.clientRuntime = clientRuntime;
    this.remote = remote;
    this.options = options;
    this.putOptions = putOptions;
    this.highWaterMark = putOptions.highWaterMark;
  }

  /**
   * Close the transfer.
   *
   * Without an argument this is a clean close. When called with an error
   * argument the transfer is aborted and the `abort` event fires before
   * `close`.
   */
  close(error?: unknown) {
    if (this.stream) {
      if (error !== undefined) {
        this.stream.abort(error);
      } else {
        this.stream.close();
      }

      return;
    }

    if (error !== undefined) {
      this.aborted = true;
      this.emit('abort');
    }

    this.emit('close');
  }

  /**
   * Writable body stream for the upload when the transfer size is already
   * known in the options.
   */
  get body(): Writable {
    const { size } = this.putOptions;

    if (size === undefined || size === null) {
      throw new Error('Missing size for writable upload transfer');
    }

    return this.ensureStream(size);
  }

  /**
   * Send a complete upload source through the transfer.
   *
   * `source` can be:
   * - a filesystem path
   * - a `Buffer` or `Uint8Array`
   * - a readable Node stream
   *
   * If `source` is a stream, the transfer size must be provided through
   * `PutTransferOptions.size`.
   */
  async send(source: TransferSource) {
    if (this.sent) {
      throw new Error('The transfer source was already sent');
    }

    this.sent = true;

    const resolvedSource = await resolveSource(source, { highWaterMark: this.highWaterMark, size: this.putOptions.size });
    const stream = this.ensureStream(resolvedSource.size);
    const closed = awaitTransferClose(this);
    // oxlint-disable-next-line promise/prefer-await-to-then
    closed.catch(() => undefined);

    try {
      await pipeline(resolvedSource.stream, stream);
      await closed;
    } catch (error) {
      stream.abort(EIO);

      try {
        await closed;
      } catch {
        // The original transfer failure is the one we want to surface.
      }

      throw toError(error);
    }
  }

  private ensureStream(size: number) {
    if (this.putOptions.size !== undefined && this.putOptions.size !== null && this.putOptions.size !== size) {
      throw new Error('Transfer source size does not match the configured upload size');
    }

    if (this.stream) {
      return this.stream;
    }

    const putOptions: SizedPutTransferOptions = { highWaterMark: this.highWaterMark, size, userExtensions: this.putOptions.userExtensions };
    const stream = new PutStream(this.remote, this.options, putOptions, this.clientRuntime);
    this.stream = stream;
    this.bindStreamEvents(stream);
    return stream;
  }
}

/**
 * TFTP client.
 *
 * The client is constructed and defers one-time network setup until the
 * first transfer starts. Concurrent first transfers share the same
 * initialization, and failed initialization is retried on the next transfer.
 */
export class Client {
  private initialization: Promise<ClientRuntime> | undefined;
  private readonly options: ClientOptions;
  private runtime: ClientRuntime | undefined;

  /**
   * Supported options:
   * - `host?: string` - server host, default `localhost`
   * - `port?: number` - server port, default `69`
   * - `blockSize?: number` - requested `blksize`, default `1468`
   * - `windowSize?: number` - requested `windowsize`, default `4`
   * - `retries?: number` - max retransmission attempts, default `3`
   * - `timeout?: number` - requested retransmission timeout in seconds,
   *   default `3`
   */
  constructor(options: ClientOptionsInput = {}) {
    this.options = createOptions(options, 'client');
    this.initialization = undefined;
    this.runtime = undefined;
  }

  /**
   * Create a manual download transfer handle for `remote`.
   *
   * The returned {@link GetTransfer} exposes the readable body stream
   * and lifecycle events.
   */
  get(remote: string, options: GetTransferOptions = {}) {
    return new GetTransfer(new GetStream(normalizeFilename(remote), this.options, options, this.initialize()));
  }

  /**
   * Download `remote` into a destination and resolve with the negotiated
   * {@link TransferStats} once the transfer completes.
   *
   * `destination` can be:
   * - a filesystem path
   * - a writable Node stream
   *
   * If `destination` is omitted, it defaults to the same string as `remote`.
   *
   * `options` always stays the third parameter. To pass options while using
   * the default destination, call `asyncGet(remote, undefined, options)`.
   */
  async asyncGet(remote: string, destination?: TransferDestination, options: GetTransferOptions = {}) {
    const resolvedDestination = destination ?? remote;

    if (typeof resolvedDestination === 'string') {
      try {
        const stats = await stat(resolvedDestination);

        if (stats.isDirectory()) {
          throw new Error('The local file is a directory');
        }
      } catch (error) {
        const resolvedError = toErrorWithCode(error);

        if (resolvedError.code !== 'ENOENT') {
          throw resolvedError;
        }
      }
    }

    const transfer = this.get(remote, options);
    let transferStats: TransferStats | undefined; // oxlint-disable-line init-declarations

    transfer.on('stats', (stats) => {
      transferStats = stats;
    });

    const closed = awaitTransferClose(transfer);
    // oxlint-disable-next-line promise/prefer-await-to-then
    closed.catch(() => undefined);

    try {
      await pipeline(transfer.body, typeof resolvedDestination === 'string' ? createWriteStream(resolvedDestination) : resolvedDestination);
      await closed;

      if (!transferStats) {
        throw new Error('Transfer closed before stats were available');
      }
    } catch (error) {
      const pathCleanup = typeof resolvedDestination === 'string' ? resolvedDestination : undefined;

      if (pathCleanup) {
        await safeUnlink(pathCleanup);
      }

      transfer.close(EIO);

      try {
        await closed;
      } catch {
        // Preserve the original write failure instead of the follow-up abort.
      }

      throw toError(error);
    }

    return transferStats;
  }

  /**
   * Create a manual upload transfer handle for `remote`.
   *
   * The returned {@link PutTransfer} exposes the writable body stream when the
   * size is known up front, and lifecycle events.
   */
  put(remote: string, options: PutTransferOptions = {}) {
    return new PutTransfer(normalizeFilename(remote), this.options, options, this.initialize());
  }

  /**
   * Upload `source` into `remote` and resolve with the negotiated
   * {@link TransferStats} once the transfer completes.
   *
   * `source` can be:
   * - a filesystem path
   * - a `Buffer` or `Uint8Array`
   * - a readable Node stream
   *
   * If `source` is a stream, `PutTransferOptions.size` must be provided.
   *
   * If `remote` is omitted, it defaults to the same string as `source`. This
   * shorthand only works when `source` is a filesystem path string.
   *
   * `options` always stays the third parameter. To pass options while using
   * the default remote path, call `asyncPut(sourcePath, undefined, options)`.
   */
  async asyncPut(source: TransferSource, remote?: string, options: PutTransferOptions = {}) {
    const resolvedRemote = remote ?? (typeof source === 'string' ? source : undefined);

    if (!resolvedRemote) {
      throw new Error('Missing remote destination for non-path upload source');
    }

    const transfer = this.put(resolvedRemote, options);
    let transferStats: TransferStats | undefined; // oxlint-disable-line init-declarations

    transfer.on('stats', (stats) => {
      transferStats = stats;
    });

    await transfer.send(source);

    if (!transferStats) {
      throw new Error('Transfer closed before stats were available');
    }

    return transferStats;
  }

  private async initialize() {
    if (this.runtime) {
      return Promise.resolve(this.runtime);
    }

    if (this.initialization) {
      return this.initialization;
    }

    /* oxlint-disable promise/prefer-await-to-then */
    const initialization = resolveClientRuntime(this.options.address)
      .then((runtime) => {
        this.runtime = runtime;
        return runtime;
      })
      .catch((error: unknown) => {
        throw toError(error);
      })
      .finally(() => {
        if (!this.runtime) {
          this.initialization = undefined;
        }
      });
    /* oxlint-enable promise/prefer-await-to-then */

    this.initialization = initialization;
    return initialization;
  }
}
