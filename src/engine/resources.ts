// Remote resources pipeline (report §5.3 / §12.1): the optimization catalog is a
// versioned, signed JSON pack that is downloaded, verified, cached and loaded at
// runtime. The bundled catalog is always the fallback — every failure here fails
// closed and leaves the app in bundled mode.
//
// Error surface mirrors Hone's taxonomy (report Appendix C):
//   RES001 resource access failure      (unreadable files, invalid endpoint)
//   RES002 resource download failed     (network, HTTP, timeout, oversized body)
//   RES003 resource update required     (newer catalog format / signing key / client)
//   RES004 resource download corrupted  (signature, JSON, schema validation)
//   RES005 resource file save fail      (cache write)
//   RES009 missing resources file       (cache absent or corrupt on load)

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { ActionSpec, Category, Tweak } from '../shared/types';
import { APP_VERSION } from './paths';

/** Envelope version understood by this build. */
export const CATALOG_FORMAT = 1;
/** Placeholder production endpoint; the resource service is not deployed yet. */
export const DEFAULT_CATALOG_ENDPOINT = 'https://resources.frameblade.gg/catalog-v1.json';
/** Raw envelope size cap (the payload is base64 inside it). */
export const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
/** Decoded payload size cap. */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
export const MAX_TWEAKS = 500;
export const MAX_ACTIONS = 24;
/** Upper bound for catalogVersion (unix-second stamps fit comfortably). */
export const MAX_CATALOG_VERSION = 4_000_000_000;

/**
 * Catalog signing keys trusted by this build. Keys live in the app so a
 * user-writable trust file can never widen the trust root. The `dev-1` key is
 * the local development key used by `scripts/serve-catalog.js`; production
 * builds must replace it with real release keys.
 */
export const TRUSTED_KEYS: Record<string, string> = {
  'dev-1': `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAiQ6UujtRR3ei2dk55vUtnKd0JQyDTyHBoaD6NkvycG0=
-----END PUBLIC KEY-----`,
};

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface CatalogPayload {
  /** Monotonic integer, bumped on every published catalog. */
  catalogVersion: number;
  /** ISO timestamp of publication. */
  publishedAt: string;
  /** Minimum Frameblade version required to understand this payload. */
  minClient?: string;
  /** Optional release notes shown in the UI/journal. */
  notes?: string;
  /** Full snapshot (a remote catalog both overrides and extends the bundled one). */
  tweaks: Tweak[];
}

export interface CatalogEnvelope {
  format: number;
  keyId: string;
  /** Ed25519 signature over `signingInput(format, keyId, payloadBytes)`, base64url. */
  signature: string;
  /** base64url of the UTF-8 payload JSON. */
  payload: string;
}

export interface CatalogCacheFile {
  schema: 1;
  endpoint: string;
  fetchedAt: string;
  envelope: CatalogEnvelope;
}

export interface CatalogFailure {
  ok: false;
  code: string;
  message: string;
}

export type CatalogResult<T> = { ok: true; value: T } | CatalogFailure;

export interface CatalogConfig {
  endpoint: string;
  source: 'env' | 'file' | 'default';
}

function fail(code: string, message: string): CatalogFailure {
  return { ok: false, code, message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ------------------------------------------------------------------ */
/* Version helpers                                                     */
/* ------------------------------------------------------------------ */

/** Numeric compare of dotted versions ("1.2.3"); missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* Signing / verification                                              */
/* ------------------------------------------------------------------ */

function decodeB64url(s: unknown, maxBytes: number): Buffer | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  const trimmed = s.replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  const buf = Buffer.from(trimmed, 'base64url');
  if (buf.length === 0 || buf.length > maxBytes) return null;
  // Reject non-canonical encodings so signatures are checked over exact bytes.
  return buf.toString('base64url') === trimmed ? buf : null;
}

/**
 * The bytes covered by the signature. Binding the envelope format and key id
 * prevents key-substitution / format-downgrade games.
 */
export function signingInput(format: number, keyId: string, payloadBytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`frameblade/catalog;format=${format};key=${keyId}\n`, 'utf8'),
    payloadBytes,
  ]);
}

/**
 * Builds a signed envelope. Used by the local catalog server and tests;
 * private keys never ship inside the app bundle.
 */
export function buildEnvelope(
  payload: CatalogPayload,
  opts: { keyId: string; privateKeyPem: string; format?: number }
): CatalogEnvelope {
  const format = opts.format ?? CATALOG_FORMAT;
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto.sign(
    null,
    signingInput(format, opts.keyId, payloadBytes),
    opts.privateKeyPem
  );
  return {
    format,
    keyId: opts.keyId,
    signature: signature.toString('base64url'),
    payload: payloadBytes.toString('base64url'),
  };
}

export function verifyEnvelope(
  raw: unknown,
  opts?: { keys?: Record<string, string>; appVersion?: string }
): CatalogResult<{ envelope: CatalogEnvelope; payload: CatalogPayload }> {
  const keys = opts?.keys ?? TRUSTED_KEYS;
  const appVersion = opts?.appVersion ?? APP_VERSION;

  if (!isRecord(raw)) return fail('RES004', 'The catalog envelope is not a JSON object.');

  const format = raw.format;
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) {
    return fail('RES004', 'The catalog envelope has an invalid format marker.');
  }
  if (format > CATALOG_FORMAT) {
    return fail(
      'RES003',
      `This catalog uses a newer format (v${format}); update Frameblade to load it.`
    );
  }

  const keyId = raw.keyId;
  if (typeof keyId !== 'string' || !/^[a-zA-Z0-9._-]{1,40}$/.test(keyId)) {
    return fail('RES004', 'The catalog envelope has an invalid signing key id.');
  }
  const pem = keys[keyId];
  if (!pem) {
    return fail(
      'RES003',
      `The catalog is signed with a key this build does not know ('${keyId}'); update Frameblade.`
    );
  }

  const payloadBytes = decodeB64url(raw.payload, MAX_PAYLOAD_BYTES);
  if (!payloadBytes) return fail('RES004', 'The catalog payload is missing or corrupt.');

  const signature = decodeB64url(raw.signature, 512);
  if (!signature) return fail('RES004', 'The catalog signature is missing or corrupt.');

  let verified = false;
  try {
    verified = crypto.verify(
      null,
      signingInput(format, keyId, payloadBytes),
      crypto.createPublicKey(pem),
      signature
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    return fail('RES004', 'The catalog signature could not be verified — the download was altered or corrupt.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return fail('RES004', 'The signed catalog payload is not valid JSON.');
  }

  const checked = validatePayload(parsed);
  if (!checked.ok) return checked;

  if (checked.value.minClient && compareVersions(checked.value.minClient, appVersion) > 0) {
    return fail(
      'RES003',
      `This catalog requires Frameblade ${checked.value.minClient} or newer (this build is ${appVersion}).`
    );
  }

  return {
    ok: true,
    value: {
      envelope: {
        format,
        keyId,
        signature: raw.signature as string,
        payload: raw.payload as string,
      },
      payload: checked.value,
    },
  };
}

export function verifyEnvelopeText(
  text: string,
  opts?: { keys?: Record<string, string>; appVersion?: string }
): CatalogResult<{ envelope: CatalogEnvelope; payload: CatalogPayload }> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('RES004', 'The downloaded catalog is not valid JSON.');
  }
  return verifyEnvelope(raw, opts);
}

/* ------------------------------------------------------------------ */
/* Payload schema validation                                           */
/* ------------------------------------------------------------------ */

const CATEGORIES = new Set<Category>(['fps-latency', 'network', 'quality-of-life', 'privacy']);

const TWEAK_KEYS = new Set([
  'id',
  'name',
  'group',
  'categories',
  'description',
  'impact',
  'risk',
  'securityWarning',
  'recommended',
  'rebootRequired',
  'effectiveNote',
  'requirements',
  'actions',
  'retired',
  'retiredReason',
]);

const ACTION_KEYS: Record<string, string[]> = {
  'registry.set': ['type', 'hive', 'key', 'name', 'value', 'valueType', 'scope', 'description'],
  'registry.delete': ['type', 'hive', 'key', 'name', 'scope', 'description'],
  'service.setStart': ['type', 'service', 'start', 'scope', 'description'],
  'service.stop': ['type', 'service', 'scope', 'description'],
  'task.setEnabled': ['type', 'taskPath', 'taskName', 'enabled', 'scope', 'description'],
  'powercfg.setActive': ['type', 'scheme', 'scope', 'description'],
  'tcp.setGlobal': ['type', 'setting', 'value', 'scope', 'description'],
  'bcdedit.set': ['type', 'element', 'value', 'scope', 'description'],
  'bcdedit.delete': ['type', 'element', 'scope', 'description'],
  'nic.setAdvanced': ['type', 'registryKeywordPattern', 'value', 'scope', 'description'],
  'powercfg.setAcValue': ['type', 'subgroup', 'setting', 'value', 'scope', 'description'],
};

const RE = {
  id: /^[a-z0-9][a-z0-9-]{2,63}$/,
  semver: /^\d{1,4}\.\d{1,4}\.\d{1,4}$/,
  regKey: /^[A-Za-z0-9 _.\-\\{}(),]{1,512}$/,
  regName: /^[A-Za-z0-9 _.\-]{1,255}$/,
  hive: /^(HKCU|HKLM)$/,
  valueType: /^(REG_SZ|REG_EXPAND_SZ|REG_DWORD)$/,
  service: /^[A-Za-z0-9_.\-]{1,64}$/,
  taskPath: /^\\[A-Za-z0-9_\\ .\-()]*$/,
  taskName: /^[A-Za-z0-9_ .\-()]{1,200}$/,
  tcpValue: /^[A-Za-z0-9_-]{1,32}$/,
  bcdElement: /^[a-z][a-z0-9]{0,47}$/,
  bcdValue: /^[A-Za-z0-9_.\-]{1,64}$/,
  nicPattern: /^[A-Za-z0-9 _.\-\\/:*]{1,64}$/,
  guid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
};

function isText(v: unknown, min: number, max: number): v is string {
  return (
    typeof v === 'string' &&
    v.length >= min &&
    v.length <= max &&
    !/[\u0000\r\n]/.test(v)
  );
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function unexpectedKey(obj: Record<string, unknown>, allowed: Iterable<string>): string | null {
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  for (const k of Object.keys(obj)) {
    if (!set.has(k)) return k;
  }
  return null;
}

function validateRequirements(
  raw: unknown,
  at: (msg: string) => string
): CatalogResult<NonNullable<Tweak['requirements']>> {
  if (!isRecord(raw)) return fail('RES004', at('requirements must be an object'));
  const bad = unexpectedKey(raw, ['minBuild', 'maxBuild', 'notes']);
  if (bad) return fail('RES004', at(`unknown requirements field '${bad}'`));
  if (raw.minBuild !== undefined && !isInt(raw.minBuild, 0, 999999)) {
    return fail('RES004', at('requirements.minBuild must be an integer'));
  }
  if (raw.maxBuild !== undefined && !isInt(raw.maxBuild, 0, 999999)) {
    return fail('RES004', at('requirements.maxBuild must be an integer'));
  }
  if (raw.notes !== undefined && !isText(raw.notes, 0, 300)) {
    return fail('RES004', at('requirements.notes must be a short single-line string'));
  }
  if (
    typeof raw.minBuild === 'number' &&
    typeof raw.maxBuild === 'number' &&
    raw.minBuild > raw.maxBuild
  ) {
    return fail('RES004', at('requirements.minBuild is greater than maxBuild'));
  }
  return {
    ok: true,
    value: {
      ...(typeof raw.minBuild === 'number' ? { minBuild: raw.minBuild } : {}),
      ...(typeof raw.maxBuild === 'number' ? { maxBuild: raw.maxBuild } : {}),
      ...(typeof raw.notes === 'string' ? { notes: raw.notes } : {}),
    },
  };
}

function validateAction(
  raw: unknown,
  tweakIndex: number,
  actionIndex: number
): CatalogResult<ActionSpec> {
  const at = (msg: string) =>
    `tweaks[${tweakIndex}].actions[${actionIndex}]: ${msg}`;
  if (!isRecord(raw)) return fail('RES004', at('action must be an object'));
  if (typeof raw.type !== 'string') return fail('RES004', at('missing action type'));

  const allowed = ACTION_KEYS[raw.type];
  if (!allowed) return fail('RES004', at(`unsupported action type '${raw.type}'`));
  const extra = unexpectedKey(raw, allowed);
  if (extra) return fail('RES004', at(`unknown field '${extra}'`));

  if (raw.scope !== 'user' && raw.scope !== 'system') {
    return fail('RES004', at("scope must be 'user' or 'system'"));
  }
  const scope = raw.scope;
  if (raw.description !== undefined && !isText(raw.description, 0, 300)) {
    return fail('RES004', at('description must be a short single-line string'));
  }
  const description = typeof raw.description === 'string' ? raw.description : undefined;

  switch (raw.type) {
    case 'registry.set':
    case 'registry.delete': {
      if (typeof raw.hive !== 'string' || !RE.hive.test(raw.hive)) {
        return fail('RES004', at('hive must be HKCU or HKLM'));
      }
      const hive = raw.hive as 'HKCU' | 'HKLM';
      if (typeof raw.key !== 'string' || !RE.regKey.test(raw.key)) {
        return fail('RES004', at('registry key contains unsupported characters'));
      }
      if (typeof raw.name !== 'string' || !RE.regName.test(raw.name)) {
        return fail('RES004', at('registry value name contains unsupported characters'));
      }
      // HKCU under an elevated helper would target the admin's hive, not the
      // player's. Keep HKCU strictly user-scope and HKLM strictly system-scope.
      if (hive === 'HKCU' && scope !== 'user') {
        return fail('RES004', at('HKCU actions must use user scope'));
      }
      if (hive === 'HKLM' && scope !== 'system') {
        return fail('RES004', at('HKLM actions must use system scope'));
      }

      if (raw.type === 'registry.delete') {
        return {
          ok: true,
          value: { type: 'registry.delete', hive, key: raw.key, name: raw.name, scope, description },
        };
      }

      const value = raw.value;
      if (typeof value !== 'number' && typeof value !== 'string') {
        return fail('RES004', at('value must be a string or an integer'));
      }
      if (typeof value === 'number' && !isInt(value, -2147483648, 4294967295)) {
        return fail('RES004', at('numeric registry values must be 32-bit integers'));
      }
      if (typeof value === 'string' && (value.length > 4096 || /[\u0000\r\n]/.test(value))) {
        return fail('RES004', at('string registry values must be single-line, max 4096 chars'));
      }
      if (raw.valueType !== undefined && (typeof raw.valueType !== 'string' || !RE.valueType.test(raw.valueType))) {
        return fail('RES004', at('valueType must be REG_SZ, REG_EXPAND_SZ or REG_DWORD'));
      }
      const valueType = raw.valueType as 'REG_SZ' | 'REG_EXPAND_SZ' | 'REG_DWORD' | undefined;
      if (typeof value === 'number' && valueType && valueType !== 'REG_DWORD') {
        return fail('RES004', at('numeric values require REG_DWORD'));
      }
      if (typeof value === 'string' && valueType === 'REG_DWORD') {
        return fail('RES004', at('string values cannot use REG_DWORD'));
      }
      return {
        ok: true,
        value: {
          type: 'registry.set',
          hive,
          key: raw.key,
          name: raw.name,
          value,
          ...(valueType ? { valueType } : {}),
          scope,
          description,
        },
      };
    }

    case 'service.setStart': {
      if (scope !== 'system') return fail('RES004', at('service actions require system scope'));
      if (typeof raw.service !== 'string' || !RE.service.test(raw.service)) {
        return fail('RES004', at('invalid service name'));
      }
      if (raw.start !== 'auto' && raw.start !== 'manual' && raw.start !== 'disabled') {
        return fail('RES004', at("start must be 'auto', 'manual' or 'disabled'"));
      }
      return {
        ok: true,
        value: { type: 'service.setStart', service: raw.service, start: raw.start, scope, description },
      };
    }

    case 'service.stop': {
      if (scope !== 'system') return fail('RES004', at('service actions require system scope'));
      if (typeof raw.service !== 'string' || !RE.service.test(raw.service)) {
        return fail('RES004', at('invalid service name'));
      }
      return { ok: true, value: { type: 'service.stop', service: raw.service, scope, description } };
    }

    case 'task.setEnabled': {
      if (scope !== 'system') return fail('RES004', at('task actions require system scope'));
      if (typeof raw.taskPath !== 'string' || !RE.taskPath.test(raw.taskPath) || raw.taskPath.length > 200) {
        return fail('RES004', at('taskPath must start with \\ and use safe characters'));
      }
      if (typeof raw.taskName !== 'string' || !RE.taskName.test(raw.taskName)) {
        return fail('RES004', at('invalid task name'));
      }
      if (typeof raw.enabled !== 'boolean') return fail('RES004', at('enabled must be a boolean'));
      return {
        ok: true,
        value: {
          type: 'task.setEnabled',
          taskPath: raw.taskPath,
          taskName: raw.taskName,
          enabled: raw.enabled,
          scope,
          description,
        },
      };
    }

    case 'powercfg.setActive': {
      if (scope !== 'system') return fail('RES004', at('power actions require system scope'));
      if (raw.scheme !== 'high-performance') {
        return fail('RES004', at("scheme must be 'high-performance'"));
      }
      return { ok: true, value: { type: 'powercfg.setActive', scheme: 'high-performance', scope, description } };
    }

    case 'tcp.setGlobal': {
      if (scope !== 'system') return fail('RES004', at('TCP actions require system scope'));
      if (
        raw.setting !== 'congestionprovider' &&
        raw.setting !== 'ecn' &&
        raw.setting !== 'autotuninglevel'
      ) {
        return fail('RES004', at('unsupported TCP setting'));
      }
      if (typeof raw.value !== 'string' || !RE.tcpValue.test(raw.value)) {
        return fail('RES004', at('invalid TCP value'));
      }
      return {
        ok: true,
        value: { type: 'tcp.setGlobal', setting: raw.setting, value: raw.value, scope, description },
      };
    }

    case 'bcdedit.set': {
      if (scope !== 'system') return fail('RES004', at('boot configuration actions require system scope'));
      if (typeof raw.element !== 'string' || !RE.bcdElement.test(raw.element)) {
        return fail('RES004', at('invalid boot configuration element'));
      }
      if (typeof raw.value !== 'string' || !RE.bcdValue.test(raw.value)) {
        return fail('RES004', at('invalid boot configuration value'));
      }
      return {
        ok: true,
        value: { type: 'bcdedit.set', element: raw.element, value: raw.value, scope, description },
      };
    }

    case 'bcdedit.delete': {
      if (scope !== 'system') return fail('RES004', at('boot configuration actions require system scope'));
      if (typeof raw.element !== 'string' || !RE.bcdElement.test(raw.element)) {
        return fail('RES004', at('invalid boot configuration element'));
      }
      return { ok: true, value: { type: 'bcdedit.delete', element: raw.element, scope, description } };
    }

    case 'nic.setAdvanced': {
      if (scope !== 'system') return fail('RES004', at('NIC actions require system scope'));
      if (
        typeof raw.registryKeywordPattern !== 'string' ||
        !RE.nicPattern.test(raw.registryKeywordPattern) ||
        raw.registryKeywordPattern.trim().length === 0
      ) {
        return fail('RES004', at('invalid NIC registry keyword pattern'));
      }
      if (!isInt(raw.value, -2147483648, 2147483647)) {
        return fail('RES004', at('NIC values must be 32-bit integers'));
      }
      return {
        ok: true,
        value: {
          type: 'nic.setAdvanced',
          registryKeywordPattern: raw.registryKeywordPattern,
          value: raw.value,
          scope,
          description,
        },
      };
    }

    case 'powercfg.setAcValue': {
      if (scope !== 'system') return fail('RES004', at('power actions require system scope'));
      if (typeof raw.subgroup !== 'string' || !RE.guid.test(raw.subgroup)) {
        return fail('RES004', at('invalid power subgroup GUID'));
      }
      if (typeof raw.setting !== 'string' || !RE.guid.test(raw.setting)) {
        return fail('RES004', at('invalid power setting GUID'));
      }
      if (!isInt(raw.value, 0, 1000)) {
        return fail('RES004', at('power setting index must be between 0 and 1000'));
      }
      return {
        ok: true,
        value: {
          type: 'powercfg.setAcValue',
          subgroup: raw.subgroup,
          setting: raw.setting,
          value: raw.value,
          scope,
          description,
        },
      };
    }

    default:
      return fail('RES004', at(`unsupported action type '${raw.type}'`));
  }
}

function validateTweak(raw: unknown, index: number): CatalogResult<Tweak> {
  const at = (msg: string) => `tweaks[${index}]: ${msg}`;
  if (!isRecord(raw)) return fail('RES004', at('optimization must be an object'));

  const extra = unexpectedKey(raw, TWEAK_KEYS);
  if (extra) return fail('RES004', at(`unknown field '${extra}'`));

  if (typeof raw.id !== 'string' || !RE.id.test(raw.id)) {
    return fail('RES004', at('id must be 3-64 chars of a-z, 0-9 and dashes'));
  }
  if (!isText(raw.name, 1, 120)) return fail('RES004', at('name must be 1-120 single-line chars'));
  if (raw.group !== undefined && !isText(raw.group, 1, 100)) {
    return fail('RES004', at('group must be 1-100 single-line chars'));
  }
  if (!Array.isArray(raw.categories) || raw.categories.length === 0 || raw.categories.length > 4) {
    return fail('RES004', at('categories must be a non-empty array'));
  }
  const categories: Category[] = [];
  for (const c of raw.categories) {
    if (typeof c !== 'string' || !CATEGORIES.has(c as Category)) {
      return fail('RES004', at(`unknown category '${String(c)}'`));
    }
    if (!categories.includes(c as Category)) categories.push(c as Category);
  }
  if (!isText(raw.description, 1, 2000)) {
    return fail('RES004', at('description must be 1-2000 single-line chars'));
  }
  if (!isText(raw.impact, 1, 400)) return fail('RES004', at('impact must be 1-400 single-line chars'));
  if (raw.risk !== 'low' && raw.risk !== 'medium' && raw.risk !== 'high') {
    return fail('RES004', at("risk must be 'low', 'medium' or 'high'"));
  }
  if (raw.securityWarning !== undefined && !isText(raw.securityWarning, 1, 600)) {
    return fail('RES004', at('securityWarning must be 1-600 single-line chars'));
  }
  if (typeof raw.recommended !== 'boolean') return fail('RES004', at('recommended must be a boolean'));
  if (typeof raw.rebootRequired !== 'boolean') {
    return fail('RES004', at('rebootRequired must be a boolean'));
  }
  if (raw.effectiveNote !== undefined && !isText(raw.effectiveNote, 1, 400)) {
    return fail('RES004', at('effectiveNote must be 1-400 single-line chars'));
  }
  if (raw.retired !== undefined && typeof raw.retired !== 'boolean') {
    return fail('RES004', at('retired must be a boolean'));
  }
  if (raw.retiredReason !== undefined && !isText(raw.retiredReason, 1, 300)) {
    return fail('RES004', at('retiredReason must be 1-300 single-line chars'));
  }

  let requirements: Tweak['requirements'];
  if (raw.requirements !== undefined) {
    const req = validateRequirements(raw.requirements, at);
    if (!req.ok) return req;
    requirements = req.value;
  }

  if (!Array.isArray(raw.actions) || raw.actions.length === 0) {
    return fail('RES004', at('actions must be a non-empty array'));
  }
  if (raw.actions.length > MAX_ACTIONS) {
    return fail('RES004', at(`too many actions (max ${MAX_ACTIONS})`));
  }

  const actions: ActionSpec[] = [];
  const scopes = new Set<'user' | 'system'>();
  for (let i = 0; i < raw.actions.length; i++) {
    const res = validateAction(raw.actions[i], index, i);
    if (!res.ok) return res;
    actions.push(res.value);
    scopes.add(res.value.scope);
  }
  if (scopes.size !== 1) {
    return fail('RES004', at('all actions must share one scope (user or system)'));
  }

  return {
    ok: true,
    value: {
      id: raw.id,
      name: raw.name,
      ...(typeof raw.group === 'string' ? { group: raw.group } : {}),
      categories,
      description: raw.description,
      impact: raw.impact,
      risk: raw.risk,
      ...(typeof raw.securityWarning === 'string' ? { securityWarning: raw.securityWarning } : {}),
      recommended: raw.recommended,
      rebootRequired: raw.rebootRequired,
      ...(typeof raw.effectiveNote === 'string' ? { effectiveNote: raw.effectiveNote } : {}),
      ...(requirements ? { requirements } : {}),
      actions,
      ...(raw.retired === true ? { retired: true } : {}),
      ...(typeof raw.retiredReason === 'string' ? { retiredReason: raw.retiredReason } : {}),
    },
  };
}

export function validatePayload(raw: unknown): CatalogResult<CatalogPayload> {
  if (!isRecord(raw)) return fail('RES004', 'The catalog payload is not an object.');

  const extra = unexpectedKey(raw, ['catalogVersion', 'publishedAt', 'minClient', 'notes', 'tweaks']);
  if (extra) return fail('RES004', `The catalog payload has an unknown field ('${extra}').`);

  if (!isInt(raw.catalogVersion, 1, MAX_CATALOG_VERSION)) {
    return fail('RES004', 'catalogVersion must be a positive integer.');
  }
  if (typeof raw.publishedAt !== 'string' || raw.publishedAt.length > 40 || Number.isNaN(Date.parse(raw.publishedAt))) {
    return fail('RES004', 'publishedAt must be an ISO timestamp.');
  }
  if (raw.minClient !== undefined && (typeof raw.minClient !== 'string' || !RE.semver.test(raw.minClient))) {
    return fail('RES004', 'minClient must be a version like "1.2.3".');
  }
  if (raw.notes !== undefined && !isText(raw.notes, 0, 500)) {
    return fail('RES004', 'notes must be a short single-line string.');
  }
  if (!Array.isArray(raw.tweaks)) return fail('RES004', 'tweaks must be an array.');
  if (raw.tweaks.length === 0) return fail('RES004', 'The catalog contains no optimizations.');
  if (raw.tweaks.length > MAX_TWEAKS) {
    return fail('RES004', `The catalog contains too many optimizations (max ${MAX_TWEAKS}).`);
  }

  const seen = new Set<string>();
  const tweaks: Tweak[] = [];
  for (let i = 0; i < raw.tweaks.length; i++) {
    const res = validateTweak(raw.tweaks[i], i);
    if (!res.ok) return res;
    if (seen.has(res.value.id)) {
      return fail('RES004', `Duplicate optimization id '${res.value.id}'.`);
    }
    seen.add(res.value.id);
    tweaks.push(res.value);
  }

  return {
    ok: true,
    value: {
      catalogVersion: raw.catalogVersion,
      publishedAt: raw.publishedAt,
      ...(typeof raw.minClient === 'string' ? { minClient: raw.minClient } : {}),
      ...(typeof raw.notes === 'string' ? { notes: raw.notes } : {}),
      tweaks,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Endpoint policy                                                     */
/* ------------------------------------------------------------------ */

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/**
 * HTTPS everywhere; plain HTTP only for loopback dev servers. Credentials in
 * URLs are rejected outright.
 */
export function checkEndpointPolicy(endpoint: string): CatalogResult<{ url: URL }> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return fail('RES001', `Invalid catalog endpoint '${endpoint}'.`);
  }
  if (url.username || url.password) {
    return fail('RES001', 'Catalog endpoints must not embed credentials.');
  }
  if (url.protocol === 'https:') return { ok: true, value: { url } };
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return { ok: true, value: { url } };
  return fail(
    'RES001',
    'Catalog endpoints must use HTTPS (plain HTTP is only allowed for loopback dev servers).'
  );
}

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export interface FetchResult {
  text: string;
  finalUrl: string;
}

/** Downloads the raw envelope with redirects, size cap and timeout (RES002). */
export function fetchCatalogEnvelope(
  endpoint: string,
  opts?: FetchOptions
): Promise<CatalogResult<FetchResult>> {
  const policy = checkEndpointPolicy(endpoint);
  if (!policy.ok) return Promise.resolve(policy);

  const timeoutMs = opts?.timeoutMs ?? 10000;
  const maxBytes = opts?.maxBytes ?? MAX_ENVELOPE_BYTES;

  return new Promise<CatalogResult<FetchResult>>((resolve) => {
    let settled = false;
    const done = (r: CatalogResult<FetchResult>): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const get = (url: URL, redirectsLeft: number): void => {
      const mod = url.protocol === 'https:' ? https : http;
      let req: http.ClientRequest;
      try {
        req = mod.get(
          url,
          {
            headers: {
              accept: 'application/json',
              'user-agent': `Frameblade/${APP_VERSION}`,
              'cache-control': 'no-cache',
            },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
              res.resume();
              const loc = res.headers.location;
              if (!loc) return done(fail('RES002', `Catalog redirect without a target (HTTP ${status}).`));
              if (redirectsLeft <= 0) return done(fail('RES002', 'Too many catalog redirects.'));
              let next: URL;
              try {
                next = new URL(loc, url);
              } catch {
                return done(fail('RES002', 'Catalog redirect target is invalid.'));
              }
              const nextPolicy = checkEndpointPolicy(next.toString());
              if (!nextPolicy.ok) return done(nextPolicy);
              return get(nextPolicy.value.url, redirectsLeft - 1);
            }
            if (status !== 200) {
              res.resume();
              return done(fail('RES002', `Catalog download failed (HTTP ${status}).`));
            }
            const declared = Number(res.headers['content-length'] ?? 0);
            if (declared > maxBytes) {
              res.destroy();
              return done(fail('RES002', 'Catalog download is too large.'));
            }
            const chunks: Buffer[] = [];
            let total = 0;
            res.on('data', (chunk: Buffer) => {
              if (settled) return;
              total += chunk.length;
              if (total > maxBytes) {
                res.destroy();
                return done(fail('RES002', 'Catalog download is too large.'));
              }
              chunks.push(chunk);
            });
            res.on('end', () => {
              done({ ok: true, value: { text: Buffer.concat(chunks).toString('utf8'), finalUrl: url.toString() } });
            });
            res.on('error', (err) => {
              done(fail('RES002', `Catalog download failed: ${err.message}`));
            });
          }
        );
      } catch (err) {
        return done(fail('RES002', `Catalog download failed: ${(err as Error).message}`));
      }
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
      req.on('error', (err) => done(fail('RES002', `Catalog download failed: ${err.message}`)));
    };

    get(policy.value.url, 3);
  });
}

/* ------------------------------------------------------------------ */
/* Local config + cache                                                */
/* ------------------------------------------------------------------ */

export function catalogCacheFile(resourcesDir: string): string {
  return path.join(resourcesDir, 'catalog-cache.json');
}

export function catalogConfigFile(resourcesDir: string): string {
  return path.join(resourcesDir, 'config.json');
}

/**
 * Endpoint resolution: environment override (dev/tests) > resources\config.json
 * (deployment override) > built-in default.
 */
export function loadCatalogConfig(resourcesDir: string): CatalogConfig {
  const env = (process.env.FRAMEBLADE_CATALOG_URL ?? '').trim();
  if (env) return { endpoint: env, source: 'env' };
  try {
    const raw = JSON.parse(fs.readFileSync(catalogConfigFile(resourcesDir), 'utf8')) as unknown;
    if (isRecord(raw) && typeof raw.endpoint === 'string' && raw.endpoint.trim()) {
      return { endpoint: raw.endpoint.trim(), source: 'file' };
    }
  } catch {
    /* missing or unreadable config: use the default */
  }
  return { endpoint: DEFAULT_CATALOG_ENDPOINT, source: 'default' };
}

/** Returns null when no cache exists; RES009 when it exists but is unusable. */
export function readCatalogCache(resourcesDir: string): CatalogResult<CatalogCacheFile> | null {
  const file = catalogCacheFile(resourcesDir);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return fail('RES001', `Could not read the cached catalog: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return fail('RES009', `The cached catalog is corrupt: ${(err as Error).message}`);
  }
  if (!isRecord(raw) || raw.schema !== 1) {
    return fail('RES009', 'The cached catalog has an unsupported schema.');
  }
  if (
    typeof raw.endpoint !== 'string' ||
    typeof raw.fetchedAt !== 'string' ||
    !isRecord(raw.envelope)
  ) {
    return fail('RES009', 'The cached catalog is incomplete.');
  }
  return {
    ok: true,
    value: {
      schema: 1,
      endpoint: raw.endpoint,
      fetchedAt: raw.fetchedAt,
      envelope: raw.envelope as unknown as CatalogEnvelope,
    },
  };
}

/** Atomic cache write (tmp + rename): RES005 on failure. */
export function writeCatalogCache(
  resourcesDir: string,
  endpoint: string,
  envelope: CatalogEnvelope
): CatalogResult<CatalogCacheFile> {
  const data: CatalogCacheFile = {
    schema: 1,
    endpoint,
    fetchedAt: new Date().toISOString(),
    envelope,
  };
  try {
    fs.mkdirSync(resourcesDir, { recursive: true });
    const target = catalogCacheFile(resourcesDir);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true, value: data };
  } catch (err) {
    return fail('RES005', `Could not save the catalog: ${(err as Error).message}`);
  }
}

/** Removes the cache (used by tests/tools); ignores missing files. */
export function clearCatalogCache(resourcesDir: string): void {
  try {
    fs.rmSync(catalogCacheFile(resourcesDir), { force: true });
  } catch {
    /* best effort */
  }
}
