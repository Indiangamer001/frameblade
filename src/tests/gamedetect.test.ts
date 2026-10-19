// Installed-game discovery: executable heuristics, launcher sources and
// de-duplication. Every test uses a scratch directory; no real library is read.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectInstalledGames, findPrimaryExe } from '../engine/gamedetect';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function touch(file: string, bytes = 8): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
}

function touchSize(file: string, size: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  fs.truncateSync(file, size);
}

test('gamedetect: findPrimaryExe ignores installers, redistributables and helpers', () => {
  const root = tempDir('fb-detect-exe-');
  touch(path.join(root, 'My Game', 'My Game.exe'), 4096);
  touch(path.join(root, 'My Game', 'Unins000.exe'), 4096);
  touch(path.join(root, 'My Game', '_CommonRedist', 'vcredist_x64.exe'), 4096);
  touch(path.join(root, 'My Game', 'bin', 'MyGame-Win64-Shipping.exe'), 4096);
  touch(path.join(root, 'My Game', 'EasyAntiCheat', 'EasyAntiCheat.exe'), 4096);

  assert.equal(
    findPrimaryExe(path.join(root, 'My Game')),
    path.join(root, 'My Game', 'My Game.exe')
  );
  assert.equal(findPrimaryExe(path.join(root, 'missing')), null);
  assert.equal(findPrimaryExe(path.join(root, 'My Game', '_CommonRedist')), null);
});

test('gamedetect: prefers the large game binary over a launcher whose name matches the folder', () => {
  const root = tempDir('fb-detect-size-');
  const game = path.join(root, 'PUBG');
  touchSize(path.join(game, 'TslGame', 'Binaries', 'Win64', 'ExecPubg.exe'), 8 * 1024 * 1024);
  touchSize(path.join(game, 'TslGame', 'Binaries', 'Win64', 'TslGame.exe'), 60 * 1024 * 1024);
  touchSize(path.join(game, 'TslGame', 'Binaries', 'Win64', 'TslGame_ZK.exe'), 24 * 1024 * 1024);

  assert.equal(
    findPrimaryExe(game),
    path.join(game, 'TslGame', 'Binaries', 'Win64', 'TslGame.exe')
  );
});

test('gamedetect: common roots return games, GOG metadata and skip launchers', async () => {
  const root = tempDir('fb-detect-common-');
  touch(path.join(root, 'My Game', 'My Game.exe'), 4096);
  touch(path.join(root, 'Other Game', 'Game.exe'), 4096);
  touch(path.join(root, 'Other Game', 'Launcher.exe'), 1024);
  touch(path.join(root, 'EpicGamesLauncher', 'EpicGamesLauncher.exe'), 4096);
  touch(path.join(root, 'NotGame', 'readme.txt'), 10);
  touch(path.join(root, 'GOG Adventure', 'GOGAdventure.exe'), 4096);
  fs.writeFileSync(
    path.join(root, 'GOG Adventure', 'goggame-123.info'),
    JSON.stringify({
      name: 'GOG Adventure',
      playTasks: [{ path: 'GOGAdventure.exe', isPrimary: true }],
    }),
    'utf8'
  );
  touch(path.join(root, 'Riot Client', 'RiotClientServices.exe'), 4096);

  const games = await detectInstalledGames({
    steamRoots: [],
    epicManifestsDir: null,
    commonRoots: [root],
  });
  const byExe = new Map(games.map((g) => [g.exe, g]));

  assert.equal(byExe.get('my game.exe')?.title, 'My Game');
  assert.equal(byExe.get('game.exe')?.title, 'Other Game');
  assert.equal(byExe.get('gogadventure.exe')?.source, 'gog');
  assert.equal(byExe.get('gogadventure.exe')?.title, 'GOG Adventure');
  assert.ok(!byExe.has('epicgameslauncher.exe'));
  assert.ok(!byExe.has('riotclientservices.exe'));
  assert.ok(!byExe.has('unins000.exe'));
});

test('gamedetect: Steam manifests provide titles, appids and cover ids', async () => {
  const steam = tempDir('fb-detect-steam-');
  const gameDir = path.join(steam, 'steamapps', 'common', 'Cool Game');
  touch(path.join(gameDir, 'CoolGame.exe'), 4096);
  fs.writeFileSync(
    path.join(steam, 'steamapps', 'appmanifest_42.acf'),
    `"AppState" { "appid" "42" "name" "Cool Game" "installdir" "Cool Game" }`,
    'utf8'
  );

  const games = await detectInstalledGames({
    steamRoots: [steam],
    epicManifestsDir: null,
    commonRoots: [],
  });
  assert.equal(games.length, 1);
  assert.equal(games[0].exe, 'coolgame.exe');
  assert.equal(games[0].title, 'Cool Game');
  assert.equal(games[0].appid, '42');
  assert.equal(games[0].source, 'steam');
});

test('gamedetect: Epic manifests use the declared launch executable', async () => {
  const manifests = tempDir('fb-detect-epic-');
  const install = tempDir('fb-detect-epic-install-');
  touch(path.join(install, 'EpicQuest.exe'), 4096);
  touch(path.join(install, 'EpicQuestHelper.exe'), 4096);
  fs.writeFileSync(
    path.join(manifests, 'epicquest.item'),
    JSON.stringify({
      DisplayName: 'Epic Quest',
      InstallLocation: install,
      LaunchExecutable: 'EpicQuest.exe',
      AppName: 'EpicQuest',
    }),
    'utf8'
  );

  const games = await detectInstalledGames({
    steamRoots: [],
    epicManifestsDir: manifests,
    commonRoots: [],
  });
  assert.equal(games.length, 1);
  assert.equal(games[0].exe, 'epicquest.exe');
  assert.equal(games[0].title, 'Epic Quest');
  assert.equal(games[0].source, 'epic');
});

test('gamedetect: Epic rejects a launch executable outside the install folder', async () => {
  const manifests = tempDir('fb-detect-epic-escape-');
  const install = tempDir('fb-detect-epic-install-');
  const outside = tempDir('fb-detect-epic-outside-');
  touch(path.join(install, 'SafeGame.exe'), 4096);
  touch(path.join(outside, 'Evil.exe'), 4096);
  fs.writeFileSync(
    path.join(manifests, 'escape.item'),
    JSON.stringify({
      DisplayName: 'Escape Test',
      InstallLocation: install,
      LaunchExecutable: path.relative(install, path.join(outside, 'Evil.exe')),
    }),
    'utf8'
  );

  const games = await detectInstalledGames({
    steamRoots: [],
    epicManifestsDir: manifests,
    commonRoots: [],
  });
  assert.equal(games.length, 1);
  assert.equal(games[0].exe, 'safegame.exe');
  assert.notEqual(games[0].path, path.join(outside, 'Evil.exe'));
});

test('gamedetect: duplicate exe names keep the richer launcher metadata', async () => {
  const steam = tempDir('fb-detect-dedupe-');
  const gameDir = path.join(steam, 'steamapps', 'common', 'Dedupe Game');
  touch(path.join(gameDir, 'Dedupe.exe'), 4096);
  fs.writeFileSync(
    path.join(steam, 'steamapps', 'appmanifest_7.acf'),
    `"AppState" { "appid" "7" "name" "Steam Name" "installdir" "Dedupe Game" }`,
    'utf8'
  );

  const common = tempDir('fb-detect-dedupe-common-');
  touch(path.join(common, 'Folder Name', 'Dedupe.exe'), 4096);

  const games = await detectInstalledGames({
    steamRoots: [steam],
    epicManifestsDir: null,
    commonRoots: [common],
  });
  assert.equal(games.length, 1);
  assert.equal(games[0].source, 'steam');
  assert.equal(games[0].title, 'Steam Name');
});
