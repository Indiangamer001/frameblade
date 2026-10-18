import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getCatalog, recommendedIds } from '../catalog/catalog';
import { builtinModes } from '../catalog/modes';
import {
  addCustomProfile,
  loadProfiles,
  markModeUsed,
  removeCustomProfile,
} from '../engine/profiles';
import { makePaths } from '../engine/paths';
import { parseRestorePointQuery, parseRestorePointTime } from '../engine/restore';

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frameblade-test-'));
  return makePaths(dir);
}

test('modes: Turbo Gaming equals the recommended catalog set', () => {
  const turbo = builtinModes().find((m) => m.id === 'turbo-gaming');
  assert.ok(turbo);
  assert.deepEqual([...turbo.tweakIds].sort(), [...recommendedIds()].sort());
  assert.ok(turbo.tweakIds.length >= 5);
  const all = new Set(getCatalog().map((t) => t.id));
  for (const id of turbo.tweakIds) assert.ok(all.has(id), `unknown tweak in mode: ${id}`);
});

test('profiles: custom profile round trip (save, update by name, delete)', () => {
  const paths = tempPaths();
  const a = addCustomProfile(paths, 'My Setup', ['x', 'y']);
  let data = loadProfiles(paths);
  assert.equal(data.custom.length, 1);
  assert.deepEqual(data.custom[0].tweakIds, ['x', 'y']);

  const b = addCustomProfile(paths, 'my setup', ['x', 'y', 'z']); // same name -> update
  data = loadProfiles(paths);
  assert.equal(data.custom.length, 1);
  assert.equal(b.id, a.id);
  assert.deepEqual(data.custom[0].tweakIds, ['x', 'y', 'z']);

  assert.equal(removeCustomProfile(paths, a.id), true);
  assert.equal(loadProfiles(paths).custom.length, 0);
  assert.equal(removeCustomProfile(paths, a.id), false);
});

test('profiles: last mode is remembered; deleting it clears the memory', () => {
  const paths = tempPaths();
  markModeUsed(paths, 'turbo-gaming');
  let data = loadProfiles(paths);
  assert.equal(data.lastMode, 'turbo-gaming');
  assert.ok((data.lastModeAt ?? 0) > 0);

  const p = addCustomProfile(paths, 'Nightly', ['x']);
  markModeUsed(paths, p.id);
  removeCustomProfile(paths, p.id);
  data = loadProfiles(paths);
  assert.equal(data.lastMode, null);
});

test('profiles: empty name or empty selection rejected', () => {
  const paths = tempPaths();
  assert.throws(() => addCustomProfile(paths, '   ', ['x']));
  assert.throws(() => addCustomProfile(paths, 'name', []));
});

test('restore: parseRestorePointTime handles CIM and ISO timestamps', () => {
  assert.equal(
    parseRestorePointTime('20261019154212.000000-000'),
    Date.UTC(2026, 9, 19, 15, 42, 12)
  );
  assert.equal(parseRestorePointTime('2026-10-19T15:42:12Z'), Date.UTC(2026, 9, 19, 15, 42, 12));
  assert.equal(parseRestorePointTime(''), null);
  assert.equal(parseRestorePointTime('not a date'), null);
});

test('restore: parseRestorePointQuery envelope', () => {
  assert.deepEqual(parseRestorePointQuery(null), { ok: false, point: null });
  assert.deepEqual(parseRestorePointQuery({ ok: true, point: null }), { ok: true, point: null });
  assert.equal(parseRestorePointQuery({ ok: false }).ok, false);

  const p = parseRestorePointQuery({
    ok: true,
    point: { creationTime: '2026-10-19T15:42:12Z', description: 'Frameblade' },
  });
  assert.equal(p.ok, true);
  assert.equal(p.point?.unixMs, Date.UTC(2026, 9, 19, 15, 42, 12));
  assert.equal(p.point?.description, 'Frameblade');

  assert.equal(parseRestorePointQuery({ ok: true, point: { creationTime: 'garbage' } }).point, null);
});
