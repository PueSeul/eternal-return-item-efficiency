'use strict';
// 프로그램 안 "아이템 수치 업데이트": fetchAll() 결과를 data/items.json·characters.json·items.meta.json 에 저장한다.
// Electron 없이 테스트할 수 있도록 main.js 에서 분리.
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

// fetchAll: ({outDir}) => Promise<{items, characters, skills, meta}> — 네 파일은 fetchAll 이 outDir 에 쓴다(CLI 와 같은 직렬화).
// 받은 데이터를 확인하기 전에 기존 파일을 덮어쓰지 않도록 dataDir 안 임시 폴더에 받게 한 뒤, 확인되면 옮긴다.
// dataDir: 저장할 data 폴더. 반환 { count, savedPath, skills, meta } (savedPath 는 items.json).
async function updateAll(fetchAll, dataDir) {
  await fs.promises.mkdir(dataDir, { recursive: true });
  const staging = await fs.promises.mkdtemp(path.join(dataDir, '.update-'));
  try {
    const { items, characters, skills, meta } = (await fetchAll({ outDir: staging })) || {};
    if (!Array.isArray(items)) throw new Error('받은 아이템 데이터가 배열이 아닙니다.');
    if (items.length === 0) throw new Error('받은 아이템이 0개라 기존 데이터를 유지합니다.');
    if (!Array.isArray(characters) || characters.length === 0) throw new Error('받은 캐릭터가 0개라 기존 데이터를 유지합니다.');
    if (!Array.isArray(skills) || skills.length === 0) throw new Error('받은 스킬 데이터가 0개라 기존 데이터를 유지합니다.');
    for (const name of FILES) await fs.promises.access(path.join(staging, name));
    // 기존 파일을 staging/old 로 옮겨 두고 새 파일을 넣는다. 중간에 실패하면 넣은 파일을 되돌려 네 파일이 섞이지 않게 한다.
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
    return { count: items.length, savedPath: path.join(dataDir, 'items.json'), skills, meta };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
}

module.exports = { loadFetchAll, updateAll };
