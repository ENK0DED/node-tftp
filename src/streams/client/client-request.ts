import type { RemoteInfo } from 'node:dgram';
import { lookup } from 'node:dns/promises';

import type {
  AckPacket,
  DataPacket,
  GetTransferOptions,
  PendingTransferStats,
  PutTransferOptions,
  SizedPutTransferOptions,
  TransferStats,
  UserExtensionsInput,
} from '../../../types/index.js';
import { toError } from '../../helpers.js';
import { DEFAULT_BLOCK_SIZE, DEFAULT_WINDOW_SIZE, MAX_BLOCK_SIZE, MAX_DEFAULT_TRANSFER_SIZE, MIN_BLOCK_SIZE } from '../../protocol/constants.js';
import { EBADMSG, EBADOP, EDENY, EFBIG } from '../../protocol/errors.js';
import { packets } from '../../protocol/packets/index.js';
import { Request } from '../../protocol/request.js';
import type { ClientOptions } from '../../protocol/utils.js';
import { knownExtensions, opcodes, parseUnsignedInteger } from '../../protocol/utils.js';

type ClientRequestOptions = Omit<GetTransferOptions & PutTransferOptions, 'userExtensions'> & { userExtensions: UserExtensionsInput };

export type ClientRuntime = { address: string; family: 4 | 6 };

type ClientRequestArgs = {
  clientRuntime?: ClientRuntime | Promise<ClientRuntime>;
  file: string;
  globalOptions: ClientOptions;
  opOptions?: GetTransferOptions | PutTransferOptions | SizedPutTransferOptions;
  reader?: boolean;
};

const detachPromise = (promise: Promise<unknown>) => {
  // oxlint-disable-next-line promise/prefer-await-to-then
  promise.catch(() => undefined);
};

export abstract class ClientRequest extends Request {
  private readonly isRRQ: boolean;
  private readonly file: string;
  private readonly globalOptions: ClientOptions;
  private readonly opOptions: ClientRequestOptions;
  private firstPacket: boolean;
  private oackExpected: boolean;
  private extensionsRetransmitted: boolean;
  private extensionsEmitted: boolean;
  private maxDataLength: number;
  private blksize: number | undefined;
  declare onError: (error: Error) => void;
  declare handleData: (message: DataPacket) => void;
  declare handleReady: (stats: TransferStats, rollover: number, oack?: boolean) => void;
  declare handleAck: (ack: AckPacket) => void;

  constructor(args: ClientRequestArgs) {
    super(args.globalOptions.address, args.globalOptions.port, args.globalOptions.retries, args.globalOptions.extensions.timeout * 1000);

    this.isRRQ = Boolean(args.reader);
    this.ipFamily = undefined;
    this.file = args.file;
    this.globalOptions = args.globalOptions;
    this.opOptions = { ...args.opOptions, userExtensions: args.opOptions?.userExtensions ?? {} };
    this.prefixError = '(Server) ';
    this.firstPacket = true;
    this.oackExpected = true;
    this.extensionsRetransmitted = false;
    this.extensionsEmitted = false;
    this.maxDataLength = 4;
    this.blksize = undefined;

    if (args.clientRuntime) {
      detachPromise(this.openWhenReady(args.clientRuntime));
    } else {
      detachPromise(this.lookupAndOpen());
    }
  }

  private async openWhenReady(clientRuntime: ClientRuntime | Promise<ClientRuntime>) {
    try {
      const runtime = await clientRuntime;
      this.address = runtime.address;
      this.ipFamily = runtime.family;
    } catch (error) {
      process.nextTick(() => {
        this.onError?.(toError(error));
      });
      return;
    }

    process.nextTick(() => {
      this.open(true);
    });
  }

  private async lookupAndOpen() {
    try {
      const { address, family } = await lookup(this.address);

      if (family !== 4 && family !== 6) {
        process.nextTick(() => {
          this.onError?.(new Error(`Unsupported IP family "${family}"`));
        });
        return;
      }

      this.address = address;
      this.ipFamily = family;
    } catch (error) {
      process.nextTick(() => {
        this.onError?.(new Error(`Cannot resolve the domain name "${this.address}"`, { cause: error }));
      });
      return;
    }

    process.nextTick(() => {
      this.open(true);
    });
  }

  private open(extensions?: boolean) {
    this.initSocket(undefined, (message: Buffer, rinfo: RemoteInfo) => {
      if (this.firstPacket) {
        this.firstPacket = false;
        this.requestTimer.reset();

        this.address = rinfo.address;
        this.port = rinfo.port;
      } else if (this.address !== rinfo.address || this.port !== rinfo.port) {
        this.sendTidError(rinfo);
        return;
      }

      if (message.length < 2) {
        this.sendErrorAndClose(EBADMSG);
        return;
      }

      this.handleMessage(message);
    });

    let buffer: Buffer; // oxlint-disable-line init-declarations

    try {
      if (this.isRRQ) {
        buffer = extensions ? packets.rrq.serialize(this.file, this.globalOptions, this.opOptions) : packets.rrq.serialize(this.file, undefined, undefined);
      } else {
        const putOptions = this.opOptions.size === undefined || this.opOptions.size === null ? undefined : { ...this.opOptions, size: this.opOptions.size };
        buffer = extensions ? packets.wrq.serialize(this.file, this.globalOptions, putOptions) : packets.wrq.serialize(this.file, undefined, undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.closeSocket(new Error(message));
      return;
    }

    this.sendAndRetransmit(buffer);
  }

  private emitDefaultExtensions() {
    this.extensionsEmitted = true;

    const stats: PendingTransferStats = {
      blockSize: DEFAULT_BLOCK_SIZE,
      // oxlint-disable-next-line unicorn/no-null
      size: this.opOptions.size ?? null,
      userExtensions: {},
      windowSize: DEFAULT_WINDOW_SIZE,
    };
    this.setStats(stats);
    this.oackExpected = false;
    this.handleReady(stats, this.globalOptions.extensions.rollover);
  }

  private setStats(stats: PendingTransferStats): asserts stats is TransferStats {
    this.maxDataLength += stats.blockSize;
    this.blksize = stats.blockSize;

    const address = this.getSocketAddress();
    stats.retries = this.retries;
    stats.timeout = Math.trunc(this.timeout / 1000);
    stats.localAddress = address.address;
    stats.localPort = address.port;
    stats.remoteAddress = this.address;
    stats.remotePort = this.port;
  }

  private handleMessage(buffer: Buffer) {
    const op = buffer.readUInt16BE(0);

    switch (op) {
      case opcodes.DATA: {
        if (!this.isRRQ) {
          this.sendErrorAndClose(EBADOP);
          return;
        }

        if (!this.extensionsEmitted) {
          this.emitDefaultExtensions();
        }

        if (buffer.length < 4 || buffer.length > this.maxDataLength) {
          this.sendErrorAndClose(EBADMSG);
          return;
        }

        try {
          this.handleData(packets.data.deserialize(buffer, this.blksize ?? DEFAULT_BLOCK_SIZE));
        } catch (error) {
          this.sendErrorAndClose(error);
        }
        return;
      }

      case opcodes.ACK: {
        if (this.isRRQ) {
          this.sendErrorAndClose(EBADOP);
          return;
        }

        if (this.extensionsEmitted) {
          try {
            this.handleAck(packets.ack.deserialize(buffer));
          } catch (error) {
            this.sendErrorAndClose(error);
          }

          return;
        }

        if ((this.opOptions.size ?? 0) > MAX_DEFAULT_TRANSFER_SIZE) {
          this.sendErrorAndClose(EFBIG);
          return;
        }

        this.emitDefaultExtensions();

        if (buffer.length !== 4 || buffer.readUInt16BE(2) !== 0) {
          this.sendErrorAndClose(EBADMSG);
        }

        return;
      }

      case opcodes.OACK: {
        if (!this.oackExpected) {
          this.sendErrorAndClose(EBADOP);
          return;
        }

        this.oackExpected = false;

        try {
          this.handleOackMessage(packets.oack.deserialize(buffer));
        } catch (error) {
          this.sendErrorAndClose(error);
        }

        return;
      }

      case opcodes.ERROR: {
        if (buffer.length < 4) {
          this.closeWithError(EBADMSG);
          return;
        }

        try {
          this.handleErrorMessage(packets.error.deserialize(buffer));
        } catch (error) {
          this.closeWithError(error);
        }

        return;
      }

      default: {
        this.sendErrorAndClose(EBADOP);
      }
    }
  }

  private handleOackMessage(message: Record<string, string>) {
    const userExtensions: Record<string, string> = {};
    const requestedUserExtensions = new Set(Object.keys(this.opOptions.userExtensions).map((key) => key.toLowerCase()));

    for (const p in message) {
      if (!Object.hasOwn(knownExtensions, p)) {
        if (!requestedUserExtensions.has(p)) {
          this.sendErrorAndClose(EDENY);
          return;
        }

        userExtensions[p] = message[p];
      }
    }

    let blockSize: number | undefined = undefined;
    let transferSize: number | undefined = undefined;
    let windowSize: number | undefined = undefined;
    let rollover: number | undefined = undefined;

    if (message.timeout) {
      const timeout = parseUnsignedInteger(message.timeout);

      if (timeout === this.globalOptions.extensions.timeout) {
        this.timeout = timeout * 1000;
      } else {
        this.sendErrorAndClose(EDENY);
        return;
      }
    }

    if (message.blksize) {
      blockSize = parseUnsignedInteger(message.blksize);

      if (blockSize === undefined || blockSize < MIN_BLOCK_SIZE || blockSize > Math.min(MAX_BLOCK_SIZE, this.globalOptions.extensions.blksize)) {
        this.sendErrorAndClose(EDENY);
        return;
      }
    }

    if (message.tsize) {
      transferSize = parseUnsignedInteger(message.tsize);

      if (transferSize === undefined || (this.opOptions.size !== undefined && transferSize !== this.opOptions.size)) {
        this.sendErrorAndClose(EDENY);
        return;
      }
    }

    if (message.windowsize) {
      windowSize = parseUnsignedInteger(message.windowsize);

      if (windowSize === undefined || windowSize <= 0 || windowSize > this.globalOptions.extensions.windowsize) {
        this.sendErrorAndClose(EDENY);
        return;
      }
    }

    if (message.rollover) {
      rollover = parseUnsignedInteger(message.rollover);

      if (rollover === undefined || rollover < 0 || rollover > 1) {
        this.sendErrorAndClose(EDENY);
        return;
      }
    }

    this.extensionsEmitted = true;
    rollover = rollover ?? this.globalOptions.extensions.rollover;

    const stats: PendingTransferStats = {
      blockSize: blockSize || DEFAULT_BLOCK_SIZE,
      // oxlint-disable-next-line unicorn/no-null
      size: transferSize ?? null,
      userExtensions,
      windowSize: windowSize || DEFAULT_WINDOW_SIZE,
    };

    this.setStats(stats);

    if (this.isRRQ) {
      this.sendAck(0);
      this.handleReady(stats, rollover, true);
      return;
    }

    this.handleReady(stats, rollover);
  }

  private handleErrorMessage(message: { code: number; message: string; name?: string }) {
    if (this.oackExpected && message.code === 8) {
      if (this.extensionsRetransmitted) {
        this.closeWithError(EBADOP);
        return;
      }

      this.extensionsRetransmitted = true;
      this.port = this.globalOptions.port;
      this.firstPacket = true;

      if (!this.socket || !this.onCloseFn) {
        return;
      }

      this.socket.removeListener('close', this.onCloseFn);
      this.socket.on('close', () => {
        this.open();
      });
      this.socket.close();
      return;
    }

    this.closeWithError(message);
  }
}
