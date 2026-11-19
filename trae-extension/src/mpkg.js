'use strict';

/**
 * Wallpaper Engine 手机版资源包（.mpkg）导入。
 *
 * 手机包（PKGM0020）和桌面包（PKGV0024）条目表结构一致，差别在于：
 *   - 纹理用 ETC2/EAC 压缩（手机上 GPU 原生支持），桌面渲染引擎只会解 RGBA/DXT；
 *   - 手机包常常把 music 层引用的 sounds/*.flac 剥掉，包内没有音频。
 *
 * 所以导入时要：解 LZ4 → 解 ETC2 → 重新编码成 PNG 塞回 TEXB（桌面包也是这么存 PNG 的），
 * 再把缺的音频从本机同 ID 的桌面包里补进来，最后按 PKGV 写出一个新的 scene.pkg。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

/** 转换逻辑变了就加一，缓存目录里的旧结果会被重新生成。 */
const CONVERTER_VERSION = 2;

const MPKG_EXT = '.mpkg';

// ETC1/ETC2 解码查表（与 OpenGL ES 规范一致）
const WRITE_ORDER = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
const WRITE_ORDER_REV = [15, 11, 7, 3, 14, 10, 6, 2, 13, 9, 5, 1, 12, 8, 4, 0];
const ETC1_MOD = [
  [2, 8],
  [5, 17],
  [9, 29],
  [13, 42],
  [18, 60],
  [24, 80],
  [33, 106],
  [47, 183],
];
const ETC1_SUBBLOCK = [
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1],
];
const ETC2_DIST = [3, 6, 11, 16, 23, 32, 41, 64];
const ETC2_ALPHA_MOD = [
  [-3, -6, -9, -15, 2, 5, 8, 14],
  [-3, -7, -10, -13, 2, 6, 9, 12],
  [-2, -5, -8, -13, 1, 4, 7, 12],
  [-2, -4, -6, -13, 1, 3, 5, 12],
  [-3, -6, -8, -12, 2, 5, 7, 11],
  [-3, -7, -9, -11, 2, 6, 8, 10],
  [-4, -7, -8, -11, 3, 6, 7, 10],
  [-3, -5, -8, -11, 2, 4, 7, 10],
  [-2, -6, -8, -10, 1, 5, 7, 9],
  [-2, -5, -8, -10, 1, 4, 7, 9],
  [-2, -4, -8, -10, 1, 3, 7, 9],
  [-2, -5, -7, -10, 1, 4, 6, 9],
  [-3, -4, -7, -10, 2, 3, 6, 9],
  [-1, -2, -3, -10, 0, 1, 2, 9],
  [-4, -6, -8, -9, 3, 5, 7, 8],
  [-3, -5, -7, -9, 2, 4, 6, 8],
];

const clamp8 = (n) => (n < 0 ? 0 : n > 255 ? 255 : n);
const u32 = (buf, at) => buf.readUInt32LE(at);

function isMpkg(file) {
  return path.extname(String(file || '')).toLowerCase() === MPKG_EXT;
}

function isPkg(file) {
  return path.extname(String(file || '')).toLowerCase() === '.pkg';
}

// ---------------------------------------------------------------- 资源包容器

/**
 * 读 PKGM/PKGV。两者表结构相同：magic 长度、magic、条目数、[名字长、名字、偏移、大小]，
 * 偏移相对表尾（即所有数据紧跟在表后面）。
 */
function readPkg(buf) {
  if (buf.length < 16) throw new Error('文件太小，不是 Wallpaper Engine 资源包');
  const magicLen = u32(buf, 0);
  if (magicLen < 4 || magicLen > 16) throw new Error('资源包魔数长度异常，可能不是 Wallpaper Engine 资源包');
  const magic = buf.toString('latin1', 4, 4 + magicLen);
  if (!/^PKG[MV]/.test(magic)) throw new Error(`不是 Wallpaper Engine 资源包（魔数 ${JSON.stringify(magic)}）`);

  let p = 4 + magicLen;
  const count = u32(buf, p);
  p += 4;
  if (count < 1 || count > 100000) throw new Error('资源包条目数异常');

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (p + 4 > buf.length) throw new Error('资源包条目表越界');
    const nameLen = u32(buf, p);
    p += 4;
    if (nameLen > 1024 || p + nameLen + 8 > buf.length) throw new Error('资源包条目名越界');
    const name = buf.toString('utf8', p, p + nameLen);
    p += nameLen;
    const offset = u32(buf, p);
    const size = u32(buf, p + 4);
    p += 8;
    entries.push({ name, offset, size });
  }

  const tableEnd = p;
  for (const entry of entries) {
    const start = tableEnd + entry.offset;
    if (start < tableEnd || start + entry.size > buf.length) {
      throw new Error(`资源包条目越界：${entry.name}`);
    }
    entry.data = buf.subarray(start, start + entry.size);
  }
  return { magic, entries, tableEnd };
}

/** 按 PKGV0024 写出（桌面版同款，渲染引擎只要求魔数以 PKGV 开头）。 */
function writePkg(entries) {
  const list = entries
    .map((entry) => ({ name: entry.name, nameBytes: Buffer.from(entry.name, 'utf8'), data: entry.data }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const magic = 'PKGV0024';
  let tableSize = 4 + magic.length + 4;
  let dataSize = 0;
  for (const entry of list) {
    tableSize += 4 + entry.nameBytes.length + 8;
    dataSize += entry.data.length;
  }

  const out = Buffer.alloc(tableSize + dataSize);
  let p = 0;
  out.writeUInt32LE(magic.length, p);
  p += 4;
  out.write(magic, p, 'latin1');
  p += magic.length;
  out.writeUInt32LE(list.length, p);
  p += 4;

  let offset = 0;
  for (const entry of list) {
    out.writeUInt32LE(entry.nameBytes.length, p);
    p += 4;
    entry.nameBytes.copy(out, p);
    p += entry.nameBytes.length;
    out.writeUInt32LE(offset, p);
    out.writeUInt32LE(entry.data.length, p + 4);
    p += 8;
    entry.offset = offset;
    offset += entry.data.length;
  }
  for (const entry of list) {
    entry.data.copy(out, p + entry.offset);
  }
  return out;
}

// ---------------------------------------------------------------- 纹理

/** LZ4 块格式（不是帧格式）：渲染引擎里也是同一套解压逻辑。 */
function lz4Decode(src, outSize) {
  const dst = Buffer.alloc(outSize);
  let s = 0;
  let i = 0;
  while (s < src.length) {
    const token = src[s++];
    let literals = token >> 4;
    if (literals === 15) {
      let b;
      do {
        b = src[s++];
        literals += b;
      } while (b === 255 && s < src.length);
    }
    if (i + literals > outSize || s + literals > src.length) throw new Error('LZ4 数据越界');
    src.copy(dst, i, s, s + literals);
    i += literals;
    s += literals;
    if (s >= src.length) break;

    if (s + 2 > src.length) throw new Error('LZ4 数据不完整');
    const back = src[s] | (src[s + 1] << 8);
    s += 2;
    let len = 4 + (token & 15);
    if ((token & 15) === 15) {
      let b;
      do {
        b = src[s++];
        len += b;
      } while (b === 255 && s < src.length);
    }
    const from = i - back;
    if (from < 0 || i + len > outSize) throw new Error('LZ4 回指越界');
    for (let k = 0; k < len; k++) dst[i + k] = dst[from + k];
    i += len;
  }
  if (i !== outSize) throw new Error(`LZ4 解压长度不符：${i}/${outSize}`);
  return dst;
}

/** 一块 ETC2 颜色（data 指向 8 字节颜色块），写入 colors[16]（RGBA 顺序，行列与 out 一致）。 */
function decodeEtc2ColorBlock(data, at, colors) {
  const j0 = (data[at + 6] << 8) | data[at + 7];
  let k = ((data[at + 4] << 8) | data[at + 5]) >>> 0;
  const flags = data[at + 3];
  const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let j = j0;

  if (flags & 2) {
    // diff bit = 1：先按差分模式算基色，越界时说明是 T / H / planar 模式
    const r = data[at] & 0xf8;
    const dr = ((data[at] << 3) & 0x18) - ((data[at] << 3) & 0x20);
    const g = data[at + 1] & 0xf8;
    const dg = ((data[at + 1] << 3) & 0x18) - ((data[at + 1] << 3) & 0x20);
    const b = data[at + 2] & 0xf8;
    const db = ((data[at + 2] << 3) & 0x18) - ((data[at + 2] << 3) & 0x20);

    if (r + dr < 0 || r + dr > 255) {
      // T 模式
      c[0][0] = ((data[at] << 3) & 0xc0) | ((data[at] << 4) & 0x30) | ((data[at] >> 1) & 0x0c) | (data[at] & 3);
      c[0][1] = (data[at + 1] & 0xf0) | (data[at + 1] >> 4);
      c[0][2] = ((data[at + 1] & 0x0f) | (data[at + 1] << 4)) & 0xff;
      c[1][0] = (data[at + 2] & 0xf0) | (data[at + 2] >> 4);
      c[1][1] = ((data[at + 2] & 0x0f) | (data[at + 2] << 4)) & 0xff;
      c[1][2] = (data[at + 3] & 0xf0) | (data[at + 3] >> 4);
      const d = ETC2_DIST[((data[at + 3] >> 1) & 6) | (data[at + 3] & 1)];
      const set = [
        [...c[0], 255],
        [clamp8(c[1][0] + d), clamp8(c[1][1] + d), clamp8(c[1][2] + d), 255],
        [...c[1], 255],
        [clamp8(c[1][0] - d), clamp8(c[1][1] - d), clamp8(c[1][2] - d), 255],
      ];
      k = (k << 1) >>> 0;
      for (let i = 0; i < 16; i++, j >>= 1, k >>>= 1) {
        colors[WRITE_ORDER[i]] = set[((k & 2) | (j & 1)) >>> 0];
      }
      return;
    }

    if (g + dg < 0 || g + dg > 255) {
      // H 模式
      c[0][0] = ((data[at] << 1) & 0xf0) | ((data[at] >> 3) & 0x0f);
      c[0][1] = ((data[at] << 5) & 0xe0) | (data[at + 1] & 0x10);
      c[0][1] |= c[0][1] >> 4;
      c[0][2] = (data[at + 1] & 8) | ((data[at + 1] << 1) & 6) | (data[at + 2] >> 7);
      c[0][2] |= (c[0][2] << 4) & 0xff;
      c[1][0] = ((data[at + 2] << 1) & 0xf0) | ((data[at + 2] >> 3) & 0x0f);
      c[1][1] = ((data[at + 2] << 5) & 0xe0) | ((data[at + 3] >> 3) & 0x10);
      c[1][1] |= c[1][1] >> 4;
      c[1][2] = ((data[at + 3] << 1) & 0xf0) | ((data[at + 3] >> 3) & 0x0f);
      let di = (data[at + 3] & 4) | ((data[at + 3] << 1) & 2);
      if (
        c[0][0] > c[1][0] ||
        (c[0][0] === c[1][0] && (c[0][1] > c[1][1] || (c[0][1] === c[1][1] && c[0][2] >= c[1][2])))
      ) {
        di++;
      }
      const d = ETC2_DIST[di];
      const set = [
        [clamp8(c[0][0] + d), clamp8(c[0][1] + d), clamp8(c[0][2] + d), 255],
        [clamp8(c[0][0] - d), clamp8(c[0][1] - d), clamp8(c[0][2] - d), 255],
        [clamp8(c[1][0] + d), clamp8(c[1][1] + d), clamp8(c[1][2] + d), 255],
        [clamp8(c[1][0] - d), clamp8(c[1][1] - d), clamp8(c[1][2] - d), 255],
      ];
      k = (k << 1) >>> 0;
      for (let i = 0; i < 16; i++, j >>= 1, k >>>= 1) {
        colors[WRITE_ORDER[i]] = set[((k & 2) | (j & 1)) >>> 0];
      }
      return;
    }

    if (b + db < 0 || b + db > 255) {
      // planar 模式
      c[0][0] = ((data[at] << 1) & 0xfc) | ((data[at] >> 5) & 3);
      c[0][1] = ((data[at] << 7) & 0x80) | (data[at + 1] & 0x7e) | (data[at] & 1);
      c[0][2] = ((data[at + 1] << 7) & 0x80) | ((data[at + 2] << 2) & 0x60) | ((data[at + 2] << 3) & 0x18) | ((data[at + 3] >> 5) & 4);
      c[0][2] |= c[0][2] >> 6;
      c[1][0] = ((data[at + 3] << 1) & 0xf8) | ((data[at + 3] << 2) & 4) | ((data[at + 3] >> 5) & 3);
      c[1][1] = (data[at + 4] & 0xfe) | (data[at + 4] >> 7);
      c[1][2] = ((data[at + 4] << 7) & 0x80) | ((data[at + 5] >> 1) & 0x7c);
      c[1][2] |= c[1][2] >> 6;
      c[2][0] = ((data[at + 5] << 5) & 0xe0) | ((data[at + 6] >> 3) & 0x1c) | ((data[at + 5] >> 1) & 3);
      c[2][1] = ((data[at + 6] << 3) & 0xf8) | ((data[at + 7] >> 5) & 0x06) | ((data[at + 6] >> 4) & 1);
      c[2][2] = ((data[at + 7] << 2) & 0xff) | ((data[at + 7] >> 4) & 3);
      for (let y = 0, i = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++, i++) {
          const r = clamp8((x * (c[1][0] - c[0][0]) + y * (c[2][0] - c[0][0]) + 4 * c[0][0] + 2) >> 2);
          const g = clamp8((x * (c[1][1] - c[0][1]) + y * (c[2][1] - c[0][1]) + 4 * c[0][1] + 2) >> 2);
          const b2 = clamp8((x * (c[1][2] - c[0][2]) + y * (c[2][2] - c[0][2]) + 4 * c[0][2] + 2) >> 2);
          colors[i] = [r, g, b2, 255];
        }
      }
      return;
    }

    // 差分模式
    const code = [data[at + 3] >> 5, (data[at + 3] >> 2) & 7];
    const table = ETC1_SUBBLOCK[data[at + 3] & 1];
    c[0][0] = r | (r >> 5);
    c[0][1] = g | (g >> 5);
    c[0][2] = b | (b >> 5);
    c[1][0] = (r + dr) | ((r + dr) >> 5);
    c[1][1] = (g + dg) | ((g + dg) >> 5);
    c[1][2] = (b + db) | ((b + db) >> 5);
    for (let i = 0; i < 16; i++, j >>= 1, k >>>= 1) {
      const s = table[i];
      const m = ETC1_MOD[code[s]][j & 1];
      const sign = k & 1 ? -1 : 1;
      colors[WRITE_ORDER[i]] = [
        clamp8(c[s][0] + sign * m),
        clamp8(c[s][1] + sign * m),
        clamp8(c[s][2] + sign * m),
        255,
      ];
    }
    return;
  }

  // individual 模式
  const code = [data[at + 3] >> 5, (data[at + 3] >> 2) & 7];
  const table = ETC1_SUBBLOCK[data[at + 3] & 1];
  c[0][0] = (data[at] & 0xf0) | (data[at] >> 4);
  c[1][0] = ((data[at] & 0x0f) | (data[at] << 4)) & 0xff;
  c[0][1] = (data[at + 1] & 0xf0) | (data[at + 1] >> 4);
  c[1][1] = ((data[at + 1] & 0x0f) | (data[at + 1] << 4)) & 0xff;
  c[0][2] = (data[at + 2] & 0xf0) | (data[at + 2] >> 4);
  c[1][2] = ((data[at + 2] & 0x0f) | (data[at + 2] << 4)) & 0xff;
  for (let i = 0; i < 16; i++, j >>= 1, k >>>= 1) {
    const s = table[i];
    const m = ETC1_MOD[code[s]][j & 1];
    const sign = k & 1 ? -1 : 1;
    colors[WRITE_ORDER[i]] = [
      clamp8(c[s][0] + sign * m),
      clamp8(c[s][1] + sign * m),
      clamp8(c[s][2] + sign * m),
      255,
    ];
  }
}

/** 把一块解好的 16 个像素写进 RGBA 画布。 */
function writeBlock(out, colors, width, height, x0, y0) {
  for (let y = 0; y < 4; y++) {
    const py = y0 + y;
    if (py >= height) break;
    for (let x = 0; x < 4; x++) {
      const px = x0 + x;
      if (px >= width) break;
      const c = colors[y * 4 + x];
      const o = (py * width + px) * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = c[3];
    }
  }
}

/** ETC2_RGBA8（EAC 8 字节 alpha + ETC2 8 字节颜色），输出 RGBA 像素。 */
function decodeEtc2a8(raw, width, height) {
  const out = Buffer.alloc(width * height * 4);
  const colors = new Array(16);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const at = (by * blocksX + bx) * 16;
      if (at + 16 > raw.length) throw new Error('ETC2 数据不足');

      decodeEtc2ColorBlock(raw, at + 8, colors);

      // alpha：48 位 3bit 索引按列优先排列，且与颜色块顺序相反
      const base = raw[at];
      const multiplier = raw[at + 1] >> 4;
      if (multiplier === 0) {
        for (let i = 0; i < 16; i++) colors[i][3] = base;
      } else {
        const table = ETC2_ALPHA_MOD[raw[at + 1] & 0x0f];
        let bits = 0n;
        for (let i = 0; i < 8; i++) bits = (bits << 8n) | BigInt(raw[at + i]);
        for (let i = 0; i < 16; i++, bits >>= 3n) {
          const idx = Number(bits & 7n);
          colors[WRITE_ORDER_REV[i]][3] = clamp8(base + multiplier * table[idx]);
        }
      }

      writeBlock(out, colors, width, height, bx * 4, by * 4);
    }
  }
  return out;
}

/** ETC1 RGB（8 字节块），alpha 恒为 255。手机包里的 RGB 贴图可能是这种。 */
function decodeEtc1(raw, width, height) {
  const out = Buffer.alloc(width * height * 4);
  const colors = new Array(16);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const at = (by * blocksX + bx) * 8;
      if (at + 8 > raw.length) throw new Error('ETC1 数据不足');
      decodeEtc2ColorBlock(raw, at, colors);
      writeBlock(out, colors, width, height, bx * 4, by * 4);
    }
  }
  return out;
}

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
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 解析 TEXV0005 容器，拿到各 mip 的压缩数据。 */
function parseTexTex(buf) {
  if (buf.length < 46) throw new Error('纹理过小');
  const magic = buf.toString('latin1', 0, 9);
  if (magic !== 'TEXV0005\0') return null;
  const format = buf.readInt32LE(18);
  const flags = u32(buf, 22);
  const textureWidth = u32(buf, 26);
  const textureHeight = u32(buf, 30);
  const width = u32(buf, 34);
  const height = u32(buf, 38);

  let texbAt = -1;
  for (let at = 34; at <= 64 && at + 9 <= buf.length; at++) {
    if (buf.toString('latin1', at, at + 9).startsWith('TEXB')) {
      texbAt = at;
      break;
    }
  }
  if (texbAt < 0) return null;

  let p = texbAt;
  const container = buf.toString('latin1', p, p + 9);
  p += 9;
  const imageCount = u32(buf, p);
  p += 4;
  let freeImageFormat = -1;
  let version = 0;
  if (container === 'TEXB0004\0') {
    freeImageFormat = buf.readInt32LE(p);
    p += 4;
    version = u32(buf, p);
    p += 4;
  } else if (container === 'TEXB0003\0') {
    freeImageFormat = buf.readInt32LE(p);
    p += 4;
  }

  const images = [];
  for (let img = 0; img < imageCount; img++) {
    const mipCount = u32(buf, p);
    p += 4;
    const mips = [];
    for (let mip = 0; mip < mipCount; mip++) {
      const w = u32(buf, p);
      const h = u32(buf, p + 4);
      p += 8;
      let compression = 0;
      let rawSize = 0;
      let dataSize = u32(buf, p);
      p += 4;
      if (container !== 'TEXB0001\0') {
        // TEXB0002/3/4：[压缩方式][原尺寸][数据长度]
        compression = dataSize;
        rawSize = u32(buf, p);
        p += 4;
        dataSize = u32(buf, p);
        p += 4;
      }
      if (p + dataSize > buf.length) throw new Error('纹理 mip 越界');
      mips.push({ width: w, height: h, compression, rawSize, data: buf.subarray(p, p + dataSize) });
      p += dataSize;
    }
    images.push(mips);
  }
  return { format, flags, textureWidth, textureHeight, width, height, freeImageFormat, images };
}

/** 把手机版 GPU 压缩纹理改写成「PNG 自由格式」的 TEXB，桌面渲染引擎原生支持。 */
function convertTex(buf) {
  const tex = parseTexTex(buf);
  if (!tex) return null;
  // 已经是 PNG/JPEG 等自由格式，或者引擎自己就能解的格式（RGBA/DXT/R8…），原样保留
  if (tex.freeImageFormat >= 0) return buf;
  if (tex.format !== 5 && tex.format !== 3) return buf;
  if (tex.images.length > 1) throw new Error('暂不支持多帧纹理');

  const mip = tex.images[0] && tex.images[0][0];
  if (!mip) throw new Error('纹理没有 mip 数据');

  let raw;
  if (mip.compression === 1) {
    raw = lz4Decode(mip.data, mip.rawSize || mip.width * mip.height * 4);
  } else if (mip.compression === 0) {
    raw = mip.data;
  } else {
    throw new Error(`不支持的纹理压缩方式：${mip.compression}`);
  }

  const rgba = tex.format === 5
    ? decodeEtc2a8(raw, mip.width, mip.height)
    : decodeEtc1(raw, mip.width, mip.height);

  const png = encodePng(rgba, mip.width, mip.height);

  // 参照桌面包：TEXI 里 format 写 0，TEXB0004 的 freeImageFormat 写 13(PNG)
  const header = Buffer.alloc(46);
  header.write('TEXV0005\0', 0, 'latin1');
  header.write('TEXI0001\0', 9, 'latin1');
  header.writeInt32LE(0, 18);
  header.writeUInt32LE(tex.flags, 22);
  header.writeUInt32LE(tex.textureWidth, 26);
  header.writeUInt32LE(tex.textureHeight, 30);
  header.writeUInt32LE(tex.width, 34);
  header.writeUInt32LE(tex.height, 38);
  header.writeUInt32LE(0, 42);

  const body = Buffer.alloc(9 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4);
  let p = 0;
  body.write('TEXB0004\0', p, 'latin1');
  p += 9;
  body.writeUInt32LE(1, p); // imageCount
  p += 4;
  body.writeInt32LE(13, p); // freeImageFormat = PNG
  p += 4;
  body.writeUInt32LE(0, p); // isVideo
  p += 4;
  body.writeUInt32LE(1, p); // mipCount
  p += 4;
  body.writeUInt32LE(mip.width, p);
  body.writeUInt32LE(mip.height, p + 4);
  body.writeUInt32LE(0, p + 8); // compression = none
  body.writeUInt32LE(0, p + 12);
  body.writeUInt32LE(png.length, p + 16);
  p += 20;

  return Buffer.concat([header, body.subarray(0, p), png]);
}

// ---------------------------------------------------------------- 转换主流程

function findEntry(entries, name) {
  return entries.find((entry) => entry.name === name) || null;
}

/** 从补充包里按名字捞音频；桌面包的 sounds/ 名字与 scene.json 引用一致。 */
function soundFromSupplement(name, supplements) {
  const base = path.basename(name).toLowerCase();
  for (const pkg of supplements) {
    const exact = findEntry(pkg.entries, name);
    if (exact) return exact.data;
    const loose = pkg.entries.find(
      (entry) => entry.name.startsWith('sounds/') && path.basename(entry.name).toLowerCase() === base
    );
    if (loose) return loose.data;
  }
  return null;
}

function readSupplement(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || !stat.size) return null;
    return readPkg(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/**
 * @param {string} source .mpkg 绝对路径
 * @param {object} options
 * @param {string} options.cacheRoot 转换结果目录（调用方保证在 D 盘）
 * @param {string[]|((workshopId:string)=>string[])} [options.supplementPkgs] 同 ID 的桌面 scene.pkg 候选
 * @param {(text:string)=>void} [options.onLog]
 */
function convertMpkg(source, options) {
  const cacheRoot = options.cacheRoot;
  const log = options.onLog || (() => {});

  const pkg = readPkg(fs.readFileSync(source));
  let title = path.basename(source, path.extname(source));
  let workshopId = '';

  const projectEntry = findEntry(pkg.entries, 'project.json');
  if (projectEntry) {
    try {
      const project = JSON.parse(projectEntry.data.toString('utf8'));
      if (project.title) title = String(project.title);
      if (project.workshopid) workshopId = String(project.workshopid);
    } catch {
      // 项目信息坏了不影响画面
    }
  }

  // 补音频要按 workshopid 找本机桌面包，所以候选路径只能解析完项目信息再问
  const supplementFiles =
    typeof options.supplementPkgs === 'function'
      ? options.supplementPkgs(workshopId) || []
      : options.supplementPkgs || [];
  const supplements = supplementFiles.map(readSupplement).filter(Boolean);

  const sceneEntry = findEntry(pkg.entries, 'scene.json');
  if (!sceneEntry) throw new Error('资源包里没有 scene.json，无法作为场景壁纸使用');

  // 1. 纹理
  const out = [];
  let convertedTex = 0;
  for (const entry of pkg.entries) {
    if (/\.tex$/i.test(entry.name)) {
      try {
        const tex = convertTex(entry.data);
        out.push({ name: entry.name, data: tex || entry.data });
        convertedTex++;
      } catch (err) {
        log(`纹理 ${entry.name} 转换失败，保留原样：${err.message}`);
        out.push(entry);
      }
      continue;
    }
    // 预览图另外存成缩略图，不重复塞进包
    if (entry.name === 'preview.gif') continue;
    out.push(entry);
  }

  // 2. 音频：scene.json 引用了但包里没有的，从桌面包补
  const soundRefs = [...new Set([...sceneEntry.data.toString('utf8').matchAll(/sounds\/[^"\\]+/g)].map((m) => m[0]))];
  let added = 0;
  for (const ref of soundRefs) {
    if (findEntry(out, ref)) continue;
    const data = soundFromSupplement(ref, supplements);
    if (!data) {
      log(`缺少音频 ${ref}，本机也没有同 ID 的桌面版可补`);
      continue;
    }
    out.push({ name: ref, data });
    added++;
  }

  // 3. 落盘
  const dir = path.join(cacheRoot, path.basename(source).replace(/[^\w.-]+/g, '_') + '-' + CONVERTER_VERSION);
  fs.mkdirSync(dir, { recursive: true });
  const pkgPath = path.join(dir, 'scene.pkg');
  const body = writePkg(out);
  fs.writeFileSync(pkgPath + '.tmp', body);
  fs.renameSync(pkgPath + '.tmp', pkgPath);

  let previewPath = null;
  const preview = findEntry(pkg.entries, 'preview.gif');
  if (preview) {
    previewPath = path.join(dir, 'preview.gif');
    fs.writeFileSync(previewPath, preview.data);
  }

  // project.json 里的 general.properties 是壁纸脚本的用户属性（音乐选择、时钟格式等），
  // 渲染引擎会单独请求它；缺了它音乐脚本就永远收不到“播哪一首”。
  let projectPath = null;
  if (projectEntry) {
    projectPath = path.join(dir, 'project.json');
    fs.writeFileSync(projectPath, projectEntry.data);
  }

  return {
    pkgPath,
    previewPath,
    projectPath,
    title,
    workshopId,
    size: body.length,
    soundsAdded: added,
    texturesConverted: convertedTex,
  };
}

/**
 * 从场景脚本里读音乐列表：作者一般把歌名数组写在脚本里（songNames），
 * 它和 project.json 里 music 属性的选项一一对应（选项值 = 下标 + 1）。
 */
function extractSongNames(scene) {
  if (!scene || !Array.isArray(scene.objects)) return null;
  for (const object of scene.objects) {
    const visible = object && object.visible;
    const script = visible && typeof visible.script === 'string' ? visible.script : '';
    if (!script) continue;
    const match = /songNames\s*=\s*\[([\s\S]*?)\]/.exec(script);
    if (!match) continue;
    const names = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (names.length) return names;
  }
  return null;
}

/**
 * 自包含的 scene.pkg 没有 project.json 时，音乐脚本拿不到“播哪一首”（init 里还会把
 * 所有音乐都 stop 掉）。这里按脚本里的歌单合成一份最小 project.json，默认播第一首。
 */
function synthesizeProject(scene, title, songNames) {
  const options = [{ label: 'NULL 空', value: '0' }].concat(
    songNames.map((name, i) => ({ label: name, value: String(i + 1) }))
  );
  return Buffer.from(
    JSON.stringify({
      type: 'scene',
      title,
      general: {
        properties: {
          music: {
            index: 5,
            options,
            order: 105,
            text: '音乐设置<br> Music',
            type: 'combo',
            value: '1',
          },
        },
      },
    }),
    'utf8'
  );
}

/**
 * 直接导入一个已经能渲染的 scene.pkg（桌面包，或本扩展转换出的自包含包）。
 * 纹理若还是 ETC2 就转 PNG；没有 project.json 时补一份，保证音乐能响。
 */
function convertPkg(source, options = {}) {
  const cacheRoot = options.cacheRoot;
  const log = options.onLog || (() => {});
  const pkg = readPkg(fs.readFileSync(source));

  const sceneEntry = findEntry(pkg.entries, 'scene.json');
  if (!sceneEntry) throw new Error('资源包里没有 scene.json，无法作为场景壁纸使用');

  let scene = null;
  try {
    scene = JSON.parse(sceneEntry.data.toString('utf8'));
  } catch {
    // JSON 坏了就别动，让渲染端自己报错
  }

  const out = [];
  let convertedTex = 0;
  let previewData = null;
  for (const entry of pkg.entries) {
    if (entry.name === 'preview.gif') {
      previewData = entry.data;
      continue;
    }
    if (/\.tex$/i.test(entry.name)) {
      try {
        out.push({ name: entry.name, data: convertTex(entry.data) || entry.data });
        convertedTex++;
      } catch (err) {
        log(`纹理 ${entry.name} 转换失败，保留原样：${err.message}`);
        out.push(entry);
      }
      continue;
    }
    out.push(entry);
  }

  let title = path.basename(source, path.extname(source));

  // 同目录若有 project.json（连同 scene.pkg 一起发过来），优先用真实的用户属性
  let projectData = null;
  let projectSynthesized = false;
  const sideProject = path.join(path.dirname(source), 'project.json');
  try {
    if (fs.existsSync(sideProject)) projectData = fs.readFileSync(sideProject);
  } catch {
    projectData = null;
  }

  if (projectData) {
    try {
      const project = JSON.parse(projectData.toString('utf8'));
      if (project.title) title = String(project.title);
    } catch {
      projectData = null;
    }
  }

  if (!projectData && scene) {
    const songNames = extractSongNames(scene);
    if (songNames) {
      projectData = synthesizeProject(scene, title, songNames);
      projectSynthesized = true;
    }
  }

  const key = crypto.createHash('sha1').update(path.resolve(source).toLowerCase()).digest('hex').slice(0, 12);
  const dir = path.join(cacheRoot, `pkg-${key}-${CONVERTER_VERSION}`);
  fs.mkdirSync(dir, { recursive: true });

  const pkgPath = path.join(dir, 'scene.pkg');
  const body = writePkg(out);
  fs.writeFileSync(pkgPath + '.tmp', body);
  fs.renameSync(pkgPath + '.tmp', pkgPath);

  let previewPath = null;
  if (previewData) {
    previewPath = path.join(dir, 'preview.gif');
    fs.writeFileSync(previewPath, previewData);
  }
  let projectPath = null;
  if (projectData) {
    projectPath = path.join(dir, 'project.json');
    fs.writeFileSync(projectPath, projectData);
  }

  return {
    pkgPath,
    previewPath,
    projectPath,
    title,
    size: body.length,
    texturesConverted: convertedTex,
    projectSynthesized,
  };
}

module.exports = {
  CONVERTER_VERSION,
  isMpkg,
  isPkg,
  readPkg,
  writePkg,
  lz4Decode,
  decodeEtc2a8,
  decodeEtc1,
  encodePng,
  convertTex,
  convertMpkg,
  convertPkg,
};
