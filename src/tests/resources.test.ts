// Resources pipeline: signed catalog verification, schema validation,
// download policy, cache and catalog merge/kill-switch semantics.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { TWEAKS } from '../catalog/tweaks';
import {
  catalogSourceInfo,
  getCatalog,
  getTweak,
  recommendedIds,
  setRemoteCatalog,
  CATALOG_VERSION,
} from '../catalog/catalog';
import {
  buildEnvelope,
  CatalogPayload,
  checkEndpointPolicy,
  clearCatalogCache,
  compareVersions,
  fetchCatalogEnvelope,
  loadCatalogConfig,
  MAX_TWEAKS,
  readCatalogCache,
  signingInput,
  validatePayload,
  verifyEnvelope,
  verifyEnvelopeText,
  writeCatalogCache,
} from '../engine/resources';
import { unsupportedReason } from '../engine/engine';
import { Tweak } from '../shared/types';

const pair = crypto.generateKeyPairSync('ed25519');
const PRIVATE_PEM = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const KEYS = { 'test-1': PUBLIC_PEM };

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function payload(overrides: Partial<CatalogPayload> = {}): CatalogPayload {
  return {
    catalogVersion: 2,
    publishedAt: new Date().toISOString(),
    notes: 'test catalog',
    tweaks: [clone(TWEAKS[0])],
    ...overrides,
  };
}

function envelope(p: CatalogPayload = payload(), keyId = 'test-1') {
  return buildEnvelope(p, { keyId, privateKeyPem: PRIVATE_PEM });
}

function systemTweak(): Tweak {
  const t = TWEAKS.find((x) => x.actions.every((a) => a.scope === 'system'));
  assert.ok(t, 'catalog has no system tweak');
  return clone(t);
}

/* ------------------------------------------------------------------ */
/* Envelope                                                            */
/* ------------------------------------------------------------------ */

test('resources: signed envelope verifies and yields the payload', () => {
  const env = envelope();
  const res = verifyEnvelope(env, { keys: KEYS });
  if (!res.ok) assert.fail(`${res.code}: ${res.message}`);
  assert.equal(res.value.payload.catalogVersion, 2);
  assert.equal(res.value.payload.tweaks.length, 1);
  assert.equal(res.value.envelope.keyId, 'test-1');
});

test('resources: tampered payload fails the signature (RES004)', () => {
  const env = envelope();
  const decoded = JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf8'));
  decoded.catalogVersion = 999;
  const forged = { ...env, payload: Buffer.from(JSON.stringify(decoded)).toString('base64url') };
  const res = verifyEnvelope(forged, { keys: KEYS });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'RES004');
});

test('resources: unknown signing key asks for an update (RES003)', () => {
  const res = verifyEnvelope(envelope(), { keys: {} });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'RES003');
});

test('resources: signature from a different key is rejected (RES004)', () => {
  const other = crypto.generateKeyPairSync('ed25519');
  const env = buildEnvelope(payload(), {
    keyId: 'test-1',
    privateKeyPem: other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
  const res = verifyEnvelope(env, { keys: KEYS });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'RES004');
});

test('resources: newer envelope format asks for an update (RES003)', () => {
  const res = verifyEnvelope({ ...envelope(), format: 2 }, { keys: KEYS });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'RES003');
});

test('resources: payload requiring a newer client asks for an update (RES003)', () => {
  const env = envelope(payload({ minClient: '99.0.0' }));
  const res = verifyEnvelope(env, { keys: KEYS });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'RES003');
});

test('resources: payload JSON is parsed after signature verification', () => {
  const bytes = Buffer.from('not json at all', 'utf8');
  const signature = crypto.sign(null, signingInput(1, 'test-1', bytes), PRIVATE_PEM);
  const env = {
    format: 1,
    keyId: 'test-1',
    signature: signature.toString('base64url'),
    payload: bytes.toString('base64url'),
  };
  const res = verifyEnvelope(env, { keys: KEYS });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'RES004');
});

test('resources: non-object envelopes are rejected (RES004)', () => {
  for (const raw of [null, 42, 'x', []]) {
    const res = verifyEnvelope(raw, { keys: KEYS });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'RES004');
  }
});

/* ------------------------------------------------------------------ */
/* Payload schema                                                      */
/* ------------------------------------------------------------------ */

test('resources: the bundled catalog passes remote schema validation', () => {
  const res = validatePayload(
    payload({ catalogVersion: Math.floor(Date.now() / 1000), tweaks: clone(TWEAKS) })
  );
  if (!res.ok) assert.fail(`${res.code}: ${res.message}`);
  assert.equal(res.value.tweaks.length, TWEAKS.length);
});

test('resources: unsupported action types are rejected', () => {
  const p = payload();
  (p.tweaks[0].actions[0] as unknown as { type: string }).type = 'shell.run';
  const res = validatePayload(p);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'RES004');
});

test('resources: tweaks cannot mix user and system scopes', () => {
  const p = payload();
  p.tweaks[0].actions = [clone(TWEAKS[0].actions[0]), systemTweak().actions[0]];
  const res = validatePayload(p);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.message, /scope/);
});

test('resources: HKLM writes must use system scope', () => {
  const p = payload({
    tweaks: [
      {
        ...clone(TWEAKS[0]),
        actions: [
          {
            type: 'registry.set',
            hive: 'HKLM',
            key: 'SOFTWARE\\Test',
            name: 'Value',
            value: 1,
            valueType: 'REG_DWORD',
            scope: 'user',
          },
        ],
      },
    ],
  });
  const res = validatePayload(p);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.message, /HKLM/);
});

test('resources: unknown fields, ids and categories are rejected', () => {
  const cases: ((p: CatalogPayload) => void)[] = [
    (p) => ((p.tweaks[0] as unknown as Record<string, unknown>).bonus = true),
    (p) => (p.tweaks[0].id = 'Not A Valid Id!'),
    (p) => ((p.tweaks[0].categories as unknown as string[])[0] = 'rgb-lighting'),
    (p) => ((p.tweaks[0] as unknown as Record<string, unknown>).retired = 'yes'),
    (p) => ((p.tweaks[0].actions[0] as unknown as Record<string, unknown>).extra = 1),
  ];
  for (const mutate of cases) {
    const p = payload();
    mutate(p);
    const res = validatePayload(p);
    assert.equal(res.ok, false, `expected rejection: ${JSON.stringify(mutate)}`);
    if (!res.ok) assert.equal(res.code, 'RES004');
  }
});

test('resources: duplicate ids and oversized catalogs are rejected', () => {
  const dup = payload();
  dup.tweaks = [clone(TWEAKS[0]), clone(TWEAKS[0])];
  const res = validatePayload(dup);
  assert.equal(res.ok, false);

  const huge = payload();
  huge.tweaks = new Array(MAX_TWEAKS + 1).fill(clone(TWEAKS[0]));
  const big = validatePayload(huge);
  assert.equal(big.ok, false);
  if (!big.ok) assert.match(big.message, /too many/i);
});

test('resources: retired tweaks are accepted and preserved', () => {
  const p = payload();
  p.tweaks[0].retired = true;
  p.tweaks[0].retiredReason = 'Caused a regression on some systems.';
  const res = validatePayload(p);
  if (!res.ok) assert.fail(`${res.code}: ${res.message}`);
  assert.equal(res.value.tweaks[0].retired, true);
  assert.equal(res.value.tweaks[0].retiredReason, 'Caused a regression on some systems.');
});

test('resources: compareVersions follows numeric segments', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
  assert.equal(compareVersions('2', '1.99.99'), 1);
});

/* ------------------------------------------------------------------ */
/* Endpoint policy + download                                          */
/* ------------------------------------------------------------------ */

test('resources: endpoint policy requires HTTPS except for loopback', () => {
  assert.equal(checkEndpointPolicy('https://cdn.example.com/catalog.json').ok, true);
  assert.equal(checkEndpointPolicy('http://127.0.0.1:4180/catalog-v1.json').ok, true);
  assert.equal(checkEndpointPolicy('http://localhost:4180/catalog-v1.json').ok, true);
  assert.equal(checkEndpointPolicy('http://[::1]:4180/catalog-v1.json').ok, true);

  for (const bad of [
    'http://cdn.example.com/catalog.json',
    'ftp://127.0.0.1/catalog.json',
    'https://user:pass@cdn.example.com/catalog.json',
    'not a url',
  ]) {
    const res = checkEndpointPolicy(bad);
    assert.equal(res.ok, false, bad);
    if (!res.ok) assert.equal(res.code, 'RES001');
  }
});

test('resources: download follows redirects, enforces caps and timeouts', async (t) => {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/ok') {
      const body = Buffer.from(JSON.stringify(envelope()), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (url === '/redirect') {
      res.writeHead(302, { location: '/ok' });
      res.end();
      return;
    }
    if (url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    }
    if (url === '/missing') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (url === '/big') {
      res.writeHead(200, { 'content-length': '4096' });
      res.end(Buffer.alloc(4096, 0x41));
      return;
    }
    if (url === '/slow') return; // never respond
    res.writeHead(500);
    res.end('boom');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const ok = await fetchCatalogEnvelope(`${base}/ok`);
  if (!ok.ok) assert.fail(`${ok.code}: ${ok.message}`);
  const verified = verifyEnvelopeText(ok.value.text, { keys: KEYS });
  assert.equal(verified.ok, true);

  const redirected = await fetchCatalogEnvelope(`${base}/redirect`);
  assert.equal(redirected.ok, true);

  for (const [pathname, expected] of [
    ['/missing', 'RES002'],
    ['/big', 'RES002'],
    ['/loop', 'RES002'],
    ['/slow', 'RES002'],
  ] as const) {
    const res = await fetchCatalogEnvelope(`${base}${pathname}`, {
      maxBytes: 1024,
      timeoutMs: 150,
    });
    assert.equal(res.ok, false, pathname);
    if (!res.ok) assert.equal(res.code, expected, pathname);
  }
});

/* ------------------------------------------------------------------ */
/* Cache + config                                                      */
/* ------------------------------------------------------------------ */

test('resources: cache round-trips and corrupt caches report RES009', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frameblade-res-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(readCatalogCache(dir), null);

  const env = envelope();
  const saved = writeCatalogCache(dir, 'http://127.0.0.1:4180/catalog-v1.json', env);
  if (!saved.ok) assert.fail(`${saved.code}: ${saved.message}`);

  const read = readCatalogCache(dir);
  assert.ok(read && read.ok);
  if (read && read.ok) {
    assert.equal(read.value.endpoint, 'http://127.0.0.1:4180/catalog-v1.json');
    assert.deepEqual(read.value.envelope, env);
    const verified = verifyEnvelope(read.value.envelope, { keys: KEYS });
    assert.equal(verified.ok, true);
  }

  fs.writeFileSync(path.join(dir, 'catalog-cache.json'), '{ not json', 'utf8');
  const corrupt = readCatalogCache(dir);
  assert.ok(corrupt && !corrupt.ok);
  if (corrupt && !corrupt.ok) assert.equal(corrupt.code, 'RES009');

  clearCatalogCache(dir);
  assert.equal(readCatalogCache(dir), null);
});

test('resources: config resolution prefers env, then file, then default', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frameblade-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.FRAMEBLADE_CATALOG_URL;
  delete process.env.FRAMEBLADE_CATALOG_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.FRAMEBLADE_CATALOG_URL;
    else process.env.FRAMEBLADE_CATALOG_URL = previous;
  });

  const fallback = loadCatalogConfig(dir);
  assert.equal(fallback.source, 'default');
  assert.match(fallback.endpoint, /^https:\/\//);

  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ endpoint: 'http://127.0.0.1:4180/catalog-v1.json' }),
    'utf8'
  );
  const fromFile = loadCatalogConfig(dir);
  assert.equal(fromFile.source, 'file');
  assert.equal(fromFile.endpoint, 'http://127.0.0.1:4180/catalog-v1.json');

  process.env.FRAMEBLADE_CATALOG_URL = 'http://127.0.0.1:5000/env.json';
  const fromEnv = loadCatalogConfig(dir);
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.endpoint, 'http://127.0.0.1:5000/env.json');
});

/* ------------------------------------------------------------------ */
/* Catalog merge + remote kill-switch                                  */
/* ------------------------------------------------------------------ */

test('resources: remote catalog overrides, extends and retires tweaks', (t) => {
  t.after(() => setRemoteCatalog(null));

  const base = getCatalog().length;
  assert.equal(catalogSourceInfo().source, 'bundled');
  assert.equal(catalogSourceInfo().version, CATALOG_VERSION);

  const override = clone(TWEAKS[0]);
  override.name = 'Remote override';
  const extra = clone(TWEAKS[1]);
  extra.id = 'remote-only';
  extra.name = 'Remote only';

  setRemoteCatalog([override, extra], 7);
  const info = catalogSourceInfo();
  assert.equal(info.source, 'remote');
  assert.equal(info.version, 'remote-7');
  assert.equal(info.remoteVersion, 7);
  assert.equal(getCatalog().length, base + 1);
  assert.equal(getTweak('remote-only')?.name, 'Remote only');
  assert.equal(getTweak(TWEAKS[0].id)?.name, 'Remote override');
  assert.ok(recommendedIds().includes('remote-only') === false);

  // Kill-switch: retiring hides a tweak but keeps it revertible.
  const retired = clone(TWEAKS[0]);
  retired.retired = true;
  retired.retiredReason = 'Regression reports.';
  setRemoteCatalog([retired], 8);
  assert.equal(getCatalog().some((x) => x.id === retired.id), false);
  const stillRevertible = getTweak(retired.id);
  assert.ok(stillRevertible?.retired);
  assert.match(String(unsupportedReason(stillRevertible!)), /retired/i);

  setRemoteCatalog(null);
  assert.equal(catalogSourceInfo().source, 'bundled');
  assert.equal(getCatalog().length, base);
});
