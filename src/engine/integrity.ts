import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Detached integrity metadata for files that must survive a tamper check
 * before they are used.
 *
 * The ledger is newline-delimited JSON. Every append is one record, and the
 * latest record for a key wins. Verification compares the recorded SHA-256
 * against the bytes that were actually read, so callers should verify the same
 * buffer they parse rather than reading the file twice (TOCTOU).
 *
 * Security boundary: a plain SHA-256 record is tamper-EVIDENT, not
 * tamper-PROOF. A process that can rewrite both the file and this ledger can
 * simply append a new, valid-looking record. For a stronger boundary:
 *   - pass `hmacKey` and keep that key in DPAPI/TPM/OS keychain, or
 *   - anchor the latest record in a remote append-only store.
 * The default 0o600 mode protects the ledger from other OS users on POSIX; on
 * Windows the inherited ACL of the per-user data directory is the practical
 * protection. Same-user malware can still read and modify both files.
 */
export const INTEGRITY_LEDGER_VERSION = 1 as const;

export interface IntegrityRecord {
  version: 1;
  /** Logical name used to look up the latest record. */
  key: string;
  /** Original file name, for diagnostics only. Never used as a path. */
  file: string;
  size: number;
  sha256: string;
  recordedAt: string;
  /** Optional HMAC-SHA256 of the canonical record payload. */
  mac?: string;
}

export interface IntegrityOptions {
  /** Logical key. Defaults to the file's basename. */
  key?: string;
  /** Optional HMAC key. If used, verification must supply the same key. */
  hmacKey?: string | Buffer;
  /** Permission mode for a newly created ledger. Defaults to 0o600. */
  mode?: number;
}

export type IntegrityStatus =
  | 'ok'
  | 'missing-file'
  | 'missing-metadata'
  | 'missing-record'
  | 'mismatch'
  | 'malformed-metadata'
  | 'missing-mac-key'
  | 'invalid-mac';

export interface IntegrityCheck {
  ok: boolean;
  status: IntegrityStatus;
  message: string;
  record?: IntegrityRecord;
  expected?: string;
  actual?: string;
}

export function sha256Buffer(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha256File(filePath: string): string {
  return sha256Buffer(fs.readFileSync(filePath));
}

/**
 * Hash a file and append a detached record for it.
 */
export function appendFileHash(
  metadataFile: string,
  filePath: string,
  options: IntegrityOptions = {}
): IntegrityRecord {
  const data = fs.readFileSync(filePath);
  const key = options.key ?? path.basename(filePath);
  return appendBufferHash(metadataFile, key, path.basename(filePath), data, options);
}

/**
 * Hash an in-memory buffer and append a detached record. Use this when the
 * caller already has the exact bytes that will be written to disk (for
 * example, a backup serialized once and then written).
 */
export function appendBufferHash(
  metadataFile: string,
  key: string,
  fileName: string,
  data: Buffer | string,
  options: Omit<IntegrityOptions, 'key'> = {}
): IntegrityRecord {
  assertKey(key);
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const record: IntegrityRecord = {
    version: INTEGRITY_LEDGER_VERSION,
    key,
    file: path.basename(fileName),
    size: bytes.length,
    sha256: sha256Buffer(bytes),
    recordedAt: new Date().toISOString(),
  };
  if (options.hmacKey !== undefined) {
    record.mac = macFor(record, options.hmacKey);
  }

  fs.mkdirSync(path.dirname(metadataFile), { recursive: true });
  const mode = options.mode ?? 0o600;
  const fd = fs.openSync(metadataFile, 'a', mode);
  try {
    // One write per record keeps concurrent appends from interleaving in the
    // common local-filesystem case. fsync makes the record durable before the
    // caller proceeds.
    fs.writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(metadataFile, mode);
  } catch {
    // Windows does not implement POSIX modes; inherits the user-profile ACL.
  }
  return record;
}

/**
 * Read every valid record from the ledger. A missing ledger is treated as an
 * empty ledger so callers can distinguish "not enabled yet" from corruption.
 */
export function readIntegrityRecords(metadataFile: string): IntegrityRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(metadataFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const records: IntegrityRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`malformed integrity metadata at line ${i + 1}`);
    }
    records.push(validateRecord(raw, i + 1));
  }
  return records;
}

export function latestIntegrityRecord(
  metadataFile: string,
  key: string
): IntegrityRecord | undefined {
  const records = readIntegrityRecords(metadataFile);
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].key === key) return records[i];
  }
  return undefined;
}

/**
 * Verify a file against the latest ledger record. The file is read once here;
 * callers that need to parse the file should prefer verifyBufferHash so the
 * verified bytes are the parsed bytes.
 */
export function verifyFileHash(
  metadataFile: string,
  filePath: string,
  options: IntegrityOptions = {}
): IntegrityCheck {
  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch (err) {
    return {
      ok: false,
      status: 'missing-file',
      message: `cannot read file for integrity check: ${(err as Error).message}`,
    };
  }
  return verifyBufferHash(metadataFile, options.key ?? path.basename(filePath), data, options);
}

/**
 * Verify bytes against the latest ledger record for `key`.
 */
export function verifyBufferHash(
  metadataFile: string,
  key: string,
  data: Buffer | string,
  options: Pick<IntegrityOptions, 'hmacKey'> = {}
): IntegrityCheck {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const actual = sha256Buffer(bytes);

  let records: IntegrityRecord[];
  try {
    records = readIntegrityRecords(metadataFile);
  } catch (err) {
    return {
      ok: false,
      status: 'malformed-metadata',
      message: (err as Error).message,
      actual,
    };
  }

  const record = latestRecord(records, key);
  if (!record) {
    return {
      ok: false,
      status: records.length === 0 ? 'missing-metadata' : 'missing-record',
      message:
        records.length === 0
          ? 'integrity metadata is missing'
          : `no integrity record for '${key}'`,
      actual,
    };
  }

  if (record.mac !== undefined) {
    if (options.hmacKey === undefined) {
      return {
        ok: false,
        status: 'missing-mac-key',
        message: 'integrity record is HMAC-protected but no HMAC key was supplied',
        record,
        expected: record.sha256,
        actual,
      };
    }
    const expectedMac = macFor(record, options.hmacKey);
    if (!constantTimeHexEqual(record.mac, expectedMac)) {
      return {
        ok: false,
        status: 'invalid-mac',
        message: 'integrity metadata authentication failed',
        record,
        expected: record.sha256,
        actual,
      };
    }
  } else if (options.hmacKey !== undefined) {
    return {
      ok: false,
      status: 'invalid-mac',
      message: 'integrity record is not authenticated',
      record,
      expected: record.sha256,
      actual,
    };
  }

  const ok = record.size === bytes.length && constantTimeHexEqual(record.sha256, actual);
  return {
    ok,
    status: ok ? 'ok' : 'mismatch',
    message: ok ? 'integrity verified' : 'integrity check failed (file changed after capture)',
    record,
    expected: record.sha256,
    actual,
  };
}

function latestRecord(records: IntegrityRecord[], key: string): IntegrityRecord | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].key === key) return records[i];
  }
  return undefined;
}

function assertKey(key: string): void {
  if (!key || key.length > 512 || /[\r\n]/.test(key)) {
    throw new Error('integrity record key must be a non-empty single-line string');
  }
}

function canonicalRecord(record: IntegrityRecord): string {
  return JSON.stringify({
    version: record.version,
    key: record.key,
    file: record.file,
    size: record.size,
    sha256: record.sha256,
    recordedAt: record.recordedAt,
  });
}

function macFor(record: IntegrityRecord, hmacKey: string | Buffer): string {
  const key = Buffer.isBuffer(hmacKey) ? hmacKey : Buffer.from(hmacKey, 'utf8');
  if (key.length === 0) throw new Error('integrity HMAC key must not be empty');
  return crypto.createHmac('sha256', key).update(canonicalRecord(record)).digest('hex');
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b) || a.length !== b.length) {
    return false;
  }
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function validateRecord(value: unknown, line: number): IntegrityRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`malformed integrity metadata at line ${line}`);
  }
  const r = value as Record<string, unknown>;
  if (r.version !== INTEGRITY_LEDGER_VERSION) {
    throw new Error(`unsupported integrity metadata version at line ${line}`);
  }
  if (typeof r.key !== 'string' || !r.key || r.key.length > 512 || /[\r\n]/.test(r.key)) {
    throw new Error(`malformed integrity key at line ${line}`);
  }
  if (typeof r.file !== 'string' || !r.file) {
    throw new Error(`malformed integrity file name at line ${line}`);
  }
  if (typeof r.size !== 'number' || !Number.isSafeInteger(r.size) || r.size < 0) {
    throw new Error(`malformed integrity size at line ${line}`);
  }
  if (typeof r.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(r.sha256)) {
    throw new Error(`malformed integrity hash at line ${line}`);
  }
  if (typeof r.recordedAt !== 'string' || Number.isNaN(Date.parse(r.recordedAt))) {
    throw new Error(`malformed integrity timestamp at line ${line}`);
  }
  if (r.mac !== undefined && (typeof r.mac !== 'string' || !/^[a-f0-9]{64}$/i.test(r.mac))) {
    throw new Error(`malformed integrity MAC at line ${line}`);
  }
  return {
    version: INTEGRITY_LEDGER_VERSION,
    key: r.key,
    file: r.file,
    size: r.size,
    sha256: r.sha256.toLowerCase(),
    recordedAt: r.recordedAt,
    ...(r.mac === undefined ? {} : { mac: r.mac.toLowerCase() }),
  };
}
