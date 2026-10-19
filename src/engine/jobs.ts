// Elevated-job envelopes and crash recovery.
//
// The unprivileged UI writes a small request file, then asks Windows to run it
// elevated. The helper must not trust arbitrary paths from that file: a local
// user can edit their own profile, and the helper runs as administrator. These
// helpers therefore enforce the canonical data directory, canonical result
// path, catalog IDs and system scope before the engine runs.
//
// The app also reconciles jobs left behind by a crash. A completed result is
// journaled and removed; an old request with no result is reported as
// interrupted so the user can run "Verify applied" instead of silently
// assuming the machine is unchanged.

import fs from 'fs';
import path from 'path';
import { EnginePaths, resolveUserDataDir } from './paths';
import { getTweak, tweakRequiresElevation } from '../catalog/catalog';
import { appendJournal } from './journal';
import { ActionResult, TweakStatus } from '../shared/types';

export const JOB_SCHEMA = 1;
export const JOB_STALE_MS = 10 * 60 * 1000;
const MAX_JOB_TWEAKS = 64;
const MAX_RESULT_STEPS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESULTS = new Set<TweakStatus>(['applied', 'reverted', 'failed', 'unsupported', 'up-to-date']);

export interface JobRequest {
  schema: 1;
  jobId: string;
  op: 'apply' | 'revert';
  tweakIds: string[];
  /** Absolute, canonical Frameblade data directory. */
  userDataDir: string;
  createdAt: number;
}

export interface JobFilePaths {
  reqFile: string;
  resFile: string;
}

export interface JobValidationOptions {
  /** Defaults to the current user's canonical Frameblade data directory. */
  expectedUserDataDir?: string;
  /** Elevated jobs may only contain system-scope tweaks. Defaults to true. */
  requireSystemScope?: boolean;
}

export interface JobRecoveryReport {
  interrupted: number;
  recovered: number;
  invalid: number;
  skipped: number;
}

export interface ValidatedJobResult {
  jobId: string;
  ok: boolean;
  elevated: boolean;
  results: ActionResult[];
  error?: { code: string; message: string };
}

function samePath(a: string, b: string): boolean {
  const clean = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return clean(a) === clean(b);
}

export function isValidJobId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

/** Canonical artifact names for a job. Throws for an unsafe job id. */
export function jobFilePaths(jobsDir: string, jobId: string): JobFilePaths {
  if (!isValidJobId(jobId)) throw new Error('Invalid elevated-job id.');
  return {
    reqFile: path.join(jobsDir, `${jobId}.req.json`),
    resFile: path.join(jobsDir, `${jobId}.res.json`),
  };
}

export function buildJobRequest(opts: {
  jobId: string;
  op: 'apply' | 'revert';
  tweakIds: string[];
  userDataDir: string;
  now?: number;
}): JobRequest {
  if (!isValidJobId(opts.jobId)) throw new Error('Invalid elevated-job id.');
  return {
    schema: JOB_SCHEMA,
    jobId: opts.jobId,
    op: opts.op,
    tweakIds: [...opts.tweakIds],
    userDataDir: path.resolve(opts.userDataDir),
    createdAt: opts.now ?? Date.now(),
  };
}

/**
 * Validates a parsed request. This is deliberately stricter than the UI:
 * unknown IDs, mixed user/system scope and paths outside the canonical data
 * directory are rejected before the elevated engine is constructed.
 */
export function validateJobRequest(
  raw: unknown,
  opts: JobValidationOptions = {}
): JobRequest {
  if (!raw || typeof raw !== 'object') throw new Error('Job request is not an object.');
  const r = raw as Record<string, unknown>;
  if (r.schema !== JOB_SCHEMA) throw new Error('Unsupported job request schema.');
  if (!isValidJobId(r.jobId)) throw new Error('Invalid job id.');
  if (r.op !== 'apply' && r.op !== 'revert') throw new Error('Invalid job operation.');
  if (!Array.isArray(r.tweakIds) || r.tweakIds.length === 0) {
    throw new Error('Job has no tweaks.');
  }
  if (r.tweakIds.length > MAX_JOB_TWEAKS) throw new Error('Job has too many tweaks.');

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of r.tweakIds) {
    if (typeof value !== 'string' || !value) throw new Error('Job contains an invalid tweak id.');
    if (seen.has(value)) throw new Error(`Duplicate tweak in job: ${value}`);
    seen.add(value);
    const tweak = getTweak(value);
    if (!tweak) throw new Error(`Unknown tweak in job: ${value}`);
    if ((opts.requireSystemScope ?? true) && !tweakRequiresElevation(tweak)) {
      throw new Error(`User-scope tweak in elevated job: ${value}`);
    }
    ids.push(value);
  }

  if (typeof r.userDataDir !== 'string' || !path.isAbsolute(r.userDataDir)) {
    throw new Error('Job data directory is not absolute.');
  }
  if (/[\r\n"]/.test(r.userDataDir)) throw new Error('Job data directory contains unsafe characters.');
  const allowedDir = opts.expectedUserDataDir ?? resolveUserDataDir();
  if (!samePath(r.userDataDir, allowedDir)) {
    throw new Error('Job data directory is outside the Frameblade profile.');
  }

  const createdAt = r.createdAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) {
    throw new Error('Job creation time is invalid.');
  }

  return {
    schema: JOB_SCHEMA,
    jobId: r.jobId,
    op: r.op,
    tweakIds: ids,
    userDataDir: path.resolve(r.userDataDir),
    createdAt,
  };
}

/** Reads and validates a request file, including its canonical name/location. */
export function readJobRequest(
  reqFile: string,
  jobsDir: string,
  opts: JobValidationOptions = {}
): { request: JobRequest; paths: JobFilePaths } {
  const resolved = path.resolve(reqFile);
  const resolvedJobs = path.resolve(jobsDir);
  if (!samePath(path.dirname(resolved), resolvedJobs)) {
    throw new Error('Job request is outside the jobs directory.');
  }
  const match = path.basename(resolved).match(/^([0-9a-f-]{36})\.req\.json$/i);
  if (!match || !isValidJobId(match[1])) throw new Error('Job request has an invalid name.');
  const text = fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(text) as unknown;
  const request = validateJobRequest(parsed, opts);
  if (request.jobId.toLowerCase() !== match[1].toLowerCase()) {
    throw new Error('Job id does not match the request file name.');
  }
  const paths = jobFilePaths(resolvedJobs, request.jobId);
  if (!samePath(paths.reqFile, resolved)) throw new Error('Job request path is not canonical.');
  return { request, paths };
}

export function validateJobResult(raw: unknown, request: JobRequest): ValidatedJobResult {
  if (!raw || typeof raw !== 'object') throw new Error('Job result is not an object.');
  const r = raw as Record<string, unknown>;
  if (r.jobId !== request.jobId) throw new Error('Job result id does not match the request.');
  if (typeof r.ok !== 'boolean') throw new Error('Job result is missing its status.');
  if (!Array.isArray(r.results)) throw new Error('Job result has no result list.');
  if (r.results.length > request.tweakIds.length) throw new Error('Job result has too many entries.');

  const allowed = new Set(request.tweakIds);
  const seen = new Set<string>();
  const results: ActionResult[] = [];
  for (const item of r.results) {
    if (!item || typeof item !== 'object') throw new Error('Job result contains an invalid entry.');
    const a = item as Record<string, unknown>;
    if (typeof a.tweakId !== 'string' || !allowed.has(a.tweakId)) {
      throw new Error('Job result contains a tweak outside the request.');
    }
    if (seen.has(a.tweakId)) throw new Error(`Duplicate result for ${a.tweakId}.`);
    seen.add(a.tweakId);
    if (typeof a.status !== 'string' || !RESULTS.has(a.status as TweakStatus)) {
      throw new Error(`Invalid status for ${a.tweakId}.`);
    }
    const steps = Array.isArray(a.steps)
      ? a.steps
          .slice(0, MAX_RESULT_STEPS)
          .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
          .map((s) => ({
            ts: typeof s.ts === 'number' ? s.ts : 0,
            level: s.level === 'warn' ? ('warn' as const) : s.level === 'error' ? ('error' as const) : ('info' as const),
            message: typeof s.message === 'string' ? s.message.slice(0, 1000) : '',
            ...(typeof s.code === 'string' ? { code: s.code } : {}),
          }))
      : [];
    results.push({
      tweakId: a.tweakId,
      status: a.status as TweakStatus,
      ...(typeof a.errorCode === 'string' ? { errorCode: a.errorCode } : {}),
      ...(typeof a.errorMessage === 'string' ? { errorMessage: a.errorMessage } : {}),
      ...(typeof a.rebootRequired === 'boolean' ? { rebootRequired: a.rebootRequired } : {}),
      steps,
    });
  }

  let error: ValidatedJobResult['error'];
  if (r.error && typeof r.error === 'object') {
    const e = r.error as Record<string, unknown>;
    if (typeof e.code === 'string' && typeof e.message === 'string') {
      error = { code: e.code, message: e.message.slice(0, 2000) };
    }
  }

  return {
    jobId: request.jobId,
    ok: r.ok,
    elevated: r.elevated === true,
    results,
    ...(error ? { error } : {}),
  };
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

function removeQuiet(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* a locked file is retried on the next launch */
  }
}

/**
 * Reconciles stale job files at startup. Recent requests are left alone so an
 * elevated helper that is still running can finish. After the grace period a
 * result is journaled, or an interrupted job is reported with a warning.
 */
export function reconcileJobs(
  paths: EnginePaths,
  opts: { graceMs?: number; now?: number; expectedUserDataDir?: string } = {}
): JobRecoveryReport {
  const report: JobRecoveryReport = { interrupted: 0, recovered: 0, invalid: 0, skipped: 0 };
  {
    let names: string[];
    try {
      names = fs.readdirSync(paths.jobsDir);
    } catch {
      return report;
    }
    const graceMs = opts.graceMs ?? JOB_STALE_MS;
    const now = opts.now ?? Date.now();

    for (const name of names) {
      if (!name.endsWith('.req.json')) continue;
      const reqFile = path.join(paths.jobsDir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(reqFile);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs < graceMs) {
        report.skipped++;
        continue;
      }

      let request: JobRequest;
      let files: JobFilePaths;
      try {
        const parsed = readJobRequest(reqFile, paths.jobsDir, {
          expectedUserDataDir: opts.expectedUserDataDir,
          requireSystemScope: true,
        });
        request = parsed.request;
        files = parsed.paths;
      } catch (err) {
        report.invalid++;
        journalJob(
          paths,
          'warn',
          `discarded invalid elevated job ${name}: ${(err as Error).message}`,
          'UTIL006'
        );
        removeQuiet(reqFile);
        const id = name.replace(/\.req\.json$/i, '');
        removeQuiet(path.join(paths.jobsDir, `${id}.res.json`));
        removeQuiet(path.join(paths.jobsDir, `${id}.res.json.running`));
        continue;
      }

      if (fs.existsSync(files.resFile)) {
        try {
          const raw = JSON.parse(fs.readFileSync(files.resFile, 'utf8')) as unknown;
          const result = validateJobResult(raw, request);
          const failed = result.results.filter((r) => r.status === 'failed').length;
          const applied = result.results.filter((r) => r.status === 'applied').length;
          const reverted = result.results.filter((r) => r.status === 'reverted').length;
          if (!result.ok || failed > 0) {
            report.interrupted++;
            journalJob(
              paths,
              'warn',
              `recovered elevated job ${request.jobId.slice(0, 8)} with problems: ` +
                `${applied} applied, ${reverted} reverted, ${failed} failed` +
                (result.error ? ` (${result.error.code}: ${result.error.message})` : ''),
              result.error?.code ?? 'UTIL006'
            );
          } else {
            report.recovered++;
            journalJob(
              paths,
              'info',
              `recovered elevated job ${request.jobId.slice(0, 8)} after restart: ` +
                `${applied} applied, ${reverted} reverted`
            );
          }
        } catch (err) {
          report.invalid++;
          journalJob(
            paths,
            'warn',
            `discarded invalid result for elevated job ${request.jobId.slice(0, 8)}: ${(err as Error).message}`,
            'UTIL006'
          );
        }
      } else {
        report.interrupted++;
        journalJob(
          paths,
          'warn',
          `elevated job ${request.jobId.slice(0, 8)} was interrupted before reporting. ` +
            'Run "Verify applied" and review the journal before assuming settings are unchanged.',
          'UTIL006'
        );
      }

      removeQuiet(files.reqFile);
      removeQuiet(files.resFile);
      removeQuiet(`${files.resFile}.running`);
    }

    // Legacy launch scripts and orphaned artifacts from pre-0.1.1 builds (or
    // a crashed cleanup) are never needed again after the grace period.
    const requestIds = new Set(
      names
        .filter((name) => name.endsWith('.req.json'))
        .map((name) => name.replace(/\.req\.json$/i, '').toLowerCase())
    );
    for (const name of names) {
      const orphan =
        /\.(res\.json|res\.json\.running|helper\.cmd|launch\.ps1)$/i.test(name) &&
        (() => {
          const id = name.split('.')[0]?.toLowerCase() ?? '';
          return !requestIds.has(id);
        })();
      if (!orphan) continue;
      const file = path.join(paths.jobsDir, name);
      try {
        if (now - fs.statSync(file).mtimeMs >= graceMs) removeQuiet(file);
      } catch {
        /* ignore */
      }
    }
  }
  return report;
}
