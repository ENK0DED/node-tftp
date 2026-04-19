import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { GetTransferOptions, TransferStats } from '../../../types/index.js';
import { createReader } from '../../protocol/reader.js';
import type { ClientOptions } from '../../protocol/utils.js';
import { ClientRequest } from './client-request.js';
import type { ClientRuntime } from './client-request.js';

type ReaderArgs = ConstructorParameters<typeof ClientRequest>[0];

class Reader extends createReader(ClientRequest) {
  constructor(args: ReaderArgs) {
    args.reader = true;
    super(args);
  }
}

export class GetStream extends Readable {
  private readonly reader: Reader;
  private readonly backlog: Buffer[];
  private backpressure: boolean;

  // oxlint-disable-next-line eslint/max-params
  constructor(remote: string, globalOptions: ClientOptions, getOptions: GetTransferOptions = {}, clientRuntime?: ClientRuntime | Promise<ClientRuntime>) {
    super();
    this.backlog = [];
    this.backpressure = false;

    let sum: Hash | undefined; // oxlint-disable-line init-declarations

    if (getOptions.sha1) {
      sum = createHash('sha1');
    } else if (getOptions.md5) {
      sum = createHash('md5');
    }

    this.reader = new Reader({ clientRuntime, file: remote, globalOptions, opOptions: getOptions });

    this.reader.onError = (error: Error) => {
      this.destroy(error);
    };

    this.reader.onAbort = () => {
      this.emit('abort');
      this.destroy();
    };

    this.reader.onClose = () => {
      if (sum) {
        const digest = sum.digest('hex');

        if (getOptions.sha1) {
          if (getOptions.sha1.toLowerCase() !== digest) {
            this.destroy(new Error('Invalid SHA1 sum, the file is corrupted'));
            return;
          }
        } else if (getOptions.md5) {
          if (getOptions.md5.toLowerCase() !== digest) {
            this.destroy(new Error('Invalid MD5 sum, the file is corrupted'));
            return;
          }
        }
      }

      // oxlint-disable-next-line unicorn/no-null
      this.push(null);
    };

    this.reader.onStats = (stats: TransferStats) => {
      this.emit('stats', stats);
    };

    this.reader.onData = (data: Buffer) => {
      if (sum) {
        sum.update(data);
      }

      if (this.backpressure) {
        this.backlog.push(data);
        return;
      }

      if (!this.push(data)) {
        this.backpressure = true;
      }
    };
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
    this.reader.abort(error);
  }

  close() {
    this.reader.close();
  }
}
