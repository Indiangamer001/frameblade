import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureDirs, makePaths } from '../engine/paths';
import { createBackup, readBackup } from '../engine/backup';
import { readIntegrityRecords } from '../engine/integrity';
import { getTweak } from '../catalog/catalog';
import { BackupEntry } from '../shared/types';

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frameblade-backup-'));
  const paths = makePaths(path.join(root, 'Frameblade'));
  ensureDirs(paths);
  return paths;
}

test('backup: new backups carry a checksum and survive a clean read', () => {
  const paths = tempPaths();
  const tweak = getTweak('disable-game-bar-dvr');
  assert.ok(tweak);
  const entries: BackupEntry[] = [
    {
      actionIndex: 0,
      action: tweak.actions[0],
      undo: { kind: 'noop', reason: 'unit test' },
    },
  ];
  const backup = createBackup(paths, tweak, entries, 'test');
  assert.match(backup.checksum ?? '', /^[a-f0-9]{64}$/);
  assert.equal(backup.integrityVersion, 1);
  const records = readIntegrityRecords(paths.backupIntegrityFile);
  assert.equal(records.length, 1);
  assert.equal(records[0].key, `${tweak.id}.json`);
  assert.match(records[0].sha256, /^[a-f0-9]{64}$/);
  const loaded = readBackup(paths, tweak);
  assert.deepEqual(loaded.entries, entries);
});

test('backup: modifying entries after capture is detected before revert', () => {
  const paths = tempPaths();
  const tweak = getTweak('disable-game-bar-dvr');
  assert.ok(tweak);
  const entries: BackupEntry[] = [
    {
      actionIndex: 0,
      action: tweak.actions[0],
      undo: { kind: 'noop', reason: 'unit test' },
    },
  ];
  createBackup(paths, tweak, entries, 'test');
  const file = path.join(paths.backupsDir, `${tweak.id}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    entries: Array<{ undo: { reason?: string } }>;
  };
  parsed.entries[0].undo.reason = 'tampered';
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');

  assert.throws(() => readBackup(paths, tweak), /integrity check failed/);
});

test('backup: legacy backups without a checksum remain revertible', () => {
  const paths = tempPaths();
  const tweak = getTweak('disable-game-bar-dvr');
  assert.ok(tweak);
  const entries: BackupEntry[] = [
    {
      actionIndex: 0,
      action: tweak.actions[0],
      undo: { kind: 'noop', reason: 'legacy' },
    },
  ];
  const file = path.join(paths.backupsDir, `${tweak.id}.json`);
  const legacy = {
    tweakId: tweak.id,
    createdAt: new Date().toISOString(),
    appVersion: '0.1.0',
    catalogVersion: 'test',
    entries,
  };
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2), 'utf8');

  const loaded = readBackup(paths, tweak);
  assert.equal(loaded.checksum, undefined);
  assert.equal(loaded.integrityVersion, undefined);
});

test('backup: new backups require their detached integrity record', () => {
  const paths = tempPaths();
  const tweak = getTweak('disable-game-bar-dvr');
  assert.ok(tweak);
  const entries: BackupEntry[] = [
    {
      actionIndex: 0,
      action: tweak.actions[0],
      undo: { kind: 'noop', reason: 'ledger test' },
    },
  ];
  createBackup(paths, tweak, entries, 'test');
  fs.rmSync(paths.backupIntegrityFile);

  assert.throws(() => readBackup(paths, tweak), /backup integrity metadata is missing/);
});

test('backup: editing the detached ledger is detected', () => {
  const paths = tempPaths();
  const tweak = getTweak('disable-game-bar-dvr');
  assert.ok(tweak);
  const entries: BackupEntry[] = [
    {
      actionIndex: 0,
      action: tweak.actions[0],
      undo: { kind: 'noop', reason: 'ledger tamper test' },
    },
  ];
  createBackup(paths, tweak, entries, 'test');

  const record = readIntegrityRecords(paths.backupIntegrityFile)[0];
  record.sha256 = '0'.repeat(64);
  fs.writeFileSync(paths.backupIntegrityFile, `${JSON.stringify(record)}\n`, 'utf8');

  assert.throws(() => readBackup(paths, tweak), /integrity check failed/);
});
