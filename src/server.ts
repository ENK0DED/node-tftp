import { createSocket } from 'node:dgram';
import type { RemoteInfo, Socket } from 'node:dgram';
import { EventEmitter, once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';

import type { CurrentTransfers, ErrorWithCode, SocketFamily, TransferSource, TransferStats, UserExtensions, UserExtensionsInput } from '../types/index.js';
import { resolveSource, safeUnlink, toError, toErrorWithCode, waitForSocketBind } from './helpers.js';
import { MAX_REQUEST_BYTES } from './protocol/constants.js';
import { EACCESS, EBADMSG, EBADNAME, EBADOP, EIO, ENOENT, ENOGET, ENOPUT } from './protocol/errors.js';
import { Helper } from './protocol/request.js';
import type { ServerOptions, ServerOptionsInput } from './protocol/utils.js';
import { createOptions, opcodes, resolvePathWithinRoot } from './protocol/utils.js';
import type { GetStream } from './streams/server/get-stream.js';
import { GetStream as ServerGetStream } from './streams/server/get-stream.js';
import type { PutStream } from './streams/server/put-stream.js';
import { PutStream as ServerPutStream } from './streams/server/put-stream.js';

type RespondOptions = {
  size?: number | null;
  userExtensions?: UserExtensionsInput;
};

type ServerRequestEvents = {
  progress: [progress: ServerRequestProgress];
};

type ServerEvents = {
  close: [];
  error: [error: Error];
  listening: [];
  request: [request: ServerRequest];
};

/**
 * Snapshot emitted by {@link ServerRequest} progress updates.
 */
export type ServerRequestProgress = {
  /** Total bytes transferred so far for this request. */
  bytesTransferred: number;
  /** Negotiated transfer size, or `null` when the size is unknown. */
  size: number | null;
};

/**
 * Request handler passed to the {@link Server} constructor.
 */
export type ServerRequestHandler = (request: ServerRequest) => void | Promise<void>;

const getSocketFamily = (address: string) => {
  const family = isIP(address === 'localhost' ? '127.0.0.1' : address);

  if (family !== 4 && family !== 6) {
    throw new Error('Invalid IP address (server)');
  }

  return family as SocketFamily;
};

const getAbortError = (error: ErrorWithCode, mapEnoent = false) => {
  if (error.code === 'EACCES' || error.code === 'EACCESS' || error.code === 'EPERM') {
    return EACCESS;
  }

  if (mapEnoent && error.code === 'ENOENT') {
    return ENOENT;
  }

  return EIO;
};

const createDonePromise = async (emitter: EventEmitter) =>
  // oxlint-disable-next-line promise/avoid-new
  new Promise<void>((resolve, reject) => {
    // oxlint-disable-next-line no-empty-function, unicorn/consistent-function-scoping
    let cleanup = () => {};

    const onError = (error: unknown) => {
      cleanup();
      reject(toError(error));
    };

    const onAbort = () => {
      cleanup();
      reject(new Error('Transfer aborted'));
    };

    const onClose = () => {
      cleanup();
      resolve();
    };

    cleanup = () => {
      emitter.off('error', onError);
      emitter.off('abort', onAbort);
      emitter.off('close', onClose);
    };

    emitter.once('error', onError);
    emitter.once('abort', onAbort);
    emitter.once('close', onClose);
  });

const serveFileGet = async (filename: string, req: GetStream, res: PutStream) => {
  let fileStats: Awaited<ReturnType<typeof stat>>; // oxlint-disable-line init-declarations

  try {
    fileStats = await stat(filename);
  } catch (error) {
    const resolvedError = toErrorWithCode(error);

    req.on('abort', () => {
      req.emit('error', resolvedError);
    });

    req.abort(getAbortError(resolvedError, true));
    return;
  }

  let aborted = false;

  const rs = createReadStream(filename)
    .on('data', (chunk: Buffer) => {
      req.emit('progress', chunk.length);
    })
    .on('error', (error) => {
      const resolvedError = toErrorWithCode(error);

      req.on('abort', () => {
        aborted = true;
        req.emit('error', resolvedError);
      });

      req.abort(getAbortError(resolvedError, true));
    });

  req.on('error', () => {
    if (!aborted) {
      rs.destroy();
    }
  });

  res.setSize(fileStats.size);
  rs.pipe(res);
};

const serveFilePut = (filename: string, req: GetStream) => {
  const ws = createWriteStream(filename);
  let open = false;
  let destroyOnOpen = false;
  let aborted = false;

  const cleanupAndDestroy = () => {
    ws.on('close', async () => {
      await safeUnlink(filename, true);
    });
    ws.destroy();
  };

  req.on('error', () => {
    if (aborted) {
      return;
    }

    if (open) {
      cleanupAndDestroy();
    } else {
      destroyOnOpen = true;
    }
  });

  ws.on('error', (error) => {
    req.on('abort', async () => {
      await safeUnlink(filename, true);
      aborted = true;
      req.emit('error', error);
    });

    req.abort(getAbortError(error));
  });

  ws.on('open', () => {
    if (destroyOnOpen) {
      cleanupAndDestroy();
      return;
    }

    open = true;
  });

  req.pipe(ws);
};

/**
 * Incoming TFTP request emitted by the server.
 *
 * For `GET` requests, call {@link respond} to send a response body.
 * For `PUT` requests, consume the incoming body through {@link body},
 * {@link readAll}, or {@link saveTo}.
 *
 * Events:
 * - `progress`: emitted with the current {@link ServerRequestProgress} as
 *   bytes are uploaded or downloaded
 */
export class ServerRequest extends EventEmitter<ServerRequestEvents> {
  private cachedBody: GetStream | undefined;
  private bytesTransferred: number;
  private inputClaimed: boolean;
  private lastEmittedBytesTransferred: number;
  private readonly rawReq: GetStream;
  private readonly rawRes: PutStream;
  private readonly root: string;
  private responseStarted: boolean;
  /** Requested remote file name as sent over TFTP. */
  readonly file: string;
  /** Negotiated transfer statistics for this request. */
  readonly stats: TransferStats;
  /** Negotiated user-defined TFTP extensions for this request. */
  readonly userExtensions: UserExtensions;
  /** Resolves once the request finishes successfully. */
  readonly done: Promise<void>;
  /** Request method, either `GET` or `PUT`. */
  readonly method: 'GET' | 'PUT';

  constructor(root: string, req: GetStream, res: PutStream) {
    super();
    this.rawReq = req;
    this.rawRes = res;
    this.bytesTransferred = 0;
    this.done = createDonePromise(req);
    this.inputClaimed = false;
    this.lastEmittedBytesTransferred = -1;
    this.method = req.method === 'PUT' ? 'PUT' : 'GET';
    this.root = root;
    this.responseStarted = false;
    this.file = req.file;

    const { stats: reqStats } = req;

    if (!reqStats) {
      throw new Error('Transfer stats are not initialized');
    }

    this.stats = reqStats;
    this.userExtensions = this.stats.userExtensions;
    // oxlint-disable-next-line promise/prefer-await-to-then
    this.done.catch(() => undefined);

    req.on('close', () => {
      this.emitProgress();
    });

    req.on('progress', (chunkLength: number) => {
      this.recordProgress(chunkLength);
    });

    if (this.method === 'PUT') {
      req.pause();
    }
  }

  /**
   * Readable upload stream for `PUT` requests.
   *
   * This is `undefined` for `GET` requests.
   */
  get body(): Readable | undefined {
    if (this.method !== 'PUT') {
      return undefined;
    }

    if (!this.cachedBody) {
      this.claimInput();
      this.cachedBody = this.rawReq;
    }

    return this.cachedBody;
  }

  /** Absolute path for `file` resolved within the configured server root. */
  get localPath(): string {
    return resolvePathWithinRoot(this.root, this.file);
  }

  /** Latest upload/download progress snapshot for this request. */
  get progress(): ServerRequestProgress {
    return { bytesTransferred: this.bytesTransferred, size: this.stats.size };
  }

  /** Abort the in-flight request. */
  abort(error?: unknown) {
    this.rawReq.abort(error);
  }

  /**
   * Read the full incoming request body into memory.
   *
   * Only available for `PUT` requests.
   *
   * @param maxBodySize - Maximum number of bytes to buffer. Defaults to
   *   64 MiB. Set to `Infinity` to disable the limit (not recommended for
   *   untrusted clients).
   */
  async readAll(maxBodySize = 64 * 1024 * 1024) {
    if (this.method !== 'PUT') {
      throw new Error('Only PUT requests expose an incoming body');
    }

    this.claimInput();

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    this.rawReq.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBodySize) {
        this.rawReq.abort('Request body too large');
        return;
      }
      chunks.push(chunk);
    });
    this.rawReq.resume();

    await this.done;
    return Buffer.concat(chunks);
  }

  /**
   * Send a response body for a `GET` request.
   *
   * When `source` is omitted, the server responds with the file resolved from
   * `localPath`.
   */
  async respond(source?: TransferSource, options: RespondOptions = {}) {
    if (this.method !== 'GET') {
      throw new Error('Only GET requests can send a response body');
    }

    if (this.responseStarted) {
      throw new Error('The response body was already started');
    }

    this.responseStarted = true;

    if (options.userExtensions) {
      this.rawRes.setUserExtensions(options.userExtensions);
    }

    let resolvedSource = source;

    if (resolvedSource === undefined) {
      try {
        resolvedSource = this.localPath;
      } catch (error) {
        this.rawReq.abort(EBADNAME);
        throw error;
      }
    }

    if (typeof resolvedSource === 'string' && options.size === undefined) {
      await serveFileGet(resolvedSource, this.rawReq, this.rawRes);
      await this.done;
      return;
    }

    const normalizedSource = await resolveSource(resolvedSource, { size: options.size });
    this.rawRes.setSize(normalizedSource.size);

    let sourceError: Error | undefined = undefined;

    normalizedSource.stream.on('data', (chunk: Buffer) => {
      this.rawReq.emit('progress', chunk.length);
    });

    normalizedSource.stream.on('error', (error) => {
      sourceError = toError(error);
      this.rawReq.abort(EIO);
    });

    normalizedSource.stream.pipe(this.rawRes);

    try {
      await this.done;
    } catch (error) {
      throw sourceError ?? toError(error);
    }
  }

  /**
   * Save the incoming `PUT` request body to disk.
   *
   * When `path` is omitted, the request is written to the file resolved from
   * the request's `file` within the server root.
   */
  async saveTo(path?: string) {
    if (this.method !== 'PUT') {
      throw new Error('Only PUT requests can be written to disk');
    }

    this.claimInput();

    let resolvedPath: string; // oxlint-disable-line init-declarations

    try {
      resolvedPath = resolvePathWithinRoot(this.root, path ?? this.file);
    } catch (error) {
      this.rawReq.abort(EBADNAME);
      throw error;
    }

    serveFilePut(resolvedPath, this.rawReq);
    await this.done;
  }

  /** Set response-side user-defined TFTP extensions for this request. */
  setUserExtensions(userExtensions: UserExtensionsInput) {
    this.rawRes.setUserExtensions(userExtensions);
  }

  private emitProgress() {
    if (this.listenerCount('progress') === 0 || this.lastEmittedBytesTransferred === this.bytesTransferred) {
      return;
    }

    this.lastEmittedBytesTransferred = this.bytesTransferred;
    this.emit('progress', this.progress);
  }

  private recordProgress(chunkLength: number) {
    this.bytesTransferred += chunkLength;
    this.emitProgress();
  }

  private claimInput() {
    if (this.inputClaimed) {
      throw new Error('The request body was already consumed');
    }

    this.inputClaimed = true;
  }
}

const defaultServeRequest = async (request: ServerRequest) => {
  await (request.method === 'GET' ? request.respond() : request.saveTo());
};

const runServeTask = async (request: ServerRequest, requestHandler: ServerRequestHandler, failures: Error[]) => {
  try {
    await requestHandler(request);
  } catch (error: unknown) {
    const resolvedError = toError(error);
    failures.push(resolvedError);
    request.abort(resolvedError.message);
    throw resolvedError;
  }
};

/**
 * TFTP server.
 *
 * Call {@link listen} to bind the socket and start handling requests.
 *
 * Events:
 * - `request`: emitted for each incoming {@link ServerRequest}
 * - `listening`: emitted once the socket is bound
 * - `close`: emitted after the server is closed
 * - `error`: emitted for server-level failures
 */
export class Server extends EventEmitter<ServerEvents> {
  private readonly currFiles: CurrentTransfers = { get: new Set(), put: new Set() };
  private failures: Error[] = [];
  private readonly family: SocketFamily;
  private readonly handler: ServerRequestHandler;
  private listening = false;
  private listenTask: Promise<void> | undefined = undefined;
  private onRequestListener: ((request: ServerRequest) => void) | undefined = undefined;
  private readonly serverOptions: ServerOptions;
  private socket: Socket | undefined = undefined;
  private readonly tasks = new Set<Promise<void>>();
  /** Bound host configured for this server. */
  readonly host: string;
  /** Bound UDP port configured for this server. */
  readonly port: number;
  /** Filesystem root used by the default request handler. */
  readonly root: string;

  /**
   * Call `await server.listen()` to bind the socket and start handling
   * requests. Without a handler the server uses the default
   * filesystem-backed behavior:
   * - `GET` requests serve files from `root`
   * - `PUT` requests write files under `root`
   *
   * Supported options:
   * - all client transport options: `host`, `port`, `blockSize`, `windowSize`,
   *   `retries`, `timeout`
   * - `root?: string` - filesystem root for the default handler, default `.`
   * - `denyGET?: boolean` - reject incoming `GET` requests
   * - `denyPUT?: boolean` - reject incoming `PUT` requests
   */
  constructor(options: ServerOptionsInput = {}, handler?: ServerRequestHandler) {
    super();
    const serverOptions = createOptions(options, 'server');
    this.family = getSocketFamily(serverOptions.address);
    this.handler = handler ?? defaultServeRequest;
    this.serverOptions = serverOptions;
    this.host = serverOptions.address;
    this.port = serverOptions.port;
    this.root = serverOptions.root;
    this.on('error', () => undefined);
  }

  /**
   * Bind the server socket and start handling requests.
   *
   * Resolves once the socket is bound. Calling `listen()` again while the
   * server is already listening is a no-op.
   */
  async listen() {
    if (this.listening) {
      return;
    }

    if (this.listenTask) {
      return this.listenTask;
    }

    this.failures = [];
    this.tasks.clear();

    const onRequest = (request: ServerRequest) => {
      const task = runServeTask(request, this.handler, this.failures);

      this.tasks.add(task);
      /* oxlint-disable promise/prefer-await-to-then */
      task
        .finally(() => {
          this.tasks.delete(task);
        })
        .catch(() => undefined);
      /* oxlint-enable promise/prefer-await-to-then */
    };

    this.onRequestListener = onRequest;
    this.on('request', onRequest);

    // oxlint-disable-next-line promise/prefer-await-to-then
    const listenTask = this.listenInternal().finally(() => {
      if (this.listenTask === listenTask) {
        this.listenTask = undefined;
      }
    });

    this.listenTask = listenTask;
    await listenTask;
  }

  /**
   * Close the server, stop accepting requests, and drain all in-flight
   * handler tasks.
   *
   * If any request handler threw an error, the first failure is rethrown
   * after all tasks have settled.
   */
  async close() {
    if (!this.listening && !this.listenTask) {
      return;
    }

    if (this.onRequestListener) {
      this.off('request', this.onRequestListener);
      this.onRequestListener = undefined;
    }

    if (this.listenTask) {
      try {
        await this.listenTask;
      } catch {
        // listenInternal already emitted the error and cleaned up the socket;
        // if it never bound we have nothing left to close.
        if (!this.socket) {
          await Promise.allSettled(this.tasks);
          return;
        }
      }
    }

    const closePromise = once(this, 'close');
    this.socket?.close();
    await closePromise;

    await Promise.allSettled(this.tasks);

    if (this.failures.length > 0) {
      const [firstFailure] = this.failures;
      this.failures = [];
      throw firstFailure;
    }
  }

  private createSocket() {
    const socket = createSocket(`udp${this.family}`)
      .on('error', (error) => {
        this.emit('error', toError(error));
      })
      .on('close', () => {
        this.listening = false;
        this.socket = undefined;
        this.emit('close');
      })
      .on('message', (message, rinfo) => {
        this.handleMessage(message, rinfo);
      });

    this.socket = socket;
    return socket;
  }

  private handleMessage(message: Buffer, rinfo: RemoteInfo) {
    const helper = new Helper(rinfo, this.family);

    if (message.length < 9 || message.length > MAX_REQUEST_BYTES) {
      helper.sendErrorAndClose(EBADMSG);
      return;
    }

    const op = message.readUInt16BE(0);

    if (op === opcodes.RRQ) {
      if (this.serverOptions.denyGET) {
        helper.sendErrorAndClose(ENOGET);
        return;
      }

      const gs = ServerGetStream.createShell();
      const ps = new ServerPutStream(this.currFiles, helper, message, this.serverOptions, gs);
      ps.onReady = () => {
        this.pushRequest(gs, ps);
      };
      return;
    }

    if (op === opcodes.WRQ) {
      if (this.serverOptions.denyPUT) {
        helper.sendErrorAndClose(ENOPUT);
        return;
      }

      const ps = ServerPutStream.createShell();
      const gs = new ServerGetStream(this.currFiles, helper, message, this.serverOptions, ps);
      gs.onReady = () => {
        this.pushRequest(gs, ps);
      };
      return;
    }

    helper.sendErrorAndClose(EBADOP);
  }

  private pushRequest(req: GetStream, res: PutStream) {
    if (!this.listening) {
      req.abort('Server is not listening');
      return;
    }

    this.emit('request', new ServerRequest(this.root, req, res));
  }

  private async listenInternal() {
    try {
      const rootStats = await stat(this.root);

      if (!rootStats.isDirectory()) {
        throw new Error('The root is not a directory');
      }

      const socket = this.socket ?? this.createSocket();
      await waitForSocketBind(socket, this.port, this.host);
      this.listening = true;
      this.emit('listening');
    } catch (error) {
      if (this.socket && !this.listening) {
        this.socket.close();
      }

      const resolvedError = toErrorWithCode(error);
      this.emit('error', resolvedError);
      throw resolvedError;
    }
  }
}
