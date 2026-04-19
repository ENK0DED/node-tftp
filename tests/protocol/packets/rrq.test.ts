import { describe, expect, test } from 'bun:test';

import { baseClientOptions, tftp } from '../../helpers.js';

describe('rrq packets', () => {
  test('serialise without options produces a bare RRQ (opcode + filename + mode)', () => {
    const buffer = tftp.packets.rrq.serialize('test.bin');
    expect(buffer).toEqual(Buffer.from('\u0000\u0001test.bin\u0000octet\u0000', 'binary'));
    expect(buffer.readUInt16BE(0)).toBe(tftp.opcodes.RRQ);
    expect(buffer[buffer.length - 1]).toBe(0);
  });

  test('serialise with full client options appends the negotiated extensions', () => {
    const buffer = tftp.packets.rrq.serialize('foo.bin', baseClientOptions());
    expect(buffer.toString('ascii')).toBe(
      '\u0000\u0001foo.bin\u0000octet\u0000blksize\u00001468\u0000rollover\u00000\u0000timeout\u00003\u0000windowsize\u00004\u0000tsize\u00000\u0000',
    );
  });

  test('serialise embeds user extensions when they are not in the known set', () => {
    const opts = baseClientOptions();
    const buffer = tftp.packets.rrq.serialize('foo.bin', opts, { userExtensions: { auth: 'token-abc' } });
    expect(buffer.toString('ascii')).toContain('auth\u0000token-abc\u0000');
  });

  test('serialise does NOT mutate the global options object', () => {
    const opts = baseClientOptions();
    expect((opts.extensionsString as Record<string, string | undefined>).tsize).toBeUndefined();
    tftp.packets.rrq.serialize('foo.bin', opts);
    // The serializer should leave the shared options object untouched.
    expect((opts.extensionsString as Record<string, string | undefined>).tsize).toBeUndefined();
  });

  test('throws ERBIG when the resulting packet exceeds 512 bytes', () => {
    const opts = baseClientOptions();
    const huge = { userExtensions: { huge: 'x'.repeat(500) } };
    expect(() => tftp.packets.rrq.serialize('foo.bin', opts, huge)).toThrow();
  });

  test('deserialise yields the request descriptor', () => {
    const opts = baseClientOptions();
    const buffer = tftp.packets.rrq.serialize('greeting.txt', opts);
    const output = tftp.packets.rrq.deserialize(buffer);
    expect(output.file).toBe('greeting.txt');
    expect(output.userExtensions).toEqual({});
    expect(output.extensions).toEqual({ ...opts.extensions, tsize: 0 });
  });
});
