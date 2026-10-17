'use strict';
// 프로그램 안 "아이템 수치 업데이트": fetchAll() 결과를 data/items.json·characters.json·skills.json·items.meta.json 에 저장한다.
// Electron 없이 테스트할 수 있도록 main.js 에서 분리.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// scripts/fetch_items.mjs (데이터 수집 담당 모듈)의 fetchAll 을 불러온다.
async function loadFetchAll(appRoot) {
  const mod = await import(pathToFileURL(path.join(appRoot, 'scripts', 'fetch_items.mjs')).href);
  if (typeof mod.fetchAll !== 'function') throw new Error('scripts/fetch_items.mjs에 fetchAll 함수가 없습니다.');
  return mod.fetchAll;
}

const FILES = ['items.json', 'characters.json', 'skills.json', 'items.meta.json'];

// 전체 업데이트 상한. 넘으면 fetchAll 에 중단 신호를 보내고 마지막 진행 단계를 담은 오류로 끝낸다.
const UPDATE_TIMEOUT_MS = 8 * 60 * 1000;

function durationText(ms) {
  return ms % 60000 === 0 ? `${ms / 60000}분` : `${ms / 1000}초`;
}

// 끝나지 않은 단계(마지막 이벤트가 done < total)의 문구. 모두 끝났으면 가장 최근 이벤트.
function pendingText(stages, last) {
  const pending = [...stages.values()].filter((p) => !(p.total > 0 && p.done >= p.total));
  const text = (p) => `${p.message || p.stage}${p.total > 1 ? ` ${p.done}/${p.total}` : ''}`;
  if (pending.length) return ` (끝나지 않은 단계: ${pending.map(text).join(', ')})`;
  return last ? ` (마지막 진행: ${text(last)})` : '';
}

// fetchAll 을 timeoutMs 안에 끝내지 못하면 reject. 진행 이벤트는 onProgress 로 넘기고, 단계별 마지막 이벤트로
// 상한을 넘겼을 때 어느 단계가 끝나지 않았는지 오류 문구에 쓴다.
async function runWithTimeout(fetchAll, options, onProgress, timeoutMs) {
  const controller = new AbortController();
  const stages = new Map();
  let last = null;
  const job = fetchAll({
    ...options,
    signal: controller.signal,
    onProgress: (p) => {
      stages.set(p.stage, p);
      last = p;
      if (onProgress) onProgress(p);
    },
  });
  job.catch(() => {}); // 상한을 넘긴 뒤 늦게 끝나는 실패는 이미 보고했다.
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const where = pendingText(stages, last);
      const err = new Error(`업데이트가 ${durationText(timeoutMs)} 안에 끝나지 않아 중단했습니다${where}. 기존 데이터를 유지합니다.`);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([job, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// fetchAll: ({outDir, onProgress, signal}) => Promise<{items, characters, skills, meta}> — 네 파일은 fetchAll 이 outDir 에 쓴다(CLI 와 같은 직렬화).
// 받은 데이터를 확인하기 전에 기존 파일을 덮어쓰지 않도록 dataDir 안 임시 폴더에 받게 한 뒤, 확인되면 옮긴다.
// dataDir: 저장할 data 폴더. onProgress: 진행 이벤트 {stage, done, total, message}. timeoutMs: 전체 상한(기본 8분).
// skillsMode: 'patched'(기본, 패치노트 실험체만 재수집) | 'all'. 'patched' 의 병합 기준은 dataDir 의 기존 skills.json 이라
// staging 에 복사해 둔다(fetchAll 은 outDir/skills.json 을 먼저 읽는다).
// 반환 { count, savedPath, skills, meta } (savedPath 는 items.json).
async function updateAll(fetchAll, dataDir, { onProgress, timeoutMs = UPDATE_TIMEOUT_MS, skillsMode = 'patched' } = {}) {
  if (skillsMode !== 'patched' && skillsMode !== 'all') throw new Error(`알 수 없는 skillsMode: ${skillsMode}`);
  await fs.promises.mkdir(dataDir, { recursive: true });
  const staging = await fs.promises.mkdtemp(path.join(dataDir, '.update-'));
  try {
    await fs.promises.copyFile(path.join(dataDir, 'skills.json'), path.join(staging, 'skills.json')).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
    const { items, characters, skills, meta } =
      (await runWithTimeout(fetchAll, { outDir: staging, skillsMode }, onProgress, timeoutMs)) || {};
    checkData({ items, characters, skills });
    await installFiles(staging, dataDir);
    return { count: items.length, savedPath: path.join(dataDir, 'items.json'), skills, meta };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
}

// 기존 파일을 덮어쓰기 전에 받은 데이터를 확인한다.
function checkData({ items, characters, skills }) {
  if (!Array.isArray(items)) throw new Error('받은 아이템 데이터가 배열이 아닙니다.');
  if (items.length === 0) throw new Error('받은 아이템이 0개라 기존 데이터를 유지합니다.');
  if (!Array.isArray(characters) || characters.length === 0) throw new Error('받은 캐릭터가 0개라 기존 데이터를 유지합니다.');
  if (!Array.isArray(skills) || skills.length === 0) throw new Error('받은 스킬 데이터가 0개라 기존 데이터를 유지합니다.');
}

// staging 의 네 파일을 dataDir 로 옮긴다. 기존 파일을 staging/old 로 옮겨 두고 새 파일을 넣으며,
// 중간에 실패하면 넣은 파일을 되돌려 네 파일이 섞이지 않게 한다. dataDir 에 없던 파일은 건너뛴다.
async function installFiles(staging, dataDir) {
  for (const name of FILES) await fs.promises.access(path.join(staging, name));
  const backup = path.join(staging, 'old');
  await fs.promises.mkdir(backup);
  const done = [];
  try {
    for (const name of FILES) {
      const target = path.join(dataDir, name);
      const old = path.join(backup, name);
      const had = await fs.promises.rename(target, old).then(() => true, (err) => {
        if (err.code === 'ENOENT') return false;
        throw err;
      });
      done.push({ target, old, had });
      await fs.promises.rename(path.join(staging, name), target);
    }
  } catch (err) {
    for (const { target, old, had } of done.reverse()) {
      await fs.promises.rm(target, { force: true });
      if (had) await fs.promises.rename(old, target);
    }
    throw err;
  }
}

// GitHub 고정 릴리스 data-latest(.github/workflows/data-refresh.yml 이 매일 올림)의 자산 주소.
const DATA_RELEASE_URL = 'https://github.com/PueSeul/eternal-return-item-efficiency/releases/download/data-latest/';
const MANIFEST_NAME = 'data-manifest.json';
// 내려받기 전체 상한(manifest + 네 파일, 합계 약 1.6MB).
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// manifest: {generatedAt, sha256: {파일 이름: hex}, dakggVersion, patch}. 네 파일의 sha256 이 없으면 오류.
function parseManifest(buf) {
  let manifest;
  try {
    manifest = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error(`${MANIFEST_NAME}이 JSON이 아닙니다.`);
  }
  const sha = manifest && manifest.sha256;
  if (!sha || FILES.some((name) => !/^[0-9a-f]{64}$/.test(sha[name]))) {
    throw new Error(`${MANIFEST_NAME}에 네 파일의 sha256이 없습니다.`);
  }
  return manifest;
}

// 지금 프로그램이 읽는 파일(dirs 순서로 처음 있는 것, resolve.js 와 같은 우선순위)의 내용. 없으면 null.
async function readFirst(name, dirs) {
  for (const dir of dirs) {
    try {
      return await fs.promises.readFile(path.join(dir, name));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return null;
}

// "아이템 수치 업데이트" 기본 동작: data-latest 의 data-manifest.json 을 받아 지금 읽는 네 파일(dataDir, 없으면
// bundledDir)의 sha256 과 비교하고, 다르면 네 파일을 받아 sha256 을 확인한 뒤 dataDir 로 원자 교체한다(installFiles).
// fetchImpl: fetch 와 같은 함수(main.js 는 net.fetch). onProgress: {stage: 'manifest'|'download', done, total, message}.
// 반환 { count, savedPath, skills, meta, note? } — 이미 같으면 파일을 건드리지 않고 note 로 알린다.
async function downloadLatest(fetchImpl, dataDir, { onProgress, bundledDir, baseUrl = DATA_RELEASE_URL, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const progress = (stage, done, total, message) => {
    if (onProgress) onProgress({ stage, done, total, message });
  };
  const signal = AbortSignal.timeout(timeoutMs);
  const get = async (name) => {
    try {
      const res = await fetchImpl(baseUrl + name, { signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      const reason = signal.aborted ? `${durationText(timeoutMs)} 안에 끝나지 않음` : (err && err.message) || String(err);
      throw new Error(`${name} 받기 실패: ${reason}`);
    }
  };
  progress('manifest', 0, 1, '데이터 정보 확인(GitHub) 중');
  const manifest = parseManifest(await get(MANIFEST_NAME));
  progress('manifest', 1, 1, '데이터 정보 확인(GitHub) 완료');

  const dirs = bundledDir && path.resolve(bundledDir) !== path.resolve(dataDir) ? [dataDir, bundledDir] : [dataDir];
  const local = await Promise.all(FILES.map((name) => readFirst(name, dirs)));
  if (FILES.every((name, i) => local[i] && sha256(local[i]) === manifest.sha256[name])) {
    const [items, , skills, meta] = local.map((buf) => JSON.parse(buf.toString('utf8')));
    const itemsDir = dirs.find((dir) => fs.existsSync(path.join(dir, 'items.json')));
    return { count: items.length, savedPath: path.join(itemsDir, 'items.json'), skills, meta, upToDate: true,
      note: '변경 없음(이미 최신 데이터)' };
  }

  await fs.promises.mkdir(dataDir, { recursive: true });
  const staging = await fs.promises.mkdtemp(path.join(dataDir, '.update-'));
  try {
    const parsed = {};
    let done = 0;
    progress('download', 0, FILES.length, '데이터 내려받기(GitHub) 중');
    // allSettled: 하나가 실패해도 나머지 쓰기가 끝난 뒤 staging 을 지운다.
    const results = await Promise.allSettled(FILES.map(async (name) => {
      const buf = await get(name);
      if (sha256(buf) !== manifest.sha256[name]) throw new Error(`${name}의 sha256이 ${MANIFEST_NAME}과 다릅니다.`);
      try {
        parsed[name] = JSON.parse(buf.toString('utf8'));
      } catch {
        throw new Error(`${name}이 JSON이 아닙니다.`);
      }
      await fs.promises.writeFile(path.join(staging, name), buf);
      done += 1;
      progress('download', done, FILES.length, `데이터 내려받기(GitHub) 중: ${name}`);
    }));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    const items = parsed['items.json'];
    const skills = parsed['skills.json'];
    checkData({ items, characters: parsed['characters.json'], skills });
    await installFiles(staging, dataDir);
    return { count: items.length, savedPath: path.join(dataDir, 'items.json'), skills, meta: parsed['items.meta.json'] };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
}

// 기본 업데이트: download() 를 먼저 하고, 실패하면(GitHub 접근 실패·검증 실패) collect()(dak.gg·패치노트 직접 수집)로
// 폴백한다. 폴백은 진행 이벤트 'fallback' 과 결과 note 로 알리고, 폴백도 실패하면 두 원인을 함께 담아 reject.
async function updateLatest({ download, collect, onProgress }) {
  let reason;
  try {
    return await download();
  } catch (err) {
    reason = (err && err.message) || String(err);
  }
  if (onProgress) onProgress({ stage: 'fallback', done: 0, total: 1, message: `GitHub 데이터를 받지 못해 직접 수집합니다(${reason})` });
  let res;
  try {
    res = await collect();
  } catch (err) {
    throw new Error(`${(err && err.message) || String(err)} (GitHub 데이터도 받지 못함: ${reason})`, { cause: err });
  }
  return { ...res, note: `GitHub 데이터를 받지 못해 dak.gg·패치노트에서 직접 수집했습니다(${reason})` };
}

module.exports = { loadFetchAll, updateAll, downloadLatest, updateLatest, UPDATE_TIMEOUT_MS, DATA_RELEASE_URL, MANIFEST_NAME, FILES };
