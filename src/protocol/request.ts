import { createSocket } from 'node:dgram';
import type { RemoteInfo, Socket } from 'node:dgram';

import type { SocketFamily } from '../../types/index.js';
import { sendOnSocket } from '../helpers.js';
import { EABORT, ETID, ETIME, wrap } from './errors.js';
import type { TFTPError } from './errors.js';
import { packets } from './packets/index.js';

type ErrorLike = {
  message: string;
  name?: string;
};

const stringifyErrorValue = (value: unknown) => {
  switch (typeof value) {
    case 'bigint':
    case 'boolean':
    case 'number':
    case 'string':
    case 'symbol': {
      return String(value);
    }

    default: {
      return EABORT.message;
    }
  }
};

const isTFTPErrorLike = (error: unknown): error is Omit<TFTPError, 'name'> | TFTPError => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  return 'code' in error && typeof error.code === 'number' && 'message' in error && typeof error.message === 'string';
};

const normalizeCloseError = (error: unknown): ErrorLike => {
  if (error instanceof Error) {
    return { message: error.message || EABORT.message, name: error.name || undefined };
  }

  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return { message: error.message, name: 'name' in error && typeof error.name === 'string' ? error.name : undefined };
  }

  return { message: stringifyErrorValue(error), name: undefined };
};

const normalizeError = (error: unknown): TFTPError => {
  if (!error) {
    return EABORT;
  }

  if (isTFTPErrorLike(error)) {
    return { code: error.code, message: error.message, name: 'name' in error ? error.name : undefined };
  }

  if (error instanceof Error) {
    return wrap(error.message || EABORT.message);
  }

  return wrap(stringifyErrorValue(error));
};

class Retransmitter {
  request: Request;
  timer: NodeJS.Timeout | undefined;
  pending: number;

  constructor(request: Request) {
    this.request = request;
    this.timer = undefined;
    this.pending = this.request.retries;
  }

  reset() {
    if (!this.timer) {
      return;
    }

    clearTimeout(this.timer);
    this.pending = this.request.retries;
    this.timer = undefined;
  }

  start(fn: () => void) {
    this.timer = setTimeout(() => {
      if (!this.pending) {
        this.request.closeSocket(new Error(ETIME.message));
      } else {
        this.pending -= 1;
        fn();
        this.start(fn);
      }
    }, this.request.timeout);
  }
}

// Access modifiers are omitted on this class because it participates in the
// class-factory mixin pattern (`createReader` / `createWriter`).  TypeScript
// cannot represent private/protected members of anonymous classes in
// declaration files (TS4094).

export class Request {
  address: string;
  port: number;
  retries: number;
  timeout: number;
  socket: Socket | undefined;
  closed: boolean;
  closing: boolean;
  aborted: boolean;
  closeError: Error | undefined;
  prefixError: string;
  requestTimer: Retransmitter;
  onCloseFn?: () => void;
  ipFamily: SocketFamily | undefined;
  // oxlint-disable-next-line class-methods-use-this, no-empty-function
  handleAbort(): void {}
  // oxlint-disable-next-line class-methods-use-this, no-empty-function
  handleError(_error: Error): void {}
  // oxlint-disable-next-line class-methods-use-this, no-empty-function
  handleClose(): void {}

  // oxlint-disable-next-line eslint/max-params
  constructor(address: string, port: number, retries: number, timeout: number) {
    this.address = address;
    this.port = port;
    this.retries = retries;
    this.timeout = timeout;
    this.socket = undefined;
    this.closed = false;
    this.closing = false;
    this.aborted = false;
    this.closeError = undefined;
    this.prefixError = '';
    this.requestTimer = this.createRetransmitter();
    this.ipFamily = undefined;
  }

  abort(error?: unknown) {
    if (this.closed || this.closing || this.aborted) {
      return;
    }

    this.aborted = true;
    // oxlint-disable-next-line promise/prefer-await-to-then, promise/no-promise-in-callback
    this.abortWithError(error).catch(() => undefined);
  }

  close() {
    if (this.closed || this.closing || this.aborted) {
      return;
    }

    this.closeSocket();
  }

  closeSocket(error?: Error) {
    if (this.closed || this.closing || !this.socket) {
      return;
    }

    this.closing = true;

    if (error) {
      this.closeError = error;
    }

    process.nextTick(() => {
      this.socket?.close();
    });
  }

  initSocket(socket: Socket | undefined | null, onMessage: (message: Buffer, rinfo: RemoteInfo) => void) {
    this.onCloseFn = () => {
      this.closed = true;
      this.requestTimer.reset();

      if (this.aborted) {
        return this.handleAbort();
      }

      if (this.closeError) {
        this.handleError(this.closeError);
      } else {
        this.handleClose();
      }
    };

    // oxlint-disable-next-line typescript/no-non-null-assertion
    this.socket = (socket || createSocket(`udp${this.ipFamily!}`))
      .on('error', (error) => {
        this.closed = true;
        this.requestTimer.reset();
        this.handleError(error);
      })
      .on('close', this.onCloseFn)
      .on('message', onMessage);
  }

  sendTidError(rinfo: RemoteInfo) {
    const errorPacket = packets.error.serialize(ETID);
    this.socket?.send(errorPacket, 0, errorPacket.length, rinfo.port, rinfo.address);
  }

  sendAck(block: number) {
    this.sendRaw(packets.ack.serialize(block));
  }

  sendBlock(block: number, buffer: Buffer) {
    this.sendRaw(packets.data.serialize(block, buffer));
  }

  sendErrorAndClose(obj: unknown) {
    const error = isTFTPErrorLike(obj) ? obj : normalizeError(obj);
    this.sendRaw(packets.error.serialize(error));
    this.closeWithError(error);
  }

  closeWithError(obj: unknown) {
    const normalized = normalizeCloseError(obj);
    const error = new Error(this.prefixError + normalized.message) as Error & { code?: string | null };

    if (normalized.name) {
      error.code = normalized.name;
    }

    this.closeSocket(error);
  }

  sendAndRetransmit(buffer: Buffer) {
    if (this.aborted) {
      return;
    }

    this.sendRaw(buffer);
    this.requestTimer.start(() => {
      this.sendRaw(buffer);
    });
  }

  sendRaw(buffer: Buffer) {
    if (this.closed || this.closing) {
      return;
    }

    this.socket?.send(buffer, 0, buffer.length, this.port, this.address);
  }

  getSocketAddress() {
    if (!this.socket) {
      throw new Error('Socket not initialized');
    }

    const address = this.socket.address();

    if (typeof address === 'string') {
      throw new Error('Invalid socket address');
    }

    return address;
  }

  createRetransmitter() {
    return new Retransmitter(this);
  }

  async abortWithError(error?: unknown) {
    try {
      await this.sendRawAsync(packets.error.serialize(normalizeError(error)));
    } finally {
      this.closeSocket();
    }
  }

  async sendRawAsync(buffer: Buffer): Promise<void> {
    if (this.closed || this.closing || !this.socket) {
      return;
    }

    await sendOnSocket(this.socket, buffer, this.port, this.address);
  }
}

export class Helper {
  rinfo: RemoteInfo;
  socket: Socket;

  constructor(rinfo: RemoteInfo, family: SocketFamily) {
    this.rinfo = rinfo;
    this.socket = createSocket(`udp${family}`);
  }

  abort(error?: unknown) {
    this.sendErrorAndClose(normalizeError(error));
  }

  sendErrorAndClose(obj: unknown) {
    const error = isTFTPErrorLike(obj) ? obj : normalizeError(obj);
    // oxlint-disable-next-line promise/prefer-await-to-then
    this.sendErrorPacket(error).catch(() => undefined);
  }

  private async sendErrorPacket(obj: Omit<TFTPError, 'name'> | TFTPError) {
    try {
      await sendOnSocket(this.socket, packets.error.serialize(obj), this.rinfo.port, this.rinfo.address);
    } finally {
      this.socket.close();
    }
  }
}
