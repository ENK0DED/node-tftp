import { Server } from '../../src/index.js';
import type { ServerRequest } from '../../src/index.js';

const activeRequests = new Set<ServerRequest>();

const server = new Server({ host: '127.0.0.1', port: 1234, root: '.' }, async (request) => {
  activeRequests.add(request);
  /* oxlint-disable promise/prefer-await-to-then */
  request.done
    .finally(() => {
      activeRequests.delete(request);
    })
    .catch(() => undefined);
  /* oxlint-enable promise/prefer-await-to-then */

  await (request.method === 'GET' ? request.respond() : request.saveTo());
});
await server.listen();

setTimeout(async () => {
  let index = 0;
  for (const request of activeRequests) {
    console.log(`Aborting request ${(index += 1)}: ${request.file}`);
    request.abort('Server shutting down');
  }

  await server.close();
  console.log('Server closed');
}, 10_000);
