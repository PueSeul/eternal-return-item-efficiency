'use strict';
// npm run build:exe: portable exe를 임시 폴더에서 빌드한 뒤 dist/ 로 복사한다.
// 프로젝트 안에서 직접 빌드하면 프로젝트 폴더를 감시하는 Electron 앱(편집기 등)이 새로 생긴 .asar 파일을
// 열어 둔 채 놓지 않아 electron-builder가 EBUSY로 실패하는 일이 있어, 중간 산출물은 프로젝트 밖에 둔다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const builder = require('electron-builder');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

async function main() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'er-build-'));
  try {
    const artifacts = await builder.build({
      projectDir: ROOT,
      targets: builder.Platform.WINDOWS.createTarget('portable'),
      config: { directories: { output: out } },
    });
    const exes = artifacts.filter((f) => f.toLowerCase().endsWith('.exe'));
    if (exes.length !== 1) throw new Error('portable exe를 찾지 못했습니다: ' + artifacts.join(', '));
    fs.mkdirSync(DIST, { recursive: true });
    const dest = path.join(DIST, path.basename(exes[0]));
    fs.copyFileSync(exes[0], dest);
    console.log(`완성: ${dest} (${fs.statSync(dest).size} bytes)`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
