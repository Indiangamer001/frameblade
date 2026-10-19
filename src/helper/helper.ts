// Privileged helper. Started elevated by the app (or manually) with a request
// file; runs the same engine with elevated=true and writes a canonical result
// file. The request is validated before any path or tweak id is trusted.

import fs from 'fs';
import path from 'path';
import { Engine } from '../engine/engine';
import { ensureDirs, makePaths, resolveUserDataDir } from '../engine/paths';
import { jobFilePaths, readJobRequest, JobRequest } from '../engine/jobs';
import { isElevated } from '../engine/win';
import { EngineError } from '../shared/errors';
import { ActionResult } from '../shared/types';

interface JobResponse {
  jobId: string;
  ok: boolean;
  elevated: boolean;
  user: string;
  results: ActionResult[];
  error?: { code: string; message: string };
}

function writeResult(file: string, out: JobResponse): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Runs one elevated job. Returns a process exit code; it never calls
 * process.exit so the Electron main process can use the same code path.
 */
export async function runHelper(reqPath: string | undefined): Promise<number> {
  if (!reqPath) {
    console.error('usage: frameblade --frameblade-helper <request.json>');
    return 2;
  }

  const expectedDataDir = resolveUserDataDir();
  const expectedJobsDir = path.join(expectedDataDir, 'jobs');
  let request: JobRequest;
  let resFile: string;
  try {
    const parsed = readJobRequest(reqPath, expectedJobsDir, {
      expectedUserDataDir: expectedDataDir,
      requireSystemScope: true,
    });
    request = parsed.request;
    resFile = parsed.paths.resFile;
  } catch (err) {
    console.error(`invalid elevated job request: ${(err as Error).message}`);
    return 2;
  }

  const out: JobResponse = {
    jobId: request.jobId,
    ok: false,
    elevated: false,
    user: process.env.USERNAME ?? '',
    results: [],
  };
  const runningFile = `${resFile}.running`;
  try {
    fs.writeFileSync(
      runningFile,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      'utf8'
    );
  } catch {
    /* the result and the reconciliation marker are both best-effort */
  }

  try {
    const paths = makePaths(request.userDataDir);
    ensureDirs(paths);

    const elevated = await isElevated();
    out.elevated = elevated;
    if (!elevated) {
      throw new EngineError('UTIL004', 'The helper was started without administrator rights.');
    }

    const engine = new Engine(paths, true);
    out.results =
      request.op === 'apply'
        ? await engine.applyMany(request.tweakIds)
        : await engine.revertMany(request.tweakIds);
    out.ok = out.results.every((r) => r.status !== 'failed');
  } catch (err) {
    const ee = EngineError.from(err);
    out.error = { code: ee.code, message: ee.message };
  }

  try {
    fs.mkdirSync(path.dirname(resFile), { recursive: true });
    writeResult(resFile, out);
    // The result is durable. Remove the claim marker; if removal fails it is
    // harmless because the result already exists.
    try {
      fs.rmSync(runningFile, { force: true });
    } catch {
      /* startup reconciliation removes stale markers */
    }
    return 0;
  } catch (err) {
    // Leave the claim marker in place so the next launch reports an
    // interrupted job instead of assuming that UAC was cancelled.
    console.error('failed to write result file:', err);
    return 1;
  }
}

if (require.main === module) {
  void runHelper(process.argv[2])
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
