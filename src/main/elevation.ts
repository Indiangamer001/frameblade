// Launches the privileged helper through a UAC elevation prompt and waits
// for its result file. Job-per-operation: no long-lived elevated process.

import { execFile, execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { EnginePaths } from '../engine/paths';
import { EXE } from '../engine/win';
import { ActionResult } from '../shared/types';
import { BRAND_NAME } from '../shared/brand';

export interface JobResult {
  ok: boolean;
  code?: string;
  error?: string;
  results?: ActionResult[];
}

export interface HelperRuntime {
  kind: 'bundled' | 'system-node';
  exe: string;
}

/**
 * Locates the runtime used to launch the privileged helper. Prefers the app's
 * own binary in Electron's "run as Node" mode (ELECTRON_RUN_AS_NODE), so both
 * dev builds and packaged installs work without a system Node.js install.
 * PCTUNE_NODE overrides it for testing.
 */
export function resolveHelperRuntime(): HelperRuntime | null {
  const override = process.env.PCTUNE_NODE;
  if (override && fs.existsSync(override)) return { kind: 'system-node', exe: override };

  const execPath = process.execPath;
  if (execPath && !/\\node\.exe$/i.test(execPath) && fs.existsSync(execPath)) {
    return { kind: 'bundled', exe: execPath };
  }

  try {
    const out = execFileSync('where.exe', ['node.exe'], { encoding: 'utf8' });
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && fs.existsSync(s));
    if (first) return { kind: 'system-node', exe: first };
  } catch {
    /* not on PATH */
  }
  return null;
}

/** Display string for the info panel; null = the helper cannot run. */
export function resolveNodeExe(): string | null {
  const rt = resolveHelperRuntime();
  if (!rt) return null;
  return rt.kind === 'bundled' ? `bundled (${path.basename(rt.exe)})` : rt.exe;
}

/**
 * Writes the two launch artifacts for a helper job:
 *  - `<jobId>.helper.cmd` — runs the helper, setting ELECTRON_RUN_AS_NODE for
 *    the bundled runtime (a batch file avoids all cmd.exe quoting pitfalls);
 *  - `<jobId>.launch.ps1` — elevates the batch file via ShellExecute.
 * Exported so the launch chain can be verified without a UAC prompt.
 */
export function writeHelperLaunchFiles(opts: {
  runtime: HelperRuntime;
  helperJs: string;
  reqFile: string;
  jobsDir: string;
  jobId: string;
}): { cmdFile: string; launcherFile: string } {
  const cmdFile = path.join(opts.jobsDir, `${opts.jobId}.helper.cmd`);
  const batLines = ['@echo off'];
  if (opts.runtime.kind === 'bundled') batLines.push('set "ELECTRON_RUN_AS_NODE=1"');
  batLines.push(`"${opts.runtime.exe}" "${opts.helperJs}" "${opts.reqFile}"`);
  fs.writeFileSync(cmdFile, batLines.join('\r\n') + '\r\n', 'utf8');

  const launcherFile = path.join(opts.jobsDir, `${opts.jobId}.launch.ps1`);
  const launcher = [
    'param([string]$cmdFile)',
    "$ErrorActionPreference = 'Stop'",
    'Start-Process -FilePath $cmdFile -Verb RunAs -Wait -WindowStyle Hidden',
    'exit 0',
  ].join('\r\n');
  fs.writeFileSync(launcherFile, launcher, 'utf8');

  return { cmdFile, launcherFile };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, _stdout, stderr) => {
      let code = 0;
      if (err) {
        const raw = (err as { code?: number | string }).code;
        code = typeof raw === 'number' ? raw : 1;
      }
      resolve({ code, stderr: stderr ?? '' });
    });
  });
}

export async function runElevatedJob(opts: {
  op: 'apply' | 'revert';
  tweakIds: string[];
  paths: EnginePaths;
}): Promise<JobResult> {
  const runtime = resolveHelperRuntime();
  if (!runtime) {
    return {
      ok: false,
      code: 'UTIL004',
      error: 'No runtime available for the privileged helper. Reinstall the app (or set PCTUNE_NODE) so system tweaks can run.',
    };
  }

  const jobId = crypto.randomUUID();
  const reqFile = path.join(opts.paths.jobsDir, `${jobId}.req.json`);
  const resFile = path.join(opts.paths.jobsDir, `${jobId}.res.json`);
  const helperJs = path.join(__dirname, '..', 'helper', 'helper.js');

  if (!fs.existsSync(helperJs)) {
    return { ok: false, code: 'UTIL005', error: `Helper script missing at ${helperJs}. Run 'npm run build' first.` };
  }

  const req = {
    jobId,
    op: opts.op,
    tweakIds: opts.tweakIds,
    userDataDir: opts.paths.userDataDir,
    resFile,
  };
  fs.writeFileSync(reqFile, JSON.stringify(req, null, 2), 'utf8');

  const { cmdFile, launcherFile } = writeHelperLaunchFiles({
    runtime,
    helperJs,
    reqFile,
    jobsDir: opts.paths.jobsDir,
    jobId,
  });

  if (fs.existsSync(resFile)) fs.rmSync(resFile);

  const r = await run(
    EXE.powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcherFile, '-cmdFile', cmdFile],
    300_000
  );

  if (!fs.existsSync(resFile)) {
    const detail = r.stderr.trim();
    return {
      ok: false,
      code: 'ELEVATION_CANCELLED',
      error: detail
        ? `The privileged helper did not report a result: ${detail}`
        : 'The elevation prompt was cancelled, or the helper exited before reporting.',
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resFile, 'utf8')) as {
      ok: boolean;
      results?: ActionResult[];
      error?: { code: string; message: string };
    };
    return {
      ok: !!parsed.ok,
      code: parsed.error?.code,
      error: parsed.error?.message,
      results: parsed.results,
    };
  } catch (err) {
    return { ok: false, code: 'UTIL006', error: `Could not parse helper result: ${(err as Error).message}` };
  }
}

/** Creates a System Restore checkpoint (best effort; Windows limits 1 per 24h). */
export async function createRestorePoint(paths: EnginePaths): Promise<{ ok: boolean; message: string }> {
  const stamp = Date.now();
  const outFile = path.join(paths.jobsDir, `restore-${stamp}.out.txt`);
  const inner = path.join(paths.jobsDir, `restore-${stamp}.ps1`);
  const launcher = path.join(paths.jobsDir, `restore-${stamp}.launch.ps1`);

  fs.writeFileSync(
    inner,
    [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      `  Checkpoint-Computer -Description '${BRAND_NAME}' -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop`,
      `  Set-Content -LiteralPath '${outFile.replace(/'/g, "''")}' -Value 'OK'`,
      '} catch {',
      `  Set-Content -LiteralPath '${outFile.replace(/'/g, "''")}' -Value ('FAIL: ' + $_.Exception.Message)`,
      '}',
    ].join('\r\n'),
    'utf8'
  );
  fs.writeFileSync(
    launcher,
    [
      'param([string]$inner)',
      "$ErrorActionPreference = 'Stop'",
      'Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",(\'"\' + $inner + \'"\')) -Verb RunAs -Wait -WindowStyle Hidden',
      'exit 0',
    ].join('\r\n'),
    'utf8'
  );

  if (fs.existsSync(outFile)) fs.rmSync(outFile);
  await run(
    EXE.powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-inner', inner],
    600_000
  );

  if (!fs.existsSync(outFile)) {
    return { ok: false, message: 'Restore point request was cancelled or produced no output.' };
  }
  const txt = fs.readFileSync(outFile, 'utf8').trim();
  if (txt === 'OK') return { ok: true, message: 'Restore point created.' };
  const msg = txt.replace(/^FAIL:\s*/, '');
  const hint =
    /disabled|not enabled|frequency|once per/i.test(msg)
      ? ' Enable System Protection for C: in Windows, and note Windows allows one restore point per 24 hours.'
      : '';
  return { ok: false, message: `${msg}${hint}` };
}
