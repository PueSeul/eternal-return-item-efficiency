'use strict';
// 프로그램 안 "아이템 수치 업데이트": fetchItems() 결과를 data/items.json 에 저장한다.
// Electron 없이 테스트할 수 있도록 main.js 에서 분리.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// scripts/fetch_items.mjs (데이터 수집 담당 모듈)의 fetchItems 를 불러온다.
async function loadFetchItems(appRoot) {
  const mod = await import(pathToFileURL(path.join(appRoot, 'scripts', 'fetch_items.mjs')).href);
  if (typeof mod.fetchItems !== 'function') throw new Error('scripts/fetch_items.mjs에 fetchItems 함수가 없습니다.');
  return mod.fetchItems;
}

// fetchItems: () => Promise<배열>, dataDir: 저장할 data 폴더. 반환 { count, savedPath }.
// 받은 값이 비어 있거나 배열이 아니면 기존 파일을 건드리지 않고 오류.
async function updateItems(fetchItems, dataDir) {
  const items = await fetchItems();
  if (!Array.isArray(items)) throw new Error('받은 아이템 데이터가 배열이 아닙니다.');
  if (items.length === 0) throw new Error('받은 아이템이 0개라 기존 데이터를 유지합니다.');
  // scripts/fetch_items.py 와 같은 형식(UTF-8, 들여쓰기 2, LF, 끝 줄바꿈).
  const text = JSON.stringify(items, null, 2) + '\n';
  await fs.promises.mkdir(dataDir, { recursive: true });
  const savedPath = path.join(dataDir, 'items.json');
  // 쓰는 도중 실패해도 기존 파일이 깨지지 않도록 임시 파일에 쓴 뒤 교체한다.
  const tmp = `${savedPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, savedPath);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
  return { count: items.length, savedPath };
}

module.exports = { loadFetchItems, updateItems };
