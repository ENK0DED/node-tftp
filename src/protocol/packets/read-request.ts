import type { RequestExtensions, RequestMessage, UserExtensions } from '../../../types/index.js';
import { MAX_BLOCK_SIZE, MAX_WINDOW_SIZE, MIN_BLOCK_SIZE } from '../constants.js';
import { EBADNAME, EDENY, EBADMODE } from '../errors.js';
import { normalizeFilename, parseUnsignedInteger } from '../utils.js';
import { readString } from './read-string.js';

export const readRequest = (buffer: Buffer, rrq: boolean): RequestMessage => {
  const o = { offset: 2 };
  const seenOptions = new Set<string>();

  let file = readString(buffer, o);
  try {
    file = normalizeFilename(file);
  } catch {
    throw EBADNAME;
  }

  const mode = readString(buffer, o).toLowerCase();
  if (mode !== 'octet') {
    throw EBADMODE;
  }

  let extensions: RequestExtensions | undefined; // oxlint-disable-line init-declarations
  const userExtensions: UserExtensions = {};

  while (o.offset < buffer.length) {
    const key = readString(buffer, o).toLowerCase();
    const value = readString(buffer, o);

    if (seenOptions.has(key)) {
      throw EDENY;
    }
    seenOptions.add(key);

    const blksize = key === 'blksize';
    const tsize = key === 'tsize';
    const timeout = key === 'timeout';
    const windowsize = key === 'windowsize';
    const rollover = key === 'rollover';

    if (blksize || tsize || timeout || windowsize || rollover) {
      const numericValue = parseUnsignedInteger(value);
      if (numericValue === undefined) {
        throw EDENY;
      }

      if (
        (blksize && (numericValue < MIN_BLOCK_SIZE || numericValue > MAX_BLOCK_SIZE)) ||
        (tsize && rrq && numericValue !== 0) ||
        (timeout && (numericValue < 1 || numericValue > 255)) ||
        (windowsize && (numericValue < 1 || numericValue > MAX_WINDOW_SIZE)) ||
        (rollover && numericValue !== 0 && numericValue !== 1)
      ) {
        throw EDENY;
      }

      if (!extensions) {
        extensions = {};
      }

      if (blksize) {
        extensions.blksize = numericValue;
      } else if (tsize) {
        extensions.tsize = numericValue;
      } else if (timeout) {
        extensions.timeout = numericValue;
      } else if (windowsize) {
        extensions.windowsize = numericValue;
      } else {
        extensions.rollover = numericValue === 0 ? 0 : 1;
      }
    } else {
      userExtensions[key] = value;
    }
  }

  // oxlint-disable-next-line unicorn/no-null
  return { extensions: extensions ?? null, file, userExtensions };
};
