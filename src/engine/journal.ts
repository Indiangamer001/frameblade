import fs from 'fs';
import path from 'path';
import { EnginePaths } from './paths';
import { JournalLine } from '../shared/types';

export function appendJournal(p: EnginePaths, line: JournalLine): void {
  fs.mkdirSync(path.dirname(p.journalFile), { recursive: true });
  fs.appendFileSync(p.journalFile, JSON.stringify(line) + '\n', 'utf8');
}

export function readJournal(p: EnginePaths, max = 250): JournalLine[] {
  try {
    const txt = fs.readFileSync(p.journalFile, 'utf8');
    const lines = txt.split(/\r?\n/).filter(Boolean);
    const out: JournalLine[] = [];
    for (const l of lines.slice(-max)) {
      try {
        out.push(JSON.parse(l) as JournalLine);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}
