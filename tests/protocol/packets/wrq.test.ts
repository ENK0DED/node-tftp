import { describe, expect, test } from 'bun:test';

import { baseClientOptions, tftp } from '../../helpers.js';

describe('wrq packets', () => {
  test('serialise without options produces a bare WRQ', () => {
    const buffer = tftp.packets.wrq.serialize('upload.bin');
    expect(buffer).toEqual(Buffer.from('\u0000\u0002upload.bin\u0000octet\u0000', 'binary'));
    expect(buffer.readUInt16BE(0)).toBe(tftp.opcodes.WRQ);
  });

  test('serialise with options encodes tsize equal to the file size', () => {
    const fileSize = 1_234_567;
    const buffer = tftp.packets.wrq.serialize('upload.bin', baseClientOptions(), { size: fileSize });
    expect(buffer.toString('ascii')).toContain(`tsize\u0000${fileSize}\u0000`);
  });

  test('user extensions are appended after the negotiated ones', () => {
    const buffer = tftp.packets.wrq.serialize('a.bin', baseClientOptions(), { size: 10, userExtensions: { sig: 'abcd' } });
    expect(buffer.toString('ascii')).toContain('sig\u0000abcd\u0000');
  });

  test('deserialise returns the request shape', () => {
    const opts = baseClientOptions();
    const buffer = tftp.packets.wrq.serialize('a.bin', opts, { size: 64 });
    const output = tftp.packets.wrq.deserialize(buffer, false);
    expect(output.file).toBe('a.bin');
    expect(output.userExtensions).toEqual({});
    expect(output.extensions).toEqual({ ...opts.extensions, tsize: 64 });
  });
});
