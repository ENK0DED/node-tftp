import type { ExtensionStrings, GetTransferOptions } from '../../../types/index.js';
import type { ClientOptions } from '../utils.js';
import { opcodes } from '../utils.js';
import { readRequest } from './read-request.js';
import { writeRequest } from './write-request.js';

export const rrq = {
  deserialize: (buffer: Buffer) => readRequest(buffer, true),
  serialize: (filename: string, globalOptions?: ClientOptions, opOptions?: GetTransferOptions) => {
    let bytes = 0;
    let extensionsString: ExtensionStrings | undefined; // oxlint-disable-line init-declarations

    if (globalOptions) {
      extensionsString = { ...globalOptions.extensionsString, tsize: '0' };
      // +1 because tsize length is 1
      bytes = globalOptions.extensionsLength + 1;
    }

    return writeRequest(opcodes.RRQ, filename, bytes, extensionsString, opOptions);
  },
};
