// Local catalog server for developing the signed resources pipeline.
//
//   npm run catalog:serve -- --port 4180 --configure
//
// Serves a signed, versioned catalog built from the bundled tweaks. `--retire`
// exercises the remote kill-switch. `--configure` points the installed app at
// this server by writing resources\config.json into the Frameblade data dir.
//
// DEV ONLY: this key pair exists so the pipeline can be exercised locally. It
// is not a production trust root — a real deployment must replace TRUSTED_KEYS
// in src/engine/resources.ts and keep the signing key off the repo.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DEV_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIOAEXyHcnaYjxBByetRTMPCZu1fEn+0ZDGMjgPurxvk2
-----END PRIVATE KEY-----`;
const DEV_KEY_ID = 'dev-1';

const argv = process.argv.slice(2);

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
  Usage: npm run catalog:serve -- [options]

    --port <n>         port to listen on (default 4180)
    --version <n>      catalog version (default: unix seconds)
    --notes <text>     release notes stored in the payload
    --retire <ids>     comma-separated tweak ids to retire (kill-switch)
    --configure        point the app at this server (resources\\config.json)
    --unconfigure      remove that config file and exit
  `);
  process.exit(0);
}

const dataDir = path.join(
  process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'),
  'Frameblade'
);
const resourcesDir = path.join(dataDir, 'resources');
const configFile = path.join(resourcesDir, 'config.json');

if (argv.includes('--unconfigure')) {
  fs.rmSync(configFile, { force: true });
  console.log(`Removed ${configFile} — Frameblade will use the bundled catalog again.`);
  process.exit(0);
}

let resources;
let tweaksModule;
try {
  resources = require(path.join(__dirname, '..', 'dist', 'engine', 'resources.js'));
  tweaksModule = require(path.join(__dirname, '..', 'dist', 'catalog', 'tweaks.js'));
} catch {
  fail('Build output not found. Run "npm run build" first.');
}

const port = Math.max(1, Math.min(65535, Number(arg('port', '4180')) || 4180));
const version = Math.max(1, Number(arg('version', '')) || Math.floor(Date.now() / 1000));
const notes = arg('notes', 'Local development catalog');
const retireIds = String(arg('retire', ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const tweaks = JSON.parse(JSON.stringify(tweaksModule.TWEAKS));
const known = new Set(tweaks.map((t) => t.id));
for (const id of retireIds) {
  const tweak = tweaks.find((t) => t.id === id);
  if (!tweak) {
    console.warn(`  ! --retire ${id}: no such tweak in the bundled catalog`);
    continue;
  }
  tweak.retired = true;
  tweak.retiredReason = 'Retired by the development catalog test.';
}
if (retireIds.some((id) => !known.has(id))) {
  console.warn('  ! unknown retire ids were ignored');
}

const payload = {
  catalogVersion: version,
  publishedAt: new Date().toISOString(),
  notes,
  tweaks,
};

const envelope = resources.buildEnvelope(payload, {
  keyId: DEV_KEY_ID,
  privateKeyPem: DEV_PRIVATE_KEY,
});

// Self-check: never serve something the client would reject.
const check = resources.verifyEnvelope(envelope, {
  keys: { [DEV_KEY_ID]: resources.TRUSTED_KEYS[DEV_KEY_ID] },
});
if (!check.ok) fail(`Signed envelope failed self-verification: ${check.code} ${check.message}`);

const body = Buffer.from(JSON.stringify(envelope, null, 2), 'utf8');
const endpoint = `http://127.0.0.1:${port}/catalog-v1.json`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  if (url.pathname !== '/catalog-v1.json') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  console.log(`  GET ${url.pathname} -> 200 (${body.length} bytes)`);
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
});

server.listen(port, '127.0.0.1', () => {
  console.log('');
  console.log('  Frameblade dev catalog server');
  console.log(`  endpoint : ${endpoint}`);
  console.log(`  catalog  : v${version} · ${tweaks.length} optimizations` + (retireIds.length ? ` · retiring ${retireIds.join(', ')}` : ''));
  console.log(`  key      : ${DEV_KEY_ID} (development key)`);

  if (argv.includes('--configure')) {
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ endpoint }, null, 2), 'utf8');
    console.log(`  app      : configured ${configFile}`);
    console.log('             click "Check" in the Optimization catalog card.');
  } else {
    console.log('  app      : not configured (pass --configure, or set FRAMEBLADE_CATALOG_URL)');
  }
  console.log('  stop     : Ctrl+C (then run with --unconfigure to revert the app config)');
  console.log('');
});
