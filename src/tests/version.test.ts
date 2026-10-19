import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { APP_VERSION } from '../engine/paths';

test('version: APP_VERSION is read from package.json', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
  ) as { version?: unknown };
  assert.equal(typeof pkg.version, 'string');
  assert.equal(APP_VERSION, pkg.version);
});
