import type { ExtensionStrings, KnownExtensionKey, UserExtensionsInput } from '../../../types/index.js';
import { MAX_REQUEST_BYTES } from '../constants.js';
import { ERBIG } from '../errors.js';
import { knownExtensions } from '../utils.js';

type WriteRequestOptions = { userExtensions?: UserExtensionsInput };

const isKnownExtension = (key: string): key is KnownExtensionKey => Object.hasOwn(knownExtensions, key);

// oxlint-disable-next-line eslint/max-params
export const writeRequest = (op: number, filename: string, extraBytes: number, extensionsString?: ExtensionStrings, opOptions?: WriteRequestOptions) => {
  const start = filename.length + 9;
  const userExtensions: [string, string][] = [];
  let totalBytes = start + extraBytes;

  if (opOptions?.userExtensions) {
    for (const [key, value] of Object.entries(opOptions.userExtensions)) {
      if (isKnownExtension(key)) {
        continue;
      }

      const stringValue = String(value);
      userExtensions.push([key, stringValue]);
      totalBytes += key.length + stringValue.length + 2;
    }
  }

  if (totalBytes > MAX_REQUEST_BYTES) {
    throw ERBIG;
  }

  const buffer = Buffer.allocUnsafe(totalBytes);
  buffer.writeUInt16BE(op, 0);
  buffer.write(filename, 2, 'ascii');
  buffer[filename.length + 2] = 0;
  buffer.write('octet', filename.length + 3, 'ascii');
  buffer[filename.length + 8] = 0;

  if (!extensionsString) {
    return buffer;
  }

  let offset = start;

  const copy = (key: string, value: string) => {
    offset += buffer.write(key, offset, 'ascii');
    buffer[offset] = 0;
    offset += 1;
    offset += buffer.write(value, offset, 'ascii');
    buffer[offset] = 0;
    offset += 1;
  };

  for (const [key, value] of Object.entries(extensionsString)) {
    if (value === undefined) {
      continue;
    }

    copy(key, value);
  }

  for (const [key, value] of userExtensions) {
    copy(key, value);
  }

  return buffer;
};
