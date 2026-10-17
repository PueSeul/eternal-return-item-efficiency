'use strict';
// 프로그램 자동 업데이트(포터블 exe). electron-updater 는 portable 대상을 지원하지 않아 직접 구현한다.
// 1) GitHub Releases latest 의 태그를 현재 버전과 비교(semver)
// 2) 자산 ER-Damage-Calculator-<버전>-portable.exe(옛 이름 ER-Damage-Calculator-v2-<버전>-portable.exe 도 허용)를
//    exe 옆 <자산 이름>.download 로 받아 <자산 이름>으로 바꾸기
// 3) 새 exe 를 교체 인자로 띄우고 종료 → 새 exe 가 이전 exe 를 .old 로 바꾸고 삭제(launchSwap · waitForExit · finishSwap)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');

const RELEASES_API = 'https://api.github.com/repos/PueSeul/eternal-return-item-efficiency/releases/latest';
// 릴리스 버전과 정확히 같은 자산 이름: 새 이름 우선, 옛 v2 이름 호환. v1 exe(ER-Damage-Calculator-v1-…)는 고르지 않는다.
const assetNames = (version) => [`ER-Damage-Calculator-${version}-portable.exe`, `ER-Damage-Calculator-v2-${version}-portable.exe`];
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
// 릴리스가 아직 없으면(404) 'latest'(version null). asset 은 exe 자산 {name, url, size} 또는 null.
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
  const assets = rel.assets || [];
  const asset = assetNames(version).map((n) => assets.find((a) => a.name === n)).find(Boolean);
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

// 교체(배치·콘솔 프로그램 없이 새 exe 가 맡는다 → 명령 프롬프트 창이 뜨지 않는다).
// 이전 실행: 받은 파일을 릴리스 자산 이름(dest)으로 두고 launchSwap 으로 새 exe 를 띄운 뒤 종료.
// 새 실행(--er-swap-from=<이전 exe> --er-swap-pid=<이전 PID>): waitForExit 로 이전 프로세스 종료를 기다려
// single-instance lock 을 잡은 뒤 finishSwap 으로 이전 exe 를 <exe>.old 로 바꾸고 지운다. 새 exe 가 뜨지 못하면 이전 exe 는 그대로다.
// (포터블 실행기는 빌드마다 다른 임시 폴더에 풀리므로 버전이 다른 두 exe 가 겹쳐 실행돼도 서로의 파일을 지우지 않는다.)
const SWAP_FROM = '--er-swap-from=';
const SWAP_PID = '--er-swap-pid=';
const NO_RENAME = '--er-no-rename';
const SWAP_TIMEOUT_MS = 120000;

// 릴리스 자산 이름(새 이름). 옛 이름(v2-)도 같은 패턴으로 알아본다.
const exeName = (version) => `ER-Damage-Calculator-${version}-portable.exe`;
const EXE_NAME_RE = /^ER-Damage-Calculator-(?:v2-)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-portable\.exe$/i;

// 1.1.0·1.2.0 의 교체 배치는 새 exe 를 원래 이름으로 둬 파일명만 옛 버전으로 남았다. 실행 중 exe 의 이름이 릴리스 자산 패턴인데
// 실행 중 버전의 이름과 다르고 그 이름이 비어 있으면 올바른 경로, 아니면 null(사용자가 바꾼 이름은 건드리지 않는다).
function misnamedTarget(exePath, version) {
  const base = path.basename(exePath);
  const want = path.join(path.dirname(exePath), exeName(version));
  if (!EXE_NAME_RE.test(base) || base === exeName(version) || fs.existsSync(want)) return null;
  return want;
}

// 교체 인자. 이전 exe 는 실행 중 exe(self)와 같은 폴더의 다른 릴리스 자산 이름이고 PID 는 양의 정수여야 한다(아니면 null: 아무것도 지우지 않음).
function parseSwapArgs(argv, self) {
  const from = argv.find((a) => a.startsWith(SWAP_FROM));
  const pid = argv.find((a) => a.startsWith(SWAP_PID));
  if (!from || !pid || !self) return null;
  const swap = { from: from.slice(SWAP_FROM.length), pid: Number(pid.slice(SWAP_PID.length)) };
  const sameDir = path.resolve(path.dirname(swap.from)).toLowerCase() === path.resolve(path.dirname(self)).toLowerCase();
  const other = path.resolve(swap.from).toLowerCase() !== path.resolve(self).toLowerCase();
  if (!Number.isInteger(swap.pid) || swap.pid <= 0 || !sameDir || !other || !EXE_NAME_RE.test(path.basename(swap.from))) return null;
  return swap;
}

// 검증·포터블 환경변수는 새 실행에 넘기지 않는다(포터블 실행기가 새 exe 경로로 다시 정한다).
const childEnvOf = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^(ER_SMOKE_|PORTABLE_EXECUTABLE_)/i.test(k)));

// 분리 실행. 시작되면 resolve, 시작하지 못하면(spawn 'error') reject.
function spawnDetached(spawnFn, cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(cmd, args, { detached: true, stdio: 'ignore', env: childEnvOf(env) });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child);
    });
  });
}

// 새 exe(dest)를 교체 인자와 함께 실행.
function launchSwap({ dest, target, pid, env = process.env, spawnFn = spawn }) {
  return spawnDetached(spawnFn, dest, [SWAP_FROM + target, SWAP_PID + pid], env);
}

// 이름 바로잡기(같은 빌드라 새 exe 를 겹쳐 띄우면 같은 임시 폴더를 서로 지운다): wscript(창 없는 GUI 호스트)가
// 이 프로세스와 포터블 실행기가 끝나 exe 를 옮길 수 있을 때까지 기다려 이름을 바꾸고 실행한다.
// 바꾸면 옛 배치가 남긴 <원래 이름>.old 도 지우기를 시도한다. 끝내 못 바꾸면 원래 exe 를 --er-no-rename 으로 실행(다시 시도하지 않음). 스크립트는 ASCII, 경로는 인자로 받는다.
const RENAME_SCRIPT = [
  'Option Explicit',
  'Dim fso, sh, src, dst, i, ok',
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'Set sh = CreateObject("Shell.Application")',
  'src = WScript.Arguments(0)',
  'dst = WScript.Arguments(1)',
  'fso.CreateTextFile(fso.GetParentFolderName(WScript.ScriptFullName) & "\\ready", True).Close',
  'ok = False',
  'For i = 1 To 240',
  '  On Error Resume Next',
  '  fso.MoveFile src, dst',
  '  If Err.Number = 0 Then ok = True',
  '  Err.Clear',
  '  On Error GoTo 0',
  '  If ok Then Exit For',
  '  WScript.Sleep 500',
  'Next',
  "rem ShellExecute (not WScript.Shell.Run) so that % in the path is not expanded.",
  'On Error Resume Next',
  'If ok Then',
  '  fso.DeleteFile src & ".old", True',
  '  sh.ShellExecute dst, "", "", "open", 1',
  'Else',
  `  sh.ShellExecute src, "${NO_RENAME}", "", "open", 1`,
  'End If',
  'fso.DeleteFolder fso.GetParentFolderName(WScript.ScriptFullName), True',
  '',
].join('\r\n');

// 스크립트가 실제로 돌기 시작했다는 표시(ready 파일)를 readyMs 안에 확인해야 성공(Windows Script Host 가 막혀 있으면
// wscript 가 곧바로 끝나므로 실패로 보고 이 실행을 그대로 이어 간다).
function launchRename({ from, to, env = process.env, spawnFn = spawn, readyMs = 10000, sleep = delay }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'er-rename-'));
  const script = path.join(dir, 'rename.vbs');
  fs.writeFileSync(script, RENAME_SCRIPT, 'ascii');
  const wscript = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  return spawnDetached(spawnFn, wscript, ['//B', '//Nologo', script, from, to], env).then(async (child) => {
    let exited = false;
    child.once('exit', () => { exited = true; });
    for (const end = Date.now() + readyMs; ;) {
      if (fs.existsSync(path.join(dir, 'ready')) || !fs.existsSync(dir)) return;
      if (exited || Date.now() > end) break;
      await sleep(100);
    }
    try { child.kill(); } catch { /* 이미 끝남 */ }
    throw new Error('이름 바꾸기 스크립트가 시작되지 않았습니다(Windows Script Host)');
  }).catch((err) => {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// 이전 프로세스(pid)가 끝나기를 기다린다. 제한 시간 안에 끝나면 true.
async function waitForExit({ pid, timeoutMs = SWAP_TIMEOUT_MS, alive = isAlive, sleep = delay }) {
  const end = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > end) return false;
    await sleep(200);
  }
  return true;
}

// 이전 exe(from)를 <from>.old 로 바꾼 뒤 지운다. 포터블 실행기는 끝날 때까지 exe 를 열어 두므로 둘 다 재시도한다.
// 제한 시간 안에 못 하면 오류(이름을 못 바꿨으면 이전 exe 그대로, 못 지웠으면 .old 로 남는다).
async function finishSwap({ from, timeoutMs = SWAP_TIMEOUT_MS, sleep = delay }) {
  const end = Date.now() + timeoutMs;
  const old = `${from}.old`;
  for (;;) {
    try {
      await fs.promises.rm(old, { force: true });
      await fs.promises.rename(from, old);
      break;
    } catch (err) {
      if (err.code === 'ENOENT' && !fs.existsSync(from)) return;
      if (Date.now() > end) throw new Error(`이전 버전 파일을 지우지 못했습니다(${from}): ${err.code || err.message}`);
      await sleep(250);
    }
  }
  for (;;) {
    try {
      await fs.promises.rm(old, { force: true });
      return;
    } catch (err) {
      if (Date.now() > end) throw new Error(`이전 버전 파일을 지우지 못했습니다(${old}): ${err.code || err.message}`);
      await sleep(250);
    }
  }
}

module.exports = {
  RELEASES_API, REQUEST_TIMEOUT_MS, SWAP_TIMEOUT_MS, NO_RENAME, RENAME_SCRIPT,
  parseVersion, compareVersions, checkForUpdate, downloadAsset,
  exeName, misnamedTarget, parseSwapArgs, launchSwap, launchRename, waitForExit, finishSwap,
};
