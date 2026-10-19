/* Frameblade renderer. Talks to the main process through window.pctune only. */

const api = window.pctune ?? createDemoApi();

/* Sample data fallback, used only when the page is opened outside Electron
   (e.g. design preview in a plain browser). The real app always gets the
   preload bridge. */
function createDemoApi() {
  const tw = (o) => ({
    group: 'Optimize FPS & Input Lag',
    categories: ['fps-latency'],
    recommended: false,
    requiresElevation: false,
    rebootRequired: false,
    unsupportedReason: null,
    state: null,
    ...o,
  });
  const tweaks = [
    tw({
      id: 'game-bar-dvr',
      name: 'Disable Game Bar & DVR',
      description:
        'Turns off the Xbox Game Bar overlay and GameDVR background capture. GameDVR keeps a rolling buffer of gameplay encoded in the background; disabling it removes that continuous CPU/GPU overhead.',
      impact: 'Removes background capture overhead. Win+G overlay stops working.',
      risk: 'low',
      recommended: true,
      state: { status: 'applied' },
    }),
    tw({
      id: 'system-responsiveness',
      name: 'System Responsiveness & Game Scheduling',
      group: 'Quality of Life',
      categories: ['quality-of-life'],
      description:
        'Lowers the multimedia class scheduler reserve so foreground games and audio threads keep more CPU time.',
      impact: 'Smoother frame pacing under CPU load.',
      risk: 'low',
      recommended: true,
      state: { status: 'applied' },
    }),
    tw({
      id: 'tcp-optimize',
      name: 'Optimize TCP (Congestion + ECN + Autotuning)',
      group: 'Network',
      categories: ['network'],
      description:
        'Sets the TCP congestion provider to CUBIC, keeps autotuning at Normal and writes the settings through to the live netsh view.',
      impact: 'Lower loss-recovery latency for online games.',
      risk: 'medium',
      requiresElevation: true,
    }),
    tw({
      id: 'timer-resolution',
      name: 'Timer Resolution Support (Win11+)',
      group: 'Optimize FPS & Input Lag',
      description:
        'Enables the Windows 11 registry switch that lets applications request a global high-resolution timer.',
      impact: 'Lower-latency timers for games that request them.',
      risk: 'low',
      requiresElevation: true,
      rebootRequired: true,
    }),
    tw({
      id: 'disable-vbs-hyperv',
      name: 'Disable VBS and Hyper-V',
      group: 'Advanced',
      description:
        'Sets hypervisorlaunchtype=off and disables virtualization-based security, HVCI and Credential Guard.',
      impact: 'Removes hypervisor and VBS overhead after a reboot.',
      securityWarning: 'Anti-cheats rely on these - some games may refuse to launch.',
      risk: 'high',
      requiresElevation: true,
      rebootRequired: true,
    }),
    tw({
      id: 'disable-lso-offloads',
      name: 'Disable Large Send Offloads',
      group: 'Advanced',
      categories: ['network'],
      description: 'Turns off Large Send Offload on physical network adapters.',
      impact: 'May smooth latency spikes; can reduce throughput.',
      risk: 'medium',
      requiresElevation: true,
      state: { status: 'failed', lastError: { code: 'OPT002', message: 'verify failed: value did not change (design preview)' } },
    }),
  ];
  const journal = [
    { ts: Date.now() - 60000, level: 'info', tweakId: 'game-bar-dvr', code: null, message: 'applied (2 steps)' },
    { ts: Date.now() - 55000, level: 'info', tweakId: 'system-responsiveness', code: null, message: 'applied (1 step)' },
    { ts: Date.now() - 40000, level: 'warn', tweakId: 'tcp-optimize', code: 'UTIL085', message: '(requires administrator to read) current value stored unverified' },
    { ts: Date.now() - 30000, level: 'error', tweakId: 'disable-lso-offloads', code: 'OPT002', message: 'verify failed: value did not change' },
  ];
  return {
    info: async () => ({
      appVersion: '0.1.0',
      catalogVersion: 1,
      windowsBuild: '26300',
      processElevated: false,
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      userDataDir: 'C:\\Users\\you\\AppData\\Local\\Frameblade',
      appliedCount: 2,
      catalogSize: 6,
      brandName: 'Frameblade',
      tagline: 'Reversible gaming tuner',
    }),
    list: async () => tweaks,
    journal: async () => journal,
    plan: async (id) => {
      const t = tweaks.find((x) => x.id === id);
      return {
        tweakId: id,
        entries: [
          { changed: true, description: 'Registry value', current: '1', target: '0', note: null },
          { changed: true, description: 'Live setting', current: 'enabled', target: 'disabled', note: '(requires administrator to read)' },
        ],
        requiresElevation: t ? t.requiresElevation : false,
        alreadyApplied: false,
        unsupportedReason: null,
      };
    },
    apply: async (ids) => ({ results: ids.map((id) => ({ tweakId: id, status: 'applied', steps: [] })) }),
    revert: async (ids) => ({ results: ids.map((id) => ({ tweakId: id, status: 'reverted', steps: [] })) }),
    verifyApplied: async () => ({ ok: true, checkedAt: Date.now(), applied: 2, drifted: [] }),
    createRestorePoint: async () => ({ ok: true, message: 'Design preview - no restore point was created.' }),
    openDataFolder: async () => '',
    profilesList: async () => ({
      builtins: [
        {
          id: 'turbo-gaming',
          name: 'Turbo Gaming',
          tagline: 'Frameblade recommended gaming setup',
          builtin: true,
          highlighted: true,
          tweakIds: ['game-bar-dvr', 'system-responsiveness', 'tcp-optimize', 'timer-resolution'],
        },
      ],
      custom: [
        {
          id: 'custom-demo',
          name: 'My Sunday Setup',
          tweakIds: ['game-bar-dvr', 'system-responsiveness'],
          createdAt: Date.now() - 86400e3,
        },
      ],
      lastMode: 'turbo-gaming',
      lastModeAt: Date.now() - 3600e3,
    }),
    profilesSave: async (name) => ({
      id: 'custom-demo',
      name: name || 'My Setup',
      tweakIds: ['game-bar-dvr'],
      createdAt: Date.now(),
    }),
    profilesDelete: async () => ({ removed: true }),
    modesMark: async () => ({ ok: true }),
    gameOpen: async () => ({ ok: true }),
    watcherGet: async () => ({
      enabled: true,
      games: ['cs2.exe', 'fortnite.exe'],
      priority: 'high',
      pollSeconds: 8,
      active: ['cs2.exe'],
      timer: { enabled: true, active: true, ready: true, units: 5000 },
    }),
    watcherUpdate: async (patch) => ({
      ok: true,
      status: {
        enabled: true,
        games: ['cs2.exe', 'fortnite.exe'],
        priority: 'high',
        pollSeconds: 8,
        active: [],
        timer: { enabled: true, active: false, ready: true, units: null },
        ...(patch ?? {}),
      },
    }),
    onWatcherUpdate: () => {},
    resourcesStatus: async () => ({
      source: 'bundled',
      version: 'm2-2026.10.19',
      bundledVersion: 'm2-2026.10.19',
      remoteVersion: null,
      remoteLoadedAt: null,
      tweakCount: tweaks.length,
      endpoint: 'https://resources.frameblade.gg/catalog-v1.json',
      endpointSource: 'default',
      cachedAt: null,
      lastCheck: null,
      retiredApplied: [],
      trustedKeyIds: ['dev-1'],
    }),
    resourcesCheck: async () => ({
      ok: false,
      status: 'failed',
      code: 'RES002',
      message: 'Design preview — network calls are disabled.',
    }),
    onCatalogUpdate: () => {},
    restoreStatus: async () => ({
      restoreEnabled: true,
      lastPoint: null,
      lastPointKnown: false,
      note: 'Could not read the restore-point list (this usually needs administrator rights).',
    }),
    exitApp: async () => ({ ok: true }),
    onExitRequest: () => {},
  };
}

let INFO = null;
let TWEAKS = [];
let CATALOG = null;
let PROFILES = { builtins: [], custom: [], lastMode: null, lastModeAt: null };
let WATCHER = { enabled: false, games: [], priority: 'high', active: [] };
let FILTER = 'all';
let QUERY = '';
let busy = false;

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/* ---------------------------------------------------------------- data */

async function refreshAll() {
  const [info, tweaks, journal, profiles, watcher, catalog] = await Promise.all([
    api.info(),
    api.list(),
    api.journal(),
    api.profilesList ? api.profilesList() : null,
    api.watcherGet ? api.watcherGet() : null,
    api.resourcesStatus ? api.resourcesStatus() : null,
  ]);
  INFO = info;
  TWEAKS = tweaks;
  if (profiles) PROFILES = profiles;
  if (watcher) WATCHER = watcher;
  if (catalog) CATALOG = catalog;
  if (INFO.brandName) {
    document.title = INFO.brandName;
    $('brand-name').textContent = INFO.brandName;
  }
  if (INFO.tagline) $('brand-sub').textContent = INFO.tagline;
  renderSysinfo();
  renderCatalog();
  renderStatusline();
  renderModes();
  renderResume();
  renderWatcher();
  renderCards();
  renderJournal(journal);
}

/* ---------------------------------------------------------------- render */

/* ------------------------------------------------------------ modes */

function allProfiles() {
  return [
    ...(PROFILES.builtins ?? []).map((m) => ({ ...m, builtin: true })),
    ...(PROFILES.custom ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      tagline: `${p.tweakIds.length} optimizations · saved setup`,
      builtin: false,
      tweakIds: p.tweakIds,
    })),
  ];
}

function appliedCount() {
  return TWEAKS.filter((t) => t.state && t.state.status === 'applied').length;
}

function renderModes() {
  const chips = $('mode-chips');
  const entries = allProfiles();
  chips.innerHTML = entries
    .map((m) => {
      const last = PROFILES.lastMode === m.id;
      return `
      <div class="mode-chip ${m.builtin ? 'turbo' : ''} ${last ? 'last' : ''}">
        <div>
          <div class="mode-name">${esc(m.name)}
            ${m.highlighted ? '<span class="tag risk-low">recommended</span>' : ''}
            ${last ? '<span class="tag">last used</span>' : ''}
          </div>
          <div class="mode-sub">${esc(m.tagline)}</div>
        </div>
        <button class="primary small" data-mode-apply="${esc(m.id)}">Apply</button>
        ${m.builtin ? '' : `<button class="ghost small" data-mode-del="${esc(m.id)}" title="Delete profile">✕</button>`}
      </div>`;
    })
    .join('');
}

function renderResume() {
  const banner = $('resume');
  const id = PROFILES.lastMode;
  const profile = allProfiles().find((m) => m.id === id);
  let dismissed = false;
  try {
    dismissed = id ? localStorage.getItem(`frameblade.resumeDismissed.${id}`) === '1' : false;
  } catch {
    /* storage unavailable */
  }
  if (!id || !profile || appliedCount() > 0 || dismissed) {
    banner.classList.add('hidden');
    return;
  }
  $('resume-text').innerHTML =
    `Welcome back — your last setup was <b>${esc(profile.name)}</b> ` +
    `(${profile.tweakIds.length} optimizations). Apply it again in one click?`;
  banner.classList.remove('hidden');
}

function renderSysinfo() {
  const admin = INFO.processElevated ? 'elevated' : 'standard user';
  $('sysinfo').textContent =
    `Windows build ${INFO.windowsBuild}\n${admin}\n` +
    `catalog ${INFO.catalogVersion} · app ${INFO.appVersion}\n` +
    `${INFO.appliedCount}/${INFO.catalogSize} applied`;
}

function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/* Remote catalog status: source, cache age, last check failure, retired tweaks. */
function renderCatalog() {
  const el = $('catalog-status');
  if (!el) return;
  if (!CATALOG) {
    el.className = 'catalog-status mono';
    el.textContent = 'status unavailable';
    return;
  }
  el.className = `catalog-status mono${CATALOG.source === 'remote' ? ' remote' : ''}`;
  const lines = [];
  lines.push(
    CATALOG.source === 'remote'
      ? `remote ${CATALOG.remoteVersion} · ${CATALOG.tweakCount} optimizations`
      : `bundled ${CATALOG.version} · ${CATALOG.tweakCount} optimizations`
  );
  if (CATALOG.source === 'remote') {
    lines.push(CATALOG.cachedAt ? `cached ${timeAgo(CATALOG.cachedAt)}` : 'loaded from cache');
  } else if (CATALOG.endpointSource && CATALOG.endpointSource !== 'default') {
    lines.push('bundled fallback · signed updates enabled');
  } else {
    lines.push('bundled fallback · remote service not configured');
  }
  if (CATALOG.retiredApplied && CATALOG.retiredApplied.length > 0) {
    lines.push(`⚠ ${CATALOG.retiredApplied.length} retired optimization(s) still applied`);
  }
  if (CATALOG.lastCheck && !CATALOG.lastCheck.ok) {
    const msg = String(CATALOG.lastCheck.message ?? 'check failed');
    lines.push(`⚠ ${CATALOG.lastCheck.code ?? 'error'}: ${msg.length > 110 ? `${msg.slice(0, 107)}…` : msg}`);
  }
  el.textContent = lines.join('\n');
}

function renderStatusline() {
  const applied = TWEAKS.filter((t) => t.state && t.state.status === 'applied').length;
  const unsupported = TWEAKS.filter((t) => t.unsupportedReason).length;
  const failed = TWEAKS.filter((t) => t.state && t.state.status === 'failed').length;
  const risky = TWEAKS.filter((t) => t.risk === 'high' && t.state && t.state.status === 'applied').length;
  const nodeNote = INFO.nodeExe ? '' : ' · helper runtime: NOT FOUND (system tweaks disabled)';
  const riskNote = risky > 0 ? ` · ⚠ ${risky} high-risk active` : '';
  $('statusline').textContent =
    `${TWEAKS.length} optimizations · ${applied} applied · ${unsupported} unsupported · ${failed} need attention${riskNote}${nodeNote}`;
}

function statusOf(t) {
  if (t.unsupportedReason) return 'unsupported';
  if (t.state) return t.state.status;
  return 'available';
}

function visibleTweaks() {
  return TWEAKS.filter((t) => {
    if (FILTER === 'advanced') {
      if (t.group !== 'Advanced') return false;
    } else if (FILTER !== 'all' && !t.categories.includes(FILTER)) {
      return false;
    }
    if (QUERY) {
      const hay = `${t.name} ${t.group ?? ''} ${t.description}`.toLowerCase();
      if (!hay.includes(QUERY)) return false;
    }
    return true;
  });
}

function renderCards() {
  const cards = $('cards');
  const list = visibleTweaks();
  if (list.length === 0) {
    cards.innerHTML = '<div class="card"><div class="card-desc">No optimizations match the current filter.</div></div>';
    return;
  }
  cards.innerHTML = list
    .map((t) => {
      const status = statusOf(t);
      const applied = status === 'applied';
      const unsupported = status === 'unsupported';
      const disabled = busy || unsupported || (!INFO.nodeExe && t.requiresElevation);
      const tags = [
        `<span class="tag risk-${t.risk}">risk: ${t.risk}</span>`,
        t.requiresElevation ? '<span class="tag admin">admin</span>' : '<span class="tag">user</span>',
        t.rebootRequired ? '<span class="tag reboot">reboot</span>' : '',
        applied ? '<span class="tag applied">applied</span>' : '',
        status === 'failed' ? '<span class="tag failed">failed</span>' : '',
        status === 'unsupported' ? '<span class="tag">unsupported</span>' : '',
      ]
        .filter(Boolean)
        .join('');
      const warnBits = [
        t.securityWarning ? `<div class="card-warn">⚠ ${esc(t.securityWarning)}</div>` : '',
        t.effectiveNote ? `<div class="card-desc">${esc(t.effectiveNote)}</div>` : '',
        t.state && t.state.lastError
          ? `<div class="card-warn">last error ${esc(t.state.lastError.code)}: ${esc(t.state.lastError.message)}</div>`
          : '',
        unsupported ? `<div class="card-warn">${esc(t.unsupportedReason)}</div>` : '',
      ]
        .filter(Boolean)
        .join('');
      return `
      <div class="card risk-${esc(t.risk)} ${applied ? 'applied' : ''} ${status === 'failed' ? 'failed' : ''} ${unsupported ? 'unsupported' : ''}" data-id="${esc(t.id)}">
        <div class="card-head">
          <div class="card-title">${esc(t.name)}</div>
        </div>
        <div class="tags">${tags}</div>
        <div class="card-desc">${esc(t.description)}</div>
        <div class="card-impact">${esc(t.impact)}</div>
        ${warnBits}
        <div class="card-foot">
          <button class="ghost small" data-plan="${esc(t.id)}">Preview</button>
          <div class="spring"></div>
          <label class="switch" title="${unsupported ? 'Unsupported on this system' : applied ? 'Revert' : 'Apply'}">
            <input type="checkbox" data-toggle="${esc(t.id)}" ${applied ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
            <span class="slider"></span>
          </label>
        </div>
      </div>`;
    })
    .join('');
}

function renderJournal(lines) {
  $('journal-count').textContent = lines.length ? `(${lines.length})` : '';
  $('journal').innerHTML = lines
    .map((l) => {
      const when = new Date(l.ts).toLocaleTimeString();
      const code = l.code ? ` (${esc(l.code)})` : '';
      return `<div class="jline ${esc(l.level)}">${esc(when)} ${esc(l.tweakId)}${code} — ${esc(l.message)}</div>`;
    })
    .join('');
}

/* ---------------------------------------------------------------- toasts */

function toast(message, kind = 'info', ms = 5200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* ---------------------------------------------------------------- modal */

let modalConfirm = null;
let modalCancel = null;

function openModal(title, bodyHtml, confirmLabel, onConfirm, onCancel) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  $('modal-confirm').textContent = confirmLabel;
  $('modal-confirm').style.display = onConfirm ? '' : 'none';
  modalConfirm = onConfirm;
  modalCancel = onCancel ?? null;
  $('modal').classList.remove('hidden');
}

function closeModal() {
  $('modal').classList.add('hidden');
  modalConfirm = null;
  modalCancel = null;
}

async function previewPlan(id) {
  const t = TWEAKS.find((x) => x.id === id);
  const plan = await api.plan(id);
  const rows = plan.entries
    .map(
      (e) => `<tr>
        <td>${e.changed ? '✱' : ''}</td>
        <td>${esc(e.description)}</td>
        <td class="mono">${esc(e.current)}${e.note ? `<br><span style="color:var(--warn)">${esc(e.note)}</span>` : ''}</td>
        <td class="mono">${esc(e.target)}</td>
      </tr>`
    )
    .join('');
  const notes = [
    plan.unsupportedReason ? `<p>⚠ ${esc(plan.unsupportedReason)}</p>` : '',
    plan.alreadyApplied ? '<p>Already applied.</p>' : '',
    plan.requiresElevation
      ? '<p>Requires administrator rights — a UAC prompt will appear when applying.</p>'
      : '',
    t && t.rebootRequired ? '<p>Reboot recommended for full effect.</p>' : '',
  ]
    .filter(Boolean)
    .join('');
  openModal(
    `Preview — ${t ? t.name : id}`,
    `${notes}
     <table>
       <tr><th></th><th>Action</th><th>Current</th><th>Target</th></tr>
       ${rows}
     </table>
     <p style="color:var(--dim)">✱ = will change. Everything shown here is captured in a backup before it changes.</p>`,
    null,
    null
  );
}

/* ---------------------------------------------------------------- actions */

async function toggleTweak(id, wanted) {
  const t = TWEAKS.find((x) => x.id === id);
  if (!t) return;
  if (wanted) {
    const plan = await api.plan(id);
    const changed = plan.entries.filter((e) => e.changed).length;
    const riskBlock =
      t.risk === 'high'
        ? `${t.securityWarning ? `<p style="color:var(--danger)">⚠ ${esc(t.securityWarning)}</p>` : '<p style="color:var(--danger)">⚠ High-risk optimization.</p>'}
           <label style="display:flex;gap:8px;align-items:flex-start;margin-top:8px;cursor:pointer">
             <input type="checkbox" id="risk-ack" />
             <span>I understand this weakens system security and I accept the risk.</span>
           </label>`
        : '';
    const body = `
      <p><b>${esc(t.name)}</b></p>
      <p>${esc(t.description)}</p>
      ${riskBlock}
      <p>${changed} of ${plan.entries.length} action(s) will change.
      ${plan.requiresElevation ? 'You will be asked for administrator rights (UAC).' : 'No administrator rights needed.'}
      ${t.rebootRequired ? 'A reboot is recommended afterwards.' : ''}</p>
      <p style="color:var(--dim)">A backup of the current state is written and verified before anything changes.</p>`;
    openModal('Apply optimization', body, 'Apply', async () => {
      closeModal();
      await runBatch([id]);
    });
    const ack = document.getElementById('risk-ack');
    if (ack) {
      const btn = $('modal-confirm');
      btn.disabled = true;
      ack.addEventListener('change', () => {
        btn.disabled = !ack.checked;
      });
    }
  } else {
    const body = `<p>Revert <b>${esc(t.name)}</b> to the state captured in its backup?</p>
      ${t.requiresElevation ? '<p style="color:var(--dim)">A UAC prompt will appear.</p>' : ''}`;
    openModal('Revert optimization', body, 'Revert', async () => {
      closeModal();
      await runBatch([id], true);
    });
  }
}

async function runBatch(ids, revert = false) {
  if (busy || ids.length === 0) return;
  busy = true;
  renderCards();
  try {
    const res = revert ? await api.revert(ids) : await api.apply(ids);
    const results = res.results ?? [];
    const summary = results
      .map((r) => {
        const t = TWEAKS.find((x) => x.id === r.tweakId);
        const name = t ? t.name : r.tweakId;
        const icon = r.status === 'applied' || r.status === 'reverted' ? '✔' : r.status === 'up-to-date' ? '•' : '✖';
        const code = r.errorCode ? ` [${esc(r.errorCode)}]` : '';
        const msg = r.errorMessage ? ` — ${esc(r.errorMessage)}` : '';
        return `<div>${icon} ${esc(name)}: ${esc(r.status)}${code}${msg}</div>`;
      })
      .join('');
    const anyFailed = results.some((r) => r.status === 'failed');
    openModal(revert ? 'Revert results' : 'Apply results', summary || '<div>Nothing to do.</div>', null, null);
    toast(
      anyFailed ? 'Some operations failed — see details.' : 'Done.',
      anyFailed ? 'err' : 'ok'
    );
  } catch (err) {
    toast(`Error: ${err.message ?? err}`, 'err', 9000);
  } finally {
    busy = false;
    await refreshAll();
  }
}

async function applyRecommended() {
  const ids = TWEAKS.filter(
    (t) => t.recommended && !t.unsupportedReason && statusOf(t) !== 'applied'
  ).map((t) => t.id);
  if (ids.length === 0) {
    toast('All recommended optimizations are already applied.', 'info');
    return;
  }
  await confirmApply(ids, { title: 'Apply Recommended', modeId: 'turbo-gaming' });
}

async function revertAll() {
  const ids = TWEAKS.filter((t) => statusOf(t) === 'applied').map((t) => t.id);
  if (ids.length === 0) {
    toast('Nothing is applied.', 'info');
    return;
  }
  openModal(
    'Revert All',
    `<p>Revert all ${ids.length} applied optimization(s) to their backed-up state?</p>`,
    'Revert all',
    async () => {
      closeModal();
      await runBatch(ids, true);
    }
  );
}

/** Re-reads every applied setting; reports values changed by another tool/Windows. */
async function verifyApplied() {
  const btn = $('btn-verify');
  const label = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Checking…';
  }
  try {
    const res = await api.verifyApplied();
    if (!res || res.ok === false) {
      toast(res?.error ?? 'Could not verify applied settings.', 'warn', 8000);
      return;
    }
    if (!res.applied) {
      toast('Nothing is applied — nothing to verify.', 'info');
      return;
    }
    if (!res.drifted || res.drifted.length === 0) {
      toast(`Verified ${res.applied} applied optimization(s) — all match their targets.`, 'ok', 6500);
      return;
    }
    const rows = res.drifted
      .map(
        (d) =>
          `<div class="vr-row"><b>${esc(d.name)}</b><div class="vr-detail">${d.changes
            .map((c) => esc(c))
            .join('<br>')}</div></div>`
      )
      .join('');
    openModal(
      'Changed outside Frameblade',
      `<p>These applied settings no longer match their target values. Another tool, a Windows update or a manual change may have altered them.</p>${rows}<p>Re-apply an optimization to put it back, or revert it to accept the current values.</p>`,
      null,
      null
    );
  } catch (err) {
    toast(`Verification failed: ${err.message ?? err}`, 'err', 9000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

/* ------------------------------------------------------- apply + guard */

function askConfirm(message, confirmLabel) {
  return new Promise((resolve) => {
    openModal(
      'Confirm',
      `<p>${esc(message)}</p>`,
      confirmLabel,
      async () => {
        closeModal();
        resolve(true);
      },
      () => resolve(false)
    );
  });
}

/** Turns a restoreStatus() response into banner text + whether to offer creating one. */
function describeRestoreGuard(status) {
  const DAY = 24 * 3600 * 1000;
  if (!status) {
    return { cls: 'warn', text: 'Restore-point status is unavailable.', recent: false, canCreate: true };
  }
  if (status.restoreEnabled === false) {
    return {
      cls: 'bad',
      text: "System Restore is turned off on this PC, so a restore point can't be created. Frameblade's own per-tweak backups can still revert every change.",
      recent: false,
      canCreate: false,
    };
  }
  if (status.lastPointKnown && status.lastPoint) {
    const recent = Date.now() - status.lastPoint.unixMs < DAY;
    const when = new Date(status.lastPoint.unixMs).toLocaleString();
    const desc = status.lastPoint.description ? ` — ${status.lastPoint.description}` : '';
    return {
      cls: recent ? 'ok' : 'warn',
      text: `Last System Restore point: ${when}${desc}${recent ? '' : ' (older than 24 h)'}.`,
      recent,
      canCreate: true,
    };
  }
  if (status.lastPointKnown) {
    return { cls: 'warn', text: 'No System Restore point was found on this PC.', recent: false, canCreate: true };
  }
  return {
    cls: 'warn',
    text: 'Could not verify restore points (reading them needs administrator rights).',
    recent: false,
    canCreate: true,
  };
}

/**
 * Confirm + guard + apply for a set of tweaks (mode, saved profile, or the
 * recommended set). Checks for a recent System Restore point first and offers
 * to create one before anything is applied.
 */
async function confirmApply(ids, opts) {
  let status = null;
  try {
    status = await api.restoreStatus();
  } catch {
    /* keep null -> generic advice */
  }
  const guard = describeRestoreGuard(status);
  const list = ids
    .map((id) => TWEAKS.find((t) => t.id === id))
    .filter(Boolean)
    .map(
      (t) =>
        `<li>${esc(t.name)}${t.requiresElevation ? ' <span class="tag admin">admin</span>' : ''}</li>`
    )
    .join('');
  const anyElevated = ids.some((id) => TWEAKS.find((t) => t.id === id)?.requiresElevation);
  const anyReboot = ids.some((id) => TWEAKS.find((t) => t.id === id)?.rebootRequired);
  const checkRow = guard.canCreate
    ? `<label class="checkrow">
         <input type="checkbox" id="rp-check" ${guard.recent ? '' : 'checked'} />
         <span>Create a System Restore point first
           <span style="color:var(--dim)">(recommended — Windows may skip it if one was already created in the last 24 h)</span>
         </span>
       </label>`
    : '';
  const body = `
    <p><b>${esc(opts.title)}</b> — ${ids.length} optimization(s).</p>
    <ul class="apply-list">${list}</ul>
    <div class="rp-status ${guard.cls}">${esc(guard.text)}</div>
    ${checkRow}
    <p>${anyElevated ? 'You will be asked for administrator rights (UAC).' : 'No administrator rights needed.'}${
      anyReboot ? ' A reboot is recommended afterwards.' : ''
    }</p>
    <p style="color:var(--dim)">Before anything changes, each optimization backs up its exact current values — that backup is what reverts it later.</p>`;
  openModal(opts.title, body, 'Apply', async () => {
    const wantsRestore = !!document.getElementById('rp-check')?.checked;
    closeModal();
    if (opts.modeId) {
      try {
        await api.modesMark(opts.modeId);
      } catch {
        /* remembering the choice is best-effort */
      }
    }
    if (wantsRestore) {
      const r = await api.createRestorePoint();
      if (!r.ok) {
        const proceed = await askConfirm(
          `The restore point was not created: ${r.message} Apply anyway?`,
          'Apply anyway'
        );
        if (!proceed) {
          toast('Apply cancelled.', 'warn');
          return;
        }
      } else {
        toast('Restore point created.', 'ok');
      }
    }
    await runBatch(ids);
    await refreshAll();
  });
}

function saveProfileFlow() {
  const count = appliedCount();
  if (count === 0) {
    toast('Apply some optimizations first — a profile snapshots the current setup.', 'warn');
    return;
  }
  openModal(
    'Save current setup',
    `<p>Save the ${count} currently applied optimization(s) as a profile you can re-apply in one click.</p>
     <p><input id="profile-name" class="search" style="max-width:none;width:100%" placeholder="Profile name (e.g. My Turbo Setup)" maxlength="48" /></p>
     <p style="color:var(--dim)">Saving with an existing name updates that profile.</p>`,
    'Save',
    async () => {
      const name = document.getElementById('profile-name')?.value ?? '';
      closeModal();
      try {
        const saved = await api.profilesSave(name);
        toast(`Profile "${saved.name}" saved (${saved.tweakIds.length} optimizations).`, 'ok');
        await refreshAll();
      } catch (err) {
        const msg = String(err.message ?? err).replace(/^Error invoking remote method '[^']+': ?/, '');
        toast(`Could not save profile: ${msg}`, 'err', 9000);
      }
    }
  );
}

/* ------------------------------------------------------------ game mode */

async function watcherUpdate(patch) {
  try {
    const res = await api.watcherUpdate(patch);
    if (res && res.status) {
      WATCHER = res.status;
      renderWatcher();
    }
    if (res && res.ok === false && res.error) {
      toast(res.error, 'warn', 8000);
      return false;
    }
    return !res || res.ok !== false;
  } catch (err) {
    toast(`Game Mode: ${err.message ?? err}`, 'err');
    return false;
  }
}

function renderWatcher() {
  const toggle = $('watcher-toggle');
  const status = $('watcher-status');
  if (!toggle || !status) return;
  const timer = WATCHER.timer ?? {};
  toggle.checked = !!WATCHER.enabled;
  status.classList.toggle('active', !!(WATCHER.active && WATCHER.active.length));
  if (!WATCHER.enabled) {
    status.textContent = 'off — boost priority for your games';
  } else if (!WATCHER.games || WATCHER.games.length === 0) {
    status.textContent = 'on — add a game to watch';
  } else if (WATCHER.active && WATCHER.active.length > 0) {
    status.textContent = `active: ${WATCHER.active.join(', ')} (${WATCHER.priority})${timer.active ? ' · 0.5 ms timer' : ''}`;
  } else {
    status.textContent = `watching ${WATCHER.games.length} game(s) · ${WATCHER.priority} priority${timer.enabled ? ' · timer on' : ''}`;
  }
}

/* ------------------------------------------------------------ exit flow */

function openExitModal(count) {
  const body = `
    <p>You have <b>${count} optimization(s)</b> applied.</p>
    <div class="rp-status warn">⚠ Reverting restores the exact values captured in each backup. Some optimizations (for example Virtualization-Based Security) only fully come back after a restart — <b>only reboot when it is safe to close your work</b>.</div>
    <div class="exit-options">
      <button id="exit-keep" class="ghost">Keep changes and exit</button>
      <button id="exit-revert" class="ghost">Restore old settings and exit</button>
      <button id="exit-revert-reboot" class="danger">Restore old settings and reboot</button>
    </div>`;
  openModal('Exit Frameblade', body, null, null);
}

async function doExit(action) {
  closeModal();
  if (action !== 'keep') toast('Restoring previous settings…', 'info', 20000);
  try {
    const res = await api.exitApp(action);
    if (res && res.ok === false) {
      const rows = (res.results ?? [])
        .filter((r) => r.status === 'failed')
        .map((r) => {
          const t = TWEAKS.find((x) => x.id === r.tweakId);
          return `<div>✖ ${esc(t ? t.name : r.tweakId)}${r.errorCode ? ` [${esc(r.errorCode)}]` : ''} — ${esc(r.errorMessage ?? '')}</div>`;
        })
        .join('');
      openModal(
        'Could not restore everything',
        `${rows || '<div>Unknown failure.</div>'}<p>The app was not closed. You can try again from "Revert All".</p>`,
        null,
        null
      );
    }
  } catch (err) {
    toast(`Exit failed: ${String(err.message ?? err)}`, 'err', 9000);
  }
}

/* ---------------------------------------------------------------- wiring */

document.addEventListener('click', async (ev) => {
  const target = ev.target;
  if (!(target instanceof HTMLElement)) return;

  const filterBtn = target.closest('.filter');
  if (filterBtn) {
    document.querySelectorAll('.filter').forEach((b) => b.classList.remove('active'));
    filterBtn.classList.add('active');
    FILTER = filterBtn.dataset.filter;
    renderCards();
    return;
  }

  const planBtn = target.closest('[data-plan]');
  if (planBtn) {
    try {
      await previewPlan(planBtn.dataset.plan);
    } catch (err) {
      toast(`Plan failed: ${err.message ?? err}`, 'err');
    }
    return;
  }

  if (target.id === 'btn-verify') return verifyApplied();
  if (target.id === 'btn-recommended') return applyRecommended();
  if (target.id === 'btn-revert-all') return revertAll();
  if (target.id === 'btn-save-profile') return saveProfileFlow();

  const modeApply = target.closest('[data-mode-apply]');
  if (modeApply) {
    const mode = allProfiles().find((m) => m.id === modeApply.dataset.modeApply);
    if (mode) await confirmApply(mode.tweakIds, { title: `Apply — ${mode.name}`, modeId: mode.id });
    return;
  }

  const modeDel = target.closest('[data-mode-del]');
  if (modeDel) {
    const mode = allProfiles().find((m) => m.id === modeDel.dataset.modeDel);
    if (mode) {
      openModal(
        'Delete profile',
        `<p>Delete the profile <b>${esc(mode.name)}</b>? Applied optimizations are not touched.</p>`,
        'Delete',
        async () => {
          closeModal();
          try {
            await api.profilesDelete(mode.id);
            toast(`Profile "${mode.name}" deleted.`, 'info');
            await refreshAll();
          } catch (err) {
            toast(`Could not delete: ${err.message ?? err}`, 'err');
          }
        }
      );
    }
    return;
  }

  if (target.id === 'resume-apply') {
    const mode = allProfiles().find((m) => m.id === PROFILES.lastMode);
    if (mode) await confirmApply(mode.tweakIds, { title: `Apply — ${mode.name}`, modeId: mode.id });
    return;
  }

  if (target.id === 'resume-dismiss') {
    try {
      localStorage.setItem(`frameblade.resumeDismissed.${PROFILES.lastMode}`, '1');
    } catch {
      /* storage unavailable */
    }
    $('resume').classList.add('hidden');
    return;
  }

  if (target.id === 'watcher-open') {
    try {
      await api.gameOpen();
    } catch (err) {
      toast(`Could not open the Game Mode window: ${err.message ?? err}`, 'err');
    }
    return;
  }

  if (target.id === 'exit-keep') return doExit('keep');
  if (target.id === 'exit-revert') return doExit('revert');
  if (target.id === 'exit-revert-reboot') return doExit('revert-reboot');

  if (target.id === 'btn-restore') {
    target.disabled = true;
    try {
      const r = await api.createRestorePoint();
      toast(r.message, r.ok ? 'ok' : 'warn', 9000);
    } finally {
      target.disabled = false;
    }
    return;
  }

  if (target.id === 'catalog-check') {
    const btn = target;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const r = await api.resourcesCheck();
      if (!r || r.ok === false) {
        toast(
          `Catalog check failed — ${r?.code ?? 'RES002'}: ${r?.message ?? 'unknown error'}`,
          'err',
          10000
        );
      } else if (r.status === 'updated') {
        const extra = r.reverted && r.reverted.length ? ` Reverted ${r.reverted.length} retired optimization(s).` : '';
        toast(
          `Catalog updated to v${r.version} — ${r.tweaks} optimizations.${extra}`,
          r.reverted && r.reverted.length ? 'warn' : 'ok',
          10000
        );
      } else {
        toast(`Catalog is up to date (v${r.version}).`, 'ok');
      }
      if (r && r.failedReverts && r.failedReverts.length > 0) {
        const first = r.failedReverts[0];
        toast(
          `Could not revert ${r.failedReverts.length} retired optimization(s): ${first.message ?? first.code ?? 'error'}`,
          'err',
          14000
        );
      }
      await refreshAll();
    } catch (err) {
      toast(`Catalog check failed: ${err.message ?? err}`, 'err', 10000);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
    return;
  }

  if (target.id === 'open-data') {
    await api.openDataFolder();
    return;
  }

  if (target.id === 'journal-refresh') {
    renderJournal(await api.journal());
    return;
  }

  if (target.id === 'journal-toggle') {
    const drawer = $('drawer');
    const opening = drawer.classList.contains('collapsed');
    drawer.classList.toggle('collapsed', !opening);
    $('journal-toggle').textContent = opening ? 'Hide' : 'Show';
    setJournalPref(opening);
    return;
  }

  if (target.id === 'modal-cancel' || target.id === 'modal-x') {
    const fn = modalCancel;
    closeModal();
    if (fn) fn();
    return;
  }
  if (target.id === 'modal-confirm') {
    const fn = modalConfirm;
    if (fn) await fn();
    return;
  }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el instanceof HTMLInputElement && el.dataset.toggle) {
    await toggleTweak(el.dataset.toggle, el.checked);
    return;
  }
  if (el instanceof HTMLInputElement && el.id === 'watcher-toggle') {
    await watcherUpdate({ enabled: el.checked });
    return;
  }
});

document.addEventListener('input', (ev) => {
  if (ev.target instanceof HTMLInputElement && ev.target.id === 'search') {
    QUERY = ev.target.value.trim().toLowerCase();
    renderCards();
  }
});

/* Journal visibility: hidden by default, remembered across restarts. */
function journalPref() {
  try {
    return localStorage.getItem('frameblade.journalOpen') === '1';
  } catch {
    return false;
  }
}

function setJournalPref(open) {
  try {
    localStorage.setItem('frameblade.journalOpen', open ? '1' : '0');
  } catch {
    /* storage unavailable (e.g. file:// preview) — ignore */
  }
}

(function initJournalState() {
  const open = journalPref();
  const drawer = $('drawer');
  drawer.classList.toggle('collapsed', !open);
  $('journal-toggle').textContent = open ? 'Hide' : 'Show';
})();

api.onExitRequest?.((data) => openExitModal(data.appliedCount));
api.onWatcherUpdate?.((status) => {
  WATCHER = status;
  renderWatcher();
});
api.onCatalogUpdate?.((payload) => {
  if (payload && payload.status) {
    CATALOG = payload.status;
    renderCatalog();
  }
});

refreshAll().catch((err) => toast(`Startup error: ${err.message ?? err}`, 'err', 12000));
