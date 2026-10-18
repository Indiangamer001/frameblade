// Shared types for the Frameblade engine.
// Mirrors the architecture described in HONE-Replication-Report.md §12.

export type Category = 'fps-latency' | 'network' | 'quality-of-life' | 'privacy';
export type Risk = 'low' | 'medium' | 'high';
export type ActionScope = 'user' | 'system';
export type RegistryHive = 'HKCU' | 'HKLM';
export type RegistryValueType = 'REG_SZ' | 'REG_EXPAND_SZ' | 'REG_DWORD';

/* ------------------------------------------------------------------ */
/* Action specifications (the tweak "DSL")                             */
/* ------------------------------------------------------------------ */

export interface RegistrySetAction {
  type: 'registry.set';
  hive: RegistryHive;
  key: string;
  name: string;
  /** number => REG_DWORD, string => REG_SZ/REG_EXPAND_SZ */
  value: string | number;
  valueType?: RegistryValueType;
  scope: ActionScope;
  description?: string;
}

export interface RegistryDeleteAction {
  type: 'registry.delete';
  hive: RegistryHive;
  key: string;
  name: string;
  scope: ActionScope;
  description?: string;
}

export interface ServiceSetStartAction {
  type: 'service.setStart';
  service: string;
  start: 'auto' | 'manual' | 'disabled';
  scope: 'system';
  description?: string;
}

export interface ServiceStopAction {
  type: 'service.stop';
  service: string;
  scope: 'system';
  description?: string;
}

export interface TaskSetEnabledAction {
  type: 'task.setEnabled';
  taskPath: string; // e.g. '\\Microsoft\\Windows\\Application Experience\\' (trailing slash)
  taskName: string;
  enabled: boolean;
  scope: 'system';
  description?: string;
}

export interface PowerPlanAction {
  type: 'powercfg.setActive';
  /** 'high-performance' resolves to the well-known Windows scheme GUID */
  scheme: 'high-performance';
  scope: 'system';
  description?: string;
}

export interface TcpSetGlobalAction {
  type: 'tcp.setGlobal';
  setting: 'congestionprovider' | 'ecn' | 'autotuninglevel';
  value: string;
  scope: 'system';
  description?: string;
}

export interface BcdeditSetAction {
  type: 'bcdedit.set';
  /** Boot configuration element, e.g. 'hypervisorlaunchtype'. Applies to {current} (ID omitted). */
  element: string;
  value: string;
  scope: 'system';
  description?: string;
}

export interface BcdeditDeleteAction {
  type: 'bcdedit.delete';
  element: string;
  scope: 'system';
  description?: string;
}

export interface NicSetAdvancedAction {
  type: 'nic.setAdvanced';
  /** Case-insensitive PowerShell -match pattern against RegistryKeyword (e.g. 'Lso'). */
  registryKeywordPattern: string;
  value: number;
  scope: 'system';
  description?: string;
}

export interface PowerCfgSetAcAction {
  type: 'powercfg.setAcValue';
  /** Subgroup GUID, e.g. 48672f38-7a9a-4bb2-8bf8-3d85be19de4e (Interrupt Steering Settings). */
  subgroup: string;
  /** Setting GUID, e.g. 2bfc24f9-5ea2-4801-8213-3dbae01aa39d (Interrupt Steering Mode). */
  setting: string;
  value: number;
  scope: 'system';
  description?: string;
}

export type ActionSpec =
  | RegistrySetAction
  | RegistryDeleteAction
  | ServiceSetStartAction
  | ServiceStopAction
  | TaskSetEnabledAction
  | PowerPlanAction
  | TcpSetGlobalAction
  | BcdeditSetAction
  | BcdeditDeleteAction
  | NicSetAdvancedAction
  | PowerCfgSetAcAction;

/* ------------------------------------------------------------------ */
/* Tweaks                                                              */
/* ------------------------------------------------------------------ */

export interface Requirements {
  /** Minimum Windows build. Win10 19041+, Win11 = 22000+, Win11 22H2 = 22621 */
  minBuild?: number;
  maxBuild?: number;
  notes?: string;
}

export interface Tweak {
  id: string;
  name: string;
  group?: string;
  categories: Category[];
  description: string;
  impact: string;
  risk: Risk;
  securityWarning?: string;
  recommended: boolean;
  rebootRequired: boolean;
  /** e.g. "Takes effect for apps started afterwards; sign out/in for full effect." */
  effectiveNote?: string;
  requirements?: Requirements;
  actions: ActionSpec[];
  /**
   * Remote kill-switch: the catalog no longer offers this optimization. It is
   * hidden from lists and cannot be applied, but remains revertible while it
   * is still applied on this machine.
   */
  retired?: boolean;
  retiredReason?: string;
}

/* ------------------------------------------------------------------ */
/* Undo records + backups                                              */
/* ------------------------------------------------------------------ */

export type Undo =
  | {
      kind: 'registry';
      hive: RegistryHive;
      key: string;
      name: string;
      existed: boolean;
      valueType?: string;
      value?: string | number;
    }
  | {
      kind: 'service.start';
      service: string;
      startBefore: 'boot' | 'system' | 'auto' | 'manual' | 'disabled';
    }
  | { kind: 'service.stop'; service: string; wasRunning: boolean }
  | { kind: 'task.enabled'; taskPath: string; taskName: string; enabledBefore: boolean }
  | { kind: 'powercfg.scheme'; schemeBefore: string }
  | { kind: 'tcp.setting'; setting: string; valueBefore: string }
  | { kind: 'bcdedit'; element: string; existed: boolean; valueBefore?: string }
  | {
      kind: 'nic.advanced';
      pattern: string;
      entries: { adapter: string; keyword: string; valueBefore: number }[];
    }
  | { kind: 'powercfg.value'; subgroup: string; setting: string; valueBefore: number }
  /** Target of the action is not present on this system; nothing was changed. */
  | { kind: 'noop'; reason: string };

export interface BackupEntry {
  actionIndex: number;
  action: ActionSpec;
  undo: Undo;
}

export interface BackupFile {
  tweakId: string;
  createdAt: string;
  appVersion: string;
  catalogVersion: string;
  entries: BackupEntry[];
}

/* ------------------------------------------------------------------ */
/* Results / state / plans                                             */
/* ------------------------------------------------------------------ */

export interface StepLog {
  ts: number;
  level: 'info' | 'warn' | 'error';
  code?: string;
  message: string;
}

export type TweakStatus = 'applied' | 'reverted' | 'failed' | 'unsupported' | 'up-to-date';

export interface ActionResult {
  tweakId: string;
  status: TweakStatus;
  errorCode?: string;
  errorMessage?: string;
  rebootRequired?: boolean;
  steps: StepLog[];
}

export interface TweakState {
  status: 'applied' | 'reverted' | 'failed';
  appliedAt?: string;
  revertedAt?: string;
  backupFile?: string;
  rebootRequired?: boolean;
  lastError?: { code: string; message: string };
}

export interface AppState {
  schema: 1;
  tweaks: Record<string, TweakState>;
}

export interface PlanEntry {
  actionIndex: number;
  type: string;
  description: string;
  current: string;
  target: string;
  changed: boolean;
  /** Set when the current state could not be read without elevation. */
  note?: string;
}

export interface TweakPlan {
  tweakId: string;
  requiresElevation: boolean;
  unsupportedReason?: string;
  alreadyApplied: boolean;
  entries: PlanEntry[];
}

export interface JournalLine {
  ts: number;
  op: 'apply' | 'revert' | 'system';
  tweakId: string;
  level: 'info' | 'warn' | 'error';
  code?: string;
  message: string;
}
