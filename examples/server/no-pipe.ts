import { once } from 'node:events';
import { buffer as readBuffer } from 'node:stream/consumers';

import { Client, Server } from '../../src/index.js';

const server = new Server({ denyPUT: true, host: '127.0.0.1', port: 1234, root: '.' }, async (request) => {
  if (request.file !== 'hello') {
    request.abort("Can only GET the file 'hello'");
    return;
  }

  request.setUserExtensions({ pid: process.pid, platform: process.platform });
  await request.respond(Buffer.from('Hello World!\n'));
});
await server.listen();

try {
  const client = new Client({ host: '127.0.0.1', port: 1234 });
  const transfer = client.get('hello', { userExtensions: { pid: '', platform: '' } });
  const [stats] = await once(transfer, 'stats');
  const body = await readBuffer(transfer.body);
  await once(transfer, 'close');

  console.log(`TFTP server running on ${stats.userExtensions.platform} with pid ${stats.userExtensions.pid}.`);
  process.stdout.write(body);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await server.close();
}
