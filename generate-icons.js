/**
 * 外部パッケージ不要のアイコン生成スクリプト
 * Node.js 組み込みの zlib だけで PNG を書き出します
 * 使い方: node generate-icons.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── PNG エンコーダ（最小実装） ────────────────────────────────
function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })());
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crcBuf = Buffer.concat([typeBytes, data]);
  const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(crcBuf));
  return Buffer.concat([len, typeBytes, data, crcVal]);
}

function makePng(pixels, size) {
  // pixels: Uint8Array of RGBA, size x size
  const IHDR = Buffer.alloc(13);
  IHDR.writeUInt32BE(size, 0);
  IHDR.writeUInt32BE(size, 4);
  IHDR[8]  = 8;  // bit depth
  IHDR[9]  = 2;  // color type: truecolor (RGB, no alpha)... use 6 for RGBA
  IHDR[9]  = 6;  // RGBA
  IHDR[10] = 0; IHDR[11] = 0; IHDR[12] = 0;

  // Raw image data: each row prefixed with filter byte 0
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const pi = (y * size + x) * 4;
      const ri = y * (1 + size * 4) + 1 + x * 4;
      raw[ri]     = pixels[pi];
      raw[ri + 1] = pixels[pi + 1];
      raw[ri + 2] = pixels[pi + 2];
      raw[ri + 3] = pixels[pi + 3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]), // PNG signature
    chunk('IHDR', IHDR),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── アイコン描画ロジック ──────────────────────────────────────
function drawIcon(size) {
  const pixels = new Uint8Array(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const radius = size * 0.46;
  const cornerR = size * 0.18;

  // 角丸四角形の当たり判定
  function inRoundRect(x, y) {
    const minX = cornerR, maxX = size - cornerR;
    const minY = cornerR, maxY = size - cornerR;
    if (x >= minX && x <= maxX && y >= 0 && y <= size) return true;
    if (y >= minY && y <= maxY && x >= 0 && x <= size) return true;
    const corners = [[cornerR, cornerR],[size-cornerR,cornerR],[cornerR,size-cornerR],[size-cornerR,size-cornerR]];
    for (const [cx, cy] of corners) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= cornerR * cornerR) return true;
    }
    return false;
  }

  // 横線3本の当たり判定
  const lineW = Math.max(1, size * 0.08);
  const lx1 = size * 0.22, lx2 = size * 0.78;
  function onLine(x, y) {
    if (x < lx1 || x > lx2) return false;
    for (const fy of [0.35, 0.50, 0.65]) {
      if (Math.abs(y - size * fy) <= lineW / 2) return true;
    }
    return false;
  }

  // アンチエイリアスなしのシンプル描画
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (inRoundRect(x + 0.5, y + 0.5)) {
        if (onLine(x + 0.5, y + 0.5)) {
          // 白線
          pixels[i] = 255; pixels[i+1] = 255; pixels[i+2] = 255; pixels[i+3] = 230;
        } else {
          // 青背景
          pixels[i] = 74; pixels[i+1] = 144; pixels[i+2] = 217; pixels[i+3] = 255;
        }
      } else {
        // 透明
        pixels[i] = 0; pixels[i+1] = 0; pixels[i+2] = 0; pixels[i+3] = 0;
      }
    }
  }
  return pixels;
}

// ── 各サイズ生成 ─────────────────────────────────────────────
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

for (const size of [16, 48, 128]) {
  const pixels = drawIcon(size);
  const png    = makePng(pixels, size);
  const out    = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(out, png);
  console.log(`生成: ${out} (${png.length} bytes)`);
}

console.log('\nアイコン生成完了！');
