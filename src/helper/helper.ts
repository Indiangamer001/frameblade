// Privileged helper. Started elevated by the app (or manually) with a request
// file; runs the same engine with elevated=true and writes a result file.

import fs from 'fs';
import { Engine } from '../engine/engine';
import { ensureDirs, makePaths } from '../engine/paths';
import { isElevated } from '../engine/win';
import { EngineError } from '../shared/errors';
import { ActionResult } from '../shared/types';

interface JobRequest {
  jobId: string;
  op: 'apply' | 'revert';
  tweakIds: string[];
  userDataDir: string;
  resFile: string;
}

interface JobResponse {
  jobId: string;
  ok: boolean;
  elevated: boolean;
  user: string;
  results: ActionResult[];
  error?: { code: string; message: string };
}

async function main(): Promise<void> {
  const reqPath = process.argv[2];
  if (!reqPath || !fs.existsSync(reqPath)) {
    console.error('usage: node helper.js <request.json>');
    process.exit(2);
  }

  const req = JSON.parse(fs.readFileSync(reqPath, 'utf8')) as JobRequest;
  const out: JobResponse = {
    jobId: req.jobId,
    ok: false,
    elevated: false,
    user: process.env.USERNAME ?? '',
    results: [],
  };

  try {
    const paths = makePaths(req.userDataDir);
    ensureDirs(paths);

    const elevated = await isElevated();
    out.elevated = elevated;
    if (!elevated) {
      throw new EngineError('UTIL004', 'The helper was started without administrator rights.');
    }

    const engine = new Engine(paths, true);
    out.results =
      req.op === 'apply'
        ? await engine.applyMany(req.tweakIds)
        : await engine.revertMany(req.tweakIds);
    out.ok = out.results.every((r) => r.status !== 'failed');
  } catch (err) {
    const ee = EngineError.from(err);
    out.error = { code: ee.code, message: ee.message };
  }

  try {
    fs.writeFileSync(req.resFile, JSON.stringify(out, null, 2), 'utf8');
  } catch (err) {
    console.error('failed to write result file:', err);
    process.exit(1);
  }
  process.exit(0);
}

void main();
