import test from 'node:test';
import assert from 'node:assert/strict';
import { getCatalog, recommendedIds, tweakRequiresElevation } from '../catalog/catalog';
import { describeAction, withTimeout } from '../engine/actions';
import { unsupportedReason } from '../engine/engine';
import { EngineError } from '../shared/errors';

test('catalog: ids are unique and non-empty', () => {
  const ids = getCatalog().map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(id.length > 3);
});

test('catalog: every tweak has at least one action and a description', () => {
  for (const t of getCatalog()) {
    assert.ok(t.actions.length > 0, `${t.id} has no actions`);
    assert.ok(t.description.length > 20, `${t.id} description too short`);
    assert.ok(t.impact.length > 5, `${t.id} impact too short`);
  }
});

test('catalog: scope invariant — user tweaks have no system actions and vice versa', () => {
  for (const t of getCatalog()) {
    const scopes = new Set(t.actions.map((a) => a.scope));
    assert.equal(scopes.size, 1, `${t.id} mixes action scopes: ${[...scopes].join(', ')}`);
  }
});

test('catalog: describeAction renders every action', () => {
  for (const t of getCatalog()) {
    for (const a of t.actions) {
      const s = describeAction(a);
      assert.ok(typeof s === 'string' && s.length > 5, `${t.id}: ${a.type}`);
    }
  }
});

test('catalog: recommendedIds is a subset of the catalog', () => {
  const all = new Set(getCatalog().map((t) => t.id));
  for (const id of recommendedIds()) assert.ok(all.has(id));
});

test('elevation split matches scopes', () => {
  for (const t of getCatalog()) {
    const needs = t.actions.some((a) => a.scope === 'system');
    assert.equal(tweakRequiresElevation(t), needs);
  }
});

test('requirements: win11 gate on the timer tweak', () => {
  const t = getCatalog().find((x) => x.id === 'timer-resolution');
  assert.ok(t);
  assert.ok((t.requirements?.minBuild ?? 0) >= 22000);
  assert.equal(typeof unsupportedReason(t, 19045), 'string'); // Win10 build -> unsupported
  assert.equal(unsupportedReason(t, 22631), undefined); // Win11 -> ok
});

test('requirements: interrupt steering gated to Win11 22H2+', () => {
  const t = getCatalog().find((x) => x.id === 'disable-dynamic-interrupt-steering');
  assert.ok(t);
  assert.equal(typeof unsupportedReason(t, 19045), 'string'); // Win10
  assert.equal(typeof unsupportedReason(t, 22000), 'string'); // 21H2 < 22621
  assert.equal(unsupportedReason(t, 22631), undefined); // 22H2+
});

test('catalog: every high-risk tweak carries a real security warning', () => {
  for (const t of getCatalog()) {
    if (t.risk === 'high') {
      assert.ok(
        t.securityWarning && t.securityWarning.length > 40,
        `${t.id} is high risk but has no meaningful securityWarning`
      );
    }
  }
});

test('catalog: Advanced set present (Hone Advanced Settings + trade-offs)', () => {
  const ids = new Set(getCatalog().map((t) => t.id));
  for (const id of [
    'disable-lso-offloads',
    'disable-vbs-hyperv',
    'disable-mitigations',
    'disable-defender-realtime',
    'disable-dynamic-interrupt-steering',
    'disable-disk-quotas',
    'disable-mpo',
  ]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
});

test('catalog: network congestion provider uses the supported cmdlet', () => {
  const t = getCatalog().find((x) => x.id === 'network-performance-tuning');
  assert.ok(t);
  const cp = t.actions.find(
    (a) => a.type === 'tcp.setGlobal' && a.setting === 'congestionprovider'
  );
  assert.ok(cp, 'congestionprovider action missing');
  if (!cp || cp.type !== 'tcp.setGlobal') throw new Error('unreachable');
  assert.equal(cp.value, 'cubic');
  assert.match(describeAction(cp), /Set-NetTCPSetting/);
  assert.doesNotMatch(describeAction(cp), /netsh int tcp set global congestionprovider/);
});

test('catalog: MPO and NTFS additions are system-scoped and opt-in', () => {  const all = getCatalog();
  const mpo = all.find((t) => t.id === 'disable-mpo');
  assert.ok(mpo, 'disable-mpo missing');
  assert.equal(mpo.risk, 'medium');
  assert.equal(mpo.recommended, false);
  assert.ok(mpo.actions.every((a) => a.scope === 'system'));
  const action = mpo.actions[0];
  assert.equal(action.type, 'registry.set');
  if (action.type === 'registry.set') {
    assert.equal(action.hive, 'HKLM');
    assert.match(action.key, /Microsoft\\Windows\\Dwm/);
    assert.equal(action.name, 'OverlayTestMode');
    assert.equal(action.value, 5);
  }

  const ntfs = all.find((t) => t.id === 'disable-ntfs-last-access');
  assert.ok(ntfs, 'disable-ntfs-last-access missing');
  assert.equal(ntfs.risk, 'low');
  assert.equal(ntfs.recommended, false);
  assert.ok(ntfs.actions.every((a) => a.scope === 'system'));
  const ntfsAction = ntfs.actions[0];
  assert.equal(ntfsAction.type, 'registry.set');
  if (ntfsAction.type === 'registry.set') {
    assert.equal(ntfsAction.name, 'NtfsDisableLastAccessUpdate');
    assert.equal(ntfsAction.value, 1);
  }
});

test('withTimeout rejects slow work with OPT007', async () => {
  await assert.rejects(
    withTimeout(new Promise((r) => setTimeout(r, 500)), 50, 'slow op'),
    (err: unknown) => err instanceof EngineError && err.code === 'OPT007'
  );
});
