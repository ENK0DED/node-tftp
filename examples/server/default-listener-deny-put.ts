import { fileURLToPath } from 'node:url';

import { Client, Server } from '../../src/index.js';

const server = new Server({ denyPUT: true, host: '127.0.0.1', port: 1234, root: '.' });
await server.listen();

try {
  const client = new Client({ host: '127.0.0.1', port: 1234 });
  await client.asyncPut(fileURLToPath(import.meta.url), 'default-listener-deny-put.ts');
} catch (error) {
  console.error(error);
} finally {
  await server.close();
}
