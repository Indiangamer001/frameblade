// Persistent profiles store (profiles.json in the data dir).
// Remembers the user's custom setups and the last mode they chose, so the
// app can offer a one-click re-apply instead of manual re-selection.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { EnginePaths } from './paths';

export interface CustomProfile {
  id: string;
  name: string;
  tweakIds: string[];
  createdAt: number;
}

export interface ProfilesData {
  version: 1;
  lastMode: string | null;
  lastModeAt: number | null;
  custom: CustomProfile[];
}

function emptyProfiles(): ProfilesData {
  return { version: 1, lastMode: null, lastModeAt: null, custom: [] };
}

function validProfile(p: unknown): p is CustomProfile {
  if (!p || typeof p !== 'object') return false;
  const c = p as CustomProfile;
  return (
    typeof c.id === 'string' &&
    c.id.length > 0 &&
    typeof c.name === 'string' &&
    c.name.length > 0 &&
    Array.isArray(c.tweakIds) &&
    c.tweakIds.every((t) => typeof t === 'string')
  );
}

export function loadProfiles(paths: EnginePaths): ProfilesData {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.profilesFile, 'utf8')) as ProfilesData;
    if (!parsed || parsed.version !== 1) return emptyProfiles();
    return {
      version: 1,
      lastMode: typeof parsed.lastMode === 'string' ? parsed.lastMode : null,
      lastModeAt: typeof parsed.lastModeAt === 'number' ? parsed.lastModeAt : null,
      custom: Array.isArray(parsed.custom) ? parsed.custom.filter(validProfile) : [],
    };
  } catch {
    return emptyProfiles();
  }
}

export function saveProfiles(paths: EnginePaths, data: ProfilesData): void {
  fs.mkdirSync(path.dirname(paths.profilesFile), { recursive: true });
  const tmp = paths.profilesFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, paths.profilesFile);
}

/** Saves (or updates, when the name already exists) a custom profile. */
export function addCustomProfile(
  paths: EnginePaths,
  name: string,
  tweakIds: string[]
): CustomProfile {
  const clean = name.trim().slice(0, 48);
  if (!clean) throw new Error('Profile name must not be empty.');
  if (tweakIds.length === 0) throw new Error('Nothing is applied — apply some optimizations first.');

  const data = loadProfiles(paths);
  const existing = data.custom.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  let profile: CustomProfile;
  if (existing) {
    existing.tweakIds = [...tweakIds];
    existing.createdAt = Date.now();
    profile = existing;
  } else {
    profile = {
      id: `custom-${crypto.randomBytes(4).toString('hex')}`,
      name: clean,
      tweakIds: [...tweakIds],
      createdAt: Date.now(),
    };
    data.custom.push(profile);
  }
  saveProfiles(paths, data);
  return profile;
}

export function removeCustomProfile(paths: EnginePaths, id: string): boolean {
  const data = loadProfiles(paths);
  const before = data.custom.length;
  data.custom = data.custom.filter((p) => p.id !== id);
  if (data.custom.length === before) return false;
  if (data.lastMode === id) data.lastMode = null;
  saveProfiles(paths, data);
  return true;
}

/** Remembers which mode/profile the user chose, for the resume banner. */
export function markModeUsed(paths: EnginePaths, modeId: string): void {
  const data = loadProfiles(paths);
  data.lastMode = modeId;
  data.lastModeAt = Date.now();
  saveProfiles(paths, data);
}
