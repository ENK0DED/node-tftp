// oxlint-disable unicorn/no-null
import type { AckPacket, TransferStats } from '../../types/index.js';
import { BLOCK_ROLLOVER, MAX_BLOCK } from './constants.js';
import type { Request } from './request.js';

// oxlint-disable-next-line typescript/no-explicit-any
type RequestBase = abstract new (...args: any[]) => Request;

type Retransmitter = {
  reset(): void;
  start(fn: () => void): void;
};

type QueuedBlock = {
  block: number;
  data: Buffer;
};

type Deferred = {
  reject: (error: Error) => void;
  resolve: () => void;
};

type WindowDeps = {
  sendBlock: (block: number, buffer: Buffer) => void;
  createRetransmitter: () => Retransmitter;
};

class BlockMaker {
  private current = 0;
  private readonly blockSize: number;
  private transferSize: number | null;
  private block: Buffer | null = null;
  private buffer: Buffer | null = null;
  private p = 0;
  private empty = false;
  private ended = false;

  constructor(blockSize: number, size: number | null) {
    this.blockSize = blockSize;
    this.transferSize = size;
  }

  setSize(size: number) {
    this.transferSize = size;
  }

  feed(buffer: Buffer) {
    this.buffer = buffer;
  }

  next() {
    if (this.ended) {
      return null;
    }

    if (this.empty) {
      this.empty = false;
      this.ended = true;
      this.buffer = null;
      return Buffer.alloc(0);
    }

    const currentBuffer = this.buffer;
    if (!currentBuffer) {
      return null;
    }

    if (this.p === currentBuffer.length) {
      if (this.transferSize === 0) {
        const b = currentBuffer;
        this.buffer = null;
        return b;
      }

      this.p = 0;
      this.buffer = null;
      return null;
    }

    let slice: Buffer | null = null;
    let block: Buffer; // oxlint-disable-line init-declarations

    if (this.block) {
      const end = this.blockSize - this.block.length;
      slice = end === currentBuffer.length ? currentBuffer : currentBuffer.subarray(0, end);
      block = Buffer.concat([this.block, slice], this.block.length + slice.length);
      this.block = null;
    } else {
      block = currentBuffer.subarray(this.p, this.p + this.blockSize);
    }

    const nextP = slice?.length ?? block.length;
    this.current += nextP;

    if (block.length < this.blockSize) {
      if (this.current === this.transferSize) {
        this.ended = true;
        this.buffer = null;
        return block;
      }

      this.block = block;
      this.p = 0;
      this.buffer = null;
      return null;
    }

    this.p += nextP;

    if (this.current === this.transferSize) {
      this.empty = true;
    }

    return block;
  }
}

class Window {
  private readonly blockSize: number;
  private readonly windowSize: number;
  private readonly rollover: number;
  private readonly rolloverFix: number;
  private block = 0;
  private start = 1;
  private end: number;
  private pending: number;
  private eof = false;
  private mayRollover = false;
  private blocks: QueuedBlock[] = [];
  private readonly timer: Retransmitter;
  private deferred: Deferred | null = null;
  private readonly sendBlockFn: WindowDeps['sendBlock'];

  // oxlint-disable-next-line eslint/max-params
  constructor(blockSize: number, windowSize: number, rollover: number, deps: WindowDeps) {
    this.blockSize = blockSize;
    this.windowSize = windowSize;
    this.rollover = rollover;
    this.rolloverFix = rollover === 0 ? 1 : 0;
    this.end = windowSize;
    this.pending = windowSize;
    this.timer = deps.createRetransmitter();
    this.sendBlockFn = deps.sendBlock;
  }

  private readonly retransmit = () => {
    this.sendWindow();
  };

  private sendWindow() {
    for (const { block, data } of this.blocks) {
      this.sendBlockFn(block, data);
    }
  }

  isEOF() {
    return this.eof;
  }

  resetTimer() {
    this.timer.reset();
  }

  async feed(block: Buffer): Promise<void> {
    this.block += 1;
    if (this.block === BLOCK_ROLLOVER) {
      this.block = this.rollover;
    }

    this.blocks.push({ block: this.block, data: block });

    this.eof = block.length < this.blockSize;
    if (this.eof) {
      this.end = this.block;
    }

    this.pending -= 1;
    if (!this.pending || this.eof) {
      // oxlint-disable-next-line eslint-plugin-promise/avoid-new
      await new Promise<void>((resolve, reject) => {
        this.deferred = { reject, resolve };

        this.timer.start(this.retransmit);
        this.sendWindow();
      });
    }
  }

  resume(block: number) {
    if (!this.mayRollover && (block < this.start - 1 || block > this.end)) {
      return;
    }

    this.timer.reset();

    if (block !== this.end) {
      if (block === this.start - 1) {
        this.timer.start(this.retransmit);
        this.sendWindow();
      } else {
        let dropCount = 0;

        while (dropCount < this.blocks.length && this.blocks[dropCount].block !== block) {
          dropCount += 1;
        }

        this.blocks.splice(0, dropCount + 1);
      }
    } else {
      this.blocks = [];
    }

    this.start = this.block + 1;
    if (this.start === BLOCK_ROLLOVER) {
      this.start = this.rollover;
    } else {
      this.mayRollover = true;
    }

    this.end = this.block + this.windowSize;
    if (this.end > MAX_BLOCK) {
      this.end -= MAX_BLOCK + this.rolloverFix;
    } else {
      this.mayRollover = false;
    }

    this.pending = this.windowSize;
    const { deferred } = this;
    this.deferred = null;
    deferred?.resolve();
  }

  reject(error: Error) {
    const { deferred } = this;
    this.deferred = null;
    deferred?.reject(error);
  }
}

/**
 * Mixin that turns any `Request` subclass into a TFTP _writer_: the half of
 * the protocol that produces outgoing `DATA` packets and consumes `ACK`s.
 *
 * See `createReader` for the rationale behind the class-factory shape.
 * Access modifiers are omitted for the same TS4094 reason.
 */
export const createWriter = <TBase extends RequestBase>(Base: TBase) => {
  abstract class Writer extends Base {
    blockMaker: BlockMaker | null = null;
    window: Window | null = null;
    transferSize: number | null = null;

    // oxlint-disable class-methods-use-this, no-empty-function
    onAbort: () => void = () => {};
    onClose: () => void = () => {};
    onError: (_error: Error) => void = () => {};
    onStats: (_stats: TransferStats) => void = () => {};
    // oxlint-enable class-methods-use-this, no-empty-function

    setTransferSize(size: number) {
      this.transferSize = size;

      if (this.blockMaker) {
        this.blockMaker.setSize(size);
      }
    }

    async send(buffer: Buffer) {
      if (!this.blockMaker || !this.window) {
        return;
      }

      this.blockMaker.feed(buffer);

      while (true) {
        const block = this.blockMaker.next();

        if (!block) {
          return;
        }

        await this.window.feed(block);

        if (!this.window.isEOF()) {
          continue;
        }

        this.closeSocket();
        return;
      }
    }

    handleClose() {
      this.window?.resetTimer();
      this.onClose();
    }

    handleAbort() {
      if (this.window) {
        this.window.resetTimer();
        this.window.reject(new Error('Aborted'));
      }

      this.onAbort();
    }

    handleError(error: Error) {
      if (this.window) {
        this.window.resetTimer();
        this.window.reject(error);
      }

      this.onError(error);
    }

    handleReady(stats: TransferStats, rollover: number) {
      this.blockMaker = new BlockMaker(stats.blockSize, this.transferSize);
      this.window = new Window(stats.blockSize, stats.windowSize, rollover, {
        createRetransmitter: () => this.createRetransmitter(),
        sendBlock: (block, buffer) => this.sendBlock(block, buffer),
      });
      this.onStats(stats);
    }

    handleAck(ack: AckPacket) {
      this.window?.resume(ack.block);
    }
  }

  return Writer;
};

export type WriterClass<TBase extends RequestBase> = ReturnType<typeof createWriter<TBase>>;
export type WriterInstance<TBase extends RequestBase> = InstanceType<WriterClass<TBase>>;
