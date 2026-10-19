import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHelperLaunchScript } from '../main/elevation';

test('elevation: bundled launch passes the helper flag and raises one UAC prompt', () => {
  const script = buildHelperLaunchScript({
    runtime: { kind: 'bundled', exe: 'C:\\Program Files\\Frameblade\\Frameblade.exe' },
    helperJs: 'C:\\app\\dist\\helper\\helper.js',
    reqFile: 'C:\\Users\\A B\\AppData\\Local\\Frameblade\\jobs\\00000000-0000-4000-8000-000000000001.req.json',
    appPath: 'C:\\Dev\\frameblade',
  });
  assert.match(script, /Start-Process/);
  assert.match(script, /-Verb RunAs/);
  assert.match(script, /--frameblade-helper/);
  assert.match(script, /C:\\Dev\\frameblade/);
  assert.doesNotMatch(script, /\.ps1|\.cmd/);
});

test('elevation: system-node launch invokes the helper script directly', () => {
  const script = buildHelperLaunchScript({
    runtime: { kind: 'system-node', exe: 'C:\\Program Files\\nodejs\\node.exe' },
    helperJs: 'C:\\app\\dist\\helper\\helper.js',
    reqFile: 'C:\\Users\\A B\\AppData\\Local\\Frameblade\\jobs\\00000000-0000-4000-8000-000000000001.req.json',
  });
  assert.match(script, /helper\.js/);
  assert.match(script, /\.req\.json/);
  assert.doesNotMatch(script, /--frameblade-helper/);
});

test('elevation: unsafe quotes in a launch path are rejected', () => {
  assert.throws(
    () =>
      buildHelperLaunchScript({
        runtime: { kind: 'bundled', exe: 'C:\\bad"path\\Frameblade.exe' },
        helperJs: 'C:\\app\\helper.js',
        reqFile: 'C:\\jobs\\00000000-0000-4000-8000-000000000001.req.json',
      }),
    /Unsafe path/
  );
});
