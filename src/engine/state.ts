import fs from 'fs';
import { EnginePaths } from './paths';
import { AppState } from '../shared/types';

export function emptyState(): AppState {
  return { schema: 1, tweaks: {} };
}

export function loadState(p: EnginePaths): AppState {
  try {
    const raw = fs.readFileSync(p.stateFile, 'utf8');
    const parsed = JSON.parse(raw) as AppState;
    if (parsed && parsed.schema === 1 && typeof parsed.tweaks === 'object' && parsed.tweaks) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return emptyState();
}

export function saveState(p: EnginePaths, state: AppState): void {
  const tmp = p.stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, p.stateFile);
}
