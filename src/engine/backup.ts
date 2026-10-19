import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { backupFileFor, EnginePaths, APP_VERSION } from './paths';
import { BackupEntry, BackupFile, Tweak } from '../shared/types';
import { EngineError } from '../shared/errors';
import { appendBufferHash, verifyBufferHash } from './integrity';
import { regQuery } from './win';

type BackupPayload = Omit<BackupFile, 'checksum'>;

function checksumFor(backup: BackupPayload): string {
  // JSON.stringify is stable for the objects we create: all keys are inserted
  // in a fixed order and every entry comes from the same parse/create path.
  return crypto.createHash('sha256').update(JSON.stringify(backup)).digest('hex');
}

export function createBackup(
  paths: EnginePaths,
  tweak: Tweak,
  entries: BackupEntry[],
  catalogVersion: string
): BackupFile {
  const payload: BackupPayload = {
    tweakId: tweak.id,
    createdAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    catalogVersion,
    entries,
    integrityVersion: 1,
  };
  const backup: BackupFile = { ...payload, checksum: checksumFor(payload) };
  const file = backupFileFor(paths, tweak.id);
  const tmp = file + '.tmp';
  const body = JSON.stringify(backup, null, 2);
  const bytes = Buffer.from(body, 'utf8');
  const previous = fs.existsSync(file) ? fs.readFileSync(file) : undefined;

  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);

  try {
    appendBufferHash(
      paths.backupIntegrityFile,
      path.basename(file),
      path.basename(file),
      bytes
    );
  } catch (err) {
    // The backup is not usable without its detached record. Put the previous
    // backup back so an earlier reverted state is not stranded by this failure.
    try {
      if (previous === undefined) {
        fs.rmSync(file, { force: true });
      } else {
        const restore = file + '.restore';
        fs.writeFileSync(restore, previous);
        fs.renameSync(restore, file);
      }
    } catch {
      /* best effort; the apply is aborted below regardless */
    }
    throw new EngineError(
      'RES009',
      `Backup was written but its integrity record could not be saved. Apply aborted. (${(err as Error).message})`
    );
  }
  return backup;
}

export function readBackup(paths: EnginePaths, tweak: Tweak): BackupFile {
  const file = backupFileFor(paths, tweak.id);
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('backup path is not a regular file');
    }

    // Read once, verify those exact bytes, then parse the same buffer. Reading
    // the file again after verification would create a TOCTOU window. If the
    // ledger can decide the result, reject before JSON.parse.
    const data = fs.readFileSync(file);
    const external = verifyBufferHash(
      paths.backupIntegrityFile,
      path.basename(file),
      data
    );
    if (external.status === 'malformed-metadata') {
      throw new Error(`backup integrity metadata is malformed (${external.message})`);
    }
    if (!external.ok && external.status !== 'missing-metadata' && external.status !== 'missing-record') {
      if (external.status === 'mismatch') {
        throw new Error('backup integrity check failed (file changed after capture)');
      }
      throw new Error(`backup integrity metadata is not usable (${external.message})`);
    }

    const parsed = JSON.parse(data.toString('utf8')) as BackupFile;
    if (!parsed || !Array.isArray(parsed.entries)) {
      throw new Error('malformed backup file');
    }
    if (parsed.integrityVersion !== undefined && parsed.integrityVersion !== 1) {
      throw new Error('unsupported backup integrity version');
    }
    if (parsed.integrityVersion === 1 && !external.ok) {
      // New backups always have a detached record. A missing record means the
      // ledger was deleted or the backup was copied without it: fail closed.
      throw new Error('backup integrity metadata is missing');
    }

    if (parsed.checksum !== undefined) {
      if (typeof parsed.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(parsed.checksum)) {
        throw new Error('malformed backup checksum');
      }
      const { checksum, ...payload } = parsed;
      if (checksumFor(payload) !== checksum.toLowerCase()) {
        throw new Error('backup integrity check failed (file changed after capture)');
      }
    }
    // Backups created before 0.1.1 have no checksum and remain revertible.
    return parsed;
  } catch (err) {
    throw new EngineError(
      'RES009',
      `No usable backup for '${tweak.id}'. Cannot revert safely. (${(err as Error).message})`
    );
  }
}

/**
 * Backup verification (mirrors Hone's UTIL085 semantics):
 *  1) structural check: one undo entry per action,
 *  2) spot-check: the first registry undo must still match the live system.
 *     If it does not, the machine changed since capture and we refuse to apply.
 */
export async function verifyBackup(
  paths: EnginePaths,
  tweak: Tweak,
  backup: BackupFile
): Promise<void> {
  if (backup.entries.length !== tweak.actions.length) {
    throw new EngineError(
      'UTIL085',
      `Backup has ${backup.entries.length} entries but the tweak has ${tweak.actions.length} actions.`
    );
  }
  const first = backup.entries.find((e) => e.undo.kind === 'registry');
  if (!first) return;
  const u = first.undo as Extract<BackupFile['entries'][number]['undo'], { kind: 'registry' }>;
  const cur = await regQuery(u.hive, u.key, u.name);
  if (u.existed) {
    if (!cur || String(cur.value) !== String(u.value)) {
      throw new EngineError(
        'UTIL085',
        `Live registry value changed since backup was captured (${u.key}\\${u.name}).`
      );
    }
  } else if (cur) {
    throw new EngineError(
      'UTIL085',
      `Registry value appeared since backup was captured (${u.key}\\${u.name}).`
    );
  }
}
