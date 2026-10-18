// Generates the Frameblade app icon (PNG + ICO) with no image dependencies:
// a rounded tile with the brand gradient and a lightning bolt, matching the
// sidebar logo. Run: node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const OUT_DIR = path.join(__dirname, '..', 'build');

/* ------------------------------------------------------------- geometry */

// Rounded-rect coverage for the tile.
const RADIUS = 56;
function inRoundedRect(x, y) {
  const r = RADIUS;
  const cx = Math.min(Math.max(x, r), SIZE - r);
  const cy = Math.min(Math.max(y, r), SIZE - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Lightning bolt polygon (roughly the ⚡ glyph), scaled/centred into SIZE.
const BOLT = [
  [58, 4],
  [22, 58],
  [46, 58],
  [34, 100],
  [80, 42],
  [54, 42],
];
const BOLT_PTS = BOLT.map(([x, y]) => [128 + (x - 51) * 2.05, 128 + (y - 52) * 2.05]);

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* --------------------------------------------------------------- colours */

const STOPS = [
  { t: 0.0, c: [34, 211, 238] }, // cyan
  { t: 0.55, c: [124, 92, 255] }, // violet
  { t: 1.0, c: [255, 79, 216] }, // magenta
];

function gradient(t) {
  for (let i = 1; i < STOPS.length; i++) {
    const a = STOPS[i - 1];
    const b = STOPS[i];
    if (t <= b.t) {
      const k = (t - a.t) / (b.t - a.t);
      return [0, 1, 2].map((j) => Math.round(a.c[j] + (b.c[j] - a.c[j]) * k));
    }
  }
  return STOPS[STOPS.length - 1].c;
}

/* ---------------------------------------------------------------- raster */

function render() {
  const buf = Buffer.alloc(SIZE * SIZE * 4, 0);
  const SS = 3; // supersampling per axis
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let tile = 0;
      let bolt = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (inRoundedRect(px, py)) tile++;
          if (inPolygon(px, py, BOLT_PTS)) bolt++;
        }
      }
      const total = SS * SS;
      const tileA = tile / total;
      const boltA = bolt / total;
      if (tileA === 0) continue;

      const t = (x + y) / (2 * SIZE);
      const grad = gradient(t);
      // composite the bolt (white) over the gradient
      const k = boltA / tileA;
      const r = Math.round(grad[0] * (1 - k) + 255 * k);
      const g = Math.round(grad[1] * (1 - k) + 255 * k);
      const b = Math.round(grad[2] * (1 - k) + 255 * k);

      const o = (y * SIZE + x) * 4;
      buf[o] = r;
      buf[o + 1] = g;
      buf[o + 2] = b;
      buf[o + 3] = Math.round(tileA * 255);
    }
  }
  return buf;
}

/* --------------------------------------------------------------- encoder */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256
  entry[1] = 0; // 256
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset
  return Buffer.concat([header, entry, png]);
}

/* ------------------------------------------------------------------- run */

const rgba = render();
const png = encodePng(rgba, SIZE);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(png));
console.log(`icon written: ${path.join(OUT_DIR, 'icon.png')} (${png.length} bytes) and icon.ico`);
