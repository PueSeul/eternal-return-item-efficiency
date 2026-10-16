'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { updateAll, loadFetchAll } = require('./update');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'er-update-test-'));
}

// fetchAll 흉내: outDir 에 세 파일을 쓰고 결과를 반환.
function fakeFetchAll(result) {
  return async ({ outDir }) => {
    fs.writeFileSync(path.join(outDir, 'items.json'), JSON.stringify(result.items));
    fs.writeFileSync(path.join(outDir, 'characters.json'), JSON.stringify(result.characters));
    fs.writeFileSync(path.join(outDir, 'items.meta.json'), JSON.stringify(result.meta));
    return result;
  };
}

test('updateAll moves the three files into dataDir and returns count/savedPath/meta', async () => {
  const root = tmpDir();
  const dataDir = path.join(root, 'data');
  const meta = { patch: { version: '1.2' } };
  const result = { items: [{ id: '1', name: '카른웬난' }, { id: '2' }], characters: [{ id: 'c' }], meta };
  const res = await updateAll(fakeFetchAll(result), dataDir);
  assert.deepStrictEqual(res, { count: 2, savedPath: path.join(dataDir, 'items.json'), meta });
  assert.deepStrictEqual(fs.readdirSync(dataDir).sort(), ['characters.json', 'items.json', 'items.meta.json']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(res.savedPath, 'utf8')), result.items);
  fs.rmSync(root, { recursive: true, force: true });
});

test('updateAll keeps existing files on fetch failure or empty/bad result', async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'items.json'), '[{"id":"old"}]\n');
  await assert.rejects(updateAll(async () => { throw new Error('network down'); }, root), /network down/);
  await assert.rejects(updateAll(async () => ({}), root), /배열이 아닙니다/);
  await assert.rejects(updateAll(fakeFetchAll({ items: [], characters: [{}], meta: {} }), root), /아이템이 0개/);
  await assert.rejects(updateAll(fakeFetchAll({ items: [{}], characters: [], meta: {} }), root), /캐릭터가 0개/);
  assert.deepStrictEqual(fs.readdirSync(root), ['items.json']);
  assert.strictEqual(fs.readFileSync(path.join(root, 'items.json'), 'utf8'), '[{"id":"old"}]\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadFetchAll imports scripts/fetch_items.mjs from appRoot', async () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'fetch_items.mjs'), 'export async function fetchAll() { return { items: [{ id: "x" }] }; }\n');
  const fetchAll = await loadFetchAll(root);
  assert.deepStrictEqual(await fetchAll(), { items: [{ id: 'x' }] });
  const root2 = tmpDir();
  fs.mkdirSync(path.join(root2, 'scripts'));
  fs.writeFileSync(path.join(root2, 'scripts', 'fetch_items.mjs'), 'export const other = 1;\n');
  await assert.rejects(loadFetchAll(root2), /fetchAll 함수가 없습니다/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(root2, { recursive: true, force: true });
});
