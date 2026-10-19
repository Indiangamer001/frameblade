// Game Mode window: flash sign, tile-grid game library with cover art, and the
// session watcher controls. Talks to the main process through the shared
// preload bridge (window.pctune); falls back to a demo API when opened from the
// design-preview server.

const api = window.pctune ?? demoApi();
let WATCHER = {
  enabled: false,
  games: [],
  priority: 'high',
  pollSeconds: 8,
  active: [],
  timer: { enabled: false, active: false, ready: false, units: null },
  autoDetect: true,
  autoApply: false,
  maxGames: 64,
  pendingAutoApply: [],
  safeTweaks: [],
  autoApplied: [],
  autoApplyActive: false,
  autoApplyError: null,
  scanning: false,
};
let ASSETS = {}; // exe -> { icon: dataURL|null, cover: dataURL|null }
let PROFILE = null; // exe shown in the profile panel
let DETECT_OPEN = false; // one-time auto-apply prompt

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(message, kind = 'info', ms = 5200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function displayName(entry) {
  return entry.title?.trim() || entry.exe.replace(/\.exe$/i, '');
}

function initials(name) {
  const words = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/* ------------------------------------------------------------------ data */

async function refresh() {
  try {
    const [watcher, assets] = await Promise.all([api.watcherGet(), api.gamesAssets()]);
    if (watcher) WATCHER = watcher;
    if (assets) ASSETS = assets;
  } catch (err) {
    toast(`Could not load the game library: ${err.message ?? err}`, 'err');
  }
  render();
}

/** Reloads icons/covers after a scan adds entries. */
async function loadAssets() {
  try {
    const assets = await api.gamesAssets();
    if (assets) ASSETS = assets;
  } catch {
    /* tiles fall back to initials */
  }
  render();
}

async function watcherUpdate(patch) {
  try {
    const res = await api.watcherUpdate(patch);
    if (res && res.status) WATCHER = res.status;
    if (res && res.ok === false && res.error) toast(res.error, 'warn', 8000);
  } catch (err) {
    toast(`Game Mode: ${err.message ?? err}`, 'err');
  }
  render();
}

/* ---------------------------------------------------------------- render */

function artHtml(entry, big = false) {
  const a = ASSETS[entry.exe] ?? {};
  if (a.cover) return `<img class="tile-cover" src="${a.cover}" alt="" />`;
  const icon = a.icon ? `<img class="tile-icon${big ? ' big' : ''}" src="${a.icon}" alt="" />` : '';
  return `<div class="tile-fallback" style="--h:${hashHue(entry.exe)}">
      <span class="tile-initials">${esc(initials(displayName(entry)))}</span>${icon}
    </div>`;
}

function tileHtml(entry) {
  const running = (WATCHER.active ?? []).includes(entry.exe);
  const badge = running ? '<span class="tile-badge">Running</span>' : '';
  const auto = entry.autoApply
    ? `<span class="tile-auto" title="Session-safe auto-apply is enabled for this game">${WATCHER.autoApply ? 'Auto' : 'Auto off'}</span>`
    : '';
  return `<article class="gtile" data-exe="${esc(entry.exe)}">
    <div class="tile-art">${artHtml(entry)}${auto}${badge}</div>
    <div class="tile-name" title="${esc(entry.path ?? entry.exe)}">${esc(displayName(entry))}</div>
    <button class="tile-link" data-g-profile="${esc(entry.exe)}">Open profile →</button>
  </article>`;
}

function render() {
  const on = !!WATCHER.enabled;
  const games = WATCHER.games ?? [];
  const active = WATCHER.active ?? [];
  const timer = WATCHER.timer ?? {};
  const auto = !!WATCHER.autoApply;
  const autoGames = games.filter((g) => g.autoApply);
  const pending = (WATCHER.pendingAutoApply ?? []).filter((g) => games.some((x) => x.exe === g.exe));

  $('g-toggle').checked = on;
  $('g-sub').textContent = on
    ? `watching ${games.length} game(s) · ${WATCHER.priority} priority${timer.active ? ' · 0.5 ms timer' : ''}${auto && autoGames.length ? ` · auto ${autoGames.length}` : ''}`
    : 'off — turn on to boost your games';
  $('g-flash').classList.toggle('active', on && active.length > 0);

  const runningEntry = games.find((g) => active.includes(g.exe));
  if (pending.length > 0) {
    $('g-library-sub').textContent = `${pending.length} new game(s) detected — choose whether to enable session-safe auto-apply.`;
  } else if (runningEntry) {
    const applied = (WATCHER.autoApplied ?? []).length;
    $('g-library-sub').textContent =
      `${displayName(runningEntry)} is running — priority boosted to ${WATCHER.priority}` +
      (applied > 0 ? ` · ${applied} session-safe setting(s) active.` : '.');
  } else {
    $('g-library-sub').textContent = on
      ? 'No recognized game running. Select a game tile or add its EXE.'
      : 'Game Mode is off — flip the switch to boost your games.';
  }

  $('g-timer').checked = !!timer.enabled;
  const timerNote = $('g-timer-note');
  if (!timer.ready) {
    timerNote.textContent =
      'Requires the Timer Resolution Support (Win11+) optimization in the main window: apply it, reboot, then enable this.';
  } else if (timer.active) {
    const ms = typeof timer.units === 'number' ? (timer.units / 10000).toFixed(2) : '0.5';
    timerNote.textContent = `Active — a ${ms} ms timer request is held for this session.`;
  } else {
    timerNote.textContent = 'Starts with the next detected game and is released when the last game exits.';
  }

  $('g-autodetect').checked = WATCHER.autoDetect !== false;
  $('g-auto').checked = auto;
  $('g-auto-count').textContent = auto && autoGames.length ? `${autoGames.length}` : '';
  const safeNames = (WATCHER.safeTweaks ?? []).map((t) => t.name).filter(Boolean).join(' · ');
  const autoPill = $('g-auto').closest('.auto-pill');
  if (autoPill) {
    autoPill.title = auto
      ? `Applies ${safeNames || 'the session-safe subset'} only while an opted-in game runs. No UAC; system and reboot-required tweaks stay manual.`
      : 'Off — no automatic setting changes. Turn on to use only session-safe (user-scope, no-reboot) tweaks for opted-in games.';
  }
  if (WATCHER.autoApplyError && !$('g-library-sub').textContent.includes('Auto-apply issue')) {
    $('g-library-sub').textContent += ` Auto-apply issue: ${WATCHER.autoApplyError}`;
  }

  $('g-games-count').textContent = games.length ? `${games.length}/${WATCHER.maxGames ?? 64}` : '';
  $('g-scan').disabled = !!WATCHER.scanning;
  $('g-scan').textContent = WATCHER.scanning ? 'Scanning…' : 'Scan games';
  $('g-games').innerHTML = games.length
    ? games.map(tileHtml).join('')
    : `<button class="gtile tile-empty" id="g-empty-add">
         <span class="plus">＋</span>
         <span>Add your first game</span>
       </button>`;

  $('g-priority').value = WATCHER.priority ?? 'high';
  $('g-poll').textContent = `· checked every ${WATCHER.pollSeconds ?? 8}s`;

  if (PROFILE) {
    if (games.some((g) => g.exe === PROFILE)) renderProfile();
    else closeProfile();
  }

  maybeShowDetectionPrompt(pending);
}

/* --------------------------------------------------------------- profile */

function renderProfile() {
  const entry = (WATCHER.games ?? []).find((g) => g.exe === PROFILE);
  if (!entry) return;
  const running = (WATCHER.active ?? []).includes(entry.exe);
  $('gp-art').innerHTML = artHtml(entry, true);
  $('gp-name').textContent = displayName(entry);
  $('gp-exe').textContent = entry.exe;
  $('gp-path').textContent = entry.path ?? 'No file path stored (added by name)';
  $('gp-status').textContent = running
    ? `Running — priority boosted to ${WATCHER.priority} (session-only).`
    : WATCHER.enabled
      ? `Not running — will be boosted to ${WATCHER.priority} when it starts.`
      : 'Game Mode is off — nothing will be boosted.';
  $('gp-auto').checked = entry.autoApply === true;
  $('gp-auto-note').textContent = entry.autoApply
    ? WATCHER.autoApply
      ? 'Session-safe auto-apply is on for this game. Values are reverted when the last opted-in game exits.'
      : 'This game is opted in, but the master auto-apply switch is off.'
    : 'Off. Enable to apply only user-scope, no-reboot optimizations while this game runs.';
}

function openProfile(exe) {
  PROFILE = exe;
  $('g-profile').classList.remove('hidden');
  renderProfile();
}

function closeProfile() {
  PROFILE = null;
  $('g-profile').classList.add('hidden');
}

/* ------------------------------------------------------- detection prompt */

let DETECT_BUSY = false;

function pendingGames() {
  const games = WATCHER.games ?? [];
  return (WATCHER.pendingAutoApply ?? []).filter((g) => games.some((x) => x.exe === g.exe));
}

function renderDetectionPrompt(pending) {
  $('g-detect-list').innerHTML = pending
    .map(
      (g) => `<label class="gd-item">
        <input type="checkbox" data-detect-exe="${esc(g.exe)}" checked />
        <div class="gd-art">${artHtml(g)}</div>
        <div class="gd-meta">
          <div class="gd-name">${esc(displayName(g))}</div>
          <div class="gd-exe mono">${esc(g.exe)}${g.source ? ` · ${esc(g.source)}` : ''}</div>
        </div>
      </label>`
    )
    .join('');
}

function maybeShowDetectionPrompt(pending) {
  if (DETECT_BUSY) return;
  if (!pending || pending.length === 0) {
    if (DETECT_OPEN) hideDetectionPrompt();
    return;
  }
  if (!DETECT_OPEN) {
    DETECT_OPEN = true;
    $('g-detect').classList.remove('hidden');
  }
  renderDetectionPrompt(pending);
}

function hideDetectionPrompt() {
  DETECT_OPEN = false;
  $('g-detect').classList.add('hidden');
}

function setDetectButtons(disabled) {
  $('g-detect-enable').disabled = disabled;
  $('g-detect-later').disabled = disabled;
}

async function enableSelectedDetections() {
  const pending = pendingGames();
  if (pending.length === 0) return;
  const chosen = new Set(
    [...document.querySelectorAll('[data-detect-exe]:checked')].map((el) => el.dataset.detectExe)
  );
  DETECT_BUSY = true;
  setDetectButtons(true);
  try {
    let last = null;
    for (const game of pending) {
      const res = await api.gamesSetAutoApply(game.exe, chosen.has(game.exe));
      if (res && res.status) last = res.status;
    }
    if (last) WATCHER = last;
    hideDetectionPrompt();
    render();
    if (chosen.size > 0) await loadAssets();
    toast(
      chosen.size > 0
        ? `Auto-apply enabled for ${chosen.size} game(s).`
        : 'No games opted in. You can enable any game from its profile.',
      chosen.size > 0 ? 'ok' : 'info'
    );
  } catch (err) {
    toast(`Could not save the auto-apply choice: ${err.message ?? err}`, 'err', 8000);
  } finally {
    DETECT_BUSY = false;
    setDetectButtons(false);
  }
}

async function deferDetections() {
  const pending = pendingGames();
  if (pending.length === 0) return;
  DETECT_BUSY = true;
  setDetectButtons(true);
  try {
    const res = await api.gamesDeferAutoApply(pending.map((g) => g.exe));
    if (res && res.status) WATCHER = res.status;
    hideDetectionPrompt();
    render();
    toast('Kept the new games in your library without auto-apply.', 'info');
  } catch (err) {
    toast(`Could not save that choice: ${err.message ?? err}`, 'err', 8000);
  } finally {
    DETECT_BUSY = false;
    setDetectButtons(false);
  }
}

/* ------------------------------------------------------------------ adds */

async function addResult(res, fallbackName) {
  if (!res || res.ok === false) {
    toast(res?.error ?? `Could not add ${fallbackName}.`, 'warn', 8000);
    if (res && res.status) WATCHER = res.status;
    render();
    return false;
  }
  WATCHER = res.status;
  if (res.entry) {
    ASSETS = { ...ASSETS, [res.entry.exe]: res.assets ?? { icon: null, cover: null } };
  }
  render();
  toast(`Added ${res.entry ? displayName(res.entry) : fallbackName} to the library.`, 'ok');
  return true;
}

async function addByBrowse() {
  let picked = null;
  try {
    picked = await api.gamesBrowse();
  } catch (err) {
    toast(`The file picker failed: ${err.message ?? err}`, 'err');
    return false;
  }
  if (!picked || picked.canceled || !picked.path) return false;
  try {
    return await addResult(await api.gamesAdd({ path: picked.path }), picked.path);
  } catch (err) {
    toast(`Could not add that game: ${err.message ?? err}`, 'err', 8000);
    return false;
  }
}

/* --------------------------------------------------------------- events */

document.addEventListener('click', async (ev) => {
  const target = ev.target;
  if (!(target instanceof Element)) return;

  if (target.id === 'g-browse' || target.closest('#g-empty-add')) {
    await addByBrowse();
    return;
  }

  if (target.id === 'g-scan') {
    const btn = $('g-scan');
    btn.disabled = true;
    btn.textContent = 'Scanning…';
    try {
      const res = await api.gamesScan();
      if (res && res.status) WATCHER = res.status;
      render();
      if (res && res.ok === false) {
        toast(res.error ?? 'The installed-game scan failed.', 'warn', 8000);
      } else if (res && res.added && res.added.length > 0) {
        await loadAssets();
        toast(`Found ${res.added.length} new game(s).`, 'ok');
      } else {
        toast('No new games found.', 'info');
      }
    } catch (err) {
      toast(`The installed-game scan failed: ${err.message ?? err}`, 'err', 8000);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Scan games';
      render();
    }
    return;
  }

  if (target.id === 'g-detect-enable') {
    await enableSelectedDetections();
    return;
  }
  if (target.id === 'g-detect-later') {
    await deferDetections();
    return;
  }

  const profileBtn = target.closest('[data-g-profile]');
  if (profileBtn) {
    openProfile(profileBtn.dataset.gProfile);
    return;
  }

  if (target.id === 'g-profile') {
    closeProfile();
    return;
  }
  if (target.id === 'gp-close') {
    closeProfile();
    return;
  }
  if (target.id === 'gp-reveal' && PROFILE) {
    const res = await api.gamesReveal(PROFILE).catch((err) => ({ ok: false, error: err.message }));
    if (!res?.ok) toast(res?.error ?? 'Could not open that location.', 'warn', 8000);
    return;
  }
  if (target.id === 'gp-cover' && PROFILE) {
    const exe = PROFILE;
    const res = await api.gamesPickCover(exe).catch((err) => ({ ok: false, error: err.message }));
    if (res?.canceled) return;
    if (!res?.ok) {
      toast(res?.error ?? 'Could not set that cover.', 'warn', 8000);
      return;
    }
    ASSETS = { ...ASSETS, [exe]: { ...(ASSETS[exe] ?? { icon: null }), cover: res.cover ?? null } };
    renderProfile();
    render();
    toast('Cover updated.', 'ok');
    return;
  }
  if (target.id === 'gp-remove' && PROFILE) {
    const exe = PROFILE;
    try {
      const res = await api.gamesRemove(exe);
      if (res && res.status) WATCHER = res.status;
      const next = { ...ASSETS };
      delete next[exe];
      ASSETS = next;
      closeProfile();
      render();
      toast(`Removed ${exe} from the library.`, 'info');
    } catch (err) {
      toast(`Could not remove ${exe}: ${err.message ?? err}`, 'err');
    }
    return;
  }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el instanceof HTMLInputElement && el.id === 'g-toggle') {
    await watcherUpdate({ enabled: el.checked });
    return;
  }
  if (el instanceof HTMLSelectElement && el.id === 'g-priority') {
    await watcherUpdate({ priority: el.value });
    return;
  }
  if (el instanceof HTMLInputElement && el.id === 'g-timer') {
    await watcherUpdate({ timerResolution: el.checked });
    return;
  }
  if (el instanceof HTMLInputElement && el.id === 'g-autodetect') {
    await watcherUpdate({ autoDetect: el.checked });
    return;
  }
  if (el instanceof HTMLInputElement && el.id === 'g-auto') {
    await watcherUpdate({ autoApply: el.checked });
    return;
  }
  if (el instanceof HTMLInputElement && el.id === 'gp-auto' && PROFILE) {
    try {
      const res = await api.gamesSetAutoApply(PROFILE, el.checked);
      if (res && res.status) WATCHER = res.status;
      if (res && res.ok === false && res.error) toast(res.error, 'warn', 8000);
      renderProfile();
      render();
      toast(
        el.checked
          ? `Session-safe auto-apply enabled for ${PROFILE}.`
          : `Session-safe auto-apply disabled for ${PROFILE}.`,
        el.checked ? 'ok' : 'info'
      );
    } catch (err) {
      toast(`Could not change auto-apply: ${err.message ?? err}`, 'err', 8000);
      renderProfile();
      render();
    }
    return;
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && PROFILE) closeProfile();
});

api.onWatcherUpdate?.((status) => {
  const before = new Set((WATCHER.games ?? []).map((g) => g.exe));
  WATCHER = status;
  render();
  if ((status.games ?? []).some((g) => !before.has(g.exe))) void loadAssets();
});

/* ------------------------------------------------------------- demo API */

function demoApi() {
  const svgCover = (a, b, text) =>
    `data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="160"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="460" height="160" fill="url(#g)"/><text x="26" y="96" font-family="Segoe UI, sans-serif" font-size="34" font-weight="700" fill="rgba(255,255,255,0.92)">${text}</text></svg>`
    )}`;
  const state = {
    enabled: true,
    priority: 'high',
    pollSeconds: 8,
    active: ['nightglass.exe'],
    timer: { enabled: true, active: true, ready: true, units: 5000 },
    autoDetect: true,
    autoApply: true,
    maxGames: 64,
    pendingAutoApply: [],
    safeTweaks: [
      { id: 'disable-game-bar-dvr', name: 'Disable Game Bar / DVR' },
      { id: 'visual-effects-performance', name: 'Visual Effects: Performance' },
    ],
    autoApplied: ['disable-game-bar-dvr', 'visual-effects-performance'],
    autoApplyActive: true,
    autoApplyError: null,
    scanning: false,
    games: [
      { exe: 'nightglass.exe', path: 'C:\\Games\\Nightglass\\nightglass.exe', title: 'Nightglass', source: 'steam', autoApply: true },
      { exe: 'ironveil.exe', path: 'C:\\Games\\Ironveil\\ironveil.exe', title: 'Ironveil', source: 'steam' },
      { exe: 'starfall.exe', path: 'C:\\Games\\Starfall Arena\\starfall.exe', title: 'Starfall Arena', source: 'steam' },
      { exe: 'riftbound.exe', path: 'C:\\Games\\Riftbound\\riftbound.exe', title: 'Riftbound', source: 'epic' },
      { exe: 'driftline.exe', path: 'C:\\Games\\Driftline\\driftline.exe', title: 'Driftline', source: 'folder' },
    ],
  };
  const assets = {
    'nightglass.exe': { icon: null, cover: svgCover('#0f2f4f', '#1b6ac9', 'NIGHTGLASS') },
    'ironveil.exe': { icon: null, cover: svgCover('#20242a', '#8a6d1f', 'IRONVEIL') },
    'starfall.exe': { icon: null, cover: svgCover('#4a1010', '#b23a1f', 'STARFALL ARENA') },
    'riftbound.exe': { icon: null, cover: svgCover('#1d1a3a', '#7c4dff', 'RIFTBOUND') },
    'driftline.exe': { icon: null, cover: svgCover('#072d2d', '#18c7b6', 'DRIFTLINE') },
  };
  const status = () => ({
    ...state,
    games: [...state.games],
    active: [...state.active],
    timer: { ...state.timer },
  });
  return {
    watcherGet: async () => status(),
    watcherUpdate: async (patch) => {
      if (typeof patch?.timerResolution === 'boolean') state.timer.enabled = patch.timerResolution;
      const { timerResolution, ...rest } = patch ?? {};
      Object.assign(state, rest);
      return { ok: true, status: status() };
    },
    gamesAssets: async () => assets,
    gamesAdd: async (payload) => {
      const exe = payload?.path
        ? payload.path.split(/[\\/]/).pop().toLowerCase()
        : `${String(payload?.name ?? '').toLowerCase().replace(/\.exe$/, '')}.exe`;
      if (!/^[a-z0-9._ -]+\.exe$/.test(exe)) return { ok: false, error: 'Design preview: invalid name.', status: status() };
      if (state.games.some((g) => g.exe === exe)) {
        return { ok: false, error: `${exe} is already in the game library.`, status: status() };
      }
      const entry = { exe, path: payload?.path ?? null };
      state.games = [...state.games, entry];
      return { ok: true, entry, assets: { icon: null, cover: null }, status: status() };
    },
    gamesRemove: async (exe) => {
      state.games = state.games.filter((g) => g.exe !== exe);
      return { ok: true, status: status() };
    },
    gamesScan: async () => ({ ok: true, added: [], scanned: 0, status: status() }),
    gamesSetAutoApply: async (exe, enabled) => {
      const entry = state.games.find((g) => g.exe === exe);
      if (!entry) return { ok: false, error: 'Not in the design-preview library.', status: status() };
      entry.autoApply = enabled === true;
      entry.prompted = true;
      if (entry.autoApply) state.autoApply = true;
      return { ok: true, status: status() };
    },
    gamesDeferAutoApply: async (exes) => {
      const list = new Set(exes ?? []);
      state.games = state.games.map((g) =>
        list.has(g.exe) ? { ...g, autoApply: false, prompted: true } : g
      );
      state.pendingAutoApply = state.pendingAutoApply.filter((g) => !list.has(g.exe));
      return { ok: true, status: status() };
    },
    gamesBrowse: async () => ({ canceled: true, path: null }),
    gamesPickCover: async () => ({ ok: true, cover: svgCover('#123a2a', '#3dffa2', 'CUSTOM COVER') }),
    gamesReveal: async () => ({ ok: true }),
    onWatcherUpdate: () => {},
  };
}

void refresh();
