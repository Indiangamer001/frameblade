import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  boostScript,
  displayTitle,
  entryFromName,
  entryFromPath,
  loadWatcher,
  matchRunning,
  parseTasklistCsv,
  saveWatcher,
  validGameName,
} from '../engine/watcher';
import { makePaths } from '../engine/paths';
import { getCatalog } from '../catalog/catalog';

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frameblade-watcher-'));
  return makePaths(dir);
}

test('watcher: parseTasklistCsv extracts unique lowercase process names', () => {
  const out = [
    '"System Idle Process","0","Services","0","8 K"',
    '"cs2.exe","1234","Console","1","1,234,567 K"',
    '"CS2.exe","99","Console","1","1 K"',
    '',
  ].join('\r\n');
  assert.deepEqual(parseTasklistCsv(out), ['system idle process', 'cs2.exe']);
});

test('watcher: matchRunning is case-insensitive', () => {
  assert.deepEqual(matchRunning(['cs2.exe', 'valorant.exe'], ['CS2.EXE', 'chrome.exe']), ['cs2.exe']);
  assert.deepEqual(matchRunning([], ['cs2.exe']), []);
});

test('watcher: validGameName normalizes and rejects unsafe names', () => {
  assert.equal(validGameName('CS2.exe'), 'cs2.exe');
  assert.equal(validGameName('  ForzaMotorsport.exe  '), 'forzamotorsport.exe');
  assert.equal(validGameName('my_game-2'), 'my_game-2.exe');
  assert.equal(validGameName('Forza Horizon 5'), 'forza horizon 5.exe'); // spaces are fine
  assert.equal(validGameName("cs2.exe'; whoami ;'"), null); // shell metachars
  assert.equal(validGameName('C:\\Games\\x.exe'), null); // path separators
  assert.equal(validGameName('a'.repeat(80)), null); // too long
  assert.equal(validGameName(''), null);
});

test('watcher: entryFromName and entryFromPath build library entries', () => {
  assert.deepEqual(entryFromName('CS2.exe'), { exe: 'cs2.exe', path: null });
  assert.equal(entryFromName("cs2.exe'; calc"), null);

  const p = 'C:\\SteamLibrary\\steamapps\\common\\dota 2 beta\\game\\bin\\win64\\dota2.exe';
  assert.deepEqual(entryFromPath(p), { exe: 'dota2.exe', path: p });
  assert.equal(entryFromPath('C:\\Games\\readme.txt'), null); // not an exe
  assert.deepEqual(entryFromPath('C:\\Games\\My Game.exe'), { exe: 'my game.exe', path: 'C:\\Games\\My Game.exe' });
});

test('watcher: loadWatcher migrates v1 string entries and dedupes', () => {
  const paths = tempPaths();
  fs.mkdirSync(path.dirname(paths.watcherFile), { recursive: true });
  fs.writeFileSync(
    paths.watcherFile,
    JSON.stringify({ version: 1, enabled: true, games: ['CS2.exe', 'cs2.exe', 'bad/name'], priority: 'high', pollSeconds: 8 }),
    'utf8'
  );
  const cfg = loadWatcher(paths);
  assert.equal(cfg.version, 2);
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.games, [{ exe: 'cs2.exe', path: null }]);
});

test('watcher: v2 entries round-trip through save/load', () => {
  const paths = tempPaths();
  const cfg = loadWatcher(paths);
  cfg.enabled = true;
  cfg.priority = 'above-normal';
  cfg.timerResolution = true;
  cfg.games = [
    { exe: 'cs2.exe', path: 'C:\\Games\\cs2.exe' },
    { exe: 'fortnite.exe', path: null },
    {
      exe: 'tslgame.exe',
      path: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\PUBG\\TslGame.exe',
      title: 'PUBG: BATTLEGROUNDS',
      appid: '578080',
    },
  ];
  saveWatcher(paths, cfg);

  const again = loadWatcher(paths);
  assert.deepEqual(again.games, cfg.games);
  assert.equal(again.priority, 'above-normal');
  assert.equal(again.enabled, true);
  assert.equal(again.timerResolution, true);
  assert.equal(displayTitle(again.games[2]), 'PUBG: BATTLEGROUNDS');
  assert.equal(displayTitle(again.games[0]), 'cs2');

  // corrupt art fields are dropped instead of failing the whole file
  fs.writeFileSync(
    paths.watcherFile,
    JSON.stringify({
      version: 2,
      games: [{ exe: 'x.exe', path: null, appid: 'not-a-number', title: '\u0001\u0002' }],
    }),
    'utf8'
  );
  assert.deepEqual(loadWatcher(paths).games, [{ exe: 'x.exe', path: null }]);

  // a corrupt file falls back to defaults instead of throwing
  fs.writeFileSync(paths.watcherFile, '{nope', 'utf8');
  assert.deepEqual(loadWatcher(paths).games, []);
  assert.equal(loadWatcher(paths).timerResolution, false);
});

test('watcher: boostScript builds a quoted PriorityClass command', () => {
  const s = boostScript('cs2.exe', 'high');
  assert.ok(s.includes("Get-Process -Name 'cs2'"), s);
  assert.ok(s.includes("PriorityClass = 'High'"), s);
  const s2 = boostScript('foo.exe', 'above-normal');
  assert.ok(s2.includes("PriorityClass = 'AboveNormal'"), s2);
});

test('watcher: boostScript sanitizes hostile names (no PS injection)', () => {
  const s = boostScript("cs2.exe' ; Start-Process calc ; '", 'high');
  const quoted = /Get-Process -Name '([^']*)'/.exec(s);
  assert.ok(quoted, s);
  assert.match(quoted[1], /^[a-z0-9._ -]*$/i, 'quoted name may only contain inert characters');
  assert.ok(!s.includes("' ;"), 'hostile characters must not survive');
  // wildcards must be stripped so -Name cannot match other processes
  const w = boostScript('cs*', 'high');
  assert.ok(!/Get-Process -Name '[^']*\*/.test(w), w);
});

test('catalog: new M2 tweaks are present and well-formed', () => {
  const all = getCatalog();
  const sysmain = all.find((t) => t.id === 'disable-sysmain');
  assert.ok(sysmain, 'disable-sysmain missing');
  assert.ok(sysmain.actions.every((a) => a.scope === 'system'));
  const prio = all.find((t) => t.id === 'priority-separation-gaming');
  assert.ok(prio, 'priority-separation-gaming missing');
  assert.ok(!prio.recommended, 'gaming preset must not be in the recommended set');
});
