// Probes Windows System Restore: is it enabled, and when was the last
// restore point created? Used to advise the user before applying a mode.
//
// Reading the restore-point list from an unelevated process can fail
// (access denied); that is reported as "unknown" instead of an error.

import { psJson, regQuery } from './win';

export interface RestorePointInfo {
  unixMs: number;
  description: string;
}

export interface RestoreStatus {
  /** false when System Restore is disabled (machine or policy). null = unknown. */
  restoreEnabled: boolean | null;
  lastPoint: RestorePointInfo | null;
  /** false when the point list could not be read (e.g. needs admin). */
  lastPointKnown: boolean;
  note?: string;
}

const POINT_QUERY = `$ErrorActionPreference = 'Stop'
try {
  $p = Get-ComputerRestorePoint | Sort-Object SequenceNumber | Select-Object -Last 1
  if ($null -eq $p) { '{"ok":true,"point":null}' }
  else {
    $o = [pscustomobject]@{ creationTime = [string]$p.CreationTime; description = [string]$p.Description }
    '{"ok":true,"point":' + ($o | ConvertTo-Json -Compress) + '}'
  }
} catch { '{"ok":false}' }`;

/** Parses WMI CIM timestamps ("20261019154212.000000-000") and ISO strings. */
export function parseRestorePointTime(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const cim = trimmed.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (cim) {
    return Date.UTC(
      Number(cim[1]),
      Number(cim[2]) - 1,
      Number(cim[3]),
      Number(cim[4]),
      Number(cim[5]),
      Number(cim[6])
    );
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

export function parseRestorePointQuery(raw: unknown): {
  ok: boolean;
  point: RestorePointInfo | null;
} {
  if (!raw || typeof raw !== 'object') return { ok: false, point: null };
  const r = raw as { ok?: unknown; point?: unknown };
  const ok = r.ok === true;
  const p = r.point as { creationTime?: unknown; description?: unknown } | null | undefined;
  if (!ok || p == null) return { ok, point: null };
  const ts = parseRestorePointTime(String(p.creationTime ?? ''));
  if (ts == null) return { ok: true, point: null };
  return { ok: true, point: { unixMs: ts, description: String(p.description ?? '') } };
}

async function restoreEnabled(): Promise<boolean | null> {
  try {
    const machine = await regQuery(
      'HKLM',
      'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore',
      'DisableSR'
    );
    const policy = await regQuery(
      'HKLM',
      'SOFTWARE\\Policies\\Microsoft\\Windows NT\\SystemRestore',
      'DisableSR'
    );
    const disabled = [machine, policy].some((v) => Number(v) === 1);
    return !disabled;
  } catch {
    return null;
  }
}

export async function restoreStatus(): Promise<RestoreStatus> {
  const enabled = await restoreEnabled();
  const raw = await psJson<unknown>(POINT_QUERY);
  const parsed = parseRestorePointQuery(raw);
  if (!parsed.ok) {
    return {
      restoreEnabled: enabled,
      lastPoint: null,
      lastPointKnown: false,
      note: 'Could not read the restore-point list (this usually needs administrator rights).',
    };
  }
  return { restoreEnabled: enabled, lastPoint: parsed.point, lastPointKnown: true };
}
