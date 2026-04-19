import { unlink, writeFile } from 'node:fs/promises';

import { Client, Server } from '../src/index.js';

const users: Record<string, string> = { usr1: 'usr1-pass' };

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
  const { user, pass } = request.userExtensions;

  if (!user || !pass || users[user] !== pass) {
    request.abort('Invalid user');
    return;
  }

  await (request.method === 'GET' ? request.respond() : request.saveTo());
});
await server.listen();

try {
  await writeFile('tmp1', '');
  const client = new Client({ host: '127.0.0.1', port: 1234 });

  try {
    await client.asyncGet('tmp1', 'tmp2');
  } catch (error) {
    console.error(error);
  }

  await client.asyncGet('tmp1', 'tmp2', { userExtensions: { pass: 'usr1-pass', user: 'usr1' } });
  console.log('OK');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await server.close();

  await cleanup();
}
