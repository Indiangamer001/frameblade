import fs from 'fs';
import { backupFileFor, EnginePaths, APP_VERSION } from './paths';
import { BackupEntry, BackupFile, Tweak } from '../shared/types';
import { EngineError } from '../shared/errors';
import { regQuery } from './win';

export function createBackup(
  paths: EnginePaths,
  tweak: Tweak,
  entries: BackupEntry[],
  catalogVersion: string
): BackupFile {
  const backup: BackupFile = {
    tweakId: tweak.id,
    createdAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    catalogVersion,
    entries,
  };
  const file = backupFileFor(paths, tweak.id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(backup, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return backup;
}

export function readBackup(paths: EnginePaths, tweak: Tweak): BackupFile {
  const file = backupFileFor(paths, tweak.id);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as BackupFile;
    if (!parsed || !Array.isArray(parsed.entries)) {
      throw new Error('malformed backup file');
    }
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
