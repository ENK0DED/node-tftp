import { Readable } from 'node:stream';

import type { CurrentTransfers, RequestMessage, TransferStats } from '../../../types/index.js';
import { noop } from '../../helpers.js';
import { ECONPUT, ECURGET } from '../../protocol/errors.js';
import { packets } from '../../protocol/packets/index.js';
import { createReader } from '../../protocol/reader.js';
import type { Helper } from '../../protocol/request.js';
import type { ServerOptions } from '../../protocol/utils.js';
import { IncomingRequest } from './incoming-request.js';
import type { PutStream } from './put-stream.js';

type ReaderArgs = ConstructorParameters<typeof IncomingRequest>[0];

class Reader extends createReader(IncomingRequest) {
  constructor(args: ReaderArgs) {
    args.reader = true;
    super(args);
  }
}

export class GetStream extends Readable {
  aborted: boolean;
  closed: boolean;
  reader: Reader | undefined;
  private readonly currFiles?: CurrentTransfers;
  private readonly backlog: Buffer[];
  private backpressure: boolean;
  ps?: PutStream;
  method?: string;
  file!: string;
  stats?: TransferStats;
  onReady: () => void;

  /** Create an empty shell used as the RRQ-side request stream. */
  static createShell(): GetStream {
    return new GetStream();
  }

  // oxlint-disable-next-line eslint/max-params
  constructor(currFiles?: CurrentTransfers, helper?: Helper, message?: Buffer, globalOptions?: ServerOptions, putStream?: PutStream) {
    super();
    this.aborted = false;
    this.closed = false;
    this.reader = undefined;
    this.backlog = [];
    this.backpressure = false;
    this.onReady = noop;

    if (!currFiles || !helper || !message || !putStream) {
      return;
    }

    this.currFiles = currFiles;

    let requestMessage: RequestMessage; // oxlint-disable-line init-declarations

    try {
      requestMessage = packets.wrq.deserialize(message, false);
    } catch (error) {
      helper.sendErrorAndClose(error);
      return;
    }

    if (this.currFiles.put.has(requestMessage.file)) {
      helper.sendErrorAndClose(ECONPUT);
      return;
    }

    if (this.currFiles.get.has(requestMessage.file)) {
      helper.sendErrorAndClose(ECURGET);
      return;
    }

    this.currFiles.put.add(requestMessage.file);

    this.method = 'PUT';
    this.file = requestMessage.file;

    putStream.gs = this;
    putStream.isWRQ = true;

    if (!globalOptions) {
      return;
    }

    // oxlint-disable-next-line promise/prefer-await-to-then
    this.startReader(helper, requestMessage, globalOptions).catch((error: unknown) => {
      helper.sendErrorAndClose(error);
    });
  }

  _read() {
    if (!this.backlog.length) {
      this.backpressure = false;
      return;
    }

    while (this.backlog.length) {
      // oxlint-disable-next-line typescript/no-non-null-assertion
      if (!this.push(this.backlog.shift()!)) {
        return;
      }
    }

    this.backpressure = false;
  }

  abort(error: unknown) {
    if (this.aborted) {
      return;
    }

    this.aborted = true;

    if (this.ps) {
      this.ps.abort(error);
    } else {
      this.reader?.abort(error);
    }
  }

  close() {
    if (this.aborted || this.closed) {
      return;
    }

    this.closed = true;

    if (this.ps) {
      this.ps.close();
    } else {
      this.reader?.close();
    }
  }

  private async startReader(helper: Helper, message: RequestMessage, globalOptions: ServerOptions) {
    this.reader = new Reader({ globalOptions, helper, message });

    const { currFiles } = this;

    if (!currFiles) {
      return;
    }

    this.reader.onError = (error: Error) => {
      currFiles.put.delete(this.file);
      this.emit('error', error);
      this.emit('close');
    };

    this.reader.onAbort = () => {
      currFiles.put.delete(this.file);
      this.emit('abort');
      this.emit('close');
    };

    this.reader.onClose = () => {
      currFiles.put.delete(this.file);
      // oxlint-disable-next-line unicorn/no-null
      this.push(null);
      this.emit('close');
    };

    this.reader.onStats = (stats: TransferStats) => {
      this.stats = stats;
      this.onReady();
    };

    this.reader.onData = (data: Buffer) => {
      this.emit('progress', data.length);

      if (this.backpressure) {
        this.backlog.push(data);
        return;
      }

      if (!this.push(data)) {
        this.backpressure = true;
      }
    };

    await this.reader.start();
  }
}
