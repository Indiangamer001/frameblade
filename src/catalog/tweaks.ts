// Catalog: 21 hand-built, reversible tweaks (core M1 set + Advanced set).
// Scope invariant: a tweak is either all-'user' actions or all-'system' actions.
// (The UI runs user tweaks in-process and system tweaks through the elevated helper.)

import { Tweak, RegistrySetAction, RegistryDeleteAction } from '../shared/types';

function regDword(
  hive: 'HKCU' | 'HKLM',
  key: string,
  name: string,
  value: number,
  scope: 'user' | 'system'
): RegistrySetAction {
  return { type: 'registry.set', hive, key, name, value, valueType: 'REG_DWORD', scope };
}

function regSz(
  hive: 'HKCU' | 'HKLM',
  key: string,
  name: string,
  value: string,
  scope: 'user' | 'system'
): RegistrySetAction {
  return { type: 'registry.set', hive, key, name, value, valueType: 'REG_SZ', scope };
}

function regDel(
  hive: 'HKCU' | 'HKLM',
  key: string,
  name: string,
  scope: 'user' | 'system'
): RegistryDeleteAction {
  return { type: 'registry.delete', hive, key, name, scope };
}

export const TWEAKS: Tweak[] = [
  /* ---------------------------------------------------------------- */
  /* Optimize FPS & Input Lag (core)                                  */
  /* ---------------------------------------------------------------- */
  {
    id: 'disable-game-bar-dvr',
    name: 'Disable Game Bar & DVR',
    group: 'Optimize FPS & Input Lag (core)',
    categories: ['fps-latency'],
    description:
      'Turns off Xbox Game Bar background capture and GameDVR recording. GameDVR keeps a rolling buffer of gameplay encoded in the background; disabling it removes that CPU/GPU overhead and the associated hooks in game processes.',
    impact: 'Removes background capture overhead. Win+G overlay and "record that" stop working.',
    risk: 'low',
    recommended: true,
    rebootRequired: false,
    effectiveNote: 'Takes effect for games started afterwards.',
    actions: [
      regDword('HKCU', 'Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR', 'AppCaptureEnabled', 0, 'user'),
      regDword('HKCU', 'Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR', 'HistoricalCaptureEnabled', 0, 'user'),
      regDword('HKCU', 'System\\GameConfigStore', 'GameDVR_Enabled', 0, 'user'),
    ],
  },
  {
    id: 'optimize-mouse-input',
    name: 'Optimize Mouse Input',
    group: 'Optimize FPS & Input Lag (core)',
    categories: ['fps-latency'],
    description:
      'Disables Windows pointer acceleration ("Enhance pointer precision"). Raw 1:1 mouse input is what competitive players expect; acceleration makes aim inconsistent because cursor speed depends on how fast you move.',
    impact: 'Consistent aim; cursor speed no longer depends on movement speed.',
    risk: 'low',
    recommended: false,
    rebootRequired: false,
    effectiveNote: 'Apps started after applying use the new setting; sign out/in for full effect.',
    actions: [
      regSz('HKCU', 'Control Panel\\Mouse', 'MouseSpeed', '0', 'user'),
      regSz('HKCU', 'Control Panel\\Mouse', 'MouseThreshold1', '0', 'user'),
      regSz('HKCU', 'Control Panel\\Mouse', 'MouseThreshold2', '0', 'user'),
    ],
  },
  {
    id: 'timer-resolution',
    name: 'Timer Resolution Support (Win11+)',
    group: 'Optimize FPS & Input Lag (core)',
    categories: ['fps-latency'],
    description:
      'Enables the Windows 11 registry switch that allows applications to request a global (system-wide) high-resolution timer, instead of paying the cost of per-process timer requests. Paired with an app that requests 0.5 ms timers this improves frame-time consistency.',
    impact: 'Lower-latency timers for apps that request them; no effect until an app requests high resolution.',
    risk: 'low',
    recommended: true,
    rebootRequired: true,
    effectiveNote: 'Requires a reboot. Requires an app that requests high-resolution timers.',
    requirements: {
      minBuild: 22000,
      notes: 'Windows 11 or newer. On Windows 10 the value has no effect.',
    },
    actions: [
      regDword(
        'HKLM',
        'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\kernel',
        'GlobalTimerResolutionRequests',
        1,
        'system'
      ),
    ],
  },
  {
    id: 'power-plan-high-performance',
    name: 'High Performance Power Plan',
    group: 'Optimize FPS & Input Lag (core)',
    categories: ['fps-latency'],
    description:
      'Switches the active power plan to "High performance". The Balanced plan parks cores and scales clocks aggressively to save power, which can add latency spikes under light game load.',
    impact: 'Cores stay ready; less frequency-scaling jitter. On laptops this raises idle power draw and heat.',
    risk: 'low',
    recommended: true,
    rebootRequired: false,
    effectiveNote: 'Revert restores your previous power plan exactly.',
    actions: [{ type: 'powercfg.setActive', scheme: 'high-performance', scope: 'system' }],
  },
  {
    id: 'disable-power-throttling',
    name: 'Disable Power Throttling',
    group: 'Optimize FPS & Input Lag (core)',
    categories: ['fps-latency'],
    description:
      'Turns off Windows power throttling (EcoQoS), which intentionally slows background processes to save battery. With it disabled, background tasks cannot have their scheduling throttled while you play.',
    impact: 'Background work runs at full speed; slightly higher power use.',
    risk: 'low',
    recommended: true,
    rebootRequired: true,
    effectiveNote: 'Read at boot; takes full effect after a reboot.',
    actions: [
      regDword('HKLM', 'SYSTEM\\CurrentControlSet\\Control\\Power\\PowerThrottling', 'PowerThrottlingOff', 1, 'system'),
    ],
  },
  {
    id: 'network-performance-tuning',
    name: 'Network Performance Tuning',
    group: 'Optimize FPS & Input Lag (core)',
    categories: ['network'],
    description:
      'Conservative TCP profile for online play: CUBIC congestion control, ECN disabled, normal receive-window auto-tuning, and removes the classic multimedia network throttling (NetworkThrottlingIndex) and system responsiveness reservation that cap non-multimedia traffic.',
    impact: 'Steadier ping under load. All settings are reversible and are Windows defaults on most systems.',
    risk: 'medium',
    recommended: true,
    rebootRequired: false,
    effectiveNote: 'Applies immediately to new connections.',
    actions: [
      { type: 'tcp.setGlobal', setting: 'congestionprovider', value: 'cubic', scope: 'system' },
      { type: 'tcp.setGlobal', setting: 'ecn', value: 'disabled', scope: 'system' },
      { type: 'tcp.setGlobal', setting: 'autotuninglevel', value: 'normal', scope: 'system' },
      regDword('HKLM', 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile', 'SystemResponsiveness', 10, 'system'),
      regDword('HKLM', 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile', 'NetworkThrottlingIndex', 4294967295, 'system'),
    ],
  },

  /* ---------------------------------------------------------------- */
  /* Visual polish                                                    */
  /* ---------------------------------------------------------------- */
  {
    id: 'visual-effects-performance',
    name: 'Visual Effects: Performance Mode',
    group: 'Visual polish',
    categories: ['quality-of-life'],
    description:
      'Switches Windows visual effects to "Adjust for best performance" and shortens the menu-show delay. Fewer animation/paint cycles in Explorer means less background CPU noise while gaming.',
    impact: 'Snappier menus; classic look instead of animations.',
    risk: 'low',
    recommended: true,
    rebootRequired: false,
    actions: [
      regDword('HKCU', 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects', 'VisualFXSetting', 2, 'user'),
      regDword('HKCU', 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', 'TaskbarAnimations', 0, 'user'),
      regSz('HKCU', 'Control Panel\\Desktop', 'MenuShowDelay', '0', 'user'),
    ],
  },
  {
    id: 'disable-transparency',
    name: 'Disable Transparency Effects',
    group: 'Visual polish',
    categories: ['quality-of-life'],
    description:
      'Disables the acrylic/blur transparency used by Start, taskbar and other surfaces. Blur is composited by the GPU every frame; turning it off frees a small amount of GPU time.',
    impact: 'Slightly less GPU compositing work; opaque UI surfaces.',
    risk: 'low',
    recommended: false,
    rebootRequired: false,
    actions: [
      regDword('HKCU', 'Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', 'EnableTransparency', 0, 'user'),
    ],
  },

  /* ---------------------------------------------------------------- */
  /* Quality of life                                                  */
  /* ---------------------------------------------------------------- */
  {
    id: 'storage-sense-off',
    name: 'Disable Storage Sense',
    group: 'Quality of life',
    categories: ['quality-of-life'],
    description:
      'Prevents Windows from automatically deleting temp files and emptying the recycle bin while games are installed/updated. Avoids surprise disk activity mid-session.',
    impact: 'You manage cleanup manually; existing files are untouched.',
    risk: 'low',
    recommended: false,
    rebootRequired: false,
    actions: [
      regDword(
        'HKCU',
        'Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy',
        '01',
        0,
        'user'
      ),
    ],
  },
  {
    id: 'onedrive-autostart-off',
    name: 'Remove OneDrive Autostart',
    group: 'Quality of life',
    categories: ['quality-of-life'],
    description:
      'Removes the OneDrive entry from the user "Run" key so it no longer launches and syncs in the background at login. OneDrive itself is not uninstalled; files stay in place.',
    impact: 'Less login CPU/disk/network activity. Start OneDrive manually when you want it.',
    risk: 'low',
    recommended: false,
    rebootRequired: false,
    effectiveNote: 'The removed autostart entry is backed up and restored on revert.',
    actions: [
      regDel('HKCU', 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'OneDrive', 'user'),
    ],
  },

  /* ---------------------------------------------------------------- */
  /* Privacy                                                          */
  /* ---------------------------------------------------------------- */
  {
    id: 'reduce-telemetry-core',
    name: 'Reduce Telemetry (Core)',
    group: 'Privacy',
    categories: ['privacy'],
    description:
      'Sets the diagnostic data policy to the minimum, disables and stops the Connected User Experiences and Telemetry service (DiagTrack), and disables the compatibility appraiser scheduled task that inventories your installed software.',
    impact: 'Less background disk/CPU/network use; Feedback Hub diagnostics limited.',
    risk: 'medium',
    recommended: true,
    rebootRequired: false,
    actions: [
      regDword('HKLM', 'SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection', 'AllowTelemetry', 0, 'system'),
      { type: 'service.setStart', service: 'DiagTrack', start: 'disabled', scope: 'system' },
      { type: 'service.stop', service: 'DiagTrack', scope: 'system' },
      {
        type: 'task.setEnabled',
        taskPath: '\\Microsoft\\Windows\\Application Experience\\',
        taskName: 'Microsoft Compatibility Appraiser',
        enabled: false,
        scope: 'system',
      },
    ],
  },

  {
    id: 'disable-sysmain',
    name: 'Disable SysMain (Superfetch)',
    group: 'Quality of Life',
    categories: ['quality-of-life'],
    description:
      'Stops and disables the SysMain service, which preloads frequently used apps into RAM and runs background memory/disk optimization. On SSDs the benefit is small, and competitive guides disable it to cut background disk activity.',
    impact: 'Less background disk/CPU activity; a few app launches may slow marginally.',
    risk: 'medium',
    recommended: false,
    rebootRequired: false,
    effectiveNote: 'The service is stopped immediately and disabled for future boots.',
    actions: [
      { type: 'service.setStart', service: 'SysMain', start: 'disabled', scope: 'system' },
      { type: 'service.stop', service: 'SysMain', scope: 'system' },
    ],
  },
  {
    id: 'priority-separation-gaming',
    name: 'Win32 Priority Separation — Gaming Preset',
    group: 'Optimize FPS & Input Lag',
    categories: ['fps-latency'],
    description:
      'Sets Win32PrioritySeparation to 26 (fixed short CPU quanta with foreground boost), the scheduling preset commonly cited by latency-tuning guides for consistent frame pacing. The captured default is restored on revert.',
    impact: 'More consistent CPU scheduling for the foreground game process.',
    risk: 'medium',
    recommended: false,
    rebootRequired: false,
    effectiveNote: 'Applies to new scheduling decisions immediately; log out/in for every process.',
    actions: [
      regDword('HKLM', 'SYSTEM\\CurrentControlSet\\Control\\PriorityControl', 'Win32PrioritySeparation', 26, 'system'),
    ],
  },

  /* ---------------------------------------------------------------- */
  /* Advanced (mirrors Hone's Advanced Settings + security trade-offs) */
  /* ---------------------------------------------------------------- */
  {
    id: 'disable-lso-offloads',
    name: 'Disable Large Send Offloads',
    group: 'Advanced',
    categories: ['network'],
    description:
      'Turns off Large Send Offload (LSO) on physical network adapters. LSO lets the NIC split large TCP segments; disabling it moves that work back to the CPU and is used by latency tweakers to remove packet-burst jitter. Hone lists this under Advanced Settings, and it can reduce maximum throughput on fast links.',
    impact: 'May smooth latency spikes; can reduce throughput on 2.5G/10G links. Reversible per adapter.',
    risk: 'medium',
    recommended: false,
    rebootRequired: false,
    effectiveNote: 'Applies to the active NIC immediately; revert restores each adapter property exactly.',
    actions: [
      { type: 'nic.setAdvanced', registryKeywordPattern: 'Lso', value: 0, scope: 'system' },
    ],
  },
  {
    id: 'disable-vbs-hyperv',
    name: 'Disable VBS and Hyper-V',
    group: 'Advanced',
    categories: ['fps-latency'],
    description:
      'Sets hypervisorlaunchtype=off and disables virtualization-based security, HVCI (memory integrity) and Credential Guard. Removes the hypervisor layer and its overhead (0-5% depending on system and workload). Hone ships this as an advanced toggle and warns in its own KB: "most anti-cheats rely on these!"',
    impact: 'Removes hypervisor/VBS overhead after a reboot. Kernel-level security protections are reduced.',
    risk: 'high',
    securityWarning:
      'Anti-cheats (Vanguard, FACEIT, ESEA-class) and some enterprise features rely on VBS-class protections - games may refuse to launch or flag the system. Also weakens protection against kernel malware and credential theft. Hone rates this High risk; so do we.',
    recommended: false,
    rebootRequired: true,
    effectiveNote: 'Takes full effect after a reboot. Revert restores the previous hypervisor setting and VBS keys.',
    actions: [
      { type: 'bcdedit.set', element: 'hypervisorlaunchtype', value: 'off', scope: 'system' },
      regDword('HKLM', 'SYSTEM\\CurrentControlSet\\Control\\DeviceGuard', 'EnableVirtualizationBasedSecurity', 0, 'system'),
      regDword('HKLM', 'SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity', 'Enabled', 0, 'system'),
      regDword('HKLM', 'SYSTEM\\CurrentControlSet\\Control\\Lsa', 'LsaCfgFlags', 0, 'system'),
    ],
  },
  {
    id: 'disable-mitigations',
    name: 'Disable Mitigations',
    group: 'Advanced',
    categories: ['fps-latency'],
    description:
      'Sets FeatureSettingsOverride=3 and FeatureSettingsOverrideMask=3, disabling the kernel Spectre/Meltdown-class side-channel mitigations system-wide. On affected CPUs this removes the mitigation performance cost. Hone marks this as a security trade-off.',
    impact: 'On affected CPUs: removes mitigation overhead. No effect on CPUs not affected by those vulnerabilities.',
    risk: 'high',
    securityWarning:
      'Disables real hardware side-channel protections (Spectre/Meltdown class) for the whole system. Some anti-cheats dislike this. Only appropriate on dedicated gaming machines where the risk is understood.',
    recommended: false,
    rebootRequired: true,
    effectiveNote: 'Read at boot; takes full effect after a reboot. Revert restores the previous values.',
    actions: [
      regDword('HKLM', 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management', 'FeatureSettingsOverride', 3, 'system'),
      regDword('HKLM', 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management', 'FeatureSettingsOverrideMask', 3, 'system'),
    ],
  },
  {
    id: 'disable-defender-realtime',
    name: 'Disable Windows Defender (Realtime)',
    group: 'Advanced',
    categories: ['fps-latency'],
    description:
      'Sets the policy values that turn off Defender real-time monitoring (DisableAntiSpyware and DisableRealtimeMonitoring). Hone references this as an advanced optimization "at the cost of security". Modern Windows enforces Tamper Protection, so these policies may be ignored until it is turned off manually.',
    impact: 'Removes Defender background scanning cost. Only sensible with a replacement AV or an offline-only machine.',
    risk: 'high',
    securityWarning:
      'A PC without real-time AV protection is exposed to malware and looks suspicious to other security software and anti-cheats. Hone itself lists this among optimizations that trade security for performance. Do not use on a machine you browse or download with.',
    recommended: false,
    rebootRequired: false,
    effectiveNote: 'May require Tamper Protection to be turned off in Windows Security first, then "gpupdate /force" or a reboot. Revert restores policy values; re-verify protection afterwards.',
    actions: [
      regDword('HKLM', 'SOFTWARE\\Policies\\Microsoft\\Windows Defender', 'DisableAntiSpyware', 1, 'system'),
      regDword('HKLM', 'SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection', 'DisableRealtimeMonitoring', 1, 'system'),
    ],
  },
  {
    id: 'disable-mpo',
    name: 'Disable Multi-Plane Overlays (MPO)',
    group: 'Advanced',
    categories: ['fps-latency'],
    description:
      'Sets DWM OverlayTestMode=5, the documented compatibility switch that turns off Multi-Plane Overlay composition. MPO lets the GPU composite overlay planes in hardware; on some driver/display combinations it causes flicker, stutter or presentation latency. Disabling it can smooth frame pacing on those systems, but increases desktop composition work and can hurt performance elsewhere.',
    impact: 'May fix MPO-related flicker/stutter; can add GPU composition load. Test games and revert if frame times worsen.',
    risk: 'medium',
    recommended: false,
    rebootRequired: false,
    effectiveNote: 'Takes effect after signing out and back in (DWM restart). A reboot is the simplest way to be sure.',
    actions: [regDword('HKLM', 'SOFTWARE\\Microsoft\\Windows\\Dwm', 'OverlayTestMode', 5, 'system')],
  },
  {
    id: 'disable-dynamic-interrupt-steering',
    name: 'Disable Dynamic Interrupt Steering',
    group: 'Advanced',
    categories: ['fps-latency'],
    description:
      'Sets the hidden power setting "Interrupt Steering Mode" (SUB_INTSTEER / MODE) to "Lock Interrupt Routing" (index 4) instead of the dynamic Windows default. Changes how hardware interrupts are routed across cores; community testing reports smoother DPC/ISR behavior on some systems and worse on others.',
    impact: 'May reduce DPC/ISR jitter; effect is system-specific - test and revert if latency worsens.',
    risk: 'medium',
    recommended: false,
    rebootRequired: false,
    effectiveNote: 'Hidden power setting (not visible in the stock power-plan UI; read via powercfg /qh). Applies immediately.',
    requirements: {
      minBuild: 22621,
      notes: 'Interrupt Steering Mode ships on Windows 11 22H2 and newer.',
    },
    actions: [
      {
        type: 'powercfg.setAcValue',
        subgroup: '48672f38-7a9a-4bb2-8bf8-3d85be19de4e',
        setting: '2bfc24f9-5ea2-4801-8213-3dbae01aa39d',
        value: 4,
        scope: 'system',
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  /* 1.4-era extras                                                   */
  /* ---------------------------------------------------------------- */
  {
    id: 'disable-ntfs-last-access',
    name: 'Disable NTFS Last Access Updates',
    group: 'Quality of life',
    categories: ['quality-of-life'],
    description:
      'Stops NTFS from writing last-access timestamps when files are read. The update is small but constant while game libraries, launchers and shader caches are scanned. Backup and archival tools that depend on access times may see stale timestamps; game data itself is unaffected.',
    impact: 'Fewer metadata writes during file scans and level loads; access-time-based tools stop seeing reads.',
    risk: 'low',
    recommended: false,
    rebootRequired: false,
    effectiveNote: 'Applies immediately to new file accesses. No reboot needed.',
    actions: [
      regDword(
        'HKLM',
        'SYSTEM\\CurrentControlSet\\Control\\FileSystem',
        'NtfsDisableLastAccessUpdate',
        1,
        'system'
      ),
    ],
  },
  {
    id: 'disable-disk-quotas',
    name: 'Disable Disk Quotas',
    group: 'Quality of life',
    categories: ['quality-of-life'],
    description:
      "Disables the NTFS disk-quota policy. Quota tracking has a small metadata cost; this is one of Hone's 1.4-era optimizations (with a warning to avoid it on managed PCs).",
    impact: 'Tiny filesystem bookkeeping removed; quota management stops being enforced.',
    risk: 'low',
    recommended: false,
    rebootRequired: false,
    actions: [
      regDword('HKLM', 'SOFTWARE\\Policies\\Microsoft\\Windows\\DiskQuota', 'Enable', 0, 'system'),
    ],
  },
];
