/**
 * Gera os ícones PNG do PWA usando apenas Node.js built-ins (zlib).
 * Execute uma vez: node scripts/generate-icons.js
 *
 * Design: fundo azul #0d4e8b com anel branco (símbolo de portal).
 */
'use strict';

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ─── Helpers PNG ──────────────────────────────────────────────────────────────

function int32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeB = Buffer.from(type, 'ascii');
  const lenB  = int32(data.length);
  const body  = Buffer.concat([typeB, data]);
  const crc   = int32(crc32(body));
  return Buffer.concat([lenB, body, crc]);
}

/**
 * Gera um PNG RGB de `size x size` pixels.
 * `getPixel(x, y)` retorna [r, g, b].
 */
function makePNG(size, getPixel) {
  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = chunk('IHDR', Buffer.concat([
    int32(size), int32(size),
    Buffer.from([8, 2, 0, 0, 0]) // 8-bit RGB, no interlace
  ]));

  // Pixel data: cada linha começa com 1 byte de filtro (0 = None)
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 3)] = 0; // filter None
    for (let x = 0; x < size; x++) {
      const [r, g, b] = getPixel(x, y);
      const off = y * (1 + size * 3) + 1 + x * 3;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b;
    }
  }

  const idat = chunk('IDAT', zlib.deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

// ─── Design: fundo azul com anel branco e ponto central ──────────────────────

const BG  = [13,  78, 139]; // #0d4e8b
const FG  = [255, 255, 255]; // branco
const ACC = [96, 165, 250]; // #60a5fa

function iconPixel(x, y, size) {
  const cx = size / 2, cy = size / 2;
  const dx = x - cx,   dy = y - cy;
  const d  = Math.sqrt(dx * dx + dy * dy);
  const R  = size * 0.42; // raio externo do anel
  const ri = size * 0.28; // raio interno do anel
  const rc = size * 0.10; // raio do ponto central

  // Anti-aliasing simples: blend na borda
  const aa = 1.2;

  function blend(colorA, colorB, t) {
    t = Math.max(0, Math.min(1, t));
    return colorA.map((v, i) => Math.round(v * (1 - t) + colorB[i] * t));
  }

  // Ponto central branco
  if (d < rc - aa)   return FG;
  if (d < rc + aa)   return blend(FG, BG, (d - (rc - aa)) / (2 * aa));

  // Anel branco
  if (d > ri && d < R) {
    const inner = blend(BG, FG, (d - (ri - aa)) / (2 * aa));
    const outer = blend(FG, BG, (d - (R  - aa)) / (2 * aa));
    if (d < ri + aa) return inner;
    if (d > R  - aa) return outer;
    return FG;
  }

  // Anel interno suavizado
  if (d >= ri - aa && d <= ri + aa) {
    return blend(FG, BG, (d - (ri - aa)) / (2 * aa));
  }

  return BG;
}

// ─── Maskable icon: mesmo design com padding 10% (safe zone) ─────────────────

function maskablePixel(x, y, size) {
  const PAD  = 0.10;
  const inner = size * (1 - PAD * 2);
  const ox = (x - size * PAD) * (size / inner);
  const oy = (y - size * PAD) * (size / inner);
  if (ox < 0 || ox >= size || oy < 0 || oy >= size) return BG;
  return iconPixel(ox, oy, size);
}

// ─── Geração dos arquivos ─────────────────────────────────────────────────────

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const sizes = [
  { name: 'icon-192.png',           size: 192, fn: iconPixel },
  { name: 'icon-512.png',           size: 512, fn: iconPixel },
  { name: 'icon-192-maskable.png',  size: 192, fn: maskablePixel },
];

for (const { name, size, fn } of sizes) {
  const buf = makePNG(size, (x, y) => fn(x, y, size));
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(`✓ ${name} (${size}x${size}) — ${buf.length} bytes`);
}

console.log('\nÍcones gerados em public/icons/');
