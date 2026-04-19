import { unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { Client, ENOPUT, Server } from '../../src/index.js';

const server = new Server({ host: '127.0.0.1', port: 1234, root: '.' }, async (request) => {
  if (request.file !== 'node.exe') {
    await (request.method === 'GET' ? request.respond() : request.saveTo());
    return;
  }

  if (request.method === 'PUT') {
    request.abort(ENOPUT.message);
    return;
  }

  const response = await fetch('https://nodejs.org/dist/latest/node.exe');
  if (!response.ok || !response.body) {
    request.abort(`Upstream HTTP request failed with status ${response.status}`);
    return;
  }

  const contentLength = Number(response.headers.get('content-length'));
  await request.respond(Readable.fromWeb(response.body), { size: Number.isFinite(contentLength) ? contentLength : undefined });
});
await server.listen();

try {
  const client = new Client({ host: '127.0.0.1', port: 1234 });
  await client.asyncGet('node.exe', 'node.exe');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await server.close();

  try {
    await unlink('node.exe');
  } catch {
    // Ignore local cleanup errors in the example.
  }
}
