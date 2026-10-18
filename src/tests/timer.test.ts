import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIMER_GATE_NAME,
  TIMER_MAX_REQUEST_100NS,
  TIMER_REQUEST_100NS,
  timerScript,
  unitsToMs,
} from '../engine/timer';

test('timer: script gates on the live registry value and requests 0.5 ms', () => {
  const s = timerScript(4242);
  assert.ok(s.includes('NtSetTimerResolution'), 'P/Invoke setter missing');
  assert.ok(s.includes('NtQueryTimerResolution'), 'P/Invoke query declaration missing');
  assert.ok(s.includes(TIMER_GATE_NAME), 'registry gate missing');
  assert.ok(s.includes("timer-ungated"), 'fail-closed branch missing');
  assert.ok(s.includes('[uint32]5000'), '0.5 ms request missing');
  assert.ok(s.includes('Get-Process -Id 4242'), 'parent-death guard missing');
  assert.ok(s.includes('timer-ok'), 'status line missing');
  assert.ok(s.includes('NtSetTimerResolution([uint32]0, $false'), 'release branch missing');
});

test('timer: script rejects invalid pids and requests', () => {
  assert.throws(() => timerScript(0));
  assert.throws(() => timerScript(-1));
  assert.throws(() => timerScript(1.5));
  assert.throws(() => timerScript(10, 0));
  assert.throws(() => timerScript(10, -5000));
  assert.throws(() => timerScript(10, TIMER_MAX_REQUEST_100NS + 1));
});

test('timer: unitsToMs converts 100 ns units', () => {
  assert.equal(unitsToMs(TIMER_REQUEST_100NS), 0.5);
  assert.equal(unitsToMs(10_000), 1);
  assert.equal(unitsToMs(156_250), 15.625);
  assert.equal(unitsToMs(500_000), 50);
});
