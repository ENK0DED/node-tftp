import path from 'node:path';

import { Server } from '../../src/index.js';

const server = new Server({ host: '127.0.0.1', port: 1234, root: '.' }, async (request) => {
  if (path.dirname(request.file) !== '.') {
    request.abort('Invalid path');
    return;
  }

  try {
    await (request.method === 'GET' ? request.respond() : request.saveTo());
  } catch (error) {
    console.error(error);
    request.abort(error);
  }
});
await server.listen();
