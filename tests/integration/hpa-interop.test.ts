import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { allocPortRange, readTransfer, readWhenComplete, startServer, tftp } from '../helpers.js';

const allocPort = allocPortRange(1);

const REPO_ROOT = join(import.meta.dir, '..', '..');
const HPA_DIR = join(REPO_ROOT, '.tftp-hpa-bin');
const HPA_TFTP = join(HPA_DIR, 'tftp');
const HPA_TFTPD = join(HPA_DIR, 'tftpd');
const HPA_BUILD = join(REPO_ROOT, 'tests', 'hpa-build.sh');

const ensureHpaBinaries = () => {
  if (existsSync(HPA_TFTP) && existsSync(HPA_TFTPD)) {
    return;
  }

  const result = spawnSync('bash', [HPA_BUILD], { encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`Failed to build tftp-hpa binaries:\n${result.stderr}`);
  }
};

let hpaAvailable = true;
let hpaBuildError: string | undefined = undefined;

try {
  ensureHpaBinaries();
} catch (error) {
  hpaBuildError = error instanceof Error ? error.message : String(error);
  hpaAvailable = false;
}

const RUN_USER = Bun.env.USER || Bun.env.LOGNAME || 'nobody';

type HpaServerHandle = { proc: ChildProcess; port: number; root: string };
type HpaTransferResult = { code: number | null; stderr: string; stdout: string };

const startHpaServer = async (root: string, port: number): Promise<HpaServerHandle> => {
  const proc = spawn(HPA_TFTPD, ['-L', '-a', `127.0.0.1:${port}`, '-c', '-p', '-u', RUN_USER, root], { stdio: 'pipe' });
  const deadline = Date.now() + 2000;

  while (Date.now() < deadline) {
    const probe = spawnSync('ss', ['-uln'], { encoding: 'utf8' });

    if (probe.stdout.includes(`127.0.0.1:${port}`)) {
      break;
    }

    await delay(25);
  }

  return { port, proc, root };
};

const stopHpaServer = async (handle: HpaServerHandle) =>
  // oxlint-disable-next-line promise/avoid-new
  new Promise<void>((resolve) => {
    if (!handle.proc.pid || handle.proc.killed) {
      resolve();
      return;
    }

    handle.proc.once('exit', () => resolve());
    handle.proc.kill('SIGKILL');
  });

// oxlint-disable-next-line eslint/max-params
const runHpaClient = async (port: number, command: string, cwd: string, timeoutMs = 8000): Promise<HpaTransferResult> =>
  // oxlint-disable-next-line promise/avoid-new
  new Promise((resolve) => {
    const proc = spawn(HPA_TFTP, ['-m', 'binary', '127.0.0.1', String(port), '-c', ...command.split(' ')], { cwd, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (b) => (stdout += String(b)));
    proc.stderr?.on('data', (b) => (stderr += String(b)));

    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);

    proc.on('exit', (code) => {
      clearTimeout(timer);
      // oxlint-disable-next-line promise/no-multiple-resolved
      resolve({ code, stderr, stdout });
    });
  });

const fixtures = {
  blockExact: Buffer.alloc(512, 0x42),
  empty: Buffer.alloc(0),
  large: Buffer.alloc(60_000, 0x37),
  multiBlock: Buffer.alloc(5000, 0xab),
  small: Buffer.from('hello, world\n'),
};

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const fixtureKeys = Object.keys(fixtures) as (keyof typeof fixtures)[];

// oxlint-disable-next-line init-declarations
let scratchRoot: string;
// oxlint-disable-next-line init-declarations
let serverRoot: string;
// oxlint-disable-next-line init-declarations
let clientRoot: string;

beforeAll(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), 'tftp-hpa-tests-'));
  serverRoot = join(scratchRoot, 'server');
  clientRoot = join(scratchRoot, 'client');
  await mkdir(serverRoot, { recursive: true });
  await mkdir(clientRoot, { recursive: true });

  for (const [name, contents] of Object.entries(fixtures)) {
    await writeFile(join(serverRoot, `${name}.bin`), contents);
    await writeFile(join(clientRoot, `${name}.bin`), contents);
  }
});

afterAll(async () => {
  if (scratchRoot) {
    await rm(scratchRoot, { force: true, recursive: true });
  }
});

describe('tftp-hpa reference smoke test', () => {
  test('hpa client ↔ hpa server self-test (GET round-trip)', async () => {
    if (!hpaAvailable) {
      throw new Error(hpaBuildError ?? 'tftp-hpa binaries are unavailable');
    }

    const port = allocPort();
    const handle = await startHpaServer(serverRoot, port);

    try {
      const result = await runHpaClient(port, `get ${join(serverRoot, 'small.bin')} smoke.bin`, clientRoot);
      expect(result.code).toBe(0);
      const actual = await readFile(join(clientRoot, 'smoke.bin'));
      expect(Buffer.compare(actual, fixtures.small)).toBe(0);
    } finally {
      await stopHpaServer(handle);
    }
  });
});

describe.skipIf(!hpaAvailable)('hpa client → new server', () => {
  test.each(fixtureKeys)('downloads "%s.bin" via tftp-hpa client', async (name) => {
    const port = allocPort();
    const server = await startServer({ port, root: serverRoot });

    try {
      const result = await runHpaClient(port, `get ${name}.bin hpa-get-${name}.bin`, clientRoot);
      expect(result.code).toBe(0);
      const actual = await readFile(join(clientRoot, `hpa-get-${name}.bin`));
      expect(Buffer.compare(actual, fixtures[name])).toBe(0);
    } finally {
      await server.close();
    }
  });

  test.each(fixtureKeys)('uploads "%s.bin" via tftp-hpa client', async (name) => {
    const port = allocPort();
    const writeRoot = join(scratchRoot, `hpa-put-${name}`);
    await mkdir(writeRoot, { recursive: true });
    const server = await startServer({ port, root: writeRoot });

    try {
      const result = await runHpaClient(port, `put ${name}.bin hpa-put-${name}.bin`, clientRoot);
      expect(result.code).toBe(0);
      const expected = fixtures[name];
      const actual = await readWhenComplete(join(writeRoot, `hpa-put-${name}.bin`), expected.length);
      expect(Buffer.compare(actual, expected)).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe.skipIf(!hpaAvailable)('new client → hpa server', () => {
  test.each(fixtureKeys)('downloads "%s.bin" from tftp-hpa server', async (name) => {
    const port = allocPort();
    const handle = await startHpaServer(serverRoot, port);
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      const localPath = join(clientRoot, `ts-get-${name}.bin`);
      await client.asyncGet(join(serverRoot, `${name}.bin`), localPath);
      const actual = await readFile(localPath);
      expect(Buffer.compare(actual, fixtures[name])).toBe(0);
    } finally {
      await stopHpaServer(handle);
    }
  });

  test.each(fixtureKeys)('uploads "%s.bin" to tftp-hpa server', async (name) => {
    const port = allocPort();
    const writeRoot = join(scratchRoot, `ts-put-${name}`);
    await mkdir(writeRoot, { recursive: true });
    const handle = await startHpaServer(writeRoot, port);
    const client = new tftp.Client({ host: '127.0.0.1', port, windowSize: 1 });

    try {
      const remote = join(writeRoot, `ts-put-${name}.bin`);
      await client.asyncPut(join(clientRoot, `${name}.bin`), remote);
      const expected = fixtures[name];
      const actual = await readWhenComplete(remote, expected.length);
      expect(Buffer.compare(actual, expected)).toBe(0);
    } finally {
      await stopHpaServer(handle);
    }
  });

  test('GET with blockSize=1024 round-trips a multi-block payload', async () => {
    const port = allocPort();
    const handle = await startHpaServer(serverRoot, port);
    const client = new tftp.Client({ blockSize: 1024, host: '127.0.0.1', port, windowSize: 1 });

    try {
      const localPath = join(clientRoot, 'opt-get-1024.bin');
      await client.asyncGet(join(serverRoot, 'multiBlock.bin'), localPath);
      const actual = await readFile(localPath);
      expect(Buffer.compare(actual, fixtures.multiBlock)).toBe(0);
    } finally {
      await stopHpaServer(handle);
    }
  });

  test('PUT with blockSize=1024 round-trips a multi-block payload', async () => {
    const port = allocPort();
    const writeRoot = join(scratchRoot, 'opt-put-1024');
    await mkdir(writeRoot, { recursive: true });
    const handle = await startHpaServer(writeRoot, port);
    const client = new tftp.Client({ blockSize: 1024, host: '127.0.0.1', port, windowSize: 1 });

    try {
      const remote = join(writeRoot, 'opt-put-1024.bin');
      await client.asyncPut(join(clientRoot, 'multiBlock.bin'), remote);
      const actual = await readWhenComplete(remote, fixtures.multiBlock.length);
      expect(Buffer.compare(actual, fixtures.multiBlock)).toBe(0);
    } finally {
      await stopHpaServer(handle);
    }
  });

  test('GET with blockSize=8192 round-trips a >1-block payload', async () => {
    const port = allocPort();
    const handle = await startHpaServer(serverRoot, port);
    const client = new tftp.Client({ blockSize: 8192, host: '127.0.0.1', port, windowSize: 1 });

    try {
      const localPath = join(clientRoot, 'opt-get-8192.bin');
      await client.asyncGet(join(serverRoot, 'large.bin'), localPath);
      const actual = await readFile(localPath);
      expect(Buffer.compare(actual, fixtures.large)).toBe(0);
    } finally {
      await stopHpaServer(handle);
    }
  });

  test('GET negotiates timeout with tftp-hpa server', async () => {
    const port = allocPort();
    const handle = await startHpaServer(serverRoot, port);
    const client = new tftp.Client({ host: '127.0.0.1', port, timeout: 7, windowSize: 1 });

    try {
      const transfer = client.get(join(serverRoot, 'small.bin'));
      const closed = once(transfer, 'close');
      const [stats] = await once(transfer, 'stats');
      const actual = await readTransfer(transfer.body);
      await closed;

      expect(stats.timeout).toBe(7);
      expect(Buffer.compare(actual, fixtures.small)).toBe(0);
    } finally {
      await stopHpaServer(handle);
    }
  });

  test('PUT negotiates timeout with tftp-hpa server', async () => {
    const port = allocPort();
    const writeRoot = join(scratchRoot, 'opt-put-timeout');
    await mkdir(writeRoot, { recursive: true });
    const handle = await startHpaServer(writeRoot, port);
    const client = new tftp.Client({ host: '127.0.0.1', port, timeout: 7, windowSize: 1 });

    try {
      const remote = join(writeRoot, 'opt-put-timeout.bin');
      const transfer = client.put(remote, { size: fixtures.small.length });
      let transferStats: { timeout: number } | undefined; // oxlint-disable-line init-declarations

      transfer.on('stats', (stats) => {
        transferStats = stats;
      });

      await transfer.send(fixtures.small);

      const actual = await readWhenComplete(remote, fixtures.small.length);
      expect(transferStats?.timeout).toBe(7);
      expect(Buffer.compare(actual, fixtures.small)).toBe(0);
    } finally {
      await stopHpaServer(handle);
    }
  });
});
