import type { Readable, Writable } from 'node:stream';

type SocketFamily = 4 | 6;

type ErrorCode = number | string | null | undefined;
type ErrorWithCode = Error & { code?: ErrorCode };

type KnownExtensionKey = 'blksize' | 'rollover' | 'timeout' | 'tsize' | 'windowsize';

type ExtensionStrings = {
  blksize: string;
  rollover: string;
  timeout: string;
  windowsize: string;
  tsize?: string;
};

type RequestExtensions = Partial<{
  blksize: number;
  rollover: 0 | 1;
  timeout: number;
  tsize: number;
  windowsize: number;
}>;

/**
 * User-defined TFTP extension values negotiated as strings.
 */
type UserExtensions = Record<string, string>;
/**
 * User-defined TFTP extension input values.
 *
 * Values are stringified before being sent over the wire.
 */
type UserExtensionsInput = Record<string, unknown>;

type TransferStatsBase = {
  /** Negotiated TFTP block size. */
  blockSize: number;
  /** Negotiated TFTP window size. */
  windowSize: number;
  /** Negotiated transfer size, or `null` when unknown. */
  size: number | null;
  /** Negotiated user-defined TFTP extensions. */
  userExtensions: UserExtensions;
};

type PendingTransferStats = TransferStatsBase &
  Partial<{
    retries: number;
    timeout: number;
    localAddress: string;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
  }>;

/**
 * Negotiated transfer metadata returned by completed client transfers and
 * exposed on server requests.
 */
type TransferStats = TransferStatsBase & {
  /** Number of retransmission attempts used during the transfer. */
  retries: number;
  /** Negotiated retransmission timeout in seconds. */
  timeout: number;
  /** Local socket address used for the transfer. */
  localAddress: string;
  /** Local socket port used for the transfer. */
  localPort: number;
  /** Remote peer address used for the transfer. */
  remoteAddress: string;
  /** Remote peer port used for the transfer. */
  remotePort: number;
};

type AckPacket = {
  block: number;
};

type DataPacket = {
  block: number;
  data: Buffer;
};

type ErrorPacket = {
  code: number;
  message: string;
};

type OackPacket = Record<string, string>;
type OackWritableExtensions = Record<string, number | string>;

type RequestMessage = {
  extensions: RequestExtensions | null;
  file: string;
  userExtensions: UserExtensions;
};

type CurrentTransfers = {
  get: Set<string>;
  put: Set<string>;
};

/**
 * Common per-transfer stream options shared by GET and PUT operations.
 */
type TransferOptions = {
  /** Custom stream `highWaterMark` used for the transfer body stream. */
  highWaterMark?: number;
  /** Additional user-defined TFTP options to negotiate. */
  userExtensions?: UserExtensionsInput;
};

/**
 * Per-transfer options for client downloads.
 */
type GetTransferOptions = TransferOptions & {
  /** Optional MD5 extension value to request from the peer. */
  md5?: string;
  /** Optional SHA-1 extension value to request from the peer. */
  sha1?: string;
};

/**
 * Per-transfer options for client uploads.
 */
type PutTransferOptions = TransferOptions & {
  /**
   * Known upload size in bytes.
   *
   * Required when uploading from a readable Node stream.
   */
  size?: number | null;
};

type SizedPutTransferOptions = TransferOptions & {
  size: number;
};

/**
 * Supported download destinations for client downloads.
 *
 * A destination can be:
 * - a filesystem path
 * - a writable Node stream
 */
type TransferDestination = string | Writable;

/**
 * Supported upload sources for client uploads.
 *
 * A source can be:
 * - a filesystem path
 * - a `Buffer` or `Uint8Array`
 * - a readable Node stream
 */
type TransferSource = string | Buffer | Uint8Array | Readable;

export type {
  AckPacket,
  CurrentTransfers,
  DataPacket,
  ErrorCode,
  ErrorPacket,
  ErrorWithCode,
  ExtensionStrings,
  GetTransferOptions,
  KnownExtensionKey,
  OackPacket,
  OackWritableExtensions,
  PendingTransferStats,
  PutTransferOptions,
  RequestExtensions,
  RequestMessage,
  SizedPutTransferOptions,
  SocketFamily,
  TransferDestination,
  TransferOptions,
  TransferSource,
  TransferStats,
  UserExtensions,
  UserExtensionsInput,
};
