// Steam discovery: appmanifest parsing, library mapping and cover candidates.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  cdnCandidates,
  libraryCacheCover,
  matchApp,
  parseAcf,
  parseLibraryFolders,
  readApps,
  steamRefFromExe,
} from '../engine/steam';

const SAMPLE = `"AppState"
{
	"appid"		"578080"
	"Universe"		"1"
	"name"		"PUBG: BATTLEGROUNDS"
	"StateFlags"		"4"
	"installdir"		"PUBG"
	"SizeOnDisk"		"469693989"
}`;

test('steam: parseAcf reads appid, name and installdir', () => {
  assert.deepEqual(parseAcf(SAMPLE), { appid: '578080', installdir: 'PUBG', name: 'PUBG: BATTLEGROUNDS' });
  assert.equal(parseAcf('{ "appid" "5" }'), null); // missing installdir
  assert.equal(parseAcf('not an acf'), null);
});

test('steam: steamRefFromExe finds the library and game folder', () => {
  const p = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\PUBG\\TslGame\\Binaries\\Win64\\TslGame.exe';
  assert.deepEqual(steamRefFromExe(p), { libraryRoot: 'C:\\Program Files (x86)\\Steam', gameDir: 'PUBG' });
  const fwd = 'D:/Games/SteamLibrary/steamapps/common/Dota 2 beta/game/bin/win64/dota2.exe';
  assert.deepEqual(steamRefFromExe(fwd), {
    libraryRoot: 'D:\\Games\\SteamLibrary',
    gameDir: 'Dota 2 beta',
  });
  assert.equal(steamRefFromExe('C:\\Games\\MyGame\\game.exe'), null);
  assert.equal(steamRefFromExe(''), null);
});

test('steam: matchApp matches installdir case-insensitively', () => {
  const apps = [{ appid: '1', installdir: 'Counter-Strike Global Offensive', name: 'CS2' }];
  assert.equal(matchApp(apps, 'counter-strike global offensive')?.appid, '1');
  assert.equal(matchApp(apps, 'nope'), null);
});

test('steam: readApps + libraryCacheCover work against a library layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-steam-'));
  const steamapps = path.join(root, 'steamapps');
  fs.mkdirSync(path.join(steamapps, 'common', 'PUBG'), { recursive: true });
  fs.writeFileSync(path.join(steamapps, 'appmanifest_578080.acf'), SAMPLE, 'utf8');
  fs.writeFileSync(path.join(steamapps, 'appmanifest_1.acf'), '{ "appid" "1" }', 'utf8'); // incomplete: ignored

  const apps = readApps(root);
  assert.equal(apps.length, 1);
  assert.equal(matchApp(apps, 'pUbG')?.name, 'PUBG: BATTLEGROUNDS');
  assert.deepEqual(readApps(path.join(root, 'missing')), []);

  const cache = path.join(root, 'appcache', 'librarycache', '578080');
  fs.mkdirSync(cache, { recursive: true });
  assert.equal(libraryCacheCover(root, '578080'), null);
  fs.writeFileSync(path.join(cache, 'header.jpg'), 'x');
  assert.equal(libraryCacheCover(root, '578080'), path.join(cache, 'header.jpg'));
  assert.equal(libraryCacheCover(root, 'bad id'), null);
});

test('steam: parseLibraryFolders extracts and dedupes vdf paths', () => {
  const vdf = `"libraryfolders"
{
  "0"
  {
    "path" "C:\\\\Program Files (x86)\\\\Steam"
  }
  "1"
  {
    "path" "D:\\\\SteamLibrary"
  }
  "2"
  {
    "path" "D:/SteamLibrary/"
  }
}`;
  assert.deepEqual(parseLibraryFolders(vdf), ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
  assert.deepEqual(parseLibraryFolders('"3" "E:\\\\OldLibrary"'), ['E:\\OldLibrary']);
  assert.deepEqual(parseLibraryFolders('"path" ""'), []);
});

test('steam: cdnCandidates validates the appid', () => {
  assert.equal(cdnCandidates('abc').length, 0);
  assert.equal(cdnCandidates('').length, 0);
  assert.match(cdnCandidates('730')[0], /\/730\/header\.jpg$/);
});
