'use strict';
// node build/make-icon.js: build/icon.ico 의 가장 큰 PNG 프레임(Electron 기본 아이콘 256px)을
// 여러 크기로 리사이즈해 모든 프레임이 투명 알파를 가진 PNG-압축 ICO로 다시 만든다.
// (electron.exe 에서 그대로 추출한 16px 프레임은 불투명 회색 배경 BMP라 탐색기에서 사각 배경이 보였다.)
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ICO = path.join(__dirname, 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function largestPngFrame(ico) {
  const count = ico.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const size = ico[e] || 256;
    const len = ico.readUInt32LE(e + 8);
    const off = ico.readUInt32LE(e + 12);
    const data = ico.subarray(off, off + len);
    if (data.subarray(0, 8).equals(PNG_SIG) && (!best || size > best.size)) best = { size, data };
  }
  if (!best) throw new Error('icon.ico 에 PNG 프레임이 없습니다');
  return best.data;
}

async function main() {
  const src = Buffer.from(largestPngFrame(fs.readFileSync(ICO)));
  const frames = [];
  for (const s of SIZES) {
    frames.push(await sharp(src).ensureAlpha().resize(s, s, { kernel: 'lanczos3' }).png().toBuffer());
  }
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let off = header.length;
  frames.forEach((buf, i) => {
    const e = 6 + 16 * i;
    header[e] = SIZES[i] % 256;
    header[e + 1] = SIZES[i] % 256;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(buf.length, e + 8);
    header.writeUInt32LE(off, e + 12);
    off += buf.length;
  });
  fs.writeFileSync(ICO, Buffer.concat([header, ...frames]));
  console.log(`${ICO}: ${SIZES.join('/')}px`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
