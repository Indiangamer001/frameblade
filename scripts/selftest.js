// End-to-end round-trip test of the engine against a SCRATCH registry key
// (HKCU\Software\Frameblade\SelfTest). Proves the full pipeline:
//   setup -> inspect -> backup(+verify) -> apply -> read-back verify ->
//   state -> revert -> read-back verify (original values restored) -> cleanup.
//
// Nothing outside the scratch key is touched; no elevation required.

const assert = require('assert');
const { execFileSync } = require('child_process');
const { Engine } = require('../dist/engine/engine');
const { makePaths, resolveUserDataDir, ensureDirs } = require('../dist/engine/paths');
const { regQuery } = require('../dist/engine/win');
const { loadState, saveState } = require('../dist/engine/state');
const { readJournal } = require('../dist/engine/journal');
const { TWEAKS } = require('../dist/catalog/tweaks');

const KEY = 'Software\\Frameblade\\SelfTest';
const TWEAK_ID = 'selftest-roundtrip';

function reg(args) {
  try {
    return execFileSync('reg.exe', args, { stdio: 'pipe' }).toString();
  } catch (err) {
    return null; // tolerate "not found" for deletes
  }
}

async function main() {
  // The engine resolves tweaks from the catalog; register the scratch tweak.
  const tweak = {
    id: TWEAK_ID,
    name: 'Self-test round trip (scratch key)',
    group: 'Self-test',
    categories: ['quality-of-life'],
    description: 'Internal pipeline test against a scratch registry key.',
    impact: 'none',
    risk: 'low',
    recommended: false,
    rebootRequired: false,
    actions: [
      { type: 'registry.set', hive: 'HKCU', key: KEY, name: 'probe', value: 9, valueType: 'REG_DWORD', scope: 'user' },
      { type: 'registry.set', hive: 'HKCU', key: KEY, name: 'extra', value: 5, valueType: 'REG_DWORD', scope: 'user' },
    ],
  };
  TWEAKS.push(tweak);

  // Scratch setup: key with probe=7, no 'extra' value.
  reg(['delete', `HKCU\\${KEY}`, '/f']);
  reg(['add', `HKCU\\${KEY}`, '/v', 'probe', '/t', 'REG_DWORD', '/d', '7', '/f']);

  const paths = makePaths(resolveUserDataDir());
  ensureDirs(paths);
  const engine = new Engine(paths, false);

  try {
    console.log('1. apply…');
    const applyRes = await engine.apply(TWEAK_ID);
    assert.equal(applyRes.status, 'applied', `apply status was ${applyRes.status}: ${JSON.stringify(applyRes)}`);

    const probeApplied = await regQuery('HKCU', KEY, 'probe');
    assert.equal(Number(probeApplied && probeApplied.value), 9, 'probe should be 9 after apply');
    const extraApplied = await regQuery('HKCU', KEY, 'extra');
    assert.equal(Number(extraApplied && extraApplied.value), 5, 'extra should be 5 after apply');
    console.log('   applied: probe=9, extra=5  ✓');

    const stateApplied = loadState(paths);
    assert.equal(stateApplied.tweaks[TWEAK_ID].status, 'applied');
    console.log('   backup + state recorded  ✓');

    console.log('2. revert…');
    const revertRes = await engine.revert(TWEAK_ID);
    assert.equal(revertRes.status, 'reverted', `revert status was ${revertRes.status}: ${JSON.stringify(revertRes)}`);

    const probeBack = await regQuery('HKCU', KEY, 'probe');
    assert.equal(Number(probeBack && probeBack.value), 7, 'probe should be restored to 7');
    const extraBack = await regQuery('HKCU', KEY, 'extra');
    assert.equal(extraBack, null, "'extra' should be absent again after revert");
    console.log('   restored: probe=7, extra absent  ✓');

    const journal = readJournal(paths, 500).filter((l) => l.tweakId === TWEAK_ID);
    assert.ok(journal.length >= 4, 'journal should contain the round-trip');
    console.log(`   journal entries: ${journal.length}  ✓`);

    console.log('\nSELFTEST PASS — backup/verify/apply/revert pipeline works end to end.');
  } finally {
    // Cleanup: scratch key, state entry, backup file.
    reg(['delete', `HKCU\\${KEY}`, '/f']);
    const state = loadState(paths);
    delete state.tweaks[TWEAK_ID];
    saveState(paths, state);
    try {
      require('fs').rmSync(require('path').join(paths.backupsDir, `${TWEAK_ID}.json`), { force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error('\nSELFTEST FAIL:', err.message);
  process.exit(1);
});
