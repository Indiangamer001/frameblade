// Thin, injection-safe wrappers around Windows primitives (reg.exe,
// PowerShell, netsh, powercfg) plus the pure parsing helpers used by tests.

import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { RegistryHive } from '../shared/types';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(exe: string, args: string[], timeoutMs = 20000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const raw = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          code = typeof raw === 'number' ? raw : 1;
        }
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    );
  });
}

const SYS = process.env.SystemRoot || 'C:\\Windows';

export const EXE = {
  reg: path.join(SYS, 'System32', 'reg.exe'),
  powershell: path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  netsh: path.join(SYS, 'System32', 'netsh.exe'),
  powercfg: path.join(SYS, 'System32', 'powercfg.exe'),
  whoami: path.join(SYS, 'System32', 'whoami.exe'),
  bcdedit: path.join(SYS, 'System32', 'bcdedit.exe'),
  shutdown: path.join(SYS, 'System32', 'shutdown.exe'),
  tasklist: path.join(SYS, 'System32', 'tasklist.exe'),
};

export const SCHEME_HIGH_PERFORMANCE = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';

/** Allow only characters that are safe inside a single-quoted PowerShell string. */
export function sanitizePs(s: string): string {
  if (!/^[A-Za-z0-9 _.\-\\/:*]+$/.test(s)) {
    throw new Error(`Unsafe string for PowerShell usage: ${JSON.stringify(s)}`);
  }
  return s;
}

export function hiveFull(h: RegistryHive): string {
  return h === 'HKCU' ? 'HKEY_CURRENT_USER' : 'HKEY_LOCAL_MACHINE';
}

export function regKeyPath(h: RegistryHive, key: string): string {
  return `${hiveFull(h)}\\${key}`;
}

export function windowsBuild(): number {
  const parts = os.release().split('.');
  return Number(parts[2] ?? 0) || 0;
}

export async function isElevated(): Promise<boolean> {
  const r = await run(EXE.whoami, ['/groups'], 10000);
  return /S-1-16-(12288|16384)/.test(r.stdout);
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export function parseRegQueryOutput(
  stdout: string,
  name: string
): { type: string; value: string | number } | null {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s{2,}(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/);
    if (!m) continue;
    const [, vname, type, raw] = m;
    if (vname.trim().toLowerCase() !== name.toLowerCase()) continue;
    return { type, value: parseRegValue(type, raw.trim()) };
  }
  return null;
}

export function parseRegValue(type: string, raw: string): string | number {
  if (type === 'REG_DWORD') {
    const hex = raw.startsWith('0x') || raw.startsWith('0X') ? raw : `0x${raw}`;
    const n = Number.parseInt(hex, 16);
    return Number.isNaN(n) ? 0 : n;
  }
  return raw;
}

export async function regQuery(
  hive: RegistryHive,
  key: string,
  name: string
): Promise<{ type: string; value: string | number } | null> {
  const r = await run(EXE.reg, ['query', regKeyPath(hive, key), '/v', name]);
  if (r.code !== 0) return null;
  return parseRegQueryOutput(r.stdout, name);
}

export async function regSet(
  hive: RegistryHive,
  key: string,
  name: string,
  value: string | number,
  valueType?: string
): Promise<void> {
  const t = valueType ?? (typeof value === 'number' ? 'REG_DWORD' : 'REG_SZ');
  const r = await run(EXE.reg, [
    'add',
    regKeyPath(hive, key),
    '/v',
    name,
    '/t',
    t,
    '/d',
    String(value),
    '/f',
  ]);
  if (r.code !== 0) {
    throw new Error(`reg add failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }
}

export async function regDelete(hive: RegistryHive, key: string, name: string): Promise<void> {
  const r = await run(EXE.reg, ['delete', regKeyPath(hive, key), '/v', name, '/f']);
  if (r.code !== 0) {
    const msg = `${r.stderr} ${r.stdout}`.toLowerCase();
    if (msg.includes('unable to find') || msg.includes('cannot find')) return;
    throw new Error(`reg delete failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }
}

/* ------------------------------------------------------------------ */
/* PowerShell JSON bridge                                              */
/* ------------------------------------------------------------------ */

export async function psJson<T = unknown>(script: string): Promise<T | null> {
  const r = await run(
    EXE.powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    30000
  );
  const out = r.stdout.trim();
  if (!out) return null;
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Services                                                            */
/* ------------------------------------------------------------------ */

export type ServiceStart = 'boot' | 'system' | 'auto' | 'manual' | 'disabled';

export function mapServiceStart(n: number): ServiceStart {
  switch (n) {
    case 0:
      return 'boot';
    case 1:
      return 'system';
    case 2:
      return 'auto';
    case 3:
      return 'manual';
    case 4:
      return 'disabled';
    default:
      return 'manual';
  }
}

export function serviceStartNumber(s: ServiceStart): number {
  switch (s) {
    case 'boot':
      return 0;
    case 'system':
      return 1;
    case 'auto':
      return 2;
    case 'manual':
      return 3;
    case 'disabled':
      return 4;
  }
}

export interface ServiceInfo {
  status: string;
  startTypeNum: number;
}

export async function getService(name: string): Promise<ServiceInfo | null> {
  const n = sanitizePs(name);
  const script = `$s = Get-Service -Name '${n}' -ErrorAction SilentlyContinue; if ($s) { @{ status = "$($s.Status)"; start = [int]$s.StartType } | ConvertTo-Json -Compress } else { 'null' }`;
  const j = await psJson<{ status: string; start: number } | string>(script);
  if (!j || j === 'null') return null;
  const obj = j as { status: string; start: number };
  return { status: String(obj.status), startTypeNum: Number(obj.start) };
}

export async function setServiceStartupType(
  name: string,
  t: 'Automatic' | 'Manual' | 'Disabled'
): Promise<void> {
  const n = sanitizePs(name);
  const r = await run(EXE.powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Set-Service -Name '${n}' -StartupType ${t}`,
  ]);
  if (r.code !== 0) {
    throw new Error(`Set-Service failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }
}

export async function stopService(name: string): Promise<void> {
  const n = sanitizePs(name);
  await run(EXE.powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Stop-Service -Name '${n}' -Force -ErrorAction SilentlyContinue`,
  ]);
}

export async function startService(name: string): Promise<void> {
  const n = sanitizePs(name);
  await run(EXE.powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Start-Service -Name '${n}' -ErrorAction SilentlyContinue`,
  ]);
}

/* ------------------------------------------------------------------ */
/* Scheduled tasks                                                     */
/* ------------------------------------------------------------------ */

/** Returns the numeric State enum (1 = Disabled) or null when not found. */
export async function getTaskState(taskPath: string, taskName: string): Promise<number | null> {
  const p = sanitizePs(taskPath);
  const n = sanitizePs(taskName);
  const script = `$t = Get-ScheduledTask -TaskPath '${p}' -TaskName '${n}' -ErrorAction SilentlyContinue; if ($t) { [int]$t.State } else { 'null' }`;
  const j = await psJson<number | string>(script);
  if (j === null || j === 'null') return null;
  return Number(j);
}

export async function setTaskEnabled(
  taskPath: string,
  taskName: string,
  enabled: boolean
): Promise<void> {
  const p = sanitizePs(taskPath);
  const n = sanitizePs(taskName);
  const cmd = enabled ? 'Enable-ScheduledTask' : 'Disable-ScheduledTask';
  const r = await run(EXE.powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `${cmd} -TaskPath '${p}' -TaskName '${n}' | Out-Null`,
  ]);
  if (r.code !== 0) {
    throw new Error(`${cmd} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }
}

/* ------------------------------------------------------------------ */
/* Power                                                               */
/* ------------------------------------------------------------------ */

export function parseActiveScheme(out: string): string | null {
  const m = out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1].toLowerCase() : null;
}

export async function getActiveScheme(): Promise<string | null> {
  const r = await run(EXE.powercfg, ['/getactivescheme']);
  if (r.code !== 0) return null;
  return parseActiveScheme(r.stdout);
}

export async function setActiveScheme(guid: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(guid)) throw new Error(`Invalid scheme GUID: ${guid}`);
  const r = await run(EXE.powercfg, ['/setactive', guid]);
  if (r.code !== 0) {
    throw new Error(`powercfg /setactive failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }
}

/* ------------------------------------------------------------------ */
/* TCP stack                                                           */
/* ------------------------------------------------------------------ */

export interface TcpInternet {
  congestionProvider: string;
  ecn: string;
  autoTuning: string;
}

/** CongestionProvider data from Get-NetTCPSetting (enum -> alias).
 *  Verified on Windows 11 (Get-NetTCPSetting enum):
 *  0=Default 1=NewReno 2=CTCP 3=DCTCP 4=LEDBAT 5=CUBIC 6=BBR2 */
export function mapCongestion(n: number): string {
  const m: Record<number, string> = {
    0: 'default',
    1: 'newreno',
    2: 'ctcp',
    3: 'dctcp',
    4: 'ledbat',
    5: 'cubic',
    6: 'bbr2',
  };
  return m[n] ?? `unknown:${n}`;
}

/** AutoTuningLevelLocal data from Get-NetTCPSetting (enum -> alias).
 *  Verified on Windows 11: 0=Disabled 1=HighlyRestricted 2=Restricted 3=Normal 4=Experimental */
export function mapAutoTuning(n: number): string {
  const m: Record<number, string> = {
    0: 'disabled',
    1: 'highlyrestricted',
    2: 'restricted',
    3: 'normal',
    4: 'experimental',
  };
  return m[n] ?? `unknown:${n}`;
}

/** netsh can only set these congestion providers. */
export const NETSH_CONGESTION_VALUES = new Set(['ctcp', 'dctcp', 'cubic', 'newreno', 'default']);

/** Alias -> proper enum name for Set-NetTCPSetting. */
export function congestionAliasToProper(alias: string): string | null {
  const m: Record<string, string> = {
    ctcp: 'CTCP',
    dctcp: 'DCTCP',
    cubic: 'CUBIC',
    newreno: 'NewReno',
    default: 'Default',
    ledbat: 'LEDBAT',
    bbr2: 'BBR2',
  };
  return m[alias] ?? null;
}

/** For congestion providers netsh cannot set (LEDBAT, BBR2). */
export async function setTcpCongestionProvider(properName: string): Promise<void> {
  if (!/^(CTCP|DCTCP|CUBIC|NewReno|Default|LEDBAT|BBR2)$/.test(properName)) {
    throw new Error(`Unsupported congestion provider: ${properName}`);
  }
  const r = await run(EXE.powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Set-NetTCPSetting -SettingName Internet -CongestionProvider ${properName}`,
  ]);
  if (r.code !== 0) {
    throw new Error(`Set-NetTCPSetting failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }
}

export async function getTcpInternet(): Promise<TcpInternet | null> {
  const script = `$t = Get-NetTCPSetting -SettingName Internet -ErrorAction SilentlyContinue; if ($t) { @{ cp = [int]$t.CongestionProvider; ecn = [int]$t.ECNCapability; at = [int]$t.AutoTuningLevelLocal } | ConvertTo-Json -Compress } else { 'null' }`;
  const j = await psJson<{ cp: number; ecn: number; at: number } | string>(script);
  if (!j || j === 'null') return null;
  const obj = j as { cp: number; ecn: number; at: number };
  return {
    congestionProvider: mapCongestion(Number(obj.cp)),
    ecn: Number(obj.ecn) === 0 ? 'disabled' : 'enabled',
    autoTuning: mapAutoTuning(Number(obj.at)),
  };
}

export async function netshTcpSetGlobal(setting: string, value: string): Promise<void> {
  const s = sanitizePs(setting);
  const v = sanitizePs(value);
  const r = await run(EXE.netsh, ['int', 'tcp', 'set', 'global', `${s}=${v}`]);
  if (r.code !== 0) {
    throw new Error(`netsh tcp set global failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }
}

/* ------------------------------------------------------------------ */
/* Boot configuration (bcdedit)                                        */
/* ------------------------------------------------------------------ */

function codedError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  return e;
}

/**
 * Parses `bcdedit /enum` output for an element (e.g. hypervisorlaunchtype).
 * Lines look like: `hypervisorlaunchtype    Off`
 */
export function parseBcdeditEnum(out: string, element: string): string | null {
  const target = element.toLowerCase();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\s+(.+?)\s*$/);
    if (!m) continue;
    if (m[1].toLowerCase() === target) return m[2].trim();
  }
  return null;
}

/**
 * Reads a boot element from the active entry.
 * The ID is omitted on purpose: `{current}` is the default and the explicit
 * `{current}` identifier is not accepted by every bcdedit build.
 * Requires administrator rights; throws UTIL004 otherwise.
 */
export async function readBcdElement(element: string): Promise<string | null> {
  const r = await run(EXE.bcdedit, ['/enum']);
  if (r.code !== 0) {
    const msg = `${r.stdout} ${r.stderr}`.trim();
    if (/access is denied/i.test(msg)) {
      throw codedError('UTIL004', 'bcdedit requires administrator rights to read the boot configuration.');
    }
    throw codedError('OPT002', `bcdedit /enum failed (exit ${r.code}): ${msg}`);
  }
  return parseBcdeditEnum(r.stdout, element);
}

export async function bcdeditSet(element: string, value: string): Promise<void> {
  const e = sanitizePs(element);
  const v = sanitizePs(value);
  const r = await run(EXE.bcdedit, ['/set', e, v]);
  if (r.code !== 0) {
    const msg = `${r.stdout} ${r.stderr}`.trim();
    throw codedError(
      /access is denied/i.test(msg) ? 'UTIL004' : 'OPT002',
      `bcdedit /set ${element} ${value} failed (exit ${r.code}): ${msg}`
    );
  }
}

export async function bcdeditDelete(element: string): Promise<void> {
  const e = sanitizePs(element);
  const r = await run(EXE.bcdedit, ['/deletevalue', e]);
  if (r.code !== 0) {
    const msg = `${r.stdout} ${r.stderr}`.trim();
    throw codedError(
      /access is denied/i.test(msg) ? 'UTIL004' : 'OPT002',
      `bcdedit /deletevalue ${element} failed (exit ${r.code}): ${msg}`
    );
  }
}

/* ------------------------------------------------------------------ */
/* NIC advanced properties                                             */
/* ------------------------------------------------------------------ */

export interface NicProperty {
  adapter: string;
  display: string;
  keyword: string;
  value: number;
}

/** Normalizes ConvertTo-Json output (single object or array) into a list. */
export function normalizeNicProps(json: unknown): NicProperty[] {
  const arr = Array.isArray(json) ? json : json ? [json] : [];
  const out: NicProperty[] = [];
  for (const item of arr) {
    const o = item as Record<string, unknown>;
    if (!o || typeof o !== 'object') continue;
    const adapter = String(o.adapter ?? '');
    const keyword = String(o.kw ?? '');
    if (!adapter || !keyword) continue;
    out.push({
      adapter,
      display: String(o.display ?? ''),
      keyword,
      value: Number(o.val),
    });
  }
  return out;
}

/** Finds advanced properties of physical adapters whose RegistryKeyword matches. */
export async function getNicAdvancedByKeyword(pattern: string): Promise<NicProperty[]> {
  const p = sanitizePs(pattern);
  const script =
    `$props = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Get-NetAdapterAdvancedProperty -ErrorAction SilentlyContinue | Where-Object { $_.RegistryKeyword -match '${p}' }; ` +
    `if ($props) { @($props | ForEach-Object { @{ adapter = $_.Name; display = $_.DisplayName; kw = $_.RegistryKeyword; val = [int](@($_.RegistryValue)[0]) } }) | ConvertTo-Json -Compress } else { 'null' }`;
  const j = await psJson<unknown>(script);
  if (j === null || j === 'null') return [];
  return normalizeNicProps(j);
}

export async function setNicAdvanced(adapter: string, keyword: string, value: number): Promise<void> {
  const a = sanitizePs(adapter);
  const k = sanitizePs(keyword);
  const script = `Set-NetAdapterAdvancedProperty -Name '${a}' -RegistryKeyword '${k}' -RegistryValue ${value} -ErrorAction Stop`;
  const r = await run(EXE.powershell, ['-NoProfile', '-NonInteractive', '-Command', script], 60000);
  if (r.code !== 0) {
    throw new Error(`Set-NetAdapterAdvancedProperty failed: ${(r.stderr || r.stdout).trim()}`);
  }
}

/* ------------------------------------------------------------------ */
/* Power settings by GUID (hidden settings need /qh to read)           */
/* ------------------------------------------------------------------ */

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAcValueFromQuery(out: string): number | null {
  const m = out.match(/Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)/);
  return m ? Number.parseInt(m[1], 16) : null;
}

/** Reads the current AC index of a power setting. Returns null when absent. */
export async function getAcValue(subgroup: string, setting: string): Promise<number | null> {
  if (!GUID_RE.test(subgroup) || !GUID_RE.test(setting)) {
    throw new Error(`Invalid power setting GUIDs: ${subgroup} / ${setting}`);
  }
  const r = await run(EXE.powercfg, ['/qh', 'SCHEME_CURRENT', subgroup, setting]);
  if (r.code !== 0) return null;
  return parseAcValueFromQuery(r.stdout);
}

export async function setAcValue(subgroup: string, setting: string, value: number): Promise<void> {
  if (!GUID_RE.test(subgroup) || !GUID_RE.test(setting)) {
    throw new Error(`Invalid power setting GUIDs: ${subgroup} / ${setting}`);
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`Invalid power setting value: ${value}`);
  }
  const r1 = await run(EXE.powercfg, ['/setacvalueindex', 'SCHEME_CURRENT', subgroup, setting, String(value)]);
  if (r1.code !== 0) {
    throw new Error(`powercfg /setacvalueindex failed: ${(r1.stderr || r1.stdout).trim()}`);
  }
  const r2 = await run(EXE.powercfg, ['/setactive', 'SCHEME_CURRENT']);
  if (r2.code !== 0) {
    throw new Error(`powercfg /setactive failed: ${(r2.stderr || r2.stdout).trim()}`);
  }
}
