'use strict';
// 프로그램 자동 업데이트(v2 포터블 exe). electron-updater 는 portable 대상을 지원하지 않아 직접 구현한다.
// 1) GitHub Releases latest 의 태그를 현재 버전과 비교(semver)
// 2) 자산 ER-Damage-Calculator-v2-*-portable.exe 를 exe 옆 임시 이름(<exe>.download)으로 받기
// 3) cmd 배치(SWAP_SCRIPT)를 띄우고 종료: 프로세스 종료·exe 잠금 해제 대기 → 원본을 <exe>.old 로 →
//    받은 파일을 원래 이름으로 → 실행. 실패하면 원본을 되돌려 다시 실행하고 실패 표시 파일을 남긴다.
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');

const RELEASES_API = 'https://api.github.com/repos/PueSeul/eternal-return-item-efficiency/releases/latest';
const ASSET_RE = /^ER-Damage-Calculator-v2-.*-portable\.exe$/;
// API 요청 제한 시간이자, 다운로드 중 이 시간 동안 데이터가 오지 않으면 실패로 본다.
const REQUEST_TIMEOUT_MS = 20000;

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null;
}

// semver 비교: a < b 이면 음수, 같으면 0, 크면 양수. 형식이 아니면 오류.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`버전 형식이 아닙니다: ${x ? b : a}`);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  // 프리릴리스가 없는 쪽이 더 높다(1.0.0-beta < 1.0.0).
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (!pn && p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

function describeError(err) {
  if (err && err.name === 'TimeoutError') return `응답 없음(${REQUEST_TIMEOUT_MS / 1000}초 초과)`;
  const msg = String((err && err.message) || err);
  const cause = err && err.cause;
  return cause ? `${msg} (${cause.code || cause.message || cause})` : msg;
}

// 최신 릴리스 확인. 반환 {status:'latest'|'available', current, version, notes, url, asset}.
// 릴리스가 아직 없으면(404) 'latest'(version null). asset 은 v2 exe 자산 {name, url, size} 또는 null.
async function checkForUpdate({ fetch, currentVersion, apiUrl = RELEASES_API }) {
  let rel;
  try {
    const res = await fetch(apiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `ER-Damage-Calculator/${currentVersion}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return { status: 'latest', current: currentVersion, version: null };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rel = await res.json();
  } catch (err) {
    throw new Error(`업데이트 확인 실패: ${describeError(err)}`);
  }
  const version = String((rel && rel.tag_name) || '').replace(/^v/, '');
  if (!parseVersion(version)) throw new Error(`업데이트 확인 실패: 릴리스 태그를 읽지 못했습니다(${rel && rel.tag_name}).`);
  if (compareVersions(version, currentVersion) <= 0) return { status: 'latest', current: currentVersion, version };
  const asset = (rel.assets || []).find((a) => ASSET_RE.test(a.name));
  return {
    status: 'available',
    current: currentVersion,
    version,
    notes: String(rel.body || ''),
    url: String(rel.html_url || ''),
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0 } : null,
  };
}

// 자산을 dest 로 받는다. onProgress({received, total}). 실패하면 dest 를 지우고 '다운로드 실패: …' 오류.
async function downloadAsset({ fetch, asset, dest, onProgress, idleMs = REQUEST_TIMEOUT_MS }) {
  const ctrl = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new Error(`응답 없음(${idleMs / 1000}초 동안 데이터 없음)`)), idleMs);
  };
  try {
    arm();
    const res = await fetch(asset.url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    let received = 0;
    const count = new Transform({
      transform(chunk, _enc, cb) {
        arm();
        received += chunk.length;
        if (onProgress) onProgress({ received, total });
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(dest), { signal: ctrl.signal });
    if (asset.size && received !== asset.size) throw new Error(`크기가 다릅니다(받은 ${received}, 릴리스 ${asset.size} bytes)`);
    const head = Buffer.alloc(2);
    const fd = await fs.promises.open(dest, 'r');
    try {
      await fd.read(head, 0, 2, 0);
    } finally {
      await fd.close();
    }
    if (head.toString('latin1') !== 'MZ') throw new Error('받은 파일이 exe가 아닙니다.');
    return { received, total };
  } catch (err) {
    await fs.promises.rm(dest, { force: true });
    throw new Error(`다운로드 실패: ${describeError(ctrl.signal.aborted && ctrl.signal.reason ? ctrl.signal.reason : err)}`);
  } finally {
    clearTimeout(timer);
  }
}

// 교체 배치. 경로는 환경변수로 받아 배치 파일은 ASCII 만 쓴다(한글 경로·코드 페이지 문제 회피).
// ER_TARGET 현재 exe, ER_NEW 받은 파일, ER_PID 끝나기를 기다릴 프로세스, ER_FAIL 실패 표시 파일.
const SWAP_SCRIPT = [
  '@echo off',
  'setlocal DisableDelayedExpansion',
  'if not exist "%ER_TARGET%" goto fail',
  'powershell -NoProfile -NonInteractive -Command "Wait-Process -Id $env:ER_PID -Timeout 120 -ErrorAction SilentlyContinue"',
  'set /a tries=0',
  ':wait',
  'rem The portable launcher keeps the exe locked until it exits: wait until it can be opened for writing.',
  '2>nul (>>"%ER_TARGET%" call ) && goto ready',
  'set /a tries+=1',
  'if %tries% geq 120 goto fail',
  'ping -n 2 127.0.0.1 >nul',
  'goto wait',
  ':ready',
  'if exist "%ER_TARGET%.old" del /f /q "%ER_TARGET%.old" >nul 2>&1',
  'if exist "%ER_TARGET%.old" goto fail',
  'move /y "%ER_TARGET%" "%ER_TARGET%.old" >nul 2>&1',
  'if errorlevel 1 goto fail',
  'move /y "%ER_NEW%" "%ER_TARGET%" >nul 2>&1',
  'if errorlevel 1 goto restore',
  'rem start sets errorlevel when the new exe cannot be started: put the original back.',
  'start "" "%ER_TARGET%"',
  'if errorlevel 1 goto restore',
  'goto end',
  ':restore',
  'move /y "%ER_TARGET%.old" "%ER_TARGET%" >nul 2>&1',
  'if errorlevel 1 move /y "%ER_TARGET%.old" "%ER_TARGET%" >nul 2>&1',
  ':fail',
  'del /f /q "%ER_NEW%" >nul 2>&1',
  '>"%ER_FAIL%" echo swap failed',
  'if exist "%ER_TARGET%" start "" "%ER_TARGET%"',
  ':end',
  '(goto) 2>nul & del "%~f0"',
  '',
].join('\r\n');

// 교체 배치를 <target>.update.cmd 로 쓰고 분리 실행한다. 프로세스가 시작되면 배치 경로로 resolve,
// 시작하지 못하면(spawn 'error') 배치를 지우고 reject. 검증·포터블 환경변수는 새 실행에 넘기지 않는다.
function launchSwap({ target, downloaded, pid, failMarker, env = process.env, spawnFn = spawn }) {
  const script = `${target}.update.cmd`;
  fs.writeFileSync(script, SWAP_SCRIPT, 'ascii');
  const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !/^(ER_SMOKE_|PORTABLE_EXECUTABLE_)/i.test(k)));
  Object.assign(childEnv, {
    ER_SCRIPT: script, ER_TARGET: target, ER_NEW: downloaded, ER_PID: String(pid), ER_FAIL: failMarker,
  });
  return new Promise((resolve, reject) => {
    // 배치 경로도 환경변수로 넘겨 경로 속 % 가 명령줄에서 치환되지 않게 한다.
    // /s: 바깥 따옴표 한 쌍만 벗기므로 경로에 공백·괄호가 있어도 그대로 실행된다.
    const child = spawnFn(env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', '""%ER_SCRIPT%""'], {
      detached: true, windowsHide: true, stdio: 'ignore', env: childEnv, windowsVerbatimArguments: true,
    });
    child.once('error', (err) => {
      fs.rmSync(script, { force: true });
      reject(err);
    });
    child.once('spawn', () => {
      child.unref();
      resolve(script);
    });
  });
}

module.exports = {
  RELEASES_API, ASSET_RE, REQUEST_TIMEOUT_MS, SWAP_SCRIPT,
  parseVersion, compareVersions, checkForUpdate, downloadAsset, launchSwap,
};
