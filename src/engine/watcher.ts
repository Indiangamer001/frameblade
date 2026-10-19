// Game Mode watcher: polls the process list for user-chosen game executables
// and, when one is running, raises its process priority for the session.
// Process priorities are not persisted and disappear when the game exits.
// Setting changes are handled by the main process, which also journals and
// reverts its opt-in, session-safe auto-apply subset.

import { EXE, psJson, run } from './win';
import fs from 'fs';
import { EnginePaths } from './paths';

export type PriorityLevel = 'normal' | 'above-normal' | 'high';
export const PRIORITY_LEVELS: PriorityLevel[] = ['normal', 'above-normal', 'high'];

/** Hard limit for the persisted game library (UI mirrors this value). */
export const MAX_GAMES = 64;

export type GameSource = 'steam' | 'epic' | 'gog' | 'folder';

/** One game in the library: exe name for watching, full path and art info when known. */
export interface GameEntry {
  exe: string;
  path: string | null;
  /** Pretty display name (taken from a launcher manifest when available). */
  title?: string;
  /** Steam appid when the game is installed through Steam (used for cover art). */
  appid?: string;
  /** Where the entry came from; optional for entries created by older versions. */
  source?: GameSource;
  /** User opted this game into session-safe auto-apply. */
  autoApply?: boolean;
  /** False until the user answers the one-time auto-apply prompt. */
  prompted?: boolean;
}

/** Trims a manifest-provided display name; rejects control characters. */
function cleanTitle(s: string): string | undefined {
  const t = s.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t && t.length <= 80 ? t : undefined;
}

/** Pretty name for a library entry: manifest title, else the exe without extension. */
export function displayTitle(entry: GameEntry): string {
  return entry.title?.trim() || entry.exe.replace(/\.exe$/i, '');
}

export interface WatcherConfig {
  version: 3;
  enabled: boolean;
  games: GameEntry[];
  priority: PriorityLevel;
  pollSeconds: number;
  /** Hold a 0.5 ms timer request while a game runs (needs the timer-resolution tweak). */
  timerResolution: boolean;
  /** Scan common launcher folders for installed games on startup / Game Mode open. */
  autoDetect: boolean;
  /** Master switch for the opt-in per-game session-safe auto-apply. */
  autoApply: boolean;
  /** Exe names the user removed, so a later scan does not keep re-adding them. */
  ignoredGames: string[];
}

export function defaultWatcherConfig(): WatcherConfig {
  return {
    version: 3,
    enabled: false,
    games: [],
    priority: 'high',
    pollSeconds: 8,
    timerResolution: false,
    autoDetect: true,
    autoApply: false,
    ignoredGames: [],
  };
}

const GAME_SOURCES: GameSource[] = ['steam', 'epic', 'gog', 'folder'];

/** Accepts v1 strings and v2/v3 objects; drops anything invalid or duplicated. */
function normalizedEntries(raw: unknown): GameEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: GameEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let exe: string | null = null;
    let entryPath: string | null = null;
    let title: string | undefined;
    let appid: string | undefined;
    let source: GameSource | undefined;
    let autoApply = false;
    let prompted: boolean | undefined;
    if (typeof item === 'string') {
      exe = validGameName(item);
    } else if (item && typeof item === 'object') {
      const o = item as {
        exe?: unknown;
        path?: unknown;
        title?: unknown;
        appid?: unknown;
        source?: unknown;
        autoApply?: unknown;
        prompted?: unknown;
      };
      if (typeof o.exe === 'string') exe = validGameName(o.exe);
      if (
        exe &&
        typeof o.path === 'string' &&
        /\.exe$/i.test(o.path) &&
        !/[\r\n"]/.test(o.path)
      ) {
        entryPath = o.path;
      }
      if (typeof o.title === 'string') title = cleanTitle(o.title);
      if (typeof o.appid === 'string' && /^\d{1,10}$/.test(o.appid)) appid = o.appid;
      if (typeof o.source === 'string' && GAME_SOURCES.includes(o.source as GameSource)) {
        source = o.source as GameSource;
      }
      autoApply = o.autoApply === true;
      if (o.prompted === false) prompted = false;
      else if (o.prompted === true) prompted = true;
    }
    if (!exe || seen.has(exe)) continue;
    seen.add(exe);
    const entry: GameEntry = { exe, path: entryPath };
    if (title) entry.title = title;
    if (appid) entry.appid = appid;
    if (source) entry.source = source;
    if (autoApply) entry.autoApply = true;
    if (prompted !== undefined) entry.prompted = prompted;
    out.push(entry);
    if (out.length >= MAX_GAMES) break;
  }
  return out;
}

function normalizedIgnored(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const exe = validGameName(item);
    if (!exe || seen.has(exe)) continue;
    seen.add(exe);
    out.push(exe);
    if (out.length >= 128) break;
  }
  return out;
}

export function loadWatcher(paths: EnginePaths): WatcherConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.watcherFile, 'utf8')) as {
      version?: number;
      enabled?: unknown;
      games?: unknown;
      priority?: unknown;
      pollSeconds?: unknown;
      timerResolution?: unknown;
      autoDetect?: unknown;
      autoApply?: unknown;
      ignoredGames?: unknown;
    };
    if (!parsed || (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3)) {
      return defaultWatcherConfig();
    }
    return {
      version: 3,
      enabled: !!parsed.enabled,
      games: normalizedEntries(parsed.games),
      priority: PRIORITY_LEVELS.includes(parsed.priority as PriorityLevel)
        ? (parsed.priority as PriorityLevel)
        : 'high',
      pollSeconds:
        typeof parsed.pollSeconds === 'number' && Number.isFinite(parsed.pollSeconds)
          ? Math.max(4, Math.min(60, Math.round(parsed.pollSeconds)))
          : 8,
      timerResolution: parsed.timerResolution === true,
      // Detection is read-only and makes the first-run experience useful;
      // upgrades from v1/v2 default it on. Existing games are not modified.
      autoDetect: parsed.autoDetect !== false,
      autoApply: parsed.autoApply === true,
      ignoredGames: normalizedIgnored(parsed.ignoredGames),
    };
  } catch {
    return defaultWatcherConfig();
  }
}

export function saveWatcher(paths: EnginePaths, cfg: WatcherConfig): void {
  fs.mkdirSync(paths.userDataDir, { recursive: true });
  const out: WatcherConfig = { ...cfg, version: 3 };
  const tmp = paths.watcherFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  fs.renameSync(tmp, paths.watcherFile);
}

/** Normalizes an executable name; returns null when it is not safe to use.
 *  Spaces are allowed (real exe names use them); path separators and shell
 *  metacharacters are not. */
export function validGameName(name: string): string | null {
  const clean = name.trim().toLowerCase().replace(/\.exe$/, '');
  if (!/^[a-z0-9._ -]{1,64}$/.test(clean)) return null;
  return `${clean}.exe`;
}

/** Entry from a typed exe name (no path known). */
export function entryFromName(name: string): GameEntry | null {
  const exe = validGameName(name);
  return exe ? { exe, path: null } : null;
}

/** Entry from a picked .exe path; keeps the full path for icon extraction. */
export function entryFromPath(filePath: string): GameEntry | null {
  if (!/\.exe$/i.test(filePath) || /[\r\n"]/.test(filePath)) return null;
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const exe = validGameName(base);
  return exe ? { exe, path: filePath } : null;
}

/** Extracts process names from `tasklist /FO CSV /NH` output (lowercase). */
export function parseTasklistCsv(out: string): string[] {
  const names = new Set<string>();
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^"([^"]+)"/);
    if (m) names.add(m[1].toLowerCase());
  }
  return [...names];
}

export function matchRunning(watched: string[], running: string[]): string[] {
  const set = new Set(running.map((r) => r.toLowerCase()));
  return watched.filter((g) => set.has(g.toLowerCase()));
}

const PRIORITY_CLASS: Record<PriorityLevel, string> = {
  normal: 'Normal',
  'above-normal': 'AboveNormal',
  high: 'High',
};

/** PowerShell that sets the priority class of all matching processes.
 *  The name is reduced to characters that are inert inside a single-quoted
 *  string (wildcards like * and ? are stripped so -Name cannot fan out). */
export function boostScript(gameName: string, level: PriorityLevel): string {
  const base = gameName
    .replace(/\.exe$/i, '')
    .replace(/[^a-z0-9._ -]/gi, '')
    .trim();
  const cls = PRIORITY_CLASS[level];
  return `try { Get-Process -Name '${base}' -ErrorAction Stop | ForEach-Object { $_.PriorityClass = '${cls}' }; '{"ok":true}' } catch { '{"ok":false}' }`;
}

export async function pollRunningGames(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const r = await run(EXE.tasklist, ['/FO', 'CSV', '/NH'], 15000);
  if (r.code !== 0) return [];
  return parseTasklistCsv(r.stdout);
}

export async function boostGame(gameName: string, level: PriorityLevel): Promise<boolean> {
  const res = await psJson<{ ok?: boolean }>(boostScript(gameName, level));
  return res?.ok === true;
}
