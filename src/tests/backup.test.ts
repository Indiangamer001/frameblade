import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureDirs, makePaths } from '../engine/paths';
import { createBackup, readBackup } from '../engine/backup';
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
  const backup = createBackup(paths, tweak, entries, 'test');
  const file = path.join(paths.backupsDir, `${tweak.id}.json`);
  const parsed = { ...backup } as { checksum?: string };
  delete parsed.checksum;
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');

  assert.equal(readBackup(paths, tweak).checksum, undefined);
});
