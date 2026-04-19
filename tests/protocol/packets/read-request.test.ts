import { describe, expect, test } from 'bun:test';

import { MAX_BLOCK_SIZE, MAX_WINDOW_SIZE } from '../../../src/protocol/constants.js';
import { baseClientOptions, buildRequestPacket, tftp } from '../../helpers.js';

const buildRequest = (op: number, extensions: Record<string, string> = {}) => buildRequestPacket(op, 'f', 'octet', extensions);
const buildMalformedRrq = (extension: string, value: string) => buildRequestPacket(tftp.opcodes.RRQ, 'f', 'octet', { [extension]: value });

/**
 * `read-request.js` deserialises both RRQ and WRQ packets.  The boolean flag
 * controls how the `tsize` extension is validated:
 *  - for RRQ (read), tsize MUST be 0 (placeholder for the server reply);
 *  - for WRQ (write), tsize MUST be the positive byte count of the file.
 */
describe('readRequest', () => {
  test('parses a classic RRQ packet', () => {
    const buffer = tftp.packets.rrq.serialize('file.bin');
    // oxlint-disable-next-line unicorn/no-null
    expect(tftp.packets.rrq.deserialize(buffer)).toEqual({ extensions: null, file: 'file.bin', userExtensions: {} });
  });

  test('parses a WRQ packet with classic extensions', () => {
    const buffer = buildRequest(tftp.opcodes.WRQ, { blksize: '1024', tsize: '12345', windowsize: '4' });
    expect(tftp.packets.wrq.deserialize(buffer, false)).toEqual({ extensions: { blksize: 1024, tsize: 12_345, windowsize: 4 }, file: 'f', userExtensions: {} });
  });

  test('rejects RRQ packets whose tsize is non-zero (per RFC2349)', () => {
    const buffer = buildMalformedRrq('tsize', '42');
    expect(() => tftp.packets.rrq.deserialize(buffer)).toThrow();
  });

  test('rejects RRQ packets whose blksize exceeds the RFC 2348 maximum', () => {
    const buffer = buildMalformedRrq('blksize', String(MAX_BLOCK_SIZE + 1));
    expect(() => tftp.packets.rrq.deserialize(buffer)).toThrow();
  });

  test('rejects RRQ packets whose windowsize exceeds the RFC 7440 maximum', () => {
    const buffer = buildMalformedRrq('windowsize', String(MAX_WINDOW_SIZE + 1));
    expect(() => tftp.packets.rrq.deserialize(buffer)).toThrow();
  });

  test('parses timeout negotiation on RRQ packets', () => {
    const buffer = buildMalformedRrq('timeout', '7');
    expect(tftp.packets.rrq.deserialize(buffer).extensions).toEqual({ timeout: 7 });
  });

  test('parses option names case-insensitively', () => {
    const buffer = buildRequest(tftp.opcodes.RRQ, { BLKSIZE: '1024', TImEOut: '7', TSIZE: '0', WINdowSize: '4' });
    expect(tftp.packets.rrq.deserialize(buffer).extensions).toEqual({ blksize: 1024, timeout: 7, tsize: 0, windowsize: 4 });
  });

  test('rejects duplicate option names case-insensitively', () => {
    const buffer = buildRequest(tftp.opcodes.RRQ, { BLKSIZE: '2048', blksize: '1024' });
    expect(() => tftp.packets.rrq.deserialize(buffer)).toThrow();
  });

  test('rejects RRQ packets whose timeout is outside RFC 2349 bounds', () => {
    expect(() => tftp.packets.rrq.deserialize(buildMalformedRrq('timeout', '0'))).toThrow();
    expect(() => tftp.packets.rrq.deserialize(buildMalformedRrq('timeout', '256'))).toThrow();
  });

  test('rejects request extensions whose numeric values exceed safe integer precision', () => {
    const buffer = buildRequest(tftp.opcodes.WRQ, { tsize: String(Number.MAX_SAFE_INTEGER + 1) });
    expect(() => tftp.packets.wrq.deserialize(buffer, false)).toThrow();
  });

  test('rejects packets with a multibyte filename', () => {
    const malformed = Buffer.from('\u0000\u0001n\xc3\xa9.bin\u0000octet\u0000', 'binary');
    expect(() => tftp.packets.rrq.deserialize(malformed)).toThrow();
  });

  test('rejects unsupported transfer modes including netascii and mail', () => {
    expect(() => tftp.packets.rrq.deserialize(buildRequestPacket(tftp.opcodes.RRQ, 'f', 'binary', {}))).toThrow();
    expect(() => tftp.packets.rrq.deserialize(buildRequestPacket(tftp.opcodes.RRQ, 'f', 'netascii', {}))).toThrow();
    expect(() => tftp.packets.rrq.deserialize(buildRequestPacket(tftp.opcodes.RRQ, 'f', 'mail', {}))).toThrow();
  });

  test('preserves user extensions verbatim', () => {
    const opts = baseClientOptions();
    const buffer = tftp.packets.rrq.serialize('a.bin', opts, { userExtensions: { auth: 'tok' } });
    const out = tftp.packets.rrq.deserialize(buffer);
    expect(out.userExtensions).toEqual({ auth: 'tok' });
    expect(out.extensions).toMatchObject({
      blksize: opts.extensions.blksize,
      timeout: opts.extensions.timeout,
      tsize: 0,
      windowsize: opts.extensions.windowsize,
    });
  });
});
