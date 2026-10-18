import { Tweak } from '../shared/types';
import { TWEAKS } from './tweaks';

/** Bump on every bundled catalog change; recorded in backups for auditability. */
export const CATALOG_VERSION = 'm2-2026.10.19';

interface RemoteCatalog {
  version: number;
  tweaks: Tweak[];
  loadedAt: string;
}

let remote: RemoteCatalog | null = null;

/**
 * Activates (or clears) a verified remote catalog. The remote snapshot
 * overrides bundled tweaks by id and may add new ones; bundled tweaks it does
 * not mention stay available so previously applied settings can always be
 * reverted.
 */
export function setRemoteCatalog(
  tweaks: Tweak[] | null,
  version = 0,
  loadedAt = new Date().toISOString()
): void {
  remote = tweaks && tweaks.length > 0 ? { version, tweaks, loadedAt } : null;
}

export function clearRemoteCatalog(): void {
  remote = null;
}

/** Union of bundled + remote, remote winning on conflicts (includes retired). */
function mergedTweaks(): Tweak[] {
  if (!remote) return TWEAKS;
  const byId = new Map<string, Tweak>();
  for (const t of TWEAKS) byId.set(t.id, t);
  for (const t of remote.tweaks) byId.set(t.id, t);
  return [...byId.values()];
}

/** Visible catalog: retired optimizations are never offered. */
export function getCatalog(): Tweak[] {
  return mergedTweaks().filter((t) => !t.retired);
}

/** Includes retired tweaks so their backups can still be reverted. */
export function getTweak(id: string): Tweak | undefined {
  return mergedTweaks().find((t) => t.id === id);
}

/** True when any action of the tweak needs an elevated process. */
export function tweakRequiresElevation(t: Tweak): boolean {
  return t.actions.some((a) => a.scope === 'system');
}

export function recommendedIds(): string[] {
  return getCatalog()
    .filter((t) => t.recommended)
    .map((t) => t.id);
}

export function retiredTweakIds(): string[] {
  return mergedTweaks()
    .filter((t) => t.retired)
    .map((t) => t.id);
}

export function isRetired(id: string): boolean {
  return getTweak(id)?.retired === true;
}

export interface CatalogSourceInfo {
  source: 'bundled' | 'remote';
  /** Version string recorded in backups ("m1-…" or "remote-<n>"). */
  version: string;
  bundledVersion: string;
  remoteVersion: number | null;
  remoteLoadedAt: string | null;
  tweakCount: number;
}

export function catalogSourceInfo(): CatalogSourceInfo {
  return {
    source: remote ? 'remote' : 'bundled',
    version: remote ? `remote-${remote.version}` : CATALOG_VERSION,
    bundledVersion: CATALOG_VERSION,
    remoteVersion: remote?.version ?? null,
    remoteLoadedAt: remote?.loadedAt ?? null,
    tweakCount: getCatalog().length,
  };
}

/** Version label used in backups and diagnostics for the active catalog. */
export function activeCatalogVersion(): string {
  return catalogSourceInfo().version;
}
