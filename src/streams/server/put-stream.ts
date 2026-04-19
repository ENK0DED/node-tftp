import type { Readable } from 'node:stream';
import { Writable } from 'node:stream';

import type { CurrentTransfers, RequestMessage, TransferStats, UserExtensionsInput } from '../../../types/index.js';
import { noop, toError } from '../../helpers.js';
import { ECURPUT } from '../../protocol/errors.js';
import { packets } from '../../protocol/packets/index.js';
import type { Helper } from '../../protocol/request.js';
import type { ServerOptions } from '../../protocol/utils.js';
import { createWriter } from '../../protocol/writer.js';
import type { GetStream } from './get-stream.js';
import { IncomingRequest } from './incoming-request.js';

class Writer extends createWriter(IncomingRequest) {}

export class PutStream extends Writable {
  isWRQ: boolean;
  private finished: boolean;
  private pendingEmptyFile: boolean;
  private writer: Writer | undefined;
  private writerReady: Promise<Writer> | undefined;
  private continueFlag: boolean;
  private continueResolvers: (() => void)[];
  private transferClosed: boolean;
  private sizeSet: boolean;
  private readonly currFiles?: CurrentTransfers;
  gs!: GetStream;
  onReady: () => void;

  /** Create an empty shell used as the WRQ-side response stream. */
  static createShell(): PutStream {
    return new PutStream();
  }

  // oxlint-disable-next-line eslint/max-params
  constructor(currFiles?: CurrentTransfers, helper?: Helper, message?: Buffer, globalOptions?: ServerOptions, getStream?: GetStream) {
    super();
    this.isWRQ = false;
    this.finished = false;
    this.pendingEmptyFile = false;
    this.writer = undefined;
    this.writerReady = undefined;
    this.continueFlag = false;
    this.continueResolvers = [];
    this.transferClosed = false;
    this.sizeSet = false;
    this.onReady = noop;

    if (!currFiles || !helper || !message || !getStream) {
      return;
    }

    this.currFiles = currFiles;

    let requestMessage: RequestMessage; // oxlint-disable-line init-declarations

    try {
      requestMessage = packets.rrq.deserialize(message);
    } catch (error) {
      helper.sendErrorAndClose(error);
      return;
    }

    if (this.currFiles.put.has(requestMessage.file)) {
      helper.sendErrorAndClose(ECURPUT);
      return;
    }

    this.currFiles.get.add(requestMessage.file);

    getStream.method = 'GET';
    getStream.file = requestMessage.file;

    this.on('unpipe', (src: Readable) => {
      if (this.finished || src?.readableEnded) {
        return;
      }

      if (this.writer) {
        this.writer.abort();
      }
    });

    this.on('finish', () => {
      this.finished = true;
    });

    this.gs = getStream;
    getStream.ps = this;

    if (!globalOptions) {
      return;
    }

    // oxlint-disable-next-line no-void
    void this.startWriter(helper, requestMessage, globalOptions);
  }

  abort(error: unknown) {
    this.writer?.abort(error);
  }

  close() {
    this.writer?.close();
  }

  private async startWriter(helper: Helper, message: RequestMessage, globalOptions: ServerOptions) {
    try {
      await this.initWriter(helper, message, globalOptions);
    } catch (error) {
      if (this.transferClosed) {
        return;
      }

      if (this.currFiles) {
        this.currFiles.get.delete(this.gs.file);
      }

      this.transferClosed = true;
      this.gs.emit('error', toError(error));
      this.gs.emit('close');
    }
  }

  private async initWriter(helper: Helper, message: RequestMessage, globalOptions: ServerOptions) {
    if (this.writer) {
      return this.writer;
    }

    if (this.writerReady) {
      return this.writerReady;
    }

    const writer = new Writer({ globalOptions, helper, message });
    this.writer = writer;

    const { currFiles } = this;

    if (!currFiles) {
      throw new Error('Current transfer registry is not initialized');
    }

    // oxlint-disable-next-line promise/avoid-new
    this.writerReady = new Promise<Writer>((resolve, reject) => {
      writer.onError = (error: Error) => {
        currFiles.get.delete(this.gs.file);
        this.transferClosed = true;
        this.gs.emit('error', error);
        this.gs.emit('close');
        reject(error);
      };

      writer.onAbort = () => {
        const error = new Error('Transfer aborted');
        currFiles.get.delete(this.gs.file);
        this.transferClosed = true;
        this.gs.emit('abort');
        this.gs.emit('close');
        reject(error);
      };

      writer.onClose = () => {
        currFiles.get.delete(this.gs.file);
        this.transferClosed = true;
        this.gs.emit('close');
      };

      writer.onStats = (stats: TransferStats) => {
        this.gs.stats = stats;
        this.onReady();
        resolve(writer);
      };

      writer.onContinue = () => {
        this.continueFlag = true;
        const resolvers = this.continueResolvers;
        this.continueResolvers = [];
        for (const resolveContinue of resolvers) {
          resolveContinue();
        }
      };

      // oxlint-disable-next-line promise/prefer-await-to-then
      writer.start().catch(reject);
    // oxlint-disable-next-line promise/prefer-await-to-then
    }).finally(() => {
      this.writerReady = undefined;
    });

    return this.writerReady;
  }

  private async waitForContinue() {
    if (this.continueFlag) {
      return Promise.resolve();
    }

    // oxlint-disable-next-line promise/avoid-new
    return new Promise<void>((resolve) => {
      this.continueResolvers.push(resolve);
    });
  }

  private async writeChunk(chunk: Buffer) {
    if (!this.writer) {
      throw new Error('Writer not initialized');
    }

    await this.waitForContinue();
    await this.writer.send(chunk);
  }

  async _final(callback: (error?: Error | null) => void) {
    if (!this.pendingEmptyFile) {
      callback();
      return;
    }

    try {
      await this.sendEmptyFile();
      callback();
    } catch (error) {
      callback(toError(error));
    }
  }

  async _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    try {
      await this.writeChunk(chunk);
      callback();
    } catch (error) {
      callback(toError(error));
    }
  }

  setSize(size: number) {
    if (this.isWRQ) {
      throw new Error('Only GET requests can set the size');
    }

    if (this.gs.aborted) {
      return;
    }

    if (this.sizeSet) {
      throw new Error('The size was previously set');
    }

    this.sizeSet = true;

    if (this.gs.stats) {
      this.gs.stats.size = size;
    }

    if (size === 0) {
      this.pendingEmptyFile = true;
    }

    this.writer?.continueRequest(size);
  }

  private async sendEmptyFile() {
    if (!this.writer) {
      throw new Error('Writer not initialized');
    }

    await this.waitForContinue();
    await this.writer.send(Buffer.alloc(0));
  }

  setUserExtensions(userExtensions: UserExtensionsInput) {
    if (this.isWRQ) {
      if (!this.gs.reader) {
        throw new Error('Cannot set user extensions before the transfer is ready');
      }
      this.gs.reader.responseUserExtensions = userExtensions;
    } else {
      if (!this.writer) {
        throw new Error('Cannot set user extensions before the transfer is ready');
      }
      this.writer.responseUserExtensions = userExtensions;
    }
  }
}
