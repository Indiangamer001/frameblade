// Executes and inspects catalog actions. Every action has three faces:
//   inspect(action)  -> what is now, what it will be, and the undo record
//   execute(action)  -> apply it (and read back to verify)
//   applyUndo(undo)  -> restore the captured state (and read back to verify)
// Scope rule: 'system' actions require an elevated process.

import {
  ActionSpec,
  RegistryHive,
  Undo,
} from '../shared/types';
import { EngineError } from '../shared/errors';
import {
  bcdeditDelete,
  bcdeditSet,
  congestionAliasToProper,
  getAcValue,
  getActiveScheme,
  getNicAdvancedByKeyword,
  getService,
  getTaskState,
  getTcpInternet,
  netshTcpSetGlobal,
  readBcdElement,
  regDelete,
  regQuery,
  regSet,
  SCHEME_HIGH_PERFORMANCE,
  serviceStartNumber,
  setAcValue,
  setActiveScheme,
  setNicAdvanced,
  setServiceStartupType,
  setTaskEnabled,
  setTcpCongestionProvider,
  startService,
  stopService,
} from './win';

export interface Inspection {
  undo: Undo;
  changed: boolean;
  current: string;
  target: string;
}

export function describeAction(a: ActionSpec): string {
  switch (a.type) {
    case 'registry.set':
      return `Set ${a.hive}\\${a.key}\\${a.name} = ${a.value}`;
    case 'registry.delete':
      return `Delete ${a.hive}\\${a.key}\\${a.name}`;
    case 'service.setStart':
      return `Service '${a.service}' startup -> ${a.start}`;
    case 'service.stop':
      return `Stop service '${a.service}'`;
    case 'task.setEnabled':
      return `${a.enabled ? 'Enable' : 'Disable'} scheduled task '${a.taskPath}${a.taskName}'`;
    case 'powercfg.setActive':
      return 'Set active power plan -> High performance';
    case 'tcp.setGlobal':
      return a.setting === 'congestionprovider'
        ? `Set-NetTCPSetting Internet -CongestionProvider ${a.value}`
        : `netsh int tcp set global ${a.setting}=${a.value}`;
    case 'bcdedit.set':
      return `bcdedit /set ${a.element} ${a.value}`;
    case 'bcdedit.delete':
      return `bcdedit /deletevalue ${a.element}`;
    case 'nic.setAdvanced':
      return `Set NIC advanced property matching '${a.registryKeywordPattern}' -> ${a.value}`;
    case 'powercfg.setAcValue':
      return `PowerCfg AC value ${a.setting} -> index ${a.value}`;
  }
}

function assertElevatedFor(a: ActionSpec, elevated: boolean): void {
  if (a.scope === 'system' && !elevated) {
    throw new EngineError(
      'UTIL004',
      `Administrator rights are required for: ${describeAction(a)}`
    );
  }
}

/* ------------------------------------------------------------------ */
/* Inspect                                                             */
/* ------------------------------------------------------------------ */

export async function inspectAction(action: ActionSpec): Promise<Inspection> {
  switch (action.type) {
    case 'registry.set':
    case 'registry.delete': {
      const cur = await regQuery(action.hive, action.key, action.name);
      const existed = !!cur;
      const undo: Undo = {
        kind: 'registry',
        hive: action.hive,
        key: action.key,
        name: action.name,
        existed,
        valueType: cur?.type,
        value: cur?.value,
      };
      if (action.type === 'registry.set') {
        const target = `${action.valueType ?? (typeof action.value === 'number' ? 'REG_DWORD' : 'REG_SZ')} ${action.value}`;
        const current = existed ? `${cur!.type} ${cur!.value}` : '(absent)';
        const changed = !existed || String(cur!.value) !== String(action.value);
        return { undo, changed, current, target };
      }
      const current = existed ? `${cur!.type} ${cur!.value}` : '(absent)';
      return { undo, changed: existed, current, target: '(absent)' };
    }

    case 'service.setStart': {
      const info = await getService(action.service);
      if (!info) {
        return {
          undo: { kind: 'noop', reason: `Service '${action.service}' is not present on this system.` },
          changed: false,
          current: '(not present)',
          target: `StartType=${action.start}`,
        };
      }
      const startBefore = (
        ['boot', 'system', 'auto', 'manual', 'disabled'] as const
      )[info.startTypeNum] ?? 'manual';
      return {
        undo: { kind: 'service.start', service: action.service, startBefore },
        changed: startBefore !== action.start,
        current: `StartType=${startBefore} Status=${info.status}`,
        target: `StartType=${action.start}`,
      };
    }

    case 'service.stop': {
      const info = await getService(action.service);
      if (!info) {
        return {
          undo: { kind: 'noop', reason: `Service '${action.service}' is not present on this system.` },
          changed: false,
          current: '(not present)',
          target: 'Status=Stopped',
        };
      }
      return {
        undo: { kind: 'service.stop', service: action.service, wasRunning: info.status === 'Running' },
        changed: info.status === 'Running',
        current: `Status=${info.status}`,
        target: 'Status=Stopped',
      };
    }

    case 'task.setEnabled': {
      const state = await getTaskState(action.taskPath, action.taskName);
      if (state === null) {
        return {
          undo: { kind: 'noop', reason: `Task '${action.taskPath}${action.taskName}' is not present.` },
          changed: false,
          current: '(not present)',
          target: action.enabled ? 'Enabled' : 'Disabled',
        };
      }
      const enabledNow = state !== 1; // 1 = Disabled
      return {
        undo: {
          kind: 'task.enabled',
          taskPath: action.taskPath,
          taskName: action.taskName,
          enabledBefore: enabledNow,
        },
        changed: enabledNow !== action.enabled,
        current: enabledNow ? 'Enabled' : 'Disabled',
        target: action.enabled ? 'Enabled' : 'Disabled',
      };
    }

    case 'powercfg.setActive': {
      const cur = await getActiveScheme();
      if (!cur) throw new EngineError('UTIL004', 'Could not read the active power scheme (powercfg).');
      return {
        undo: { kind: 'powercfg.scheme', schemeBefore: cur },
        changed: cur !== SCHEME_HIGH_PERFORMANCE,
        current: cur,
        target: `${SCHEME_HIGH_PERFORMANCE} (High performance)`,
      };
    }

    case 'tcp.setGlobal': {
      const t = await getTcpInternet();
      if (!t) throw new EngineError('UTIL004', 'Could not read TCP settings (Get-NetTCPSetting).');
      const current =
        action.setting === 'congestionprovider'
          ? t.congestionProvider
          : action.setting === 'ecn'
            ? t.ecn
            : t.autoTuning;
      return {
        undo: { kind: 'tcp.setting', setting: action.setting, valueBefore: current },
        changed: current !== action.value,
        current,
        target: action.value,
      };
    }

    case 'bcdedit.set': {
      const v = await readBcdElement(action.element);
      return {
        undo: {
          kind: 'bcdedit',
          element: action.element,
          existed: v !== null,
          valueBefore: v ?? undefined,
        },
        changed: (v ?? '').toLowerCase() !== action.value.toLowerCase(),
        current: v ?? '(absent)',
        target: action.value,
      };
    }

    case 'bcdedit.delete': {
      const v = await readBcdElement(action.element);
      return {
        undo: {
          kind: 'bcdedit',
          element: action.element,
          existed: v !== null,
          valueBefore: v ?? undefined,
        },
        changed: v !== null,
        current: v ?? '(absent)',
        target: '(absent / firmware default)',
      };
    }

    case 'nic.setAdvanced': {
      const props = await getNicAdvancedByKeyword(action.registryKeywordPattern);
      if (props.length === 0) {
        return {
          undo: {
            kind: 'noop',
            reason: `No NIC advanced properties matching '${action.registryKeywordPattern}'.`,
          },
          changed: false,
          current: '(no matching properties)',
          target: String(action.value),
        };
      }
      return {
        undo: {
          kind: 'nic.advanced',
          pattern: action.registryKeywordPattern,
          entries: props.map((p) => ({
            adapter: p.adapter,
            keyword: p.keyword,
            valueBefore: p.value,
          })),
        },
        changed: props.some((p) => p.value !== action.value),
        current: props.map((p) => `${p.adapter}:${p.keyword}=${p.value}`).join(', '),
        target: `${action.value} (${props.length} propert${props.length === 1 ? 'y' : 'ies'})`,
      };
    }

    case 'powercfg.setAcValue': {
      const cur = await getAcValue(action.subgroup, action.setting);
      if (cur === null) {
        return {
          undo: { kind: 'noop', reason: 'Power setting is not present on this build.' },
          changed: false,
          current: '(not present)',
          target: `index ${action.value}`,
        };
      }
      return {
        undo: {
          kind: 'powercfg.value',
          subgroup: action.subgroup,
          setting: action.setting,
          valueBefore: cur,
        },
        changed: cur !== action.value,
        current: `index ${cur}`,
        target: `index ${action.value}`,
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Execute                                                             */
/* ------------------------------------------------------------------ */

export async function executeAction(action: ActionSpec, elevated: boolean): Promise<void> {
  assertElevatedFor(action, elevated);
  switch (action.type) {
    case 'registry.set': {
      await regSet(action.hive, action.key, action.name, action.value, action.valueType);
      const back = await regQuery(action.hive, action.key, action.name);
      if (!back || String(back.value) !== String(action.value)) {
        throw new EngineError(
          'OPT002',
          `Verification failed: ${action.key}\\${action.name} did not reach ${action.value}.`
        );
      }
      return;
    }
    case 'registry.delete': {
      await regDelete(action.hive, action.key, action.name);
      const back = await regQuery(action.hive, action.key, action.name);
      if (back) {
        throw new EngineError('OPT002', `Verification failed: ${action.key}\\${action.name} still exists.`);
      }
      return;
    }
    case 'service.setStart': {
      const ps = action.start === 'auto' ? 'Automatic' : action.start === 'manual' ? 'Manual' : 'Disabled';
      await setServiceStartupType(action.service, ps);
      const info = await getService(action.service);
      if (!info || info.startTypeNum !== serviceStartNumber(action.start)) {
        throw new EngineError('OPT002', `Verification failed: service '${action.service}' startup type.`);
      }
      return;
    }
    case 'service.stop': {
      await stopService(action.service);
      const info = await getService(action.service);
      if (info && info.status === 'Running') {
        throw new EngineError('OPT002', `Verification failed: service '${action.service}' still running.`);
      }
      return;
    }
    case 'task.setEnabled': {
      await setTaskEnabled(action.taskPath, action.taskName, action.enabled);
      const state = await getTaskState(action.taskPath, action.taskName);
      const enabledNow = state !== null && state !== 1;
      if (enabledNow !== action.enabled && state !== null) {
        throw new EngineError('OPT002', `Verification failed: task '${action.taskName}' state.`);
      }
      return;
    }
    case 'powercfg.setActive': {
      await setActiveScheme(SCHEME_HIGH_PERFORMANCE);
      const cur = await getActiveScheme();
      if (cur !== SCHEME_HIGH_PERFORMANCE) {
        throw new EngineError('OPT002', 'Verification failed: active power scheme did not change.');
      }
      return;
    }
    case 'tcp.setGlobal': {
      // Windows 11 removed 'congestionprovider' from 'netsh int tcp set global';
      // the supported path is Set-NetTCPSetting (also covers LEDBAT/BBR2).
      if (action.setting === 'congestionprovider') {
        const proper = congestionAliasToProper(action.value);
        if (!proper) {
          throw new EngineError('UTIL007', `Unknown congestion provider '${action.value}'.`);
        }
        await setTcpCongestionProvider(proper);
      } else {
        await netshTcpSetGlobal(action.setting, action.value);
      }
      const t = await getTcpInternet();
      const now =
        action.setting === 'congestionprovider'
          ? t?.congestionProvider
          : action.setting === 'ecn'
            ? t?.ecn
            : t?.autoTuning;
      if (now !== action.value) {
        throw new EngineError(
          'OPT002',
          `Verification failed: tcp ${action.setting} is '${now ?? 'unknown'}', expected '${action.value}'.`
        );
      }
      return;
    }

    case 'bcdedit.set': {
      await bcdeditSet(action.element, action.value);
      const back = await readBcdElement(action.element);
      if ((back ?? '').toLowerCase() !== action.value.toLowerCase()) {
        throw new EngineError(
          'OPT002',
          `Verification failed: bcdedit ${action.element} is '${back ?? 'absent'}', expected '${action.value}'.`
        );
      }
      return;
    }

    case 'bcdedit.delete': {
      await bcdeditDelete(action.element);
      const back = await readBcdElement(action.element);
      if (back !== null) {
        throw new EngineError('OPT002', `Verification failed: bcdedit ${action.element} is still present ('${back}').`);
      }
      return;
    }

    case 'nic.setAdvanced': {
      const props = await getNicAdvancedByKeyword(action.registryKeywordPattern);
      for (const p of props) {
        await setNicAdvanced(p.adapter, p.keyword, action.value);
      }
      const after = await getNicAdvancedByKeyword(action.registryKeywordPattern);
      const bad = after.filter((p) => p.value !== action.value);
      if (bad.length > 0) {
        throw new EngineError(
          'OPT002',
          `Verification failed: ${bad.map((b) => `${b.keyword}=${b.value}`).join(', ')} did not reach ${action.value}.`
        );
      }
      return;
    }

    case 'powercfg.setAcValue': {
      await setAcValue(action.subgroup, action.setting, action.value);
      const back = await getAcValue(action.subgroup, action.setting);
      if (back !== action.value) {
        throw new EngineError(
          'OPT002',
          `Verification failed: power setting is index ${back}, expected ${action.value}.`
        );
      }
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Undo                                                               */
/* ------------------------------------------------------------------ */

export async function applyUndo(undo: Undo, elevated: boolean): Promise<void> {
  switch (undo.kind) {
    case 'noop':
      return;
    case 'registry': {
      if (elevated === false && undo.hive === 'HKLM') {
        throw new EngineError('UTIL004', `Administrator rights required to restore ${undo.key}\\${undo.name}.`);
      }
      if (undo.existed) {
        await regSet(undo.hive, undo.key, undo.name, undo.value ?? '', undo.valueType);
      } else {
        await regDelete(undo.hive, undo.key, undo.name);
      }
      const back = await regQuery(undo.hive, undo.key, undo.name);
      const ok = undo.existed ? !!back && String(back.value) === String(undo.value) : !back;
      if (!ok) throw new EngineError('UTIL006', `Revert verification failed for ${undo.key}\\${undo.name}.`);
      return;
    }
    case 'service.start': {
      const ps =
        undo.startBefore === 'auto'
          ? 'Automatic'
          : undo.startBefore === 'manual'
            ? 'Manual'
            : undo.startBefore === 'disabled'
              ? 'Disabled'
              : // boot/system starts cannot be represented by Set-Service; use Automatic as closest safe value
                'Automatic';
      await setServiceStartupType(undo.service, ps);
      const info = await getService(undo.service);
      const expected =
        undo.startBefore === 'boot' || undo.startBefore === 'system'
          ? 2
          : serviceStartNumber(undo.startBefore);
      if (info && info.startTypeNum !== expected) {
        throw new EngineError('UTIL006', `Revert verification failed for service '${undo.service}'.`);
      }
      return;
    }
    case 'service.stop': {
      if (undo.wasRunning) {
        await startService(undo.service);
      }
      return;
    }
    case 'task.enabled': {
      await setTaskEnabled(undo.taskPath, undo.taskName, undo.enabledBefore);
      return;
    }
    case 'powercfg.scheme': {
      await setActiveScheme(undo.schemeBefore);
      const cur = await getActiveScheme();
      if (cur !== undo.schemeBefore) {
        throw new EngineError('UTIL006', 'Revert verification failed for active power scheme.');
      }
      return;
    }
    case 'tcp.setting': {
      // Restore the captured value. Values recorded as 'unknown:N' cannot be
      // mapped back; fall back to CUBIC, the Windows 11 default for Internet.
      const unknown = undo.valueBefore.startsWith('unknown:');
      const v = undo.setting === 'congestionprovider' && unknown ? 'cubic' : undo.valueBefore;
      if (undo.setting === 'congestionprovider') {
        const proper = congestionAliasToProper(v);
        if (!proper) {
          throw new EngineError('UTIL006', `Cannot restore congestion provider '${v}'.`);
        }
        await setTcpCongestionProvider(proper);
      } else {
        await netshTcpSetGlobal(undo.setting, v);
      }
      if (!unknown) {
        const t = await getTcpInternet();
        if (t) {
          const now =
            undo.setting === 'congestionprovider'
              ? t.congestionProvider
              : undo.setting === 'ecn'
                ? t.ecn
                : t.autoTuning;
          if (now !== v) {
            throw new EngineError(
              'UTIL006',
              `Revert verification failed: tcp ${undo.setting} is '${now}', expected '${v}'.`
            );
          }
        }
      }
      return;
    }

    case 'bcdedit': {
      if (undo.existed) {
        await bcdeditSet(undo.element, undo.valueBefore ?? '');
        const back = await readBcdElement(undo.element);
        if ((back ?? '').toLowerCase() !== (undo.valueBefore ?? '').toLowerCase()) {
          throw new EngineError('UTIL006', `Revert verification failed for bcdedit ${undo.element}.`);
        }
      } else {
        await bcdeditDelete(undo.element);
      }
      return;
    }

    case 'nic.advanced': {
      for (const e of undo.entries) {
        await setNicAdvanced(e.adapter, e.keyword, e.valueBefore);
      }
      const after = await getNicAdvancedByKeyword(undo.pattern);
      for (const e of undo.entries) {
        const found = after.find((p) => p.adapter === e.adapter && p.keyword === e.keyword);
        if (found && found.value !== e.valueBefore) {
          throw new EngineError(
            'UTIL006',
            `Revert verification failed: ${e.keyword} is ${found.value}, expected ${e.valueBefore}.`
          );
        }
      }
      return;
    }

    case 'powercfg.value': {
      await setAcValue(undo.subgroup, undo.setting, undo.valueBefore);
      const back = await getAcValue(undo.subgroup, undo.setting);
      if (back !== undo.valueBefore) {
        throw new EngineError(
          'UTIL006',
          `Revert verification failed: power setting is index ${back}, expected ${undo.valueBefore}.`
        );
      }
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Timeout guard (OPT007)                                              */
/* ------------------------------------------------------------------ */

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new EngineError('OPT007', `'${what}' timed out after ${ms} ms.`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export type { RegistryHive };
