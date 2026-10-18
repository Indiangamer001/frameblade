// Support-friendly error taxonomy, mirroring the pattern used by Hone
// (see report Appendix C). Codes are surfaced in the UI and journals.

export const ERROR_CODES = {
  RES001: 'Resource access failure',
  RES002: 'Resource download failed',
  RES003: 'Resource update required',
  RES004: 'Resource download corrupted',
  RES005: 'Resource file save fail',
  RES009: 'Missing resource file',
  UTIL001: 'Optimization process conflict (anti-tamper / interference)',
  UTIL004: 'System verification failure',
  UTIL005: 'Optimization loading failure',
  UTIL006: 'Optimization failure',
  UTIL007: 'Unsupported optimization',
  UTIL008: 'Out of space',
  UTIL009: 'Extraction failure',
  UTIL010: 'Reboot failure',
  UTIL011: 'A required Windows service is disabled',
  UTIL085: 'Backup verification failure',
  UTIL086: 'Startup verification failure',
  OPT002: 'Optimization cannot run',
  OPT007: 'Stuck optimization failure',
  OPT010: 'System compatibility check failure',
  SYS015: 'System file in use',
  ELEVATION_CANCELLED: 'Elevation was cancelled',
  UNKNOWN: 'Unknown error',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class EngineError extends Error {
  code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? ERROR_CODES[code]);
    this.code = code;
    this.name = 'EngineError';
  }

  static from(err: unknown): EngineError {
    if (err instanceof EngineError) return err;
    const e = err as { code?: string; message?: string };
    if (e && typeof e.code === 'string' && e.code in ERROR_CODES) {
      return new EngineError(e.code as ErrorCode, e.message);
    }
    return new EngineError('UNKNOWN', e?.message ?? String(err));
  }
}
