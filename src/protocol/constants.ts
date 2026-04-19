/**
 * Protocol-level constants shared between the client/server reader and
 * writer state machines.  Pulled into a dedicated module so the same
 * values aren't redefined in three different files (which previously
 * happened with both `MAX_BLOCK` and the rollover bound).
 */

/** Largest block number the protocol can carry in 16 bits. */
export const MAX_BLOCK = 65_535;

/**
 * One past `MAX_BLOCK` — used to detect rollover before the increment
 * would otherwise overflow 16 bits.
 */
export const BLOCK_ROLLOVER = 65_536;

/**
 * Default block size mandated by RFC 1350 when the `blksize` extension
 * is not negotiated.
 */
export const DEFAULT_BLOCK_SIZE = 512;

/**
 * Default window size implied by RFC 1350 (every block is its own
 * window).  Negotiated up by the `windowsize` extension (RFC 7440).
 */
export const DEFAULT_WINDOW_SIZE = 1;

/** Maximum size, in bytes, of an RRQ/WRQ packet including options. */
export const MAX_REQUEST_BYTES = 512;

/** Minimum legal negotiated block size (RFC 2348). */
export const MIN_BLOCK_SIZE = 8;

/** Maximum legal negotiated block size (RFC 2348). */
export const MAX_BLOCK_SIZE = 65_464;

/** Maximum legal negotiated window size (RFC 7440). */
export const MAX_WINDOW_SIZE = MAX_BLOCK;

/**
 * Maximum transfer size addressable without negotiated rollover or block-size
 * extensions: 65535 blocks at the RFC 1350 default 512-byte block size.
 */
export const MAX_DEFAULT_TRANSFER_SIZE = MAX_BLOCK * DEFAULT_BLOCK_SIZE;
