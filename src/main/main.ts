// Electron main process: owns the unprivileged engine, splits applies into
// user-scope (in-process) and system-scope (elevated helper job) work.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { ensureDirs, makePaths, resolveUserDataDir } from '../engine/paths';
import { Engine, unsupportedReason } from '../engine/engine';
import { getCatalog, getTweak, tweakRequiresElevation, catalogSourceInfo, isRetired, setRemoteCatalog } from '../catalog/catalog';
import { builtinModes } from '../catalog/modes';
import { loadState } from '../engine/state';
import { appendJournal, readJournal } from '../engine/journal';
import {
  addCustomProfile,
  loadProfiles,
  markModeUsed,
  removeCustomProfile,
} from '../engine/profiles';
import {
  boostGame,
  entryFromName,
  entryFromPath,
  GameEntry,
  loadWatcher,
  matchRunning,
  pollRunningGames,
  PRIORITY_LEVELS,
  PriorityLevel,
  saveWatcher,
} from '../engine/watcher';
import { restoreStatus } from '../engine/restore';
import { startTimerBoost, TimerSession, unitsToMs } from '../engine/timer';
import {
  CatalogPayload,
  fetchCatalogEnvelope,
  loadCatalogConfig,
  readCatalogCache,
  TRUSTED_KEYS,
  verifyEnvelope,
  verifyEnvelopeText,
  writeCatalogCache,
} from '../engine/resources';
import { cdnCandidates, libraryCacheCover, steamAppForExe, steamInstallPath } from '../engine/steam';
import { EXE, isElevated, run, windowsBuild } from '../engine/win';
import { createRestorePoint, resolveNodeExe, runElevatedJob } from './elevation';
import { APP_VERSION } from '../engine/paths';
import { BRAND_NAME, BRAND_TAGLINE } from '../shared/brand';
import { ActionResult, Tweak } from '../shared/types';

const paths = makePaths(resolveUserDataDir());
let engine: Engine;
let mainWindow: BrowserWindow | null = null;
let gameWindow: BrowserWindow | null = null;
let exitConfirmed = false;

/** Path to the copied app icon inside the renderer bundle (may be absent before first build). */
function windowIcon(): string | undefined {
  const p = path.join(__dirname, '..', 'renderer', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

function appliedIds(): string[] {
  const state = loadState(paths);
  return Object.entries(state.tweaks)
    .filter(([, s]) => s.status === 'applied')
    .map(([id]) => id);
}

/** Read-only scan of applied tweaks: re-plans every action and reports entries that
 *  no longer match the catalog target. Used by the "Verify applied" action so an
 *  external tool's changes (or a partial Windows reset) are visible before reverting. */
async function verifyAppliedTweaks(): Promise<{
  ok: boolean;
  checkedAt: number;
  applied: number;
  drifted: Array<{ id: string; name: string; changes: string[] }>;
}> {
  const applied = appliedIds().filter((id) => !isRetired(id));
  const drifted: Array<{ id: string; name: string; changes: string[] }> = [];
  for (const id of applied) {
    try {
      const plan = await engine.plan(id);
      const changes = plan.entries
        .filter((e) => e.current !== '(requires administrator to read)' && e.changed)
        .map((e) => `${e.description}: ${e.current} → ${e.target}`);
      if (changes.length > 0) drifted.push({ id, name: getTweak(id)?.name ?? id, changes });
    } catch {
      // One unreadable tweak must not abort the whole scan.
    }
  }
  appendJournal(paths, {
    ts: Date.now(),
    op: 'system',
    level: drifted.length > 0 ? 'warn' : 'info',
    tweakId: 'verify-applied',
    message:
      drifted.length > 0
        ? `verified ${applied.length} applied tweak(s) — ${drifted.length} changed outside Frameblade`
        : `verified ${applied.length} applied tweak(s) — all match their target values`,
  });
  return { ok: true, checkedAt: Date.now(), applied: applied.length, drifted };
}

/* ------------------------------------------------------------ Game Mode */

let watcherTimer: NodeJS.Timeout | null = null;
const activeGames = new Set<string>();
let timerSession: TimerSession | null = null;
let timerStarting = false;
let timerWarned = false;

function watcherStatus() {
  const cfg = loadWatcher(paths);
  return {
    enabled: cfg.enabled,
    games: cfg.games,
    priority: cfg.priority,
    pollSeconds: cfg.pollSeconds,
    active: [...activeGames],
    timer: {
      enabled: cfg.timerResolution,
      active: timerSession?.active === true,
      ready: appliedIds().includes('timer-resolution'),
      units: timerSession?.currentUnits ?? null,
    },
  };
}

function watcherNotify(): void {
  const status = watcherStatus();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('watcher:update', status);
  }
}

/** Releases the session timer request (the helper process exit drops it in the OS). */
function stopTimerBoost(reason: string): void {
  const session = timerSession;
  if (!session) return;
  timerSession = null;
  session.stop();
  appendJournal(paths, {
    ts: Date.now(),
    op: 'system',
    level: 'info',
    tweakId: 'game-mode',
    message: `${reason} — ${unitsToMs(session.currentUnits)} ms timer request released`,
  });
  watcherNotify();
}

/** Starts the helper once per session, after verifying the catalog gate is applied.
 *  The helper itself re-reads GlobalTimerResolutionRequests and fails closed if the
 *  tweak has not survived (or the machine has not rebooted yet). */
async function ensureTimerBoost(cfg: ReturnType<typeof loadWatcher>): Promise<void> {
  if (!cfg.timerResolution || timerSession || timerStarting) return;
  if (activeGames.size === 0) return;
  if (!appliedIds().includes('timer-resolution')) return;
  timerStarting = true;
  try {
    const res = await startTimerBoost({ parentPid: process.pid });
    if (!res.ok) {
      if (!timerWarned) {
        timerWarned = true;
        appendJournal(paths, {
          ts: Date.now(),
          op: 'system',
          level: 'warn',
          tweakId: 'game-mode',
          code: 'OPT002',
          message: `timer resolution helper: ${res.error}`,
        });
      }
      return;
    }
    // The game may have exited (or the option been turned off) while PowerShell compiled.
    if (activeGames.size === 0 || !loadWatcher(paths).timerResolution) {
      res.session.stop();
      return;
    }
    timerSession = res.session;
    timerWarned = false;
    appendJournal(paths, {
      ts: Date.now(),
      op: 'system',
      level: 'info',
      tweakId: 'game-mode',
      message: `timer request held at ${unitsToMs(res.session.currentUnits)} ms — session-only`,
    });
  } finally {
    timerStarting = false;
    watcherNotify();
  }
}

async function watcherTick(): Promise<void> {
  const cfg = loadWatcher(paths);
  if (!cfg.enabled || cfg.games.length === 0) {
    stopTimerBoost('Game Mode off');
    return;
  }
  if (!cfg.timerResolution) stopTimerBoost('timer option off');

  const running = await pollRunningGames();
  const matches = matchRunning(cfg.games.map((g) => g.exe), running);

  for (const game of matches) {
    if (activeGames.has(game)) continue;
    activeGames.add(game);
    const ok = await boostGame(game, cfg.priority);
    appendJournal(paths, {
      ts: Date.now(),
      op: 'system',
      level: ok ? 'info' : 'warn',
      tweakId: 'game-mode',
      code: ok ? undefined : 'OPT002',
      message: ok
        ? `detected ${game} — priority set to ${cfg.priority} (session-only)`
        : `detected ${game} — priority boost failed`,
    });
    watcherNotify();
  }

  for (const game of [...activeGames]) {
    if (matches.includes(game)) continue;
    activeGames.delete(game);
    appendJournal(paths, {
      ts: Date.now(),
      op: 'system',
      level: 'info',
      tweakId: 'game-mode',
      message: `${game} exited — session boost ended`,
    });
    watcherNotify();
  }

  if (activeGames.size === 0) {
    stopTimerBoost('last game exited');
    return;
  }
  void ensureTimerBoost(cfg);
}

function applyWatcherState(): void {
  const cfg = loadWatcher(paths);
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
  if (!cfg.enabled) {
    activeGames.clear();
    stopTimerBoost('Game Mode off');
    watcherNotify();
    return;
  }
  if (!cfg.timerResolution) stopTimerBoost('timer option off');
  const ms = Math.max(4, Math.min(60, cfg.pollSeconds)) * 1000;
  watcherTimer = setInterval(() => {
    void watcherTick();
  }, ms);
  void watcherTick();
}

function updateWatcher(patch: unknown): { ok: boolean; error?: string; status: ReturnType<typeof watcherStatus> } {
  const cfg = loadWatcher(paths);
  if (patch && typeof patch === 'object') {
    const p = patch as { enabled?: unknown; priority?: unknown; pollSeconds?: unknown; timerResolution?: unknown };
    if (typeof p.enabled === 'boolean') cfg.enabled = p.enabled;
    if (typeof p.priority === 'string' && PRIORITY_LEVELS.includes(p.priority as PriorityLevel)) {
      cfg.priority = p.priority as PriorityLevel;
    }
    if (typeof p.pollSeconds === 'number' && Number.isFinite(p.pollSeconds)) {
      cfg.pollSeconds = Math.max(4, Math.min(60, Math.round(p.pollSeconds)));
    }
    if (typeof p.timerResolution === 'boolean') cfg.timerResolution = p.timerResolution;
  }
  saveWatcher(paths, cfg);
  applyWatcherState();
  watcherNotify();
  return { ok: true, status: watcherStatus() };
}

/* ------------------------------------------------- remote resources */

const resourcesDir = path.join(paths.userDataDir, 'resources');

interface CatalogCheck {
  at: string;
  ok: boolean;
  code?: string;
  message?: string;
}

let catalogLastCheck: CatalogCheck | null = null;
let catalogCachedAt: string | null = null;

function resourcesStatus() {
  const cfg = loadCatalogConfig(resourcesDir);
  const info = catalogSourceInfo();
  return {
    ...info,
    endpoint: cfg.endpoint,
    endpointSource: cfg.source,
    cachedAt: catalogCachedAt,
    lastCheck: catalogLastCheck,
    retiredApplied: appliedIds().filter((id) => isRetired(id)),
    trustedKeyIds: Object.keys(TRUSTED_KEYS),
  };
}

function catalogJournal(
  level: 'info' | 'warn' | 'error',
  message: string,
  code?: string
): void {
  appendJournal(paths, {
    ts: Date.now(),
    op: 'system',
    tweakId: 'resource-catalog',
    level,
    code,
    message,
  });
}

function catalogNotify(payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('catalog:update', payload);
  }
}

function activateCatalog(payload: CatalogPayload, loadedAt: string): void {
  setRemoteCatalog(payload.tweaks, payload.catalogVersion, loadedAt);
  catalogCachedAt = loadedAt;
}

/** Offline-first: a verified cached catalog is loaded before the window opens. */
function initCatalogFromCache(): void {
  const cached = readCatalogCache(resourcesDir);
  if (!cached) return;
  if (!cached.ok) {
    catalogLastCheck = {
      at: new Date().toISOString(),
      ok: false,
      code: cached.code,
      message: cached.message,
    };
    catalogJournal('warn', `cached catalog ignored: ${cached.message}`, cached.code);
    return;
  }
  const verified = verifyEnvelope(cached.value.envelope);
  if (!verified.ok) {
    catalogLastCheck = {
      at: new Date().toISOString(),
      ok: false,
      code: verified.code,
      message: verified.message,
    };
    catalogJournal('warn', `cached catalog rejected: ${verified.message}`, verified.code);
    return;
  }
  activateCatalog(verified.value.payload, cached.value.fetchedAt);
  catalogJournal(
    'info',
    `remote catalog v${verified.value.payload.catalogVersion} loaded from cache ` +
      `(${verified.value.payload.tweaks.length} optimizations)`
  );
}

export interface CatalogCheckResult {
  ok: boolean;
  status: 'updated' | 'up-to-date' | 'failed';
  version?: number;
  tweaks?: number;
  notes?: string;
  reverted?: string[];
  failedReverts?: { id: string; code?: string; message?: string }[];
  code?: string;
  message?: string;
}

async function checkCatalog(): Promise<CatalogCheckResult> {
  const cfg = loadCatalogConfig(resourcesDir);
  const fetched = await fetchCatalogEnvelope(cfg.endpoint);
  if (!fetched.ok) {
    catalogLastCheck = {
      at: new Date().toISOString(),
      ok: false,
      code: fetched.code,
      message: fetched.message,
    };
    catalogJournal('error', `catalog check failed: ${fetched.message}`, fetched.code);
    return { ok: false, status: 'failed', code: fetched.code, message: fetched.message };
  }

  const verified = verifyEnvelopeText(fetched.value.text);
  if (!verified.ok) {
    catalogLastCheck = {
      at: new Date().toISOString(),
      ok: false,
      code: verified.code,
      message: verified.message,
    };
    catalogJournal('error', `catalog check failed: ${verified.message}`, verified.code);
    return { ok: false, status: 'failed', code: verified.code, message: verified.message };
  }

  const payload = verified.value.payload;
  const current = catalogSourceInfo().remoteVersion ?? 0;
  let status: 'updated' | 'up-to-date' = 'up-to-date';

  if (payload.catalogVersion > current) {
    const saved = writeCatalogCache(resourcesDir, cfg.endpoint, verified.value.envelope);
    if (!saved.ok) {
      catalogLastCheck = {
        at: new Date().toISOString(),
        ok: false,
        code: saved.code,
        message: saved.message,
      };
      catalogJournal('error', `catalog save failed: ${saved.message}`, saved.code);
      return { ok: false, status: 'failed', code: saved.code, message: saved.message };
    }
    activateCatalog(payload, saved.value.fetchedAt);
    status = 'updated';
    catalogJournal(
      'info',
      `remote catalog v${payload.catalogVersion} activated ` +
        `(${payload.tweaks.length} optimizations)`
    );
  }

  // Remote kill-switch: tweaks retired by the catalog are reverted when the
  // user explicitly checks for updates (never silently at startup).
  const retiredApplied = appliedIds().filter((id) => isRetired(id));
  const reverted: string[] = [];
  const failedReverts: { id: string; code?: string; message?: string }[] = [];
  if (retiredApplied.length > 0) {
    const res = await revertMany(retiredApplied);
    for (const r of res.results ?? []) {
      if (r.status === 'reverted' || r.status === 'up-to-date') reverted.push(r.tweakId);
      else failedReverts.push({ id: r.tweakId, code: r.errorCode, message: r.errorMessage });
    }
    catalogJournal(
      failedReverts.length > 0 ? 'error' : 'warn',
      `catalog retired ${retiredApplied.length} applied optimization(s); ` +
        `reverted ${reverted.length}` +
        (failedReverts.length > 0 ? `, failed ${failedReverts.length}` : ''),
      failedReverts.length > 0 ? 'UTIL006' : undefined
    );
  }

  catalogLastCheck = { at: new Date().toISOString(), ok: true };
  const result: CatalogCheckResult = {
    ok: true,
    status,
    version: payload.catalogVersion,
    tweaks: payload.tweaks.length,
    notes: payload.notes,
    reverted,
    failedReverts,
  };
  catalogNotify({ status: resourcesStatus(), result });
  return result;
}

/* --------------------------------------------------------- game library */

/** Single-quote a string for PowerShell (literal, quotes escaped). */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** MIME type for a cached image file. */
function imageMime(file: string): string | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return null;
}

const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** Reads an image file as a data URL (null when missing, huge or not an image). */
function fileDataUrl(file: string): string | null {
  try {
    const mime = imageMime(file);
    if (!mime) return null;
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0 || st.size > MAX_ASSET_BYTES) return null;
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

/** Where downloaded/picked cover art for the library is cached. */
function coversDir(): string {
  return path.join(paths.thumbsDir, 'covers');
}

/** Cached cover for a game: user-picked (`*.custom.*`) beats automatic (`*.auto.*`). */
function cachedCover(exe: string): string | null {
  let files: string[];
  try {
    files = fs.readdirSync(coversDir());
  } catch {
    return null;
  }
  const pick = (kind: string) => files.find((f) => f.startsWith(`${exe}.${kind}.`) && imageMime(f));
  const name = pick('custom') ?? pick('auto');
  return name ? fileDataUrl(path.join(coversDir(), name)) : null;
}

/** Downloads an image URL to destFile (follows redirects, 8 s timeout). */
function downloadImage(url: string, destFile: string, redirects = 3): Promise<boolean> {
  return new Promise((resolve) => {
    if (redirects < 0) {
      resolve(false);
      return;
    }
    const req = https.get(
      url,
      { timeout: 8000, headers: { 'User-Agent': 'Frameblade/0.1', Accept: 'image/*' } },
      (res) => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          void downloadImage(new URL(res.headers.location, url).toString(), destFile, redirects - 1).then(
            resolve
          );
          return;
        }
        const type = String(res.headers['content-type'] ?? '');
        if (code !== 200 || !type.startsWith('image/')) {
          res.resume();
          resolve(false);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_ASSET_BYTES) {
            res.destroy();
            resolve(false);
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            fs.writeFileSync(destFile, Buffer.concat(chunks));
            resolve(true);
          } catch {
            resolve(false);
          }
        });
        res.on('error', () => resolve(false));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

/**
 * Ensures a cached PNG thumbnail for the entry and returns it as a data URL.
 * The icon comes from the .exe itself (System.Drawing); typed-in names without
 * a path get no thumbnail and the window shows its default letter tile.
 */
async function ensureThumb(entry: GameEntry): Promise<string | null> {
  const file = path.join(paths.thumbsDir, `${entry.exe}.png`);
  try {
    if (!fs.existsSync(file)) {
      if (!entry.path || !fs.existsSync(entry.path)) return null;
      const script = [
        'Add-Type -AssemblyName System.Drawing',
        '$ErrorActionPreference = "Stop"',
        `$icon = [System.Drawing.Icon]::ExtractAssociatedIcon(${psQuote(entry.path)})`,
        'if ($icon -eq $null) { exit 3 }',
        '$bmp = New-Object System.Drawing.Bitmap -ArgumentList @($icon.ToBitmap(), 64, 64)',
        `$bmp.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
      ].join('; ');
      const r = await run(
        EXE.powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        20000
      );
      if (r.code !== 0 || !fs.existsSync(file)) return null;
    }
    return fileDataUrl(file);
  } catch {
    return null;
  }
}

/**
 * Full-art banner for a library tile: user-picked image, else Steam's local
 * library cache, else the Steam CDN (only for entries with a known appid).
 * Returns null when the tile should use the generated fallback art.
 */
async function ensureCover(entry: GameEntry): Promise<string | null> {
  try {
    const cached = cachedCover(entry.exe);
    if (cached) return cached;

    if (!entry.appid) return null;
    const dir = coversDir();
    fs.mkdirSync(dir, { recursive: true });

    const steamPath = await steamInstallPath();
    if (steamPath) {
      const local = libraryCacheCover(steamPath, entry.appid);
      if (local) {
        const dest = path.join(dir, `${entry.exe}.auto${path.extname(local).toLowerCase() || '.jpg'}`);
        try {
          fs.copyFileSync(local, dest);
        } catch {
          /* fall back to reading the cache file directly below */
        }
        return fileDataUrl(fs.existsSync(dest) ? dest : local);
      }
    }

    const dest = path.join(dir, `${entry.exe}.auto.jpg`);
    for (const url of cdnCandidates(entry.appid)) {
      if (await downloadImage(url, dest)) {
        const data = fileDataUrl(dest);
        if (data) return data;
      }
      try {
        fs.rmSync(dest, { force: true });
      } catch {
        /* cache only */
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Fills in the display title and Steam appid when the exe is a Steam install. */
function enrichEntry(entry: GameEntry): GameEntry {
  if (!entry.path) return entry;
  try {
    const app = steamAppForExe(entry.path);
    if (app) {
      const next: GameEntry = { ...entry, appid: app.appid };
      if (!entry.title) next.title = app.name;
      return next;
    }
  } catch {
    /* not a Steam install */
  }
  return entry;
}

async function addGame(payload: unknown): Promise<{
  ok: boolean;
  error?: string;
  entry?: GameEntry;
  assets?: { icon: string | null; cover: string | null };
  status: ReturnType<typeof watcherStatus>;
}> {
  const p = (payload ?? {}) as { path?: unknown; name?: unknown };
  let entry: GameEntry | null = null;
  if (typeof p.path === 'string' && p.path) entry = entryFromPath(p.path);
  else if (typeof p.name === 'string' && p.name.trim()) entry = entryFromName(p.name);

  if (entry) entry = enrichEntry(entry);

  if (!entry) {
    return {
      ok: false,
      error: 'That is not a valid .exe name or path — pick the game’s executable with Browse.',
      status: watcherStatus(),
    };
  }

  const cfg = loadWatcher(paths);
  if (cfg.games.some((g) => g.exe === entry.exe)) {
    return { ok: false, error: `${entry.exe} is already in the game library.`, status: watcherStatus() };
  }

  cfg.games = [...cfg.games, entry].slice(0, 32);
  saveWatcher(paths, cfg);
  applyWatcherState();
  watcherNotify();
  const assets = { icon: await ensureThumb(entry), cover: await ensureCover(entry) };
  return { ok: true, entry, assets, status: watcherStatus() };
}

function removeGame(exe: string): { ok: boolean; status: ReturnType<typeof watcherStatus> } {
  const clean = exe.toLowerCase();
  const cfg = loadWatcher(paths);
  cfg.games = cfg.games.filter((g) => g.exe !== clean);
  saveWatcher(paths, cfg);
  // drop cached art for this game (icons + covers)
  try {
    fs.rmSync(path.join(paths.thumbsDir, `${clean}.png`), { force: true });
    for (const f of fs.readdirSync(coversDir())) {
      if (f.startsWith(`${clean}.`)) fs.rmSync(path.join(coversDir(), f), { force: true });
    }
  } catch {
    /* cache only */
  }
  applyWatcherState();
  watcherNotify();
  return { ok: true, status: watcherStatus() };
}

/** Icons + cover art for every library entry, keyed by exe. */
async function assetsForGames(): Promise<Record<string, { icon: string | null; cover: string | null }>> {
  const cfg = loadWatcher(paths);
  const out: Record<string, { icon: string | null; cover: string | null }> = {};
  for (const g of cfg.games) {
    out[g.exe] = { icon: await ensureThumb(g), cover: await ensureCover(g) };
  }
  return out;
}

/** Copies a user-picked image into the cover cache. Returns a data URL. */
function setCustomCover(exe: string, src: string): { ok: boolean; cover?: string | null; error?: string } {
  try {
    const st = fs.statSync(src);
    if (!st.isFile() || st.size > MAX_ASSET_BYTES) {
      return { ok: false, error: 'That image file is too large (max 8 MB).' };
    }
    const ext = path.extname(src).toLowerCase() === '.jpeg' ? '.jpg' : path.extname(src).toLowerCase();
    if (!imageMime(`x${ext}`)) {
      return { ok: false, error: 'Unsupported image type — use PNG, JPG, WEBP or GIF.' };
    }
    const dir = coversDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${exe}.custom.`)) fs.rmSync(path.join(dir, f), { force: true });
    }
    const dest = path.join(dir, `${exe}.custom${ext}`);
    fs.copyFileSync(src, dest);
    return { ok: true, cover: fileDataUrl(dest) };
  } catch (err) {
    return { ok: false, error: `Could not read that image: ${(err as Error).message}` };
  }
}

function listView() {
  const state = loadState(paths);
  return getCatalog().map((t) => ({
    ...t,
    requiresElevation: tweakRequiresElevation(t),
    unsupportedReason: unsupportedReason(t),
    state: state.tweaks[t.id] ?? null,
  }));
}

function partition(ids: string[]): { user: Tweak[]; system: Tweak[] } {
  const user: Tweak[] = [];
  const system: Tweak[] = [];
  for (const id of ids) {
    const t = getTweak(id);
    if (!t) continue;
    (tweakRequiresElevation(t) ? system : user).push(t);
  }
  return { user, system };
}

function failed(tweakId: string, code: string, message: string): ActionResult {
  return { tweakId, status: 'failed', errorCode: code, errorMessage: message, steps: [] };
}

async function applyMany(ids: string[]): Promise<{ results: ActionResult[] }> {
  const { user, system } = partition(ids);
  const results: ActionResult[] = [];
  for (const t of user) results.push(await engine.apply(t.id));

  if (system.length > 0) {
    const job = await runElevatedJob({ op: 'apply', tweakIds: system.map((t) => t.id), paths });
    if (job.results && job.results.length > 0) {
      results.push(...job.results);
    } else {
      const code = job.code ?? 'ELEVATION_CANCELLED';
      const msg = job.error ?? 'The privileged helper reported no results.';
      results.push(...system.map((t) => failed(t.id, code, msg)));
    }
  }
  return { results };
}

async function revertMany(ids: string[]): Promise<{ results: ActionResult[] }> {
  const { user, system } = partition(ids);
  const results: ActionResult[] = [];
  for (const t of user) results.push(await engine.revert(t.id));

  if (system.length > 0) {
    const job = await runElevatedJob({ op: 'revert', tweakIds: system.map((t) => t.id), paths });
    if (job.results && job.results.length > 0) {
      results.push(...job.results);
    } else {
      const code = job.code ?? 'ELEVATION_CANCELLED';
      const msg = job.error ?? 'The privileged helper reported no results.';
      results.push(...system.map((t) => failed(t.id, code, msg)));
    }
  }
  return { results };
}

function scheduleClose(delayMs: number): void {
  exitConfirmed = true;
  setTimeout(() => mainWindow?.close(), delayMs);
}

/** Quit flow: optionally restore previous settings (and reboot) before closing. */
async function handleExit(action: string): Promise<{ ok: boolean; results?: ActionResult[] }> {
  if (action === 'cancel') return { ok: true };

  if (action === 'keep') {
    scheduleClose(0);
    return { ok: true };
  }

  const ids = appliedIds();
  let results: ActionResult[] = [];
  if (ids.length > 0) {
    const res = await revertMany(ids);
    results = res.results ?? [];
    if (results.some((r) => r.status === 'failed')) return { ok: false, results };
  }

  if (action === 'revert-reboot') {
    await run(
      EXE.shutdown,
      [
        '/r',
        '/t',
        '25',
        '/c',
        'Frameblade restored your previous settings. Restarting in 25 seconds - run shutdown /a to cancel.',
      ],
      10000
    );
  }
  scheduleClose(0);
  return { ok: true, results };
}

function registerIpc(): void {
  ipcMain.handle('app:info', async () => {
    const state = loadState(paths);
    const catalog = catalogSourceInfo();
    return {
      appVersion: APP_VERSION,
      catalogVersion: catalog.version,
      catalogSource: catalog.source,
      windowsBuild: windowsBuild(),
      processElevated: await isElevated(),
      nodeExe: resolveNodeExe(),
      userDataDir: paths.userDataDir,
      brandName: BRAND_NAME,
      tagline: BRAND_TAGLINE,
      appliedCount: Object.values(state.tweaks).filter((s) => s.status === 'applied').length,
      catalogSize: getCatalog().length,
    };
  });

  ipcMain.handle('tweaks:list', () => listView());
  ipcMain.handle('state:get', () => loadState(paths));
  ipcMain.handle('tweaks:plan', (_e, id: string) => engine.plan(id));
  ipcMain.handle('tweaks:verify', () => verifyAppliedTweaks());
  ipcMain.handle('tweaks:apply', (_e, ids: string[]) => applyMany(ids));
  ipcMain.handle('tweaks:revert', (_e, ids: string[]) => revertMany(ids));
  ipcMain.handle('journal:list', () => readJournal(paths, 250).reverse());
  ipcMain.handle('restore:create', () => createRestorePoint(paths));
  ipcMain.handle('data:open', async () => {
    await shell.openPath(paths.userDataDir);
    return paths.userDataDir;
  });

  ipcMain.handle('profiles:list', () => {
    const data = loadProfiles(paths);
    return {
      builtins: builtinModes(),
      custom: data.custom,
      lastMode: data.lastMode,
      lastModeAt: data.lastModeAt,
    };
  });
  ipcMain.handle('profiles:save', (_e, name: string) =>
    addCustomProfile(paths, String(name ?? ''), appliedIds())
  );
  ipcMain.handle('profiles:delete', (_e, id: string) => ({
    removed: removeCustomProfile(paths, String(id ?? '')),
  }));
  ipcMain.handle('modes:mark', (_e, modeId: string) => {
    markModeUsed(paths, String(modeId ?? ''));
    return { ok: true };
  });
  ipcMain.handle('restore:status', () => restoreStatus());
  ipcMain.handle('resources:status', () => resourcesStatus());
  ipcMain.handle('resources:check', () => checkCatalog());
  ipcMain.handle('watcher:get', () => watcherStatus());
  ipcMain.handle('watcher:update', (_e, patch: unknown) => updateWatcher(patch));
  ipcMain.handle('games:add', (_e, payload: unknown) => addGame(payload));
  ipcMain.handle('games:remove', (_e, exe: string) => removeGame(String(exe ?? '')));
  ipcMain.handle('games:assets', () => assetsForGames());
  ipcMain.handle('games:reveal', (_e, exe: unknown) => {
    const clean = String(exe ?? '').toLowerCase();
    const entry = loadWatcher(paths).games.find((g) => g.exe === clean);
    if (!entry) return { ok: false, error: 'That game is not in the library anymore.' };
    if (entry.path && fs.existsSync(entry.path)) {
      shell.showItemInFolder(entry.path);
      return { ok: true };
    }
    return {
      ok: false,
      error: entry.path
        ? 'The executable could not be found — it may have been moved or uninstalled.'
        : 'No file path stored for this game (it was added by name) — use “Add game” to pick its exe.',
    };
  });
  ipcMain.handle('games:pickCover', async (e, exe: unknown) => {
    const clean = String(exe ?? '').toLowerCase();
    const entry = loadWatcher(paths).games.find((g) => g.exe === clean);
    if (!entry) return { ok: false, error: 'That game is not in the library anymore.' };

    const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts = {
      title: `Cover image for ${clean}`,
      properties: ['openFile'] as const,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    };
    const r = parent
      ? await dialog.showOpenDialog(parent, { ...opts, properties: [...opts.properties] })
      : await dialog.showOpenDialog({ ...opts, properties: [...opts.properties] });
    const src = r.filePaths[0];
    if (r.canceled || !src) return { ok: false, canceled: true };
    return setCustomCover(clean, src);
  });
  ipcMain.handle('games:browse', async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts = {
      title: 'Add a game executable',
      properties: ['openFile'] as const,
      filters: [{ name: 'Programs', extensions: ['exe'] }],
    };
    const r = parent
      ? await dialog.showOpenDialog(parent, { ...opts, properties: [...opts.properties] })
      : await dialog.showOpenDialog({ ...opts, properties: [...opts.properties] });
    return { canceled: r.canceled, path: r.filePaths[0] ?? null };
  });
  ipcMain.handle('game:open', () => openGameWindow());
  ipcMain.handle('app:exit', (_e, action: string) => handleExit(String(action ?? '')));
}

/** Game Mode lives in its own window: flash sign, game library, priority. */
function openGameWindow(): { ok: boolean } {
  if (gameWindow && !gameWindow.isDestroyed()) {
    gameWindow.show();
    gameWindow.focus();
    return { ok: true };
  }
  const icon = windowIcon();
  const win = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 640,
    minHeight: 560,
    backgroundColor: '#06070d',
    title: `${BRAND_NAME} — Game Mode`,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  gameWindow = win;
  win.on('closed', () => {
    gameWindow = null;
  });
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'game.html'));
  return { ok: true };
}

function createWindow(): void {
  const icon = windowIcon();
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#06070d',
    title: BRAND_NAME,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;

  win.on('close', (e) => {
    if (exitConfirmed) return;
    const applied = appliedIds().length;
    if (applied === 0) return;
    e.preventDefault();
    win.webContents.send('app:exit-request', { appliedCount: applied });
  });
  win.on('closed', () => {
    mainWindow = null;
  });

  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.on('before-quit', () => {
  stopTimerBoost('app exit');
});

process.on('exit', () => {
  try {
    timerSession?.stop();
  } catch {
    /* best effort on a dying process */
  }
});

void app.whenReady().then(() => {
  ensureDirs(paths);
  engine = new Engine(paths, false);
  initCatalogFromCache(); // offline-first: verified cache before first paint
  Menu.setApplicationMenu(null); // custom UI: no File/Edit/View/Window menu bar
  registerIpc();
  createWindow();
  applyWatcherState();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
