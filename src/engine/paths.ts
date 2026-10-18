import fs from 'fs';
import os from 'os';
import path from 'path';
import { BRAND_SLUG, LEGACY_DATA_DIR } from '../shared/brand';

export interface EnginePaths {
  userDataDir: string;
  stateFile: string;
  journalFile: string;
  backupsDir: string;
  jobsDir: string;
  logsDir: string;
  profilesFile: string;
  watcherFile: string;
  thumbsDir: string;
}

function localBaseDir(): string {
  return process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
}

export function defaultUserDataDir(): string {
  return path.join(localBaseDir(), BRAND_SLUG);
}

function legacyUserDataDir(): string {
  return path.join(localBaseDir(), LEGACY_DATA_DIR);
}

/**
 * Canonical data directory. Migrates the legacy brand folder once so
 * backups, state and journals survive the rename.
 */
export function resolveUserDataDir(): string {
  const target = defaultUserDataDir();
  try {
    if (!fs.existsSync(target) && fs.existsSync(legacyUserDataDir())) {
      try {
        fs.renameSync(legacyUserDataDir(), target);
      } catch {
        fs.cpSync(legacyUserDataDir(), target, { recursive: true });
      }
    }
  } catch {
    /* best effort; fall through to the new path */
  }
  return target;
}

export function makePaths(userDataDir: string): EnginePaths {
  return {
    userDataDir,
    stateFile: path.join(userDataDir, 'state.json'),
    journalFile: path.join(userDataDir, 'journals', 'journal.ndjson'),
    backupsDir: path.join(userDataDir, 'backups'),
    jobsDir: path.join(userDataDir, 'jobs'),
    logsDir: path.join(userDataDir, 'logs'),
    profilesFile: path.join(userDataDir, 'profiles.json'),
    watcherFile: path.join(userDataDir, 'watcher.json'),
    thumbsDir: path.join(userDataDir, 'thumbs'),
  };
}

export function ensureDirs(p: EnginePaths): void {
  for (const dir of [
    p.userDataDir,
    path.dirname(p.journalFile),
    p.backupsDir,
    p.jobsDir,
    p.logsDir,
    p.thumbsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function backupFileFor(paths: EnginePaths, tweakId: string): string {
  return path.join(paths.backupsDir, `${tweakId}.json`);
}

export const APP_VERSION = '0.1.0';
