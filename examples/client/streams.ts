import { Readable, Writable } from 'node:stream';

import { Client } from '../../src/index.js';

const payload = Buffer.from('hello from a stream\n');

try {
  const client = new Client({ host: '127.0.0.1', port: 69 });

  let downloadedBytes = 0;
  const sink = new Writable({
    final(callback) {
      console.log(`Downloaded ${downloadedBytes} bytes`);
      callback();
    },
    write(chunk, _encoding, callback) {
      downloadedBytes += chunk.length;
      callback();
    },
  });

  await client.asyncGet('remote-file', sink);
  await client.asyncPut(Readable.from([payload.subarray(0, 6), payload.subarray(6)]), 'remote-from-iterable.txt', { size: payload.length });

  console.log(`Uploaded ${payload.length} bytes from a stream`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
