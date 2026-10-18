// The core engine: plan -> inspect -> backup -> verify -> apply -> verify,
// with journal, state and automatic rollback. Mirrors the pipeline described
// in the replication report (Hone's OPT/UTIL taxonomy made explicit).

import fs from 'fs';
import { backupFileFor, EnginePaths, APP_VERSION } from './paths';
import { appendJournal } from './journal';
import { loadState, saveState } from './state';
import { createBackup, readBackup, verifyBackup } from './backup';
import { applyUndo, describeAction, executeAction, inspectAction, withTimeout, Inspection } from './actions';
import { getTweak, activeCatalogVersion } from '../catalog/catalog';
import { windowsBuild } from './win';
import { BRAND_NAME } from '../shared/brand';
import { EngineError } from '../shared/errors';
import {
  ActionResult,
  BackupEntry,
  PlanEntry,
  StepLog,
  Tweak,
  TweakPlan,
} from '../shared/types';

const ACTION_TIMEOUT_MS = 30_000;

/** Requirement gate. Returns a human reason when the tweak is unsupported. */
export function unsupportedReason(tweak: Tweak, build = windowsBuild()): string | undefined {
  if (tweak.retired) {
    return tweak.retiredReason
      ? `Retired by the remote catalog: ${tweak.retiredReason}`
      : 'Retired by the remote catalog — it can no longer be applied, only reverted.';
  }
  if (process.platform !== 'win32') {
    return `This build of ${BRAND_NAME} only supports Windows.`;
  }
  const req = tweak.requirements;
  if (!req) return undefined;
  if (req.minBuild !== undefined && build < req.minBuild) {
    return req.notes ?? `Requires Windows build ${req.minBuild} or newer (this system: ${build}).`;
  }
  if (req.maxBuild !== undefined && build > req.maxBuild) {
    return req.notes ?? `Only supported up to Windows build ${req.maxBuild} (this system: ${build}).`;
  }
  return undefined;
}

export class Engine {
  constructor(
    private readonly paths: EnginePaths,
    private readonly elevated: boolean
  ) {}

  getPaths(): EnginePaths {
    return this.paths;
  }

  /* ---------------------------------------------------------------- */
  /* Plan (read-only, works without elevation)                        */
  /* ---------------------------------------------------------------- */
  async plan(tweakId: string): Promise<TweakPlan> {
    const tweak = getTweak(tweakId);
    if (!tweak) throw new EngineError('RES009', `Unknown tweak '${tweakId}'.`);
    const unsupported = unsupportedReason(tweak);
    const state = loadState(this.paths);
    const entries: PlanEntry[] = [];
    for (let i = 0; i < tweak.actions.length; i++) {
      const action = tweak.actions[i];
      try {
        const info = await inspectAction(action);
        entries.push({
          actionIndex: i,
          type: action.type,
          description: describeAction(action),
          current: info.current,
          target: info.target,
          changed: info.changed,
        });
      } catch (err) {
        const ee = EngineError.from(err);
        // Some system state cannot be read without elevation (e.g. bcdedit).
        // The plan stays useful: mark it and let the elevated helper resolve it.
        if (action.scope === 'system') {
          entries.push({
            actionIndex: i,
            type: action.type,
            description: describeAction(action),
            current: '(requires administrator to read)',
            target: describeAction(action),
            changed: true,
            note: ee.message,
          });
          continue;
        }
        throw err;
      }
    }
    return {
      tweakId,
      requiresElevation: tweak.actions.some((a) => a.scope === 'system'),
      unsupportedReason: unsupported,
      alreadyApplied: state.tweaks[tweakId]?.status === 'applied',
      entries,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Apply                                                            */
  /* ---------------------------------------------------------------- */
  async apply(tweakId: string): Promise<ActionResult> {
    const steps: StepLog[] = [];
    const log = (
      level: StepLog['level'],
      message: string,
      code?: string
    ): void => {
      const step: StepLog = { ts: Date.now(), level, message, code };
      steps.push(step);
      appendJournal(this.paths, {
        ts: step.ts,
        op: 'apply',
        tweakId,
        level,
        code,
        message,
      });
    };

    const tweak = getTweak(tweakId);
    if (!tweak) throw new EngineError('RES009', `Unknown tweak '${tweakId}'.`);

    const unsupported = unsupportedReason(tweak);
    if (unsupported) {
      log('error', unsupported, 'UTIL007');
      return { tweakId, status: 'unsupported', errorCode: 'UTIL007', errorMessage: unsupported, steps };
    }

    const state = loadState(this.paths);
    if (state.tweaks[tweakId]?.status === 'applied') {
      log('info', 'Already applied.');
      return { tweakId, status: 'up-to-date', steps };
    }

    // Inspect every action first: capture undo records and detect no-ops.
    const inspections: Inspection[] = [];
    for (const action of tweak.actions) {
      try {
        inspections.push(await withTimeout(inspectAction(action), ACTION_TIMEOUT_MS, describeAction(action)));
      } catch (err) {
        const ee = EngineError.from(err);
        log('error', ee.message, ee.code);
        return { tweakId, status: 'failed', errorCode: ee.code, errorMessage: ee.message, steps };
      }
    }

    if (!inspections.some((i) => i.changed)) {
      log('info', 'No changes needed — the system already matches the target state.');
      return { tweakId, status: 'up-to-date', steps };
    }

    // Backup + verification (UTIL085).
    const entries: BackupEntry[] = tweak.actions.map((action, i) => ({
      actionIndex: i,
      action,
      undo: inspections[i].undo,
    }));
    let backup;
    try {
      backup = createBackup(this.paths, tweak, entries, activeCatalogVersion());
      await withTimeout(verifyBackup(this.paths, tweak, backup), ACTION_TIMEOUT_MS, 'backup verification');
      log('info', `Backup written and verified (${backup.entries.length} entries).`);
    } catch (err) {
      const ee = EngineError.from(err);
      log('error', `Backup phase failed: ${ee.message}`, ee.code);
      return { tweakId, status: 'failed', errorCode: ee.code, errorMessage: ee.message, steps };
    }

    // Execute.
    const appliedIndexes: number[] = [];
    try {
      for (let i = 0; i < tweak.actions.length; i++) {
        const action = tweak.actions[i];
        if (!inspections[i].changed) {
          log('info', `Skipped (already correct): ${describeAction(action)}`);
          continue;
        }
        await withTimeout(executeAction(action, this.elevated), ACTION_TIMEOUT_MS, describeAction(action));
        appliedIndexes.push(i);
        log('info', `Applied: ${describeAction(action)}`);
      }
    } catch (err) {
      const ee = EngineError.from(err);
      log('error', `Apply failed: ${ee.message}`, ee.code);
      // Roll back what we already changed, newest first.
      for (const i of [...appliedIndexes].reverse()) {
        try {
          await withTimeout(applyUndo(entries[i].undo, this.elevated), ACTION_TIMEOUT_MS, 'rollback');
          log('warn', `Rolled back: ${describeAction(tweak.actions[i])}`);
        } catch (err2) {
          const ee2 = EngineError.from(err2);
          log(
            'error',
            `Rollback failed for '${describeAction(tweak.actions[i])}': ${ee2.message}. Manual fix may be needed.`,
            ee2.code
          );
        }
      }
      const s = loadState(this.paths);
      s.tweaks[tweakId] = {
        ...(s.tweaks[tweakId] ?? { status: 'failed' as const }),
        status: 'failed',
        lastError: { code: ee.code, message: ee.message },
      };
      saveState(this.paths, s);
      return { tweakId, status: 'failed', errorCode: ee.code, errorMessage: ee.message, steps };
    }

    const s = loadState(this.paths);
    s.tweaks[tweakId] = {
      status: 'applied',
      appliedAt: new Date().toISOString(),
      backupFile: backupFileFor(this.paths, tweakId),
      rebootRequired: tweak.rebootRequired,
    };
    saveState(this.paths, s);
    log(
      'info',
      tweak.rebootRequired ? 'Applied. Reboot recommended for full effect.' : 'Applied.'
    );
    return { tweakId, status: 'applied', rebootRequired: tweak.rebootRequired, steps };
  }

  /* ---------------------------------------------------------------- */
  /* Revert                                                           */
  /* ---------------------------------------------------------------- */
  async revert(tweakId: string): Promise<ActionResult> {
    const steps: StepLog[] = [];
    const log = (level: StepLog['level'], message: string, code?: string): void => {
      const step: StepLog = { ts: Date.now(), level, message, code };
      steps.push(step);
      appendJournal(this.paths, { ts: step.ts, op: 'revert', tweakId, level, code, message });
    };

    const tweak = getTweak(tweakId);
    if (!tweak) throw new EngineError('RES009', `Unknown tweak '${tweakId}'.`);

    const state = loadState(this.paths);
    const backupPath = backupFileFor(this.paths, tweakId);
    if (!fs.existsSync(backupPath)) {
      log('info', 'Nothing to revert — no backup exists for this tweak.');
      return { tweakId, status: 'up-to-date', steps };
    }

    let backup;
    try {
      backup = readBackup(this.paths, tweak);
    } catch (err) {
      const ee = EngineError.from(err);
      log('error', ee.message, ee.code);
      return { tweakId, status: 'failed', errorCode: ee.code, errorMessage: ee.message, steps };
    }

    const failures: string[] = [];
    for (const entry of [...backup.entries].reverse()) {
      const what = describeAction(entry.action);
      try {
        await withTimeout(applyUndo(entry.undo, this.elevated), ACTION_TIMEOUT_MS, `revert: ${what}`);
        log('info', `Restored: ${what}`);
      } catch (err) {
        const ee = EngineError.from(err);
        failures.push(`${what}: ${ee.message}`);
        log('error', `Restore failed: ${what} — ${ee.message}`, ee.code);
      }
    }

    if (failures.length > 0) {
      const s = loadState(this.paths);
      s.tweaks[tweakId] = {
        ...(s.tweaks[tweakId] ?? { status: 'failed' as const }),
        status: 'failed',
        lastError: { code: 'UTIL006', message: failures.join(' | ') },
      };
      saveState(this.paths, s);
      return {
        tweakId,
        status: 'failed',
        errorCode: 'UTIL006',
        errorMessage: `${failures.length} restore step(s) failed.`,
        steps,
      };
    }

    const s = loadState(this.paths);
    s.tweaks[tweakId] = {
      status: 'reverted',
      revertedAt: new Date().toISOString(),
      backupFile: backupPath,
    };
    saveState(this.paths, s);
    log('info', 'Reverted to the backed-up (original) state.');
    return { tweakId, status: 'reverted', steps };
  }

  /* ---------------------------------------------------------------- */
  /* Batch helpers                                                    */
  /* ---------------------------------------------------------------- */
  async applyMany(ids: string[]): Promise<ActionResult[]> {
    const out: ActionResult[] = [];
    for (const id of ids) out.push(await this.apply(id));
    return out;
  }

  async revertMany(ids: string[]): Promise<ActionResult[]> {
    // Revert in reverse order of application.
    const out: ActionResult[] = [];
    for (const id of [...ids].reverse()) out.push(await this.revert(id));
    return out;
  }
}

export { APP_VERSION };
