import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapAutoTuning,
  mapCongestion,
  mapServiceStart,
  normalizeNicProps,
  parseAcValueFromQuery,
  parseActiveScheme,
  parseBcdeditEnum,
  parseRegQueryOutput,
  parseRegValue,
  regKeyPath,
  sanitizePs,
} from '../engine/win';

test('parseRegQueryOutput: dword value', () => {
  const out =
    '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR\r\n' +
    '    AppCaptureEnabled    REG_DWORD    0x0\r\n\r\n';
  const r = parseRegQueryOutput(out, 'AppCaptureEnabled');
  assert.equal(r?.type, 'REG_DWORD');
  assert.equal(r?.value, 0);
});

test('parseRegQueryOutput: string value', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Control Panel\\Desktop\r\n    MenuShowDelay    REG_SZ    400\r\n\r\n';
  const r = parseRegQueryOutput(out, 'MenuShowDelay');
  assert.equal(r?.type, 'REG_SZ');
  assert.equal(r?.value, '400');
});

test('parseRegQueryOutput: 0xffffffff stays unsigned', () => {
  assert.equal(parseRegValue('REG_DWORD', '0xffffffff'), 4294967295);
});

test('parseRegQueryOutput: different value name -> null', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Software\\X\r\n    Other    REG_DWORD    0x1\r\n\r\n';
  assert.equal(parseRegQueryOutput(out, 'AppCaptureEnabled'), null);
});

test('parseActiveScheme extracts the GUID', () => {
  const out = 'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)';
  assert.equal(parseActiveScheme(out), '381b4222-f694-41f0-9685-ff5bb260df2e');
  assert.equal(parseActiveScheme('no guid here'), null);
});

test('mapServiceStart enum mapping', () => {
  assert.equal(mapServiceStart(0), 'boot');
  assert.equal(mapServiceStart(1), 'system');
  assert.equal(mapServiceStart(2), 'auto');
  assert.equal(mapServiceStart(3), 'manual');
  assert.equal(mapServiceStart(4), 'disabled');
});

test('tcp enum mappings (verified against Get-NetTCPSetting on Win11)', () => {
  assert.equal(mapCongestion(5), 'cubic');
  assert.equal(mapCongestion(2), 'ctcp');
  assert.equal(mapCongestion(0), 'default');
  assert.equal(mapCongestion(6), 'bbr2');
  assert.equal(mapCongestion(9), 'unknown:9');
  assert.equal(mapAutoTuning(3), 'normal');
  assert.equal(mapAutoTuning(2), 'restricted');
  assert.equal(mapAutoTuning(0), 'disabled');
});

test('sanitizePs blocks injection attempts', () => {
  assert.equal(sanitizePs('DiagTrack'), 'DiagTrack');
  assert.equal(sanitizePs('\\Microsoft\\Windows\\Application Experience\\'), '\\Microsoft\\Windows\\Application Experience\\');
  assert.throws(() => sanitizePs("x'; Remove-Item C:\\ -Recurse -Force #"));
});

test('regKeyPath builds full hive paths', () => {
  assert.equal(regKeyPath('HKLM', 'SYSTEM\\X'), 'HKEY_LOCAL_MACHINE\\SYSTEM\\X');
  assert.equal(regKeyPath('HKCU', 'Software\\Y'), 'HKEY_CURRENT_USER\\Software\\Y');
});

test('parseBcdeditEnum finds the element value (case-insensitive)', () => {
  const out = [
    'Windows Boot Manager',
    '--------------------',
    'identifier              {bootmgr}',
    'default                 {current}',
    '',
    'Windows Boot Loader',
    '-------------------',
    'identifier              {current}',
    'device                  partition=C:',
    'hypervisorlaunchtype    Off',
    'nx                      OptIn',
    '',
  ].join('\r\n');
  assert.equal(parseBcdeditEnum(out, 'hypervisorlaunchtype'), 'Off');
  assert.equal(parseBcdeditEnum(out, 'HyperVisorLaunchType'), 'Off');
  assert.equal(parseBcdeditEnum(out, 'useplatformclock'), null);
});

test('parseAcValueFromQuery parses hidden power setting output', () => {
  const out = [
    'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)',
    '  Subgroup GUID: 48672f38-7a9a-4bb2-8bf8-3d85be19de4e  (Interrupt Steering Settings)',
    '    Power Setting GUID: 2bfc24f9-5ea2-4801-8213-3dbae01aa39d  (Interrupt Steering Mode)',
    '      Current AC Power Setting Index: 0x00000004',
    '      Current DC Power Setting Index: 0x00000000',
  ].join('\r\n');
  assert.equal(parseAcValueFromQuery(out), 4);
  assert.equal(parseAcValueFromQuery('nope'), null);
});

test('normalizeNicProps handles single object and arrays', () => {
  const single = { adapter: 'Ethernet', display: 'Large Send Offload v2 (IPv4)', kw: '*LsoV2IPv4', val: 1 };
  assert.deepEqual(normalizeNicProps(single), [
    { adapter: 'Ethernet', display: 'Large Send Offload v2 (IPv4)', keyword: '*LsoV2IPv4', value: 1 },
  ]);
  assert.equal(normalizeNicProps([single, { ...single, kw: '*LsoV2IPv6' }]).length, 2);
  assert.deepEqual(normalizeNicProps(null), []);
  assert.deepEqual(normalizeNicProps({ bogus: true }), []);
});
