// Built-in modes: named, ready-to-apply presets of catalog tweaks.
// "Turbo Gaming" is the flagship one-click setup; users can also save
// their own profiles (see engine/profiles.ts) which appear next to these.

import { recommendedIds } from './catalog';

export interface Mode {
  id: string;
  name: string;
  tagline: string;
  builtin: boolean;
  /** Shows the "recommended" badge in the UI. */
  highlighted?: boolean;
  tweakIds: string[];
}

export function builtinModes(): Mode[] {
  return [
    {
      id: 'turbo-gaming',
      name: 'Turbo Gaming',
      tagline: 'Frameblade recommended gaming setup',
      builtin: true,
      highlighted: true,
      tweakIds: recommendedIds(),
    },
  ];
}

export function findBuiltinMode(id: string): Mode | undefined {
  return builtinModes().find((m) => m.id === id);
}
