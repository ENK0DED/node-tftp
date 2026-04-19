import type { ExtensionStrings, SizedPutTransferOptions } from '../../../types/index.js';
import type { ClientOptions } from '../utils.js';
import { opcodes } from '../utils.js';
import { readRequest } from './read-request.js';
import { writeRequest } from './write-request.js';

export const wrq = {
  deserialize: readRequest,
  serialize: (filename: string, globalOptions?: ClientOptions, opOptions?: SizedPutTransferOptions) => {
    let bytes = 0;
    let extensionsString: ExtensionStrings | undefined; // oxlint-disable-line init-declarations

    if (globalOptions) {
      // tsize is size
      const str = String(opOptions?.size ?? 0);
      extensionsString = { ...globalOptions.extensionsString, tsize: str };
      bytes = globalOptions.extensionsLength + str.length;
    }

    return writeRequest(opcodes.WRQ, filename, bytes, extensionsString, opOptions);
  },
};
