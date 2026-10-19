// Preload bridge: the only surface the renderer can call.
import { contextBridge, ipcRenderer } from 'electron';

export interface ExitRequestData {
  appliedCount: number;
}

contextBridge.exposeInMainWorld('pctune', {
  info: () => ipcRenderer.invoke('app:info'),
  list: () => ipcRenderer.invoke('tweaks:list'),
  state: () => ipcRenderer.invoke('state:get'),
  plan: (id: string) => ipcRenderer.invoke('tweaks:plan', id),
  verifyApplied: () => ipcRenderer.invoke('tweaks:verify'),
  apply: (ids: string[]) => ipcRenderer.invoke('tweaks:apply', ids),
  revert: (ids: string[]) => ipcRenderer.invoke('tweaks:revert', ids),
  journal: () => ipcRenderer.invoke('journal:list'),
  createRestorePoint: () => ipcRenderer.invoke('restore:create'),
  restoreStatus: () => ipcRenderer.invoke('restore:status'),
  openDataFolder: () => ipcRenderer.invoke('data:open'),
  resourcesStatus: () => ipcRenderer.invoke('resources:status'),
  resourcesCheck: () => ipcRenderer.invoke('resources:check'),
  onCatalogUpdate: (cb: (payload: unknown) => void) => {
    ipcRenderer.on('catalog:update', (_e, payload) => cb(payload));
  },
  profilesList: () => ipcRenderer.invoke('profiles:list'),
  profilesSave: (name: string) => ipcRenderer.invoke('profiles:save', name),
  profilesDelete: (id: string) => ipcRenderer.invoke('profiles:delete', id),
  modesMark: (modeId: string) => ipcRenderer.invoke('modes:mark', modeId),
  gameOpen: () => ipcRenderer.invoke('game:open'),
  watcherGet: () => ipcRenderer.invoke('watcher:get'),
  watcherUpdate: (patch: unknown) => ipcRenderer.invoke('watcher:update', patch),
  gamesAdd: (payload: unknown) => ipcRenderer.invoke('games:add', payload),
  gamesBrowse: () => ipcRenderer.invoke('games:browse'),
  gamesRemove: (exe: string) => ipcRenderer.invoke('games:remove', exe),
  gamesScan: () => ipcRenderer.invoke('games:scan'),
  gamesSetAutoApply: (exe: string, enabled: boolean) =>
    ipcRenderer.invoke('games:setAutoApply', exe, enabled),
  gamesDeferAutoApply: (exes: string[]) => ipcRenderer.invoke('games:deferAutoApply', exes),
  gamesAssets: () => ipcRenderer.invoke('games:assets'),
  gamesReveal: (exe: string) => ipcRenderer.invoke('games:reveal', exe),
  gamesPickCover: (exe: string) => ipcRenderer.invoke('games:pickCover', exe),
  onWatcherUpdate: (cb: (status: unknown) => void) => {
    ipcRenderer.on('watcher:update', (_e, status) => cb(status));
  },
  exitApp: (action: string) => ipcRenderer.invoke('app:exit', action),
  onExitRequest: (cb: (data: ExitRequestData) => void) => {
    ipcRenderer.on('app:exit-request', (_e, data) => cb(data as ExitRequestData));
  },
});
