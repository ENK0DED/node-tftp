import type { Readable } from 'node:stream';
import { Writable } from 'node:stream';

import type { SizedPutTransferOptions, TransferStats } from '../../../types/index.js';
import { toError } from '../../helpers.js';
import type { ClientOptions } from '../../protocol/utils.js';
import { createWriter } from '../../protocol/writer.js';
import { ClientRequest } from './client-request.js';
import type { ClientRuntime } from './client-request.js';

type WriterArgs = ConstructorParameters<typeof ClientRequest>[0];

class Writer extends createWriter(ClientRequest) {
  constructor(args: WriterArgs) {
    super(args);

    // oxlint-disable-next-line unicorn/no-null
    const size = args.opOptions && 'size' in args.opOptions ? args.opOptions.size : null;
    // oxlint-disable-next-line unicorn/no-null
    this.transferSize = size ?? null;
  }
}

export class PutStream extends Writable {
  private readonly remote: string;
  private readonly globalOptions: ClientOptions;
  private readonly putOptions: SizedPutTransferOptions;
  private readonly emptyFile: boolean;
  private finished: boolean;
  private writer: Writer | undefined;
  private writerReady: Promise<Writer> | undefined;
  private readonly clientRuntime: ClientRuntime | Promise<ClientRuntime> | undefined;

  // oxlint-disable-next-line eslint/max-params
  constructor(remote: string, globalOptions: ClientOptions, putOptions: SizedPutTransferOptions, clientRuntime?: ClientRuntime | Promise<ClientRuntime>) {
    if (putOptions.size === undefined || putOptions.size === null) {
      throw new Error('Missing file size');
    }

    super();

    this.remote = remote;
    this.globalOptions = globalOptions;
    this.putOptions = putOptions;
    this.emptyFile = putOptions.size === 0;
    this.finished = false;
    this.writer = undefined;
    this.writerReady = undefined;
    this.clientRuntime = clientRuntime;

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
  }

  private async createWriter() {
    if (this.writer) {
      return this.writer;
    }

    if (this.writerReady) {
      return this.writerReady;
    }

    const writer = new Writer({ clientRuntime: this.clientRuntime, file: this.remote, globalOptions: this.globalOptions, opOptions: this.putOptions });
    this.writer = writer;

    // oxlint-disable-next-line promise/avoid-new
    this.writerReady = new Promise<Writer>((resolve, reject) => {
      writer.onError = (error: Error) => {
        this.destroy(error);
        reject(error);
      };

      writer.onAbort = () => {
        const error = new Error('Transfer aborted');
        this.emit('abort');
        this.destroy();
        reject(error);
      };

      writer.onClose = () => {
        // The Writable will emit 'close' itself once `end()`/'finish' has run;
        // emitting it manually here would race with the natural stream
        // teardown.
      };

      writer.onStats = (stats: TransferStats) => {
        this.emit('stats', stats);
        resolve(writer);
      };
    // oxlint-disable-next-line promise/prefer-await-to-then
    }).finally(() => {
      this.writerReady = undefined;
    });

    return this.writerReady;
  }

  private async sendEmptyFile() {
    const writer = await this.createWriter();
    await writer.send(Buffer.alloc(0));
  }

  private async writeChunk(chunk: Buffer) {
    const writer = this.writer ?? (await this.createWriter());
    await writer.send(chunk);
  }

  async _final(callback: (error?: Error | null) => void) {
    if (!this.emptyFile) {
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

  abort(error: unknown) {
    if (this.writer) {
      this.writer.abort(error);
    }
  }

  close() {
    if (this.writer) {
      this.writer.close();
    }
  }
}
