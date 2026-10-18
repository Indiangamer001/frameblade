// CLI harness: lets you drive the same engine the app uses, without Electron.
// Run from an admin terminal for system tweaks. User tweaks work unprivileged.
//
//   node dist/cli.js list
//   node dist/cli.js plan <id|all>
//   node dist/cli.js apply <id|recommended|all>
//   node dist/cli.js revert <id|all>
//   node dist/cli.js journal [count]
//   node dist/cli.js modes

import { Engine, unsupportedReason } from './engine/engine';
import { getCatalog, getTweak, recommendedIds, tweakRequiresElevation } from './catalog/catalog';
import { builtinModes } from './catalog/modes';
import { loadProfiles } from './engine/profiles';
import { ensureDirs, makePaths, resolveUserDataDir } from './engine/paths';
import { isElevated } from './engine/win';
import { loadState } from './engine/state';
import { readJournal } from './engine/journal';
import { ActionResult } from './shared/types';

function statusOf(id: string, state: ReturnType<typeof loadState>): string {
  const s = state.tweaks[id];
  return s ? s.status : 'available';
}

async function main(): Promise<number> {
  const [cmd, arg] = process.argv.slice(2);
  const paths = makePaths(resolveUserDataDir());
  ensureDirs(paths);
  const elevated = await isElevated();
  const engine = new Engine(paths, elevated);
  const state = loadState(paths);

  switch (cmd) {
    case 'list': {
      console.log(`catalog: ${getCatalog().length} tweaks | elevated: ${elevated} | data: ${paths.userDataDir}\n`);
      for (const t of getCatalog()) {
        const flags = [
          tweakRequiresElevation(t) ? 'admin' : 'user',
          t.recommended ? 'recommended' : '',
          unsupportedReason(t) ? 'unsupported' : '',
        ]
          .filter(Boolean)
          .join(', ');
        console.log(`${t.id.padEnd(32)} ${statusOf(t.id, state).padEnd(12)} [${flags}]  ${t.name}`);
      }
      return 0;
    }

    case 'plan': {
      const ids = !arg || arg === 'all' ? getCatalog().map((t) => t.id) : [arg];
      for (const id of ids) {
        const plan = await engine.plan(id);
        console.log(`\n== ${id} ==`);
        if (plan.unsupportedReason) console.log(`  UNSUPPORTED: ${plan.unsupportedReason}`);
        if (plan.alreadyApplied) console.log('  (already applied)');
        for (const e of plan.entries) {
          console.log(
            `  [${e.changed ? 'change' : '  ok  '}] ${e.description}\n           current: ${e.current}\n           target : ${e.target}${e.note ? `\n           note   : ${e.note}` : ''}`
          );
        }
      }
      return 0;
    }

    case 'apply': {
      const ids =
        !arg || arg === 'recommended'
          ? recommendedIds()
          : arg === 'all'
            ? getCatalog().map((t) => t.id)
            : [arg];
      let failed = 0;
      for (const id of ids) {
        const tweak = getTweak(id);
        if (!tweak) {
          console.error(`Unknown tweak '${id}'`);
          failed++;
          continue;
        }
        if (tweakRequiresElevation(tweak) && !elevated) {
          console.log(`SKIP ${id}: needs an elevated terminal (run as administrator).`);
          continue;
        }
        const r = await engine.apply(id);
        printResult(r);
        if (r.status === 'failed') failed++;
      }
      return failed > 0 ? 1 : 0;
    }

    case 'revert': {
      const ids = !arg || arg === 'all' ? Object.keys(state.tweaks) : [arg];
      let failed = 0;
      for (const id of ids) {
        const tweak = getTweak(id);
        if (!tweak) continue;
        if (tweakRequiresElevation(tweak) && !elevated) {
          console.log(`SKIP ${id}: needs an elevated terminal (run as administrator).`);
          continue;
        }
        const r = await engine.revert(id);
        printResult(r);
        if (r.status === 'failed') failed++;
      }
      return failed > 0 ? 1 : 0;
    }

    case 'journal': {
      const n = arg ? Number(arg) : 40;
      for (const line of readJournal(paths, n)) {
        const when = new Date(line.ts).toISOString().slice(11, 19);
        console.log(
          `${when} [${line.level.toUpperCase()}] ${line.tweakId} ${line.code ? `(${line.code}) ` : ''}${line.message}`
        );
      }
      return 0;
    }

    case 'modes': {
      const profiles = loadProfiles(paths);
      console.log(`last used: ${profiles.lastMode ?? '(none)'}\n`);
      for (const m of builtinModes()) {
        console.log(`${m.id.padEnd(20)} ${m.name} — ${m.tweakIds.length} tweaks (${m.tagline})`);
      }
      for (const p of profiles.custom) {
        console.log(`${p.id.padEnd(20)} ${p.name} — ${p.tweakIds.length} tweaks (saved setup)`);
      }
      return 0;
    }

    default: {
      console.log(
        'usage: node dist/cli.js <list|plan|apply|revert|journal|modes> [id|all|recommended|count]'
      );
      return 2;
    }
  }
}

function printResult(r: ActionResult): void {
  const tag = r.status.toUpperCase();
  console.log(`\n${tag} ${r.tweakId}${r.errorCode ? ` [${r.errorCode}]` : ''}`);
  if (r.errorMessage) console.log(`  error: ${r.errorMessage}`);
  for (const s of r.steps) console.log(`  - ${s.level}: ${s.message}`);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
