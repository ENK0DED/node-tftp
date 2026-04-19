// oxlint-disable unicorn/no-null
import type { DataPacket, TransferStats } from '../../types/index.js';
import { DEFAULT_BLOCK_SIZE, DEFAULT_WINDOW_SIZE, MAX_BLOCK } from './constants.js';
import type { Request } from './request.js';

// oxlint-disable-next-line typescript/no-explicit-any
type RequestBase = abstract new (...args: any[]) => Request;
type IncomingDataGuard = { rejectIncomingData?: (data: Buffer) => unknown };

const sortByBlock = (a: DataPacket, b: DataPacket) => a.block - b.block;

/**
 * Mixin that turns any `Request` subclass (`ClientRequest` for the client side,
 * `IncomingRequest` for the server side) into a TFTP _reader_: the half of the
 * protocol that consumes incoming `DATA` packets and dispatches `ACK`s.
 *
 * Implemented as a class-factory rather than a separate class plus runtime
 * `Object.defineProperties` mixin so that:
 *
 *   - the result is a real subclass of the chosen `Base`, with a single
 *     prototype chain — no method shadowing, no `declare` stubs;
 *   - TypeScript can infer all method signatures naturally from the base
 *     class without needing a hand-maintained `interface` merge;
 *   - construction uses the native derived-class default constructor: a
 *     subclass like `ServerReader extends createReader(IncomingRequest)` just
 *     calls `super(args)` and the args flow through to the original
 *     constructor as usual.
 *
 * Access modifiers are omitted because TypeScript cannot represent
 * private/protected members of anonymous classes in declaration files (TS4094).
 */
export const createReader = <TBase extends RequestBase>(Base: TBase) => {
  abstract class Reader extends Base {
    blockSize = DEFAULT_BLOCK_SIZE;
    windowSize = DEFAULT_WINDOW_SIZE;
    windowStart = 1;
    windowEnd = DEFAULT_WINDOW_SIZE;
    pending = DEFAULT_WINDOW_SIZE;
    windowBlocksIndex: Record<number, true> = Object.create(null);
    windowBlocks: DataPacket[] = [];
    lastReceived = false;
    oackReceived: boolean | null = null;
    firstWindow = true;
    mayRollover = false;
    rolloverFix = 0;
    windowStartRollovered = false;
    noMoreData = false;
    readerTimer = this.createRetransmitter();

    retransmitHandler = () => {
      const block = this.blockToRetransmit();

      if (block > 0) {
        this.windowStart = block === MAX_BLOCK ? 1 : block + 1;
        this.lastReceived = false;
        this.notifyWindow(block);
      }

      this.sendAck(block);
    };

    // oxlint-disable class-methods-use-this, no-empty-function
    onAbort: () => void = () => {};
    onClose: () => void = () => {};
    onData: (data: Buffer) => void = () => {};
    onError: (error: Error) => void = () => {};
    onStats: (stats: TransferStats) => void = () => {};
    // oxlint-enable class-methods-use-this, no-empty-function

    handleClose() {
      this.readerTimer.reset();
      this.onClose();
    }

    handleAbort() {
      this.readerTimer.reset();
      this.onAbort();
    }

    handleError(error: Error) {
      this.readerTimer.reset();
      this.onError(error);
    }

    handleReady(stats: TransferStats, _rollover: number, oack?: boolean) {
      this.windowSize = stats.windowSize;
      this.pending = stats.windowSize;
      this.windowEnd = stats.windowSize;
      this.blockSize = stats.blockSize;

      this.readerTimer.start(this.retransmitHandler);
      this.oackReceived = oack ?? null;

      this.onStats(stats);
    }

    blockToRetransmit() {
      if (!this.windowBlocks.length) {
        if (this.oackReceived) {
          return 0;
        }

        if (this.windowStart === 0 || (this.windowStart === 1 && !this.firstWindow)) {
          return MAX_BLOCK;
        }

        return this.windowStart - 1;
      }

      this.sortWindow();

      let last = this.windowStart - 1;

      for (const windowBlock of this.windowBlocks) {
        if (last + 1 !== windowBlock.block) {
          return last === -1 || (this.mayRollover && last === 0) ? MAX_BLOCK : last;
        }

        last += 1;

        if (last === MAX_BLOCK) {
          return MAX_BLOCK;
        }
      }

      return last;
    }

    sortWindow() {
      if (this.mayRollover) {
        const preRoll: DataPacket[] = [];
        const postRoll: DataPacket[] = [];

        for (const entry of this.windowBlocks) {
          (entry.block >= this.windowStart ? preRoll : postRoll).push(entry);
        }

        preRoll.sort(sortByBlock);
        postRoll.sort(sortByBlock);
        this.windowBlocks = [...preRoll, ...postRoll];
        return;
      }

      this.windowBlocks.sort(sortByBlock);
    }

    notifyWindow(block?: number) {
      let arr: DataPacket[]; // oxlint-disable-line init-declarations

      // TFTP block numbers start at 1, so 0 is never a valid data block here.
      if (block) {
        let index = -1;

        for (let i = 0; i < this.windowBlocks.length; i += 1) {
          if (this.windowBlocks[i].block === block) {
            index = i;
            break;
          }
        }

        arr = index === -1 ? [] : this.windowBlocks.slice(0, index + 1);
      } else {
        arr = this.windowBlocks;
      }

      for (const message of arr) {
        if (message.data.length) {
          this.onData(message.data);
        }
      }

      if (this.lastReceived) {
        this.noMoreData = true;
        return this.closeSocket();
      }

      this.pending = this.windowSize;
      this.windowBlocks = [];
      this.windowBlocksIndex = Object.create(null);
      this.oackReceived = false;
      this.firstWindow = false;
    }

    handleData(message: DataPacket) {
      if (this.noMoreData) {
        return;
      }

      if (message.block === 0 && this.rolloverFix === 0) {
        this.rolloverFix = 1;

        if (this.windowStartRollovered) {
          this.windowStart -= 1;
        }

        this.windowEnd -= 1;
      }

      if (!this.mayRollover && (message.block < this.windowStart || message.block > this.windowEnd)) {
        return;
      }

      if (this.windowBlocksIndex[message.block]) {
        return;
      }

      const incomingDataError = (this as Request & IncomingDataGuard).rejectIncomingData?.(message.data);

      if (incomingDataError !== undefined) {
        this.sendErrorAndClose(incomingDataError);
        return;
      }

      this.windowBlocksIndex[message.block] = true;
      this.windowBlocks.push(message);

      if (message.data.length < this.blockSize) {
        this.pending = message.block - this.windowStart + 1 - this.windowBlocks.length;
        this.lastReceived = true;
      } else {
        this.pending -= 1;
      }

      if (!this.pending) {
        this.readerTimer.reset();
        this.readerTimer.start(this.retransmitHandler);

        if (this.windowSize > 1) {
          this.sortWindow();
        }

        this.windowStart += this.windowSize;

        if (this.windowStart > MAX_BLOCK) {
          this.windowStartRollovered = true;
          this.windowStart -= MAX_BLOCK + this.rolloverFix;
        }

        this.windowEnd = this.windowStart + this.windowSize - 1;
        this.mayRollover = this.windowEnd > MAX_BLOCK;

        if (this.mayRollover) {
          this.windowEnd -= MAX_BLOCK + this.rolloverFix;
        }

        this.sendAck(this.windowBlocks[this.windowBlocks.length - 1].block);
        this.notifyWindow();
      }
    }
  }

  return Reader;
};

export type ReaderClass<TBase extends RequestBase> = ReturnType<typeof createReader<TBase>>;
export type ReaderInstance<TBase extends RequestBase> = InstanceType<ReaderClass<TBase>>;
