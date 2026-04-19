import { createReadStream } from 'node:fs';
import { appendFile, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';

import { Client, Server } from '../src/index.js';

const cleanup = async () => {
  for (const file of ['tmp1', 'tmp2']) {
    try {
      await unlink(file);
    } catch {
      // Ignore cleanup failures in the example.
    }
  }
};

const server = new Server({ denyPUT: true, host: '127.0.0.1', port: 1234, root: '.' }, async (request) => {
  const offset = Number.parseInt(request.userExtensions.offset ?? '0', 10);
  if (Number.isNaN(offset) || offset < 0) {
    request.abort('The offset must be a non-negative integer');
    return;
  }

  const file = path.join('.', request.file);
  const metadata = await stat(file);
  const size = Math.max(metadata.size - offset, 0);

  await request.respond(createReadStream(file, { start: offset }), { size });
});
await server.listen();

try {
  await writeFile('tmp1', '0123456789');
  await writeFile('tmp2', '01234');

  const client = new Client({ host: '127.0.0.1', port: 1234 });
  await client.asyncGet(
    'tmp1',
    new Writable({
      async write(chunk, _encoding, callback) {
        try {
          await appendFile('tmp2', chunk);
          callback();
        } catch (error: unknown) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    }),
    { userExtensions: { offset: 5 } },
  );

  const content = await readFile('tmp2', 'utf8');
  console.log(content.trim());
  // 0123456789 (original "01234" + resumed "56789")
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await server.close();

  await cleanup();
}
