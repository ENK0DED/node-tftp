# `@enk0ded/tftp`

Stream-first TFTP client and server for Node.js.

This package implements modern `octet`-mode TFTP with option negotiation, `tftp-hpa` interoperability tests, and a stream-oriented API for both client and server use.

## Install

```bash
npm install @enk0ded/tftp
```

Requirements:

- Node.js `>= 24`
- ESM package environment
- Bun for local development and test commands

## Quick Start

### Download a file

```ts
import { Client } from '@enk0ded/tftp';

const client = new Client({
  host: '127.0.0.1',
  port: 69,
});

await client.asyncGet('remote.bin', 'local.bin');
```

### Upload a file

```ts
import { Client } from '@enk0ded/tftp';

const client = new Client({
  host: '127.0.0.1',
  port: 69,
});

await client.asyncPut('local.bin', 'remote.bin');
```

### Run a default server

```ts
import { Server } from '@enk0ded/tftp';

const server = new Server({
  host: '127.0.0.1',
  port: 69,
  root: '/srv/tftp',
});

await server.listen();
```

### Handle requests with a custom handler

```ts
import { Server } from '@enk0ded/tftp';

const server = new Server(
  {
    host: '127.0.0.1',
    port: 1069,
    root: '/srv/tftp',
  },
  async (request) => {
    if (request.method === 'GET') {
      await request.respond(Buffer.from('hello\n'));
    } else {
      const body = await request.readAll();
      console.log(request.file, body.length);
    }
  },
);

await server.listen();
```

## Client API

### `new Client(options?)`

Creates a client instance. Supported options:

- `host?: string` - server host, default `localhost`
- `port?: number` - server port, default `69`
- `blockSize?: number` - requested `blksize`, default `1468`
- `windowSize?: number` - requested `windowsize`, default `4`
- `retries?: number` - max retransmission attempts, default `3`
- `timeout?: number` - requested retransmission timeout in **seconds**, default `3`

### `client.asyncGet(remote, destination, options?)`

Downloads a remote file to a path or writable stream and resolves when the transfer completes.

`destination` can be:

- a filesystem path
- a writable Node stream

If `destination` is omitted, the local destination defaults to the same string as `remote`.

`options` always stays the third argument. To pass `options` while using the default destination, call `client.asyncGet(remote, undefined, options)`.

Returns the negotiated `TransferStats`.

### `client.asyncPut(source, remote, options?)`

Uploads a local source to a remote file and resolves when the transfer completes.

`source` can be:

- a filesystem path
- a `Buffer` or `Uint8Array`
- a readable Node stream

If `source` is a stream, pass `options.size`.

If `remote` is omitted, the remote destination defaults to the same string as `source`. This shorthand only works when `source` is a filesystem path string.

`options` always stays the third argument. To pass `options` while using the default remote path, call `client.asyncPut(sourcePath, undefined, options)`.

Returns the negotiated `TransferStats`.

### `client.get(remote, options?)`

Returns a transfer object with:

- `body: Readable`
- `close(error?)` -- clean close without an argument, abort with an error argument

The transfer object emits lifecycle events:

- `stats` -- negotiated `TransferStats` are available
- `done` -- transfer completed successfully
- `abort` -- transfer was aborted
- `close` -- underlying stream closed (always fires last)

### `client.put(remote, options?)`

Returns a transfer object with:

- `body: Writable` when `options.size` is known
- `send(source)`
- `close(error?)` -- clean close without an argument, abort with an error argument

The transfer object emits lifecycle events:

- `stats` -- negotiated `TransferStats` are available
- `done` -- transfer completed successfully
- `abort` -- transfer was aborted
- `close` -- underlying stream closed (always fires last)

### Client options per transfer

`GetTransferOptions`:

- `highWaterMark?: number`
- `userExtensions?: Record<string, unknown>`
- `md5?: string`
- `sha1?: string`

`PutTransferOptions`:

- `highWaterMark?: number`
- `userExtensions?: Record<string, unknown>`
- `size?: number | null`

### `TransferStats`

Returned by `asyncGet` and `asyncPut`, emitted by the `stats` event on `GetTransfer` and `PutTransfer`, and exposed on `ServerRequest.stats`:

- `blockSize: number` - negotiated TFTP block size
- `windowSize: number` - negotiated TFTP window size
- `size: number | null` - negotiated transfer size, or `null` when unknown
- `timeout: number` - negotiated retransmission timeout in seconds
- `retries: number` - retransmission attempts used during the transfer
- `userExtensions: Record<string, string>` - negotiated user-defined TFTP extensions
- `localAddress: string` - local socket address
- `localPort: number` - local socket port
- `remoteAddress: string` - remote peer address
- `remotePort: number` - remote peer port

### Named exports

The package also exports the transfer and request classes for TypeScript consumers who need to type-annotate variables:

```ts
import { Client, GetTransfer, PutTransfer, Server, ServerRequest } from '@enk0ded/tftp';
```

Type-only exports: `TransferDestination`, `TransferSource`, `ServerRequestHandler`, `ServerRequestProgress`.

## Server API

### `new Server(options?, handler?)`

Creates a server instance. Without a handler it uses the default filesystem-backed behavior:

- `GET` -> serves files from `root`
- `PUT` -> writes files under `root`

Supported options:

- all client transport options: `host`, `port`, `blockSize`, `windowSize`, `retries`, `timeout`
- `root?: string` - default `.`
- `denyGET?: boolean`
- `denyPUT?: boolean`

### `server.listen()`

Binds the server socket and starts handling requests. Resolves once the socket is bound.

Calling `listen()` again while the server is already listening is a no-op.

### `server.close()`

Closes the server socket, stops accepting new requests, and waits for all in-flight handler tasks to settle. If any request handler threw an error, the first failure is rethrown after all tasks have completed.

**Note:** The server registers a default no-op `error` event listener to prevent `unhandledError` crashes. If you need to observe server-level errors (socket failures, bind errors), attach your own `error` listener:

```ts
server.on('error', (error) => {
  console.error('Server error:', error);
});
```

### `server.on('request', handler)`

Listens for incoming request objects.

Each request exposes:

- `method: 'GET' | 'PUT'`
- `file: string`
- `localPath: string`
- `stats: TransferStats`
- `progress: { bytesTransferred: number; size: number | null }`
- `userExtensions: Record<string, string>`
- `done: Promise<void>`
- `body?: Readable`
- `abort(error?)`
- `readAll()` for `PUT`
- `respond(source?, options?)` for `GET`
- `saveTo(path?)` for `PUT`
- `setUserExtensions(userExtensions)`

Each request also emits a `progress` event with the same `{ bytesTransferred, size }` snapshot as bytes are uploaded or downloaded.

## Exported Errors

The package exports TFTP error descriptors such as:

- `ENOENT` - File not found
- `EACCESS` - Access violation
- `ENOSPC` - Disk full or allocation exceeded
- `EBADOP` - Illegal TFTP operation
- `ETID` - Unknown transfer ID
- `EEXIST` - File already exists
- `ENOUSER` - No such user
- `EDENY` - Request denied
- `EBADMSG` - Malformed TFTP message
- `EABORT` - Aborted
- `EFBIG` - File too big
- `ETIME` - Timed out
- `EBADMODE` - Invalid transfer mode
- `EBADNAME` - Invalid filename
- `EIO` - I/O error
- `ENOGET` - Cannot GET files
- `ENOPUT` - Cannot PUT files
- `ERBIG` - Request bigger than 512 bytes
- `ECONPUT` - Concurrent PUT over the same file
- `ECURPUT` - File is being written by another request
- `ECURGET` - File is being read by another request
- `ESOCKET` - Invalid remote socket

Each exported error has `{ code, name, message }`.

## RFC Compliance

- [RFC 1350 - The TFTP Protocol](http://www.ietf.org/rfc/rfc1350.txt) ✓ (`octet` mode only, see below)
- [RFC 2347 - Option Extension](http://www.ietf.org/rfc/rfc2347.txt) ✓
- [RFC 2348 - Blocksize Option](http://www.ietf.org/rfc/rfc2348.txt) ✓
- [RFC 2349 - Timeout Interval and Transfer Size Options](http://www.ietf.org/rfc/rfc2349.txt) ✓
- [RFC 7440 - Windowsize Option](https://tools.ietf.org/rfc/rfc7440.txt) ✓
- [De facto - Rollover Option](http://www.compuphase.com/tftp.htm) ✓
- [RFC 2090 - Multicast Option](http://www.ietf.org/rfc/rfc2090.txt) ✗
- [RFC 3617 - URI Scheme](http://www.ietf.org/rfc/rfc3617.txt) ✗
- `mail` and `netascii` transfer modes ✗

### Verified Behavior

The test suite covers:

- raw UDP RFC compliance cases
- retransmission and lost-packet recovery
- wrong-TID handling (error code 5 sent to the offending source)
- strict OACK acceptance/rejection rules
- option name case-insensitivity
- duplicate option rejection
- `tftp-hpa` interoperability for both client and server roles

### Exceptions and Design Choices

1. **`octet` mode only** - only binary (`octet`) transfers are supported. `netascii` is not implemented and `mail` is rejected. The implementation is intentionally strict and correct for the modern binary-transfer case.
2. **Duplicate options are rejected** - request and OACK packets must not contain the same option twice. Instead of silently choosing one value, duplicates are rejected during negotiation. This matches the RFC 2347 rule that an option may only be specified once.
3. **Option names are case-insensitive** - known options and custom user extensions are matched case-insensitively as required by the RFCs.
4. **`rollover` is interoperability-only** - the protocol layer recognizes and negotiates the de facto `rollover` extension, but it is not exposed as a top-level client/server option.

## Testing

Useful commands:

```bash
bun run lint
bun test
bunx tsc --noEmit
bun run build
npm pack --dry-run
```

`bun test` runs the full suite. The repository validates behavior at several levels:

- **Protocol unit tests** for packet parsing/serialization, option normalization, error descriptors, opcode tables, and filename validation.
- **Transfer and API integration tests** for the stream-first client/server facade, default filesystem-backed serving, manual request handling, abort behavior, progress events, and exact block-size edge cases.
- **Raw RFC compliance tests** that drive the protocol over UDP sockets directly. These cover retransmission, timeout negotiation, strict OACK validation, wrong-TID handling, duplicate option rejection, and transfer-mode rejection.
- **`tftp-hpa` interoperability tests** that run this package against the upstream `tftp-hpa` client and server in both directions, including blocksize and timeout negotiation.

The `tftp-hpa` interop suite downloads the latest tagged upstream snapshot from the official tree on demand, caches it under `.tftp-hpa-cache/`, and builds the local reference binaries into `.tftp-hpa-bin/`.

The build uses upstream autotools (`autoconf`, `autoheader`, `make`) instead of shipping generated config files in this repository. For local and CI test runs, the harness also applies a tiny source patch to `tftpd` so it skips Unix privilege-dropping calls when running unprivileged on high test ports. That keeps the reference behavior intact for protocol testing without requiring root or privileged containers.

Local release readiness is expected to include the full validation path shown above: linting, the full test suite, typechecking, a production build, and `npm pack --dry-run` to confirm the published tarball contents.

GitHub Actions runs the same validation on pushes and pull requests, and the release workflow reruns it on version tags before publishing to npm.

## Examples

The example programs under `examples/` are written in TypeScript and demonstrate the maintained stream-first API:

- `client/streams.ts` - streaming `asyncGet` and `asyncPut`
- `client/copy-remote-file.ts` - pipe a remote GET into a remote PUT
- `server/graceful-shutdown.ts` - track and abort in-flight requests on shutdown
- `server/proxy-http.ts` - serve GET responses from HTTP
- `server/no-pipe.ts` - restrict files and set response user extensions
- `server/reuse-default-listener.ts` - default handler with path guard
- `server/default-listener-deny-put.ts` - built-in PUT rejection
- `user-extensions.ts` - custom user extension round-trip
- `user-extensions-resume.ts` - resume-style GET via custom offset extension
- `user-extensions-authentication.ts` - fake auth via user extensions

## Release

Use `bun run release` to drive releases with `bumpp`.

The release flow is:

1. The very first publish must be done manually on npm to create the `@enk0ded/tftp` package entry.
2. After that bootstrap publish, configure npm trusted publishing for this repository and the `release.yml` workflow.
3. `bumpp` updates the version, creates the git tag, and pushes it.
4. GitHub Actions validates the tag build.
5. The release workflow publishes to npm with trusted publishing and provenance, then creates a GitHub Release with autogenerated notes.

## Notes

- TFTP runs over UDP and is best suited to controlled environments such as boot services, provisioning, and embedded workflows.
- The published package currently documents and supports the stream-oriented JavaScript API exposed from the package root.
