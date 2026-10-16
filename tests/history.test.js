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

test('가격 합 0: D는 정상 저장, 효율은 null이고 100% 기준·효율순 정렬에서 제외', () => {
  const free = items.map((it) => ({ ...it, price: 0 }));
  const inputs = { ...F.DEFAULT_INPUTS, skillDamage: 200, atkCoefPct: 0, defense: 80 };
  const result = F.calculate(free, inputs);
  assert.equal(result.price, 0);
  assert.equal(result.ratio, null);
  assert.ok(result.D >= 1 && Number.isFinite(result.D));
  assert.equal(F.efficiencyPercent(result.ratio, 0.5), null);

  const storage = memoryStorage();
  const zero = H.makeEntry({ equipped, inputs, result, now: new Date('2026-10-16T02:00:00Z') });
  const paid = H.makeEntry({ equipped, inputs, result: F.calculate(items, inputs), now: new Date('2026-10-16T01:00:00Z') });
  H.save(storage, H.add(H.add([], paid), zero));
  const list = H.load(storage);
  const loadedZero = list.find((e) => e.result.price === 0);
  assert.equal(loadedZero.result.D, result.D);
  assert.equal(loadedZero.result.ratio, null);
  assert.equal(H.bestRatio(list), paid.result.ratio); // 0 가격 기록은 기준에서 제외
  assert.equal(H.bestRatio([zero]), null);
  const byEff = H.sorted(list, 'efficiency');
  assert.equal(byEff[0].result.price, 1000); // 0 가격 기록은 순위 없이 맨 뒤
  assert.equal(byEff[byEff.length - 1].result.price, 0);
  assert.equal(H.sorted(list, 'recent')[0].result.price, 0); // 최근순에는 그대로 보임
});

test('기록 저장 후 다시 읽으면 구성·입력값·결과가 그대로', () => {
  const storage = memoryStorage();
  const inputs = { ...F.DEFAULT_INPUTS, skillDamage: 200, atkCoefPct: 0, defense: 80 };
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
  assert.equal(loaded.formulaVersion, H.FORMULA_VERSION);
  assert.equal(loaded.result.R, 80);
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
  const v = H.FORMULA_VERSION;
  const list = [{ formulaVersion: v, result: { ratio: 0.2 } }, { formulaVersion: v, result: { ratio: null } }, { formulaVersion: v, result: { ratio: 0.5 } }, {}];
  assert.equal(H.bestRatio(list), 0.5);
  // 이전 계산식 기록(버전 없음)은 비교 기준에서 제외
  assert.equal(H.bestRatio([...list, { result: { ratio: 9 } }]), 0.5);
  assert.equal(H.bestRatio([]), null);
});

test('sorted: 최근순은 시각 내림차순, 최고 효율순은 비율 내림차순(없음은 뒤, 동률은 최근 먼저)', () => {
  const e = (id, time, ratio, formulaVersion = H.FORMULA_VERSION) => ({ id, time, formulaVersion, itemIds: {}, result: { ratio } });
  const list = [e('a', '2026-10-16T01:00:00Z', 0.2), e('b', '2026-10-16T03:00:00Z', null),
    e('c', '2026-10-16T02:00:00Z', 0.5), e('d', '2026-10-16T04:00:00Z', 0.2), e('old', '2026-10-16T05:00:00Z', 9, null)];
  assert.deepEqual(H.sorted(list, 'recent').map((x) => x.id), ['old', 'd', 'b', 'c', 'a']);
  // 이전 계산식 기록은 비율이 커도 효율순 맨 뒤(비율 없음과 같은 취급, 동률은 최근 먼저)
  assert.deepEqual(H.sorted(list, 'efficiency').map((x) => x.id), ['c', 'd', 'a', 'old', 'b']);
  assert.deepEqual(list.map((x) => x.id), ['a', 'b', 'c', 'd', 'old']); // 원본은 그대로
});

test('slotItems: 기록의 id로 현재 데이터에서 아이템을 찾고, 없으면 저장된 이름으로 대체', () => {
  const byId = new Map(items.map((it) => [String(it.id), it]));
  const itemIds = {}; const itemNames = {};
  for (const it of items) { itemIds[it.slot] = it.id; itemNames[it.slot] = '옛이름'; }
  itemIds['다리'] = 'gone';
  delete itemIds['팔']; delete itemNames['팔'];
  const r = H.slotItems({ itemIds, itemNames }, F.SLOTS, byId);
  assert.deepEqual(r.map((x) => x.slot), F.SLOTS);
  const weapon = items.find((it) => it.slot === '무기');
  assert.deepEqual(r[0], { slot: '무기', id: String(weapon.id), found: true, name: weapon.name, imageUrl: weapon.imageUrl || null });
  const legs = r[F.SLOTS.indexOf('다리')];
  assert.deepEqual([legs.found, legs.name, legs.imageUrl], [false, '옛이름', null]);
  const arm = r[F.SLOTS.indexOf('팔')];
  assert.deepEqual([arm.found, arm.name, arm.id], [false, '?', null]);
});
