import type { Socket } from 'node:dgram';

import type {
  AckPacket,
  DataPacket,
  OackWritableExtensions,
  RequestExtensions,
  RequestMessage,
  TransferStats,
  UserExtensions,
  UserExtensionsInput,
} from '../../../types/index.js';
import { noop, waitForSocketBind } from '../../helpers.js';
import { DEFAULT_BLOCK_SIZE, DEFAULT_WINDOW_SIZE, MAX_DEFAULT_TRANSFER_SIZE } from '../../protocol/constants.js';
import { EBADMSG, EBADOP, EFBIG } from '../../protocol/errors.js';
import { packets } from '../../protocol/packets/index.js';
import { Request } from '../../protocol/request.js';
import type { Helper } from '../../protocol/request.js';
import type { ServerOptions } from '../../protocol/utils.js';
import { knownExtensions, opcodes } from '../../protocol/utils.js';

type IncomingRequestArgs = {
  globalOptions: ServerOptions;
  helper: Helper;
  message: RequestMessage;
  reader?: boolean;
  size?: number | null;
};

// Access modifiers are omitted because this class participates in the
// class-factory mixin pattern (TS4094).

export abstract class IncomingRequest extends Request {
  isRRQ: boolean;
  globalOptions: ServerOptions;
  maxDataLength: number;
  receivedBytes: number;
  transferSize: number | null;
  requestUserExtensions: UserExtensions;
  responseUserExtensions: UserExtensionsInput | null;
  oackSent: boolean;
  firstPacket: boolean;
  requestExtensions: RequestExtensions | null;
  responseExtensions: OackWritableExtensions | null;
  started: boolean;
  declare handleData: (message: DataPacket) => void;
  declare handleReady: (stats: TransferStats, rollover: number, oack?: boolean) => void;
  declare handleAck: (ack: AckPacket) => void;
  declare setTransferSize: (size: number) => void;
  onContinue: () => void;

  constructor(args: IncomingRequestArgs) {
    super(args.helper.rinfo.address, args.helper.rinfo.port, args.globalOptions.retries, args.globalOptions.extensions.timeout * 1000);

    this.isRRQ = !args.reader;
    this.globalOptions = args.globalOptions;
    this.maxDataLength = 4;
    this.receivedBytes = 0;
    // oxlint-disable unicorn/no-null
    this.transferSize = args.size ?? null;
    this.requestUserExtensions = args.message.userExtensions;
    this.responseUserExtensions = null;
    this.oackSent = false;
    this.firstPacket = true;
    this.requestExtensions = args.message.extensions;
    this.responseExtensions = null;
    // oxlint-enable unicorn/no-null
    this.started = false;
    this.onContinue = noop;

    this.initSocket(args.helper.socket, (message: Buffer, rinfo) => {
      if (this.address !== rinfo.address || this.port !== rinfo.port) {
        this.sendTidError(rinfo);
        return;
      }

      if (this.firstPacket) {
        this.firstPacket = false;
        this.requestTimer.reset();
      }

      this.handleMessage(message);
    });
  }

  async bindSocketAndContinue(socket: Socket) {
    await waitForSocketBind(socket, 0);

    if (this.requestExtensions !== null) {
      this.sendOackMessage(this.requestExtensions);
      return;
    }

    if (this.isRRQ && (this.transferSize ?? 0) > MAX_DEFAULT_TRANSFER_SIZE) {
      this.sendErrorAndClose(EFBIG);
      return;
    }

    this.handleReady(this.createStats(DEFAULT_BLOCK_SIZE, DEFAULT_WINDOW_SIZE), 0);

    if (!this.isRRQ) {
      this.sendAck(0);
    }
  }

  async start() {
    if (this.started) {
      return;
    }

    this.started = true;

    if (!this.socket) {
      throw new Error('Socket not initialized');
    }

    try {
      await this.bindSocketAndContinue(this.socket);
    } catch (error) {
      this.closeWithError(error);
    }
  }

  continueRequest(size: number) {
    this.setTransferSize(size);

    if (this.requestExtensions === null) {
      this.onContinue();
      return;
    }

    if (!this.responseExtensions) {
      return;
    }

    if (this.responseExtensions.tsize !== undefined) {
      this.responseExtensions.tsize = size;
    }

    for (const [key, value] of Object.entries(this.responseUserExtensions ?? {})) {
      const normalizedKey = key.toLowerCase();

      if (Object.hasOwn(knownExtensions, normalizedKey)) {
        continue;
      }

      if (this.requestUserExtensions[normalizedKey] === undefined) {
        continue;
      }

      this.responseExtensions[normalizedKey] = String(value);
    }

    this.sendAndRetransmit(packets.oack.serialize(this.responseExtensions));
  }

  createStats(blockSize: number, windowSize: number): TransferStats {
    this.maxDataLength += blockSize;

    const address = this.getSocketAddress();
    return {
      blockSize,
      localAddress: address.address,
      localPort: address.port,
      remoteAddress: this.address,
      remotePort: this.port,
      retries: this.retries,
      size: this.transferSize,
      timeout: Math.trunc(this.timeout / 1000),
      userExtensions: this.requestUserExtensions,
      windowSize,
    };
  }

  rejectIncomingData(data: Buffer) {
    if (this.isRRQ || this.transferSize === null) {
      return undefined;
    }

    const nextReceivedBytes = this.receivedBytes + data.length;
    if (nextReceivedBytes > this.transferSize) {
      return EFBIG;
    }

    this.receivedBytes = nextReceivedBytes;
    return undefined;
  }

  handleMessage(buffer: Buffer) {
    const op = buffer.readUInt16BE(0);

    switch (op) {
      case opcodes.DATA: {
        if (this.isRRQ) {
          this.sendErrorAndClose(EBADOP);
          return;
        }

        if (buffer.length < 4 || buffer.length > this.maxDataLength) {
          this.sendErrorAndClose(EBADMSG);
          return;
        }

        try {
          this.handleData(packets.data.deserialize(buffer, this.maxDataLength - 4));
        } catch (error) {
          this.sendErrorAndClose(error);
        }

        return;
      }

      case opcodes.ACK: {
        if (!this.isRRQ) {
          this.sendErrorAndClose(EBADOP);
          return;
        }

        if (buffer.length !== 4) {
          this.sendErrorAndClose(EBADMSG);
          return;
        }

        if (this.oackSent) {
          this.oackSent = false;

          if (buffer.readUInt16BE(2) !== 0) {
            this.sendErrorAndClose(EBADMSG);
          } else {
            this.onContinue();
          }

          return;
        }

        try {
          this.handleAck(packets.ack.deserialize(buffer));
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
          this.closeSocket(new Error(packets.error.deserialize(buffer).message));
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

  sendOackMessage(extensions: RequestExtensions) {
    const serverExt = this.globalOptions.extensions;
    const ext: OackWritableExtensions = {};

    if (extensions.blksize !== undefined) {
      ext.blksize = Math.min(extensions.blksize, serverExt.blksize);
    }

    if (extensions.windowsize !== undefined) {
      ext.windowsize = Math.min(extensions.windowsize, serverExt.windowsize);
    }

    if (extensions.tsize !== undefined) {
      if (!this.isRRQ) {
        this.transferSize = extensions.tsize;
      }

      ext.tsize = extensions.tsize;
    }

    if (extensions.timeout !== undefined) {
      ext.timeout = extensions.timeout;
      this.timeout = extensions.timeout * 1000;
    }

    // Acknowledge the client's rollover request but always force value 0
    // (0-based block wrapping). The server does not support 1-based rollover
    // since the reader/writer arithmetic assumes 0-based wrapping.
    if (extensions.rollover !== undefined) {
      ext.rollover = 0;
    }

    this.oackSent = true;
    const blockSize = typeof ext.blksize === 'number' ? ext.blksize : DEFAULT_BLOCK_SIZE;
    const windowSize = typeof ext.windowsize === 'number' ? ext.windowsize : DEFAULT_WINDOW_SIZE;

    if (this.isRRQ) {
      this.responseExtensions = ext;
      this.handleReady(this.createStats(blockSize, windowSize), 0, true);
      return;
    }

    this.handleReady(this.createStats(blockSize, windowSize), 0, true);
    this.sendAndRetransmit(packets.oack.serialize(ext));
  }
}
