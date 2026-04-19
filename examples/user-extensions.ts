import { once } from 'node:events';
import { unlink, writeFile } from 'node:fs/promises';

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

const server = new Server({ host: '127.0.0.1', port: 1234, root: '.' }, async (request) => {
  const current = Number.parseInt(request.userExtensions.num ?? '0', 10);
  request.setUserExtensions({ num: current - 1 });
  await (request.method === 'GET' ? request.respond() : request.saveTo());
});
await server.listen();

try {
  await writeFile('tmp1', '');
  const client = new Client({ host: '127.0.0.1', port: 1234 });

  const transfer = client.get('tmp1', { userExtensions: { num: '42' } });
  const [stats] = await once(transfer, 'stats');
  console.log(stats.userExtensions); // { num: '41' }
  await once(transfer, 'close');

  const upload = client.put('tmp2', { size: 0, userExtensions: { num: '-10' } });
  let uploadStats: Record<string, unknown> | undefined; // oxlint-disable-line init-declarations
  upload.on('stats', (s) => {
    uploadStats = s.userExtensions;
  });
  await upload.send(Buffer.alloc(0));
  console.log(uploadStats); // { num: '-11' }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await server.close();
  await cleanup();
}
