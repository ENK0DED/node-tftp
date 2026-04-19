import { once } from 'node:events';

import { Client } from '../../src/index.js';

try {
  const client = new Client({ host: '127.0.0.1', port: 69 });
  const download = client.get('remote-file');
  const [stats] = await once(download, 'stats');

  if (stats.size === null) {
    download.close('The server did not report a file size');
    throw new Error('Cannot mirror a transfer without a negotiated tsize');
  }

  const upload = client.put('remote-file-copy', { size: stats.size });
  await upload.send(download.body);
  await once(download, 'close');
  console.log(`Copied ${stats.size} bytes to remote-file-copy`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
