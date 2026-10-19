'use strict';

// electron-builder sign hook. It signs every executable electron-builder asks
// about (the app exe and the NSIS installer) with a certificate from the
// current user's certificate store, or an explicit PFX for local testing.
//
// Production path (Certum SimplySign / OV cloud certificate):
//   FRAMEBLADE_CERT_SHA1=<thumbprint>
//
// Local PFX path (testing only; a self-signed cert still warns on other PCs):
//   FRAMEBLADE_CERT_FILE=<path to .pfx>
//   FRAMEBLADE_CERT_PASSWORD=<password>
//
// Set FRAMEBLADE_REQUIRE_SIGNING=1 to fail the build instead of producing an
// unsigned artifact when no certificate is configured.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMESTAMP_URL = 'http://timestamp.digicert.com';

function findSigntool() {
  const candidates = [
    process.env.SIGNTOOL_PATH,
    path.join(__dirname, '..', 'node_modules', '@electron', 'windows-sign', 'vendor', 'signtool.exe'),
    path.join(__dirname, '..', 'node_modules', 'electron-winstaller', 'vendor', 'signtool.exe'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return 'signtool.exe';
}

function signFile(file) {
  const sha1 = process.env.FRAMEBLADE_CERT_SHA1?.trim();
  const subject = process.env.FRAMEBLADE_CERT_SUBJECT?.trim();
  const pfx = process.env.FRAMEBLADE_CERT_FILE?.trim();
  const password = process.env.FRAMEBLADE_CERT_PASSWORD ?? '';
  const required = process.env.FRAMEBLADE_REQUIRE_SIGNING === '1';

  if (!sha1 && !subject && !pfx) {
    const message = `[sign] No signing certificate configured; ${path.basename(file)} remains unsigned.`;
    if (required) {
      throw new Error(message);
    }
    console.warn(message);
    return;
  }

  const args = [
    'sign',
    '/fd', 'SHA256',
    '/td', 'SHA256',
    '/tr', process.env.FRAMEBLADE_TIMESTAMP_URL || DEFAULT_TIMESTAMP_URL,
  ];

  if (sha1) {
    args.push('/sha1', sha1);
  } else if (subject) {
    args.push('/n', subject);
  } else {
    args.push('/f', pfx);
    if (password) {
      args.push('/p', password);
    }
  }

  args.push(file);

  const signtool = findSigntool();
  console.log(`[sign] Signing ${file}`);
  console.log(`[sign] Using ${signtool}`);
  execFileSync(signtool, args, { stdio: 'inherit' });

  console.log(`[sign] Verifying ${file}`);
  execFileSync(signtool, ['verify', '/pa', '/v', file], { stdio: 'inherit' });
}

exports.sign = async function signWindows(configuration) {
  if (!configuration || typeof configuration.path !== 'string') {
    throw new Error('[sign] electron-builder did not provide a file path to sign.');
  }
  signFile(configuration.path);
};

exports.default = exports.sign;
