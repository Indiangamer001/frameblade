// Launches the privileged helper through a UAC elevation prompt and waits
// for its result file. Job-per-operation: no long-lived elevated process.
//
// Security notes:
//  - The launcher is passed to PowerShell as an encoded command, not written
//    to a user-writable .cmd/.ps1 file. A local process cannot race the UAC
//    prompt by editing a script that is about to run elevated.
//  - The helper derives its own result path and validates the request against
//    the canonical data directory before touching the engine.
//  - A .running marker distinguishes a UAC cancellation from an interrupted
//    helper, so crash recovery can report the latter accurately.

import { execFile, execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { EnginePaths } from '../engine/paths';
import { EXE } from '../engine/win';
import { appendJournal } from '../engine/journal';
import {
  buildJobRequest,
  jobFilePaths,
  validateJobResult,
  JobRequest,
} from '../engine/jobs';
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
 * own binary, so both dev builds and packaged installs work without a system
 * Node.js install. PCTUNE_NODE overrides it for testing.
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

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function winArg(value: string): string {
  if (/[\r\n"]/.test(value)) throw new Error('Unsafe path in elevated launch.');
  return `"${value}"`;
}

/**
 * Builds the outer PowerShell command that raises one UAC prompt and waits for
 * the helper. Exported so the launch chain can be tested without a UAC prompt.
 */
export function buildHelperLaunchScript(opts: {
  runtime: HelperRuntime;
  helperJs: string;
  reqFile: string;
  /** Development app path; Electron needs it when process.defaultApp is true. */
  appPath?: string;
}): string {
  if (/[\r\n"]/.test(opts.runtime.exe) || /[\r\n"]/.test(opts.helperJs)) {
    throw new Error('Unsafe path in elevated launch.');
  }
  const args: string[] = [];
  if (opts.runtime.kind === 'bundled') {
    if (opts.appPath) args.push(opts.appPath);
    args.push('--frameblade-helper', opts.reqFile);
  } else {
    args.push(opts.helperJs, opts.reqFile);
  }
  const argList = args.map(winArg).join(' ');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -FilePath ${psQuote(opts.runtime.exe)} -ArgumentList ${psQuote(argList)} -Verb RunAs -Wait -WindowStyle Hidden -PassThru`,
    'if ($null -eq $p) { exit 1 }',
    'exit 0',
  ].join('\r\n');
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

function journalJob(
  paths: EnginePaths,
  level: 'info' | 'warn',
  message: string,
  code?: string
): void {
  appendJournal(paths, {
    ts: Date.now(),
    op: 'system',
    level,
    tweakId: 'elevated-job',
    ...(code ? { code } : {}),
    message,
  });
}

function cleanupJobFiles(reqFile: string, resFile: string, runningFile: string): void {
  for (const file of [reqFile, resFile, runningFile]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* a locked file is retried by startup reconciliation */
    }
  }
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
      error:
        'No runtime available for the privileged helper. Reinstall the app (or set PCTUNE_NODE) so system tweaks can run.',
    };
  }

  const jobId = crypto.randomUUID();
  const { reqFile, resFile } = jobFilePaths(opts.paths.jobsDir, jobId);
  const runningFile = `${resFile}.running`;
  const helperJs = path.join(__dirname, '..', 'helper', 'helper.js');

  if (!fs.existsSync(helperJs)) {
    return {
      ok: false,
      code: 'UTIL005',
      error: `Helper script missing at ${helperJs}. Run 'npm run build' first.`,
    };
  }

  let request: JobRequest;
  try {
    request = buildJobRequest({
      jobId,
      op: opts.op,
      tweakIds: opts.tweakIds,
      userDataDir: opts.paths.userDataDir,
    });
    fs.mkdirSync(opts.paths.jobsDir, { recursive: true });
    fs.writeFileSync(reqFile, JSON.stringify(request, null, 2), 'utf8');
  } catch (err) {
    return { ok: false, code: 'UTIL006', error: `Could not create elevated job: ${(err as Error).message}` };
  }

  let script: string;
  try {
    script = buildHelperLaunchScript({
      runtime,
      helperJs,
      reqFile,
      appPath:
        runtime.kind === 'bundled' && process.defaultApp
          ? path.resolve(process.argv[1] || '.')
          : undefined,
    });
  } catch (err) {
    cleanupJobFiles(reqFile, resFile, runningFile);
    return { ok: false, code: 'UTIL006', error: `Could not build elevated launch: ${(err as Error).message}` };
  }

  const r = await run(
    EXE.powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedCommand(script),
    ],
    300_000
  );

  if (!fs.existsSync(resFile)) {
    const started = fs.existsSync(runningFile);
    if (started) {
      journalJob(
        opts.paths,
        'warn',
        `elevated job ${jobId.slice(0, 8)} did not report a result; it will be reconciled on the next launch`,
        'UTIL006'
      );
    } else {
      // No helper ever claimed the job, so this is a cancelled UAC prompt, not
      // an interrupted apply.
      cleanupJobFiles(reqFile, resFile, runningFile);
    }
    const detail = r.stderr.trim();
    return {
      ok: false,
      code: 'ELEVATION_CANCELLED',
      error: detail
        ? `The privileged helper did not report a result: ${detail}`
        : 'The elevation prompt was cancelled, or the helper exited before reporting.',
    };
  }

  let result: ReturnType<typeof validateJobResult>;
  try {
    const parsed = JSON.parse(fs.readFileSync(resFile, 'utf8')) as unknown;
    result = validateJobResult(parsed, request);
  } catch (err) {
    journalJob(
      opts.paths,
      'warn',
      `elevated job ${jobId.slice(0, 8)} returned an invalid result: ${(err as Error).message}`,
      'UTIL006'
    );
    cleanupJobFiles(reqFile, resFile, runningFile);
    return { ok: false, code: 'UTIL006', error: `Could not validate helper result: ${(err as Error).message}` };
  }

  const failed = result.results.filter((x) => x.status === 'failed').length;
  journalJob(
    opts.paths,
    result.ok && failed === 0 ? 'info' : 'warn',
    `elevated job ${jobId.slice(0, 8)} ${opts.op === 'apply' ? 'apply' : 'revert'} finished: ` +
      `${result.results.filter((x) => x.status === 'applied').length} applied, ` +
      `${result.results.filter((x) => x.status === 'reverted').length} reverted, ${failed} failed` +
      (result.error ? ` (${result.error.code}: ${result.error.message})` : ''),
    result.ok && failed === 0 ? undefined : result.error?.code ?? 'OPT002'
  );
  cleanupJobFiles(reqFile, resFile, runningFile);

  return {
    ok: result.ok,
    code: result.error?.code,
    error: result.error?.message ?? (failed > 0 ? `${failed} helper action(s) failed.` : undefined),
    results: result.results,
  };
}

/** Creates a System Restore checkpoint (best effort; Windows limits 1 per 24h). */
export async function createRestorePoint(paths: EnginePaths): Promise<{ ok: boolean; message: string }> {
  const stamp = Date.now();
  const outFile = path.join(paths.jobsDir, `restore-${stamp}.out.txt`);

  const inner = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  Checkpoint-Computer -Description ${psQuote(BRAND_NAME)} -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop`,
    `  Set-Content -LiteralPath ${psQuote(outFile)} -Value 'OK'`,
    '} catch {',
    `  Set-Content -LiteralPath ${psQuote(outFile)} -Value ('FAIL: ' + $_.Exception.Message)`,
    '}',
  ].join('\r\n');
  const innerEncoded = encodedCommand(inner);
  const outer = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -FilePath ${psQuote(EXE.powershell)} -ArgumentList ${psQuote(
      `-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${innerEncoded}`
    )} -Verb RunAs -Wait -WindowStyle Hidden -PassThru`,
    'if ($null -eq $p) { exit 1 }',
    'exit 0',
  ].join('\r\n');

  if (fs.existsSync(outFile)) fs.rmSync(outFile);
  await run(
    EXE.powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedCommand(outer),
    ],
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
