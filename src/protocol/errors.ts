// oxlint-disable sort-keys
/** Serializable TFTP error descriptor exported by this package. */
export type TFTPError = {
  code: number;
  name: string | undefined;
  message: string;
};

/** TFTP error descriptor for a missing file. */
export const ENOENT: TFTPError = { code: 1, name: 'ENOENT', message: 'File not found' }; // rfc
/** TFTP error descriptor for an access violation. */
export const EACCESS: TFTPError = { code: 2, name: 'EACCESS', message: 'Access violation' }; // rfc
/** TFTP error descriptor for a full disk or exhausted allocation. */
export const ENOSPC: TFTPError = { code: 3, name: 'ENOSPC', message: 'Disk full or allocation exceeded' }; // rfc
/** TFTP error descriptor for an illegal TFTP operation. */
export const EBADOP: TFTPError = { code: 4, name: 'EBADOP', message: 'Illegal TFTP operation' }; // rfc
/** TFTP error descriptor for an unknown transfer identifier. */
export const ETID: TFTPError = { code: 5, name: 'ETID', message: 'Unknown transfer ID' }; // rfc
/** TFTP error descriptor for an already existing file. */
export const EEXIST: TFTPError = { code: 6, name: 'EEXIST', message: 'File already exists' }; // rfc
/** TFTP error descriptor for a missing user. */
export const ENOUSER: TFTPError = { code: 7, name: 'ENOUSER', message: 'No such user' }; // rfc
/** TFTP error descriptor for a denied request. */
export const EDENY: TFTPError = { code: 8, name: 'EDENY', message: 'The request has been denied' }; // rfc

// Implementation-defined errors. Per RFC 1350, only codes 1..7 are reserved
// (and 8 by RFC 2347 — the Option Negotiation extension). Anything outside
// that range must be sent over the wire with code 0 ("Not defined, see
// error message"), so these entries intentionally use code 0.
/** Error descriptor for an invalid remote socket. */
export const ESOCKET: TFTPError = { code: 0, name: 'ESOCKET', message: 'Invalid remote socket' };
/** Error descriptor for a malformed TFTP message. */
export const EBADMSG: TFTPError = { code: 0, name: 'EBADMSG', message: 'Malformed TFTP message' };
/** Error descriptor for an aborted transfer. */
export const EABORT: TFTPError = { code: 0, name: 'EABORT', message: 'Aborted' };
/** Error descriptor for an oversized file. */
export const EFBIG: TFTPError = { code: 0, name: 'EFBIG', message: 'File too big' };
/** Error descriptor for a timed out transfer. */
export const ETIME: TFTPError = { code: 0, name: 'ETIME', message: 'Timed out' };
/** Error descriptor for an invalid transfer mode. */
export const EBADMODE: TFTPError = { code: 0, name: 'EBADMODE', message: 'Invalid transfer mode' };
/** Error descriptor for an invalid file name. */
export const EBADNAME: TFTPError = { code: 0, name: 'EBADNAME', message: 'Invalid filename' };
/** Error descriptor for a generic I/O failure. */
export const EIO: TFTPError = { code: 0, name: 'EIO', message: 'I/O error' };
/** Error descriptor emitted when GET requests are disabled. */
export const ENOGET: TFTPError = { code: 0, name: 'ENOGET', message: 'Cannot GET files' };
/** Error descriptor emitted when PUT requests are disabled. */
export const ENOPUT: TFTPError = { code: 0, name: 'ENOPUT', message: 'Cannot PUT files' };
/** Error descriptor for oversized requests with too many extensions. */
export const ERBIG: TFTPError = { code: 0, name: 'ERBIG', message: 'Request bigger than 512 bytes (too much extensions)' };
/** Error descriptor for concurrent PUTs targeting the same file. */
export const ECONPUT: TFTPError = { code: 0, name: 'ECONPUT', message: 'Concurrent PUT request over the same file' };
/** Error descriptor for files currently being written by another request. */
export const ECURPUT: TFTPError = { code: 0, name: 'ECURPUT', message: 'The requested file is being written by another request' };
/** Error descriptor for files currently being read by another request. */
export const ECURGET: TFTPError = { code: 0, name: 'ECURGET', message: 'The requested file is being read by another request' };

/** Map of all exported TFTP error descriptors keyed by name. */
export const errors: Record<string, TFTPError> = {
  ENOENT,
  EACCESS,
  ENOSPC,
  EBADOP,
  ETID,
  EEXIST,
  ENOUSER,
  EDENY,
  ESOCKET,
  EBADMSG,
  EABORT,
  EFBIG,
  ETIME,
  EBADMODE,
  EBADNAME,
  EIO,
  ENOGET,
  ENOPUT,
  ERBIG,
  ECONPUT,
  ECURPUT,
  ECURGET,
};

const messageToCode = new Map(Object.values(errors).map((e) => [e.message, e.code]));

/** Wrap an arbitrary wire error message in the exported {@link TFTPError} shape. */
export const wrap = (message: string): TFTPError => ({ code: messageToCode.get(message) ?? 0, name: undefined, message });
