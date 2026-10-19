// Installed-game discovery. The scanner is read-only: it inspects Steam
// libraries, Epic manifests, GOG metadata and common game folders, then picks
// the most likely game executable in each folder. The main process decides
// which detections to add to the user's library and which need consent.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { entryFromPath, GameEntry, GameSource } from './watcher';
import { readApps, steamLibraryRoots } from './steam';

export interface DetectedGame extends GameEntry {
  /** Full path to the detected executable (always known for detections). */
  path: string;
  source: GameSource;
  /** Root folder that produced the detection; useful for diagnostics. */
  origin?: string;
}

export interface DetectOptions {
  /** Explicit Steam library roots. `[]` disables Steam scanning. */
  steamRoots?: string[];
  /** Epic manifest folder. `null` disables Epic scanning. */
  epicManifestsDir?: string | null;
  /** Explicit common game roots. `[]` disables generic folder scanning. */
  commonRoots?: string[];
  /** Safety cap for callers that only need a bounded list. */
  maxGames?: number;
}

const MAX_WALK_DEPTH = 5;
const MAX_WALK_ENTRIES = 3000;

/** Executables that are installers, helpers, crash reporters or anti-cheat. */
const EXE_BLOCKLIST: RegExp[] = [
  /^unins/i,
  /^uninstall/i,
  /^setup/i,
  /^install(er)?/i,
  /^update/i,
  /^updater/i,
  /^repair/i,
  /^vcredist/i,
  /^vc_redist/i,
  /^dxsetup/i,
  /^dxwebsetup/i,
  /^dotnet/i,
  /^ue[45]prereq/i,
  /^crash/i,
  /^report/i,
  /^helper/i,
  /^service/i,
  /^eac/i,
  /^easyanticheat/i,
  /^battleye/i,
  /^be_?service/i,
  /^anticheat/i,
  /^steamwebhelper/i,
  /^epicwebhelper/i,
  /^gogalaxy/i,
  /^galaxyclient/i,
  /^unitycrashhandler/i,
  /^unrealcefsubprocess/i,
  /^cef/i,
  /^crashpad/i,
  /^python/i,
  /^node/i,
  /^java/i,
  /^ffmpeg/i,
  /^ffprobe/i,
  /^7z/i,
  /^winrar/i,
  /^gamelaunchhelper/i,
  /^launchwinapp/i,
  /^gamebar/i,
  /^xboxgamebar/i,
  /^runtimebroker/i,
  /^epicgameslauncher/i,
  /^riotclientservices/i,
  /^riotclientux/i,
  /^battlenet/i,
  /^eadedent/i,
  /^origin/i,
  /^ubisoftconnect/i,
];

/** Folders that never contain the game's main process. */
const DIR_BLOCKLIST = new Set([
  '_commonredist',
  'commonredist',
  'redist',
  'redistributable',
  'directx',
  'dotnet',
  'vcredist',
  'support',
  'engine',
  'tools',
  'editor',
  'easyanticheat',
  'battleye',
  'anticheat',
  'crashreport',
  'crashpad',
  'logs',
  'saves',
  'savegames',
  'config',
  'cache',
  'temp',
  'backup',
  'backups',
  'uninstall',
  'installer',
  'symbols',
  'debug',
  'mods',
  'workshop',
]);

/** Direct child folders of a library root that are launchers or metadata. */
const ROOT_SKIP = new Set([
  'steam',
  'steamapps',
  'steamlibrary',
  'common',
  'workshop',
  'steamworks shared',
  'epic games launcher',
  'gog galaxy',
  'riot client',
  'battle.net',
  'blizzard entertainment',
  'ea desktop',
  'origin games',
  'ubisoft game launcher',
  'rockstar games launcher',
  'amazon games',
  'xboxgames',
  'games',
  'gog games',
  'epic games',
  'riot games',
  'ea games',
  'electronic arts',
  'rockstar games',
  'unreal engine',
]);

function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function safeTitle(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 80) : undefined;
}

function prettyFolderName(name: string): string | undefined {
  return safeTitle(name.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim());
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function directDirs(dir: string): Array<{ name: string; path: string }> {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.isSymbolicLink())
      .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function blockedDir(name: string): boolean {
  return DIR_BLOCKLIST.has(name.trim().toLowerCase());
}

const ROOT_SKIP_COMPACT = new Set([...ROOT_SKIP].map((name) => normName(name)));

function rootSkipped(name: string): boolean {
  return ROOT_SKIP.has(name.trim().toLowerCase()) || ROOT_SKIP_COMPACT.has(normName(name));
}

function blockedExe(name: string): boolean {
  return EXE_BLOCKLIST.some((re) => re.test(name));
}

interface Candidate {
  file: string;
  score: number;
  size: number;
}

function scoreExe(file: string, size: number, gameDir: string): number {
  const base = path.basename(file, path.extname(file));
  const baseNorm = normName(base);
  const gameNorm = normName(path.basename(gameDir));
  let score = 0;

  if (baseNorm && gameNorm && baseNorm === gameNorm) score += 120;
  else if (baseNorm && gameNorm && (gameNorm.includes(baseNorm) || baseNorm.includes(gameNorm))) {
    score += 50;
  }

  const rel = path.relative(gameDir, file).toLowerCase();
  if (/(^|\\)(bin|binaries|win64|x64|game|retail)(\\|$)/.test(rel)) score += 25;
  const depth = rel.split(/[\\/]/).filter(Boolean).length;
  score += Math.max(0, 20 - depth * 4);

  // A game's main executable is usually much larger than a launcher or a
  // crash/anti-cheat helper. Size is a stronger signal than a launcher name
  // that happens to contain the install-folder name (e.g. ExecPubg.exe).
  if (size >= 50 * 1024 * 1024) score += 60;
  else if (size >= 20 * 1024 * 1024) score += 45;
  else if (size >= 2 * 1024 * 1024) score += 20;
  else if (size > 0 && size < 200 * 1024) score -= 10;

  if (/^(launcher|start|play|exec)/.test(baseNorm)) score -= 35;
  if (/_be$|_zk$/.test(baseNorm)) score -= 50;
  if (/shipping|win64|game|client/.test(baseNorm)) score += 10;
  if (/server|dedicated/.test(baseNorm)) score -= 50;

  return score;
}

/**
 * Picks the executable that most looks like the game's main process.
 * Returns null when the folder has no usable candidate.
 */
export function findPrimaryExe(gameDir: string): string | null {
  if (!gameDir || !isDir(gameDir)) return null;
  const candidates: Candidate[] = [];
  let visited = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || visited >= MAX_WALK_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited++ >= MAX_WALK_ENTRIES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink() && !blockedDir(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.exe$/i.test(entry.name) || blockedExe(entry.name)) continue;
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        /* size is only a tie-breaker */
      }
      candidates.push({ file: full, size, score: scoreExe(full, size, gameDir) });
    }
  };

  walk(gameDir, 0);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || b.size - a.size || a.file.localeCompare(b.file));
  return candidates[0].file;
}

function makeDetected(
  file: string,
  title: string | undefined,
  source: GameSource,
  origin: string | undefined,
  appid?: string
): DetectedGame | null {
  const parsed = entryFromPath(file);
  if (!parsed || !parsed.path) return null;
  const entry: DetectedGame = {
    ...parsed,
    path: parsed.path,
    source,
  };
  const clean = safeTitle(title);
  if (clean) entry.title = clean;
  if (appid && /^\d{1,10}$/.test(appid)) entry.appid = appid;
  if (origin) entry.origin = origin;
  return entry;
}

interface GogInfo {
  title?: string;
  exe?: string;
}

/** Reads GOG's `goggame-*.info` metadata in an install folder, when present. */
function readGogInfo(dir: string): GogInfo | null {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => /^goggame-.*\.info$/i.test(f));
  } catch {
    return null;
  }
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as {
        name?: unknown;
        playTasks?: Array<{ path?: unknown; workingDir?: unknown; isPrimary?: unknown }>;
      };
      const info: GogInfo = { title: safeTitle(data.name) };
      const tasks = Array.isArray(data.playTasks) ? data.playTasks : [];
      const ordered = [
        ...tasks.filter((t) => t && t.isPrimary === true),
        ...tasks.filter((t) => !t || t.isPrimary !== true),
      ];
      for (const task of ordered) {
        if (!task || typeof task.path !== 'string' || !/\.exe$/i.test(task.path)) continue;
        const workingDir = typeof task.workingDir === 'string' ? task.workingDir : '';
        const candidate = path.resolve(dir, workingDir, task.path);
        const inside = path.relative(dir, candidate);
        if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) {
          if (isDir(path.dirname(candidate)) && fs.existsSync(candidate)) {
            info.exe = candidate;
            break;
          }
        }
      }
      return info;
    } catch {
      /* try the next info file */
    }
  }
  return null;
}

async function detectSteam(roots: string[]): Promise<DetectedGame[]> {
  const out: DetectedGame[] = [];
  for (const root of [...new Set(roots.map((r) => path.normalize(r)))]) {
    const common = path.join(root, 'steamapps', 'common');
    const apps = readApps(root);
    const known = new Set<string>();
    for (const app of apps) {
      known.add(app.installdir.toLowerCase());
      if (!app.installdir || /[\\/]/.test(app.installdir) || app.installdir === '.' || app.installdir === '..') {
        continue;
      }
      const dir = path.join(common, app.installdir);
      const exe = findPrimaryExe(dir);
      if (!exe) continue;
      const game = makeDetected(exe, app.name, 'steam', root, app.appid);
      if (game) out.push(game);
    }
    // Some manual installs share the Steam library but have no appmanifest.
    for (const child of directDirs(common)) {
      if (known.has(child.name.toLowerCase()) || rootSkipped(child.name) || blockedDir(child.name)) {
        continue;
      }
      const exe = findPrimaryExe(child.path);
      if (!exe) continue;
      const game = makeDetected(exe, prettyFolderName(child.name), 'folder', common);
      if (game) out.push(game);
    }
    await yieldToLoop();
  }
  return out;
}

interface EpicManifest {
  DisplayName?: unknown;
  InstallLocation?: unknown;
  LaunchExecutable?: unknown;
  AppName?: unknown;
}

function defaultEpicManifestsDir(): string {
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  return path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
}

async function detectEpic(manifestsDir: string | null): Promise<DetectedGame[]> {
  if (!manifestsDir) return [];
  let files: string[];
  try {
    files = fs.readdirSync(manifestsDir).filter((f) => /\.item$/i.test(f));
  } catch {
    return [];
  }
  const out: DetectedGame[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(manifestsDir, file), 'utf8')) as EpicManifest;
      if (typeof data.InstallLocation !== 'string') continue;
      const install = path.resolve(data.InstallLocation);
      if (!isDir(install)) continue;
      let exe: string | null = null;
      if (typeof data.LaunchExecutable === 'string') {
        const rel = data.LaunchExecutable.replace(/[\\/]+/g, '\\');
        if (rel && !path.isAbsolute(rel) && !rel.includes('..')) {
          const candidate = path.resolve(install, rel);
          const inside = path.relative(install, candidate);
          if (inside && !inside.startsWith('..') && !path.isAbsolute(inside) && /\.exe$/i.test(candidate)) {
            if (fs.existsSync(candidate)) exe = candidate;
          }
        }
      }
      if (!exe) exe = findPrimaryExe(install);
      if (!exe) continue;
      const game = makeDetected(exe, safeTitle(data.DisplayName), 'epic', manifestsDir);
      if (game) out.push(game);
    } catch {
      /* skip malformed manifest */
    }
    await yieldToLoop();
  }
  return out;
}

async function detectCommon(roots: string[]): Promise<DetectedGame[]> {
  const out: DetectedGame[] = [];
  for (const root of [...new Set(roots.map((r) => path.normalize(r)))]) {
    for (const child of directDirs(root)) {
      if (rootSkipped(child.name) || blockedDir(child.name)) continue;
      const gog = readGogInfo(child.path);
      const exe = gog?.exe ?? findPrimaryExe(child.path);
      if (!exe) continue;
      const title = gog?.title ?? prettyFolderName(child.name);
      const game = makeDetected(exe, title, gog ? 'gog' : 'folder', root);
      if (game) out.push(game);
    }
    await yieldToLoop();
  }
  return out;
}

/** Common install roots used by the major launchers and standalone games. */
export function defaultCommonRoots(): string[] {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates: string[] = [
    path.join(pf, 'Epic Games'),
    path.join(pfx86, 'Epic Games'),
    path.join(pfx86, 'GOG Galaxy', 'Games'),
    path.join(pfx86, 'Ubisoft', 'Ubisoft Game Launcher', 'games'),
    path.join(pfx86, 'Ubisoft'),
    path.join(pf, 'Riot Games'),
    path.join(pfx86, 'Riot Games'),
    path.join(pf, 'EA Games'),
    path.join(pfx86, 'EA Games'),
    path.join(pf, 'Electronic Arts'),
    path.join(pfx86, 'Electronic Arts'),
    path.join(pfx86, 'Origin Games'),
    path.join(pf, 'Origin Games'),
    path.join(pf, 'Rockstar Games'),
    path.join(pfx86, 'Rockstar Games'),
    path.join(pf, 'Amazon Games', 'Library'),
    path.join(pfx86, 'Amazon Games', 'Library'),
    path.join(pf, 'Battle.net'),
    path.join(pfx86, 'Battle.net'),
    path.join(pf, 'Blizzard Entertainment'),
    path.join(pfx86, 'Blizzard Entertainment'),
    path.join(pfx86, 'Steam', 'steamapps', 'common'),
    path.join(pf, 'Steam', 'steamapps', 'common'),
    'C:\\GOG Games',
    'C:\\XboxGames',
    'C:\\Games',
    path.join(os.homedir(), 'Games'),
  ];
  for (const drive of ['C', 'D', 'E', 'F', 'G', 'H']) {
    for (const name of ['Games', 'GOG Games', 'Epic Games', 'XboxGames', 'Riot Games']) {
      candidates.push(`${drive}:\\${name}`);
    }
    candidates.push(`${drive}:\\SteamLibrary\\steamapps\\common`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of candidates) {
    const norm = path.normalize(p).replace(/[\\/]+$/, '');
    const key = norm.toLowerCase();
    if (seen.has(key) || !isDir(norm)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

function sourceRank(source: GameSource): number {
  if (source === 'steam' || source === 'epic') return 4;
  if (source === 'gog') return 3;
  return 1;
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Scans installed-game sources. Pass explicit empty arrays / null in tests to
 * avoid touching the real machine. Default roots cover Steam, Epic, GOG,
 * Ubisoft, Riot, EA, Rockstar, Amazon, Xbox and common `\Games` folders.
 */
export async function detectInstalledGames(opts: DetectOptions = {}): Promise<DetectedGame[]> {
  const steamRoots = opts.steamRoots ?? (await steamLibraryRoots());
  const epicDir = opts.epicManifestsDir === undefined ? defaultEpicManifestsDir() : opts.epicManifestsDir;
  const commonRoots = opts.commonRoots ?? defaultCommonRoots();
  const maxGames = Math.max(1, Math.min(256, opts.maxGames ?? 128));

  const found: DetectedGame[] = [];
  found.push(...(await detectSteam(steamRoots)));
  found.push(...(await detectEpic(epicDir)));
  found.push(...(await detectCommon(commonRoots)));

  const byExe = new Map<string, DetectedGame>();
  for (const game of found) {
    const prev = byExe.get(game.exe);
    if (!prev || sourceRank(game.source) > sourceRank(prev.source)) byExe.set(game.exe, game);
  }
  return [...byExe.values()]
    .sort((a, b) => (a.title ?? a.exe).localeCompare(b.title ?? b.exe, undefined, { sensitivity: 'base' }))
    .slice(0, maxGames);
}
