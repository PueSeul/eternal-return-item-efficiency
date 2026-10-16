'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { updateItems, loadFetchItems } = require('./update');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'er-update-test-'));
}

test('updateItems writes UTF-8 JSON to dataDir/items.json and returns count/savedPath', async () => {
  const root = tmpDir();
  const dataDir = path.join(root, 'data');
  const items = [{ id: '1', name: '카른웬난', stats: { 공격력: 58 } }, { id: '2', name: '검' }];
  const res = await updateItems(async () => items, dataDir);
  assert.deepStrictEqual(res, { count: 2, savedPath: path.join(dataDir, 'items.json') });
  const text = fs.readFileSync(res.savedPath, 'utf8');
  assert.deepStrictEqual(JSON.parse(text), items);
  assert.ok(text.includes('카른웬난'));
  assert.ok(text.endsWith(']\n'));
  assert.deepStrictEqual(fs.readdirSync(dataDir), ['items.json']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('updateItems keeps existing file when fetch fails or returns bad data', async () => {
  const root = tmpDir();
  const file = path.join(root, 'items.json');
  fs.writeFileSync(file, '[{"id":"old"}]\n');
  await assert.rejects(updateItems(async () => { throw new Error('network down'); }, root), /network down/);
  await assert.rejects(updateItems(async () => ({}), root), /배열이 아닙니다/);
  await assert.rejects(updateItems(async () => [], root), /0개/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '[{"id":"old"}]\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadFetchItems imports scripts/fetch_items.mjs from appRoot', async () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'fetch_items.mjs'), 'export async function fetchItems() { return [{ id: "x" }]; }\n');
  const fetchItems = await loadFetchItems(root);
  assert.deepStrictEqual(await fetchItems(), [{ id: 'x' }]);
  const root2 = tmpDir();
  fs.mkdirSync(path.join(root2, 'scripts'));
  fs.writeFileSync(path.join(root2, 'scripts', 'fetch_items.mjs'), 'export const other = 1;\n');
  await assert.rejects(loadFetchItems(root2), /fetchItems 함수가 없습니다/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(root2, { recursive: true, force: true });
});
