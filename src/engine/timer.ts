// Game Mode runtime component: holds a 0.5 ms timer-resolution request for the
// duration of a game session.
//
// Windows 10 2004+ scopes NtSetTimerResolution calls to the calling process unless
// the machine is opted into legacy global requests. The catalog's "Timer Resolution
// Support" tweak writes GlobalTimerResolutionRequests=1 (Windows 11) and needs a
// reboot; this helper verifies the live value before it does anything, then raises
// the request from a small PowerShell process that lives exactly as long as the
// session. Killing that process releases the request - nothing is persisted, so no
// backup/revert cycle is needed.

import { spawn, ChildProcess } from 'child_process';
import { EXE } from './win';

/** 100 ns units: 5000 = 0.5 ms. */
export const TIMER_REQUEST_100NS = 5000;
/** Highest request worth sending (1 s); Windows clamps to its own minimum anyway. */
export const TIMER_MAX_REQUEST_100NS = 10_000_000;
export const TIMER_GATE_KEY = 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\kernel';
export const TIMER_GATE_NAME = 'GlobalTimerResolutionRequests';

export interface TimerSession {
  readonly pid: number | null;
  readonly requestedUnits: number;
  /** Resolution Windows actually reported after the request (100 ns units). */
  readonly currentUnits: number;
  readonly active: boolean;
  /** Kills the helper; the OS drops its request when the process exits. */
  stop(): void;
}

export type TimerStartResult =
  | { ok: true; session: TimerSession }
  | { ok: false; code: 'unsupported' | 'ungated' | 'timeout' | 'failed'; error: string };

/** Milliseconds from 100 ns units, for UI/journal text. */
export function unitsToMs(units: number): number {
  return Math.round((units / 10_000) * 1000) / 1000;
}

/** PowerShell that gates on the live registry value, requests 0.5 ms, reports the
 *  result on stdout and then sleeps until the parent process disappears. The
 *  process-exit check means a crashed app cannot leave the request behind. */
export function timerScript(parentPid: number, request = TIMER_REQUEST_100NS): string {
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    throw new Error('timerScript: parentPid must be a positive integer');
  }
  if (!Number.isInteger(request) || request <= 0 || request > TIMER_MAX_REQUEST_100NS) {
    throw new Error('timerScript: request out of range');
  }
  return `$ErrorActionPreference = 'Stop'
$gate = (Get-ItemProperty -Path 'HKLM:\\${TIMER_GATE_KEY}' -Name '${TIMER_GATE_NAME}' -ErrorAction SilentlyContinue).${TIMER_GATE_NAME}
if ($gate -ne 1) { Write-Output 'timer-ungated'; exit 2 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FramebladeTimer {
    [DllImport("ntdll.dll")]
    public static extern int NtSetTimerResolution(uint desiredResolution, [MarshalAs(UnmanagedType.U1)] bool setResolution, out uint currentResolution);
    [DllImport("ntdll.dll")]
    public static extern int NtQueryTimerResolution(out uint minimumResolution, out uint maximumResolution, out uint currentResolution);
}
'@
$cur = [uint32]0
$status = [FramebladeTimer]::NtSetTimerResolution([uint32]${request}, $true, [ref]$cur)
if ($status -ne 0) { Write-Output "timer-error $status"; exit 1 }
Write-Output "timer-ok $cur"
while ($true) {
  Start-Sleep -Seconds 5
  if (-not (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue)) { break }
}
$released = [uint32]0
[FramebladeTimer]::NtSetTimerResolution([uint32]0, $false, [ref]$released) | Out-Null`;
}

function cleanError(err: unknown, fallback: string): string {
  const text = err instanceof Error ? err.message : String(err ?? '');
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine ? oneLine.slice(0, 300) : fallback;
}

/** Starts the helper and waits for its first status line. */
export async function startTimerBoost(
  opts: { parentPid?: number; request?: number; timeoutMs?: number } = {}
): Promise<TimerStartResult> {
  if (process.platform !== 'win32') {
    return { ok: false, code: 'unsupported', error: 'timer resolution is only available on Windows' };
  }
  const parentPid = opts.parentPid ?? process.pid;
  const request = opts.request ?? TIMER_REQUEST_100NS;
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    return { ok: false, code: 'failed', error: 'invalid parent process id' };
  }
  if (!Number.isInteger(request) || request <= 0 || request > TIMER_MAX_REQUEST_100NS) {
    return { ok: false, code: 'failed', error: 'invalid timer resolution request' };
  }

  let child: ChildProcess;
  try {
    child = spawn(
      EXE.powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        timerScript(parentPid, request),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    return { ok: false, code: 'failed', error: cleanError(err, 'could not start the timer helper') };
  }

  const waitMs = Math.max(3000, Math.min(30000, opts.timeoutMs ?? 15000));
  const pid = child.pid ?? null;

  return new Promise<TimerStartResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      // The helper writes nothing after its status line; keep the handle but let
      // the pipes go so a forgotten session cannot hold the event loop open.
      child.stdout?.resume();
      child.stderr?.resume();
      child.unref();
    };

    const finish = (result: TimerStartResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!result.ok) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
      resolve(result);
    };

    const fail = (code: 'ungated' | 'timeout' | 'failed', error: string) => {
      finish({ ok: false, code, error });
    };

    const timeout = setTimeout(() => {
      fail('timeout', 'the timer helper did not report a resolution in time');
    }, waitMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('timer-ungated')) {
        fail(
          'ungated',
          'global timer requests are not enabled - apply the Timer Resolution Support optimization and reboot'
        );
        return;
      }
      const m = /timer-ok (\d+)/.exec(stdout);
      if (m) {
        const currentUnits = Number(m[1]);
        const session: TimerSession = {
          pid,
          requestedUnits: request,
          currentUnits,
          get active() {
            return child.exitCode === null && !child.killed;
          },
          stop() {
            try {
              child.kill();
            } catch {
              /* already gone */
            }
          },
        };
        finish({ ok: true, session });
        return;
      }
      const err = /timer-error (\d+)/.exec(stdout);
      if (err) fail('failed', `NtSetTimerResolution failed with status ${err[1]}`);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      fail('failed', cleanError(err, 'the timer helper could not start'));
    });

    child.on('exit', (code) => {
      if (!settled) {
        const detail = stderr.trim() ? cleanError(stderr, '') : '';
        fail('failed', detail || `the timer helper exited before starting (code ${code ?? 'unknown'})`);
      }
    });
  });
}
