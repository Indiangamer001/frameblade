import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  appendBufferHash,
  appendFileHash,
  readIntegrityRecords,
  sha256Buffer,
  sha256File,
  verifyBufferHash,
  verifyFileHash,
} from '../engine/integrity';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'frameblade-integrity-'));
}

test('integrity: SHA-256 matches a known digest', () => {
  assert.equal(
    sha256Buffer('hello world'),
    'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
  );
});

test('integrity: append records a file and verifies the exact bytes', () => {
  const dir = tempDir();
  const file = path.join(dir, 'backup.json');
  const ledger = path.join(dir, 'integrity', 'backups.ndjson');
  fs.writeFileSync(file, '{"a":1}\n', 'utf8');

  const record = appendFileHash(ledger, file);
  assert.equal(record.key, 'backup.json');
  assert.equal(record.size, Buffer.byteLength('{"a":1}\n'));
  assert.equal(record.sha256, sha256Buffer(fs.readFileSync(file)));
  assert.equal(record.sha256, sha256File(file));
  assert.equal(readIntegrityRecords(ledger).length, 1);

  const check = verifyFileHash(ledger, file);
  assert.equal(check.ok, true);
  assert.equal(check.status, 'ok');
  assert.equal(check.actual, record.sha256);

  const bufferCheck = verifyBufferHash(ledger, 'backup.json', Buffer.from('{"a":1}\n'));
  assert.equal(bufferCheck.ok, true);
});

test('integrity: the latest record wins after a legitimate rewrite', () => {
  const dir = tempDir();
  const file = path.join(dir, 'backup.json');
  const ledger = path.join(dir, 'integrity.ndjson');
  fs.writeFileSync(file, '{"a":1}\n', 'utf8');
  appendFileHash(ledger, file);

  fs.writeFileSync(file, '{"a":2}\n', 'utf8');
  assert.equal(verifyFileHash(ledger, file).status, 'mismatch');

  appendFileHash(ledger, file);
  assert.equal(verifyFileHash(ledger, file).status, 'ok');
  assert.equal(readIntegrityRecords(ledger).length, 2);
});

test('integrity: missing records and malformed metadata are reported', () => {
  const dir = tempDir();
  const file = path.join(dir, 'backup.json');
  const ledger = path.join(dir, 'integrity.ndjson');
  fs.writeFileSync(file, '{"a":1}\n', 'utf8');

  assert.equal(verifyFileHash(ledger, file).status, 'missing-metadata');

  appendFileHash(ledger, file);
  assert.equal(verifyBufferHash(ledger, 'another-key', Buffer.from('x')).status, 'missing-record');

  fs.appendFileSync(ledger, '{not json}\n', 'utf8');
  assert.equal(verifyFileHash(ledger, file).status, 'malformed-metadata');
});

test('integrity: optional HMAC authentication catches ledger edits', () => {
  const dir = tempDir();
  const file = path.join(dir, 'backup.json');
  const ledger = path.join(dir, 'integrity.ndjson');
  fs.writeFileSync(file, '{"a":1}\n', 'utf8');

  appendFileHash(ledger, file, { hmacKey: 'test-key' });
  assert.equal(verifyFileHash(ledger, file, { hmacKey: 'test-key' }).status, 'ok');
  assert.equal(verifyFileHash(ledger, file).status, 'missing-mac-key');
  assert.equal(verifyFileHash(ledger, file, { hmacKey: 'wrong-key' }).status, 'invalid-mac');

  const [record] = readIntegrityRecords(ledger);
  record.sha256 = '0'.repeat(64);
  fs.writeFileSync(ledger, `${JSON.stringify(record)}\n`, 'utf8');
  assert.equal(verifyFileHash(ledger, file, { hmacKey: 'test-key' }).status, 'invalid-mac');
});

test('integrity: a caller-supplied HMAC key rejects unauthenticated records', () => {
  const dir = tempDir();
  const file = path.join(dir, 'backup.json');
  const ledger = path.join(dir, 'integrity.ndjson');
  fs.writeFileSync(file, '{"a":1}\n', 'utf8');

  appendFileHash(ledger, file);
  assert.equal(verifyFileHash(ledger, file, { hmacKey: 'test-key' }).status, 'invalid-mac');
});

test('integrity: buffer records use a caller-supplied logical key and file name', () => {
  const dir = tempDir();
  const ledger = path.join(dir, 'integrity.ndjson');
  const record = appendBufferHash(
    ledger,
    'backup:nightglass',
    path.join('somewhere', 'nightglass.json'),
    Buffer.from('{"game":"Nightglass"}\n')
  );

  assert.equal(record.key, 'backup:nightglass');
  assert.equal(record.file, 'nightglass.json');
  const check = verifyBufferHash(
    ledger,
    'backup:nightglass',
    Buffer.from('{"game":"Nightglass"}\n')
  );
  assert.equal(check.ok, true);
});
