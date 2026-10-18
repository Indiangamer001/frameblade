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
};
let ASSETS = {}; // exe -> { icon: dataURL|null, cover: dataURL|null }
let PROFILE = null; // exe shown in the profile panel

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
  return `<article class="gtile" data-exe="${esc(entry.exe)}">
    <div class="tile-art">${artHtml(entry)}${badge}</div>
    <div class="tile-name" title="${esc(entry.path ?? entry.exe)}">${esc(displayName(entry))}</div>
    <button class="tile-link" data-g-profile="${esc(entry.exe)}">Open profile →</button>
  </article>`;
}

function render() {
  const on = !!WATCHER.enabled;
  const games = WATCHER.games ?? [];
  const active = WATCHER.active ?? [];
  const timer = WATCHER.timer ?? {};

  $('g-toggle').checked = on;
  $('g-sub').textContent = on
    ? `watching ${games.length} game(s) · ${WATCHER.priority} priority${timer.active ? ' · 0.5 ms timer' : ''}`
    : 'off — turn on to boost your games';
  $('g-flash').classList.toggle('active', on && active.length > 0);

  const runningEntry = games.find((g) => active.includes(g.exe));
  $('g-library-sub').textContent = runningEntry
    ? `${displayName(runningEntry)} is running — priority boosted to ${WATCHER.priority}.`
    : on
      ? 'No recognized game running. Select a game tile or add its EXE.'
      : 'Game Mode is off — flip the switch to boost your games.';

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
  $('g-games-count').textContent = games.length ? `${games.length}/32` : '';
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
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && PROFILE) closeProfile();
});

api.onWatcherUpdate?.((status) => {
  WATCHER = status;
  render();
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
    active: ['cs2.exe'],
    timer: { enabled: true, active: true, ready: true, units: 5000 },
    games: [
      { exe: 'cs2.exe', path: 'C:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe', title: 'Counter-Strike 2', appid: '730' },
      { exe: 'tslgame.exe', path: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\PUBG\\TslGame\\Binaries\\Win64\\TslGame.exe', title: 'PUBG: BATTLEGROUNDS', appid: '578080' },
      { exe: 'dota2.exe', path: 'C:\\SteamLibrary\\steamapps\\common\\dota 2 beta\\game\\bin\\win64\\dota2.exe', title: 'Dota 2', appid: '570' },
      { exe: 'fortnite.exe', path: null },
      { exe: 'apex.exe', path: null, title: 'Apex Legends' },
    ],
  };
  const assets = {
    'cs2.exe': { icon: null, cover: svgCover('#0f2f4f', '#1b6ac9', 'COUNTER-STRIKE 2') },
    'tslgame.exe': { icon: null, cover: svgCover('#20242a', '#8a6d1f', 'PUBG: BATTLEGROUNDS') },
    'dota2.exe': { icon: null, cover: svgCover('#4a1010', '#b23a1f', 'DOTA 2') },
    'fortnite.exe': { icon: null, cover: null },
    'apex.exe': { icon: null, cover: null },
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
    gamesBrowse: async () => ({ canceled: true, path: null }),
    gamesPickCover: async () => ({ ok: true, cover: svgCover('#123a2a', '#3dffa2', 'CUSTOM COVER') }),
    gamesReveal: async () => ({ ok: true }),
    onWatcherUpdate: () => {},
  };
}

void refresh();
