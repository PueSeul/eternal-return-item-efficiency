'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const H = require('../src/history');
const F = require('../src/formula');
const items = require(path.join(__dirname, 'fixtures', 'items.sample.json'));

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

const equipped = Object.fromEntries(items.map((it) => [it.slot, it]));

test('기록 저장 후 다시 읽으면 구성·입력값·결과가 그대로', () => {
  const storage = memoryStorage();
  const inputs = { ...F.DEFAULT_INPUTS, defense: 80 };
  const result = F.calculate(items, inputs);
  const entry = H.makeEntry({ equipped, inputs, result, now: new Date('2026-10-16T00:00:00Z') });
  H.save(storage, H.add([], entry));
  const [loaded] = H.load(storage);
  assert.equal(loaded.time, '2026-10-16T00:00:00.000Z');
  assert.deepEqual(loaded.itemIds, { 무기: 'w1', 머리: 'h1', 옷: 'c1', 팔: 'a1', 다리: 'l1' });
  assert.equal(loaded.itemNames['무기'], '테스트 검');
  assert.deepEqual(loaded.inputs, inputs);
  assert.equal(loaded.result.D, result.D);
  assert.equal(loaded.result.price, 1000);
});

test('손상된 저장값은 빈 배열', () => {
  const storage = memoryStorage();
  storage.setItem(H.STORAGE_KEY, '{not json');
  assert.deepEqual(H.load(storage), []);
  storage.setItem(H.STORAGE_KEY, '{"a":1}');
  assert.deepEqual(H.load(storage), []);
  const good = { id: 'x', itemIds: {}, result: { D: 1 } };
  storage.setItem(H.STORAGE_KEY, JSON.stringify([null, {}, 3, { id: 'y', result: null, itemIds: {} }, good]));
  assert.deepEqual(H.load(storage), [good]);
});

test('add는 최신을 앞에, 최대 개수 유지 / remove', () => {
  let list = [];
  for (let i = 0; i < H.MAX_ENTRIES + 3; i++) list = H.add(list, { id: String(i), result: { ratio: i } });
  assert.equal(list.length, H.MAX_ENTRIES);
  assert.equal(list[0].id, String(H.MAX_ENTRIES + 2));
  list = H.remove(list, list[0].id);
  assert.equal(list.length, H.MAX_ENTRIES - 1);
});

test('bestRatio는 null 비율을 무시하고 최고치 반환', () => {
  const list = [{ result: { ratio: 0.2 } }, { result: { ratio: null } }, { result: { ratio: 0.5 } }, {}];
  assert.equal(H.bestRatio(list), 0.5);
  assert.equal(H.bestRatio([]), null);
});
