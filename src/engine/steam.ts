// Steam library discovery: maps an installed game's exe to its Steam app
// (appmanifest_*.acf) and finds banner art in Steam's local library cache,
// with the public Steam CDN as a network fallback. Parsing helpers are pure
// and covered by tests; the fs/registry helpers are used by the main process.

import fs from 'fs';
import path from 'path';
import { regQuery } from './win';

export interface SteamRef {
  /** Folder that contains `steamapps` (a Steam library root). */
  libraryRoot: string;
  /** Game folder name under `steamapps\common`. */
  gameDir: string;
}

/** Finds the Steam library a given exe path lives in, if any. */
export function steamRefFromExe(exePath: string): SteamRef | null {
  if (!exePath || /[\r\n"]/.test(exePath)) return null;
  const norm = exePath.replace(/\//g, '\\');
  const m = /^(.*?)\\steamapps\\common\\([^\\]+)(?:\\|$)/i.exec(norm);
  if (!m || !m[1] || !m[2]) return null;
  return { libraryRoot: m[1], gameDir: m[2].trim() };
}

export interface SteamApp {
  appid: string;
  installdir: string;
  name: string;
}

/** Extracts appid / installdir / name from an appmanifest_*.acf keyvalues file. */
export function parseAcf(text: string): SteamApp | null {
  const appid = /"appid"\s+"(\d{1,10})"/i.exec(text)?.[1];
  const installdir = /"installdir"\s+"([^"\r\n]{1,200})"/i.exec(text)?.[1]?.trim();
  if (!appid || !installdir) return null;
  const name = /"name"\s+"([^"\r\n]{1,120})"/i.exec(text)?.[1]?.trim() || installdir;
  return { appid, installdir, name };
}

/** Reads every complete appmanifest in one library. */
export function readApps(libraryRoot: string): SteamApp[] {
  const dir = path.join(libraryRoot, 'steamapps');
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SteamApp[] = [];
  for (const f of files) {
    if (!/^appmanifest_\d{1,10}\.acf$/i.test(f)) continue;
    try {
      const app = parseAcf(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (app) out.push(app);
    } catch {
      /* unreadable manifest: skip it */
    }
  }
  return out;
}

/** Extracts the library roots from Steam's `libraryfolders.vdf` text.
 *  Older Steam clients used a numbered list; current clients use a "path"
 *  key per entry. Both store Windows paths with escaped backslashes. */
export function parseLibraryFolders(text: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  // Current clients use a "path" key; older clients used a numbered key.
  const re = /"(?:path|\d+)"\s+"((?:[^"\\]|\\.)+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[1].replace(/\\(["\\/])/g, '$1').trim();
    if (!/^[A-Za-z]:[\\/]/.test(raw)) continue;
    const norm = path.normalize(raw).replace(/[\\/]+$/, '');
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(norm);
  }
  return roots;
}

/** Main Steam install plus every library root it knows about. */
export async function steamLibraryRoots(): Promise<string[]> {
  const main = await steamInstallPath();
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | null | undefined) => {
    if (!p) return;
    const norm = path.normalize(p).replace(/[\\/]+$/, '');
    const key = norm.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(norm);
  };
  add(main);
  if (main) {
    try {
      const text = fs.readFileSync(path.join(main, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const p of parseLibraryFolders(text)) add(p);
    } catch {
      /* library list is optional */
    }
  }
  return roots;
}

/** Finds the app whose installdir matches a game folder (case-insensitive). */
export function matchApp(apps: SteamApp[], gameDir: string): SteamApp | null {
  const target = gameDir.trim().toLowerCase();
  if (!target) return null;
  return apps.find((a) => a.installdir.toLowerCase() === target) ?? null;
}

/** Resolves an installed exe to its Steam app, when it is a Steam install. */
export function steamAppForExe(exePath: string): SteamApp | null {
  const ref = steamRefFromExe(exePath);
  if (!ref) return null;
  return matchApp(readApps(ref.libraryRoot), ref.gameDir);
}

/** Banner art for an appid inside Steam's local library cache, if present.
 *  (Steam fills header.jpg lazily; the CDN fallback covers the rest.) */
export function libraryCacheCover(steamPath: string, appid: string): string | null {
  if (!/^\d{1,10}$/.test(appid)) return null;
  const dir = path.join(steamPath, 'appcache', 'librarycache', appid);
  for (const file of ['header.jpg', 'library_hero.jpg', 'library_600x900.jpg']) {
    const p = path.join(dir, file);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* unreadable entry: try the next candidate */
    }
  }
  return null;
}

/** Public CDN banner candidates for an appid (tried in order). */
export function cdnCandidates(appid: string): string[] {
  if (!/^\d{1,10}$/.test(appid)) return [];
  return [
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_231x87.jpg`,
  ];
}

/**
 * Main Steam install (owns appcache/librarycache). Reads the user's registry
 * value first, then falls back to the common install locations.
 */
export async function steamInstallPath(): Promise<string | null> {
  try {
    const v = (await regQuery('HKCU', 'Software\\Valve\\Steam', 'SteamPath'))?.value;
    if (typeof v === 'string' && v.trim()) {
      const p = path.resolve(v.trim().replace(/\//g, '\\'));
      if (fs.existsSync(path.join(p, 'steam.exe'))) return p;
    }
  } catch {
    /* fall through to the well-known locations */
  }
  for (const p of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) {
    if (fs.existsSync(path.join(p, 'steam.exe'))) return p;
  }
  return null;
}
