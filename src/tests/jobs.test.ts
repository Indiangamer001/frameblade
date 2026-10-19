import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureDirs, makePaths } from '../engine/paths';
import {
  buildJobRequest,
  jobFilePaths,
  readJobRequest,
  reconcileJobs,
  validateJobRequest,
  validateJobResult,
} from '../engine/jobs';
import { readJournal } from '../engine/journal';

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frameblade-jobs-'));
  const paths = makePaths(path.join(root, 'Frameblade'));
  ensureDirs(paths);
  return paths;
}

function jobFor(paths: ReturnType<typeof makePaths>, op: 'apply' | 'revert' = 'apply') {
  return buildJobRequest({
    jobId: '00000000-0000-4000-8000-000000000001',
    op,
    tweakIds: ['timer-resolution'],
    userDataDir: paths.userDataDir,
  });
}

function writeRequest(paths: ReturnType<typeof makePaths>, req = jobFor(paths)) {
  const files = jobFilePaths(paths.jobsDir, req.jobId);
  fs.writeFileSync(files.reqFile, JSON.stringify(req, null, 2), 'utf8');
  return { req, files };
}

function ageFile(file: string): void {
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
}

test('jobs: request validation accepts system tweaks in the canonical profile', () => {
  const paths = tempPaths();
  const req = jobFor(paths);
  const parsed = validateJobRequest(req, {
    expectedUserDataDir: paths.userDataDir,
    requireSystemScope: true,
  });
  assert.equal(parsed.jobId, req.jobId);
  assert.deepEqual(parsed.tweakIds, ['timer-resolution']);
});

test('jobs: request validation rejects user-scope, unknown and out-of-profile ids', () => {
  const paths = tempPaths();
  const expectedUserDataDir = paths.userDataDir;
  const user = buildJobRequest({
    jobId: '00000000-0000-4000-8000-000000000002',
    op: 'apply',
    tweakIds: ['disable-game-bar-dvr'],
    userDataDir: paths.userDataDir,
  });
  assert.throws(
    () => validateJobRequest(user, { expectedUserDataDir, requireSystemScope: true }),
    /User-scope/
  );

  const unknown = { ...jobFor(paths), tweakIds: ['not-a-tweak'] };
  assert.throws(
    () => validateJobRequest(unknown, { expectedUserDataDir, requireSystemScope: true }),
    /Unknown tweak/
  );

  const other = buildJobRequest({
    jobId: '00000000-0000-4000-8000-000000000003',
    op: 'apply',
    tweakIds: ['timer-resolution'],
    userDataDir: path.join(os.tmpdir(), 'not-frameblade'),
  });
  assert.throws(
    () => validateJobRequest(other, { expectedUserDataDir, requireSystemScope: true }),
    /outside/
  );
});

test('jobs: request files are canonical and cannot escape the jobs directory', () => {
  const paths = tempPaths();
  const { req, files } = writeRequest(paths);
  const parsed = readJobRequest(files.reqFile, paths.jobsDir, {
    expectedUserDataDir: paths.userDataDir,
    requireSystemScope: true,
  });
  assert.equal(parsed.request.jobId, req.jobId);

  const outside = path.join(paths.userDataDir, 'outside.req.json');
  fs.writeFileSync(outside, JSON.stringify(req), 'utf8');
  assert.throws(
    () =>
      readJobRequest(outside, paths.jobsDir, {
        expectedUserDataDir: paths.userDataDir,
        requireSystemScope: true,
      }),
    /outside the jobs directory/
  );
});

test('jobs: results cannot name tweaks that were not requested', () => {
  const paths = tempPaths();
  const req = jobFor(paths);
  const good = {
    jobId: req.jobId,
    ok: true,
    elevated: true,
    results: [{ tweakId: 'timer-resolution', status: 'applied', steps: [] }],
  };
  assert.equal(validateJobResult(good, req).results.length, 1);
  assert.throws(
    () =>
      validateJobResult(
        {
          ...good,
          results: [{ tweakId: 'disable-game-bar-dvr', status: 'applied', steps: [] }],
        },
        req
      ),
    /outside the request/
  );
});

test('jobs: startup reconciliation reports an interrupted job and removes its files', () => {
  const paths = tempPaths();
  const { files } = writeRequest(paths);
  ageFile(files.reqFile);

  const report = reconcileJobs(paths, {
    graceMs: 1000,
    now: Date.now(),
    expectedUserDataDir: paths.userDataDir,
  });
  assert.equal(report.interrupted, 1);
  assert.equal(fs.existsSync(files.reqFile), false);
  const lines = readJournal(paths, 20);
  assert.ok(lines.some((l) => l.tweakId === 'elevated-job' && l.level === 'warn'));
});

test('jobs: startup reconciliation journals a completed result', () => {
  const paths = tempPaths();
  const { req, files } = writeRequest(paths);
  fs.writeFileSync(
    files.resFile,
    JSON.stringify({
      jobId: req.jobId,
      ok: true,
      elevated: true,
      results: [{ tweakId: 'timer-resolution', status: 'applied', steps: [] }],
    }),
    'utf8'
  );
  ageFile(files.reqFile);
  ageFile(files.resFile);

  const report = reconcileJobs(paths, {
    graceMs: 1000,
    now: Date.now(),
    expectedUserDataDir: paths.userDataDir,
  });
  assert.equal(report.recovered, 1);
  assert.equal(report.interrupted, 0);
  assert.equal(fs.existsSync(files.reqFile), false);
  assert.equal(fs.existsSync(files.resFile), false);
  assert.ok(
    readJournal(paths, 20).some((l) => l.tweakId === 'elevated-job' && l.level === 'info')
  );
});

test('jobs: startup reconciliation leaves a recent job for a running helper', () => {
  const paths = tempPaths();
  const { files } = writeRequest(paths);
  const report = reconcileJobs(paths, {
    graceMs: 10 * 60 * 1000,
    now: Date.now(),
    expectedUserDataDir: paths.userDataDir,
  });
  assert.equal(report.skipped, 1);
  assert.equal(fs.existsSync(files.reqFile), true);
});

test('jobs: startup reconciliation discards an invalid request', () => {
  const paths = tempPaths();
  const req = jobFor(paths);
  const files = jobFilePaths(paths.jobsDir, req.jobId);
  fs.writeFileSync(files.reqFile, JSON.stringify({ ...req, tweakIds: ['not-a-tweak'] }), 'utf8');
  ageFile(files.reqFile);

  const report = reconcileJobs(paths, {
    graceMs: 1000,
    now: Date.now(),
    expectedUserDataDir: paths.userDataDir,
  });
  assert.equal(report.invalid, 1);
  assert.equal(fs.existsSync(files.reqFile), false);
});
