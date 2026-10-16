'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const B = require('../src/baseline');
const H = require('../src/history');
const F = require('../src/formula');
const E = require('../src/explain');
const items = require(path.join(__dirname, 'fixtures', 'items.sample.json'));

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

const SLOTS = F.SLOTS;
const equipped = Object.fromEntries(items.map((it) => [it.slot, it]));
const inputs = { ...F.DEFAULT_INPUTS, skillDamage: 200, atkCoefPct: 0, defense: 80 };

test('효율 %: 기준 세트가 있으면 현재 가격당 데미지 ÷ 기준 가격당 데미지 × 100', () => {
  const cur = { D: 300, price: 1000, ratio: 0.3 };
  const base = { D: 200, price: 1000, ratio: 0.2 };
  const e = B.efficiency(cur, base, 0.6);
  assert.equal(e.mode, 'baseline');
  assert.equal(e.refRatio, 0.2);
  assert.ok(Math.abs(e.pct - 150) < 1e-9); // 히스토리 최고(0.6)는 무시
  // 실제 계산 결과로도: 같은 세트면 100%
  const r = F.calculate(items, inputs);
  assert.ok(Math.abs(B.efficiency(r, F.calculate(items, inputs), null).pct - 100) < 1e-9);
});

test('효율 %: 기준 세트 미완성(결과 없음)이면 히스토리 최고 대비로 폴백', () => {
  const cur = { D: 300, price: 1000, ratio: 0.3 };
  const e = B.efficiency(cur, null, 0.6);
  assert.equal(e.mode, 'history');
  assert.equal(e.refRatio, 0.6);
  assert.ok(Math.abs(e.pct - 50) < 1e-9);
  assert.equal(B.efficiency(cur, null, null).pct, null);
  const partial = { ...equipped };
  delete partial['팔'];
  assert.equal(B.isComplete(partial, SLOTS), false);
  assert.equal(B.isComplete(equipped, SLOTS), true);
  assert.equal(B.isComplete({}, SLOTS), false);
});

test('가격 0: 기준 가격 합 0이면 가격당 추가 데미지 = (현재 D − 기준 D) ÷ 현재 가격 합', () => {
  const e = B.efficiency({ D: 391.66, price: 1155, ratio: 391.66 / 1155 }, { D: 300, price: 0, ratio: null }, 0.5);
  assert.equal(e.mode, 'baseline');
  assert.equal(e.kind, 'perPrice');
  assert.equal(e.pct, null);
  assert.ok(Math.abs(e.value - 91.66 / 1155) < 1e-12);
  assert.equal(B.LABELS[e.kind], '가격당 추가 데미지');
  assert.equal(B.valueText(e.kind, e.value), '0.0794');
  // 현재 D가 기준보다 작으면 음수
  assert.equal(B.valueText('perPrice', B.efficiency({ D: 100, price: 1000, ratio: 0.1 }, { D: 300, price: 0, ratio: null }).value), '-0.2000');
  // 현재 가격 합도 0이면 "—"
  const both0 = B.efficiency({ D: 400, price: 0, ratio: null }, { D: 300, price: 0, ratio: null }, 0.5);
  assert.equal(both0.kind, 'perPrice');
  assert.equal(both0.value, null);
  assert.equal(B.valueText(both0.kind, both0.value), '—');
  // 기준 가격이 0이 아니면 기존 % 식
  const pctEff = B.efficiency({ D: 300, price: 1000, ratio: 0.3 }, { D: 200, price: 1000, ratio: 0.2 });
  assert.equal(pctEff.kind, 'percent');
  assert.ok(Math.abs(pctEff.value - 150) < 1e-9);
  assert.equal(B.valueText('percent', 150), '150%');
  assert.equal(B.LABELS.percent, '데미지 효율');
});

test('가격 0: 실제 계산 결과로 기준 가격 0 → 가격당 추가 데미지, 현재 가격 0(기준 가격 있음) → "—"', () => {
  const free = F.calculate(items.map((it) => ({ ...it, price: 0 })), inputs);
  const paid = F.calculate(items, inputs);
  assert.equal(free.ratio, null);
  const e = B.efficiency(paid, free, 0.5);
  assert.equal(e.mode, 'baseline');
  assert.equal(e.kind, 'perPrice');
  assert.equal(e.value, 0); // 같은 스탯이라 추가 데미지 0
  const back = B.efficiency(free, paid, 0.5);
  assert.equal(back.kind, 'percent');
  assert.equal(back.pct, null);
  // 비교 표의 차이: 가격·데미지는 계산, 가격당 데미지는 한쪽이 없으면 null
  const rows = B.compareRows(paid, free);
  assert.deepEqual(rows.map((x) => x.label), ['기준', '현재', '차이']);
  assert.equal(rows[2].price, 1000);
  assert.equal(rows[2].D, 0);
  assert.equal(rows[2].ratio, null);
});

test('compareRows: 기준 / 현재 / 차이(현재 − 기준)', () => {
  const rows = B.compareRows({ D: 300, price: 1500, ratio: 0.2 }, { D: 200, price: 1000, ratio: 0.2 });
  assert.deepEqual(rows[0], { label: '기준', price: 1000, D: 200, ratio: 0.2 });
  assert.deepEqual(rows[1], { label: '현재', price: 1500, D: 300, ratio: 0.2 });
  assert.deepEqual(rows[2], { label: '차이', price: 500, D: 100, ratio: 0 });
});

test('기준 세트 저장/복원: v1·v2 키 분리, 깨진 값은 빈 기준, 데이터에 없는 아이템은 missing', () => {
  const storage = memoryStorage();
  B.save(storage, 'v1', equipped, SLOTS);
  assert.notEqual(B.storageKey('v1'), B.storageKey('v2'));
  assert.deepEqual(B.load(storage, 'v2', SLOTS), {});
  const saved = B.load(storage, 'v1', SLOTS);
  assert.deepEqual(Object.keys(saved), SLOTS);
  const byId = new Map(items.map((it) => [String(it.id), it]));
  const { set, missing } = B.resolve(saved, byId, SLOTS);
  assert.ok(B.isComplete(set, SLOTS));
  assert.equal(set['무기'], equipped['무기']);
  assert.deepEqual(missing, []);
  // 데이터에서 사라진 아이템, 다른 부위 id
  saved['다리'] = { id: 'gone', name: '옛 신발' };
  saved['팔'] = { id: equipped['무기'].id, name: 'x' };
  const r2 = B.resolve(saved, byId, SLOTS);
  assert.deepEqual(r2.missing, ['팔(x)', '다리(옛 신발)']);
  assert.equal(B.isComplete(r2.set, SLOTS), false);
  storage.setItem(B.storageKey('v1'), '{not json');
  assert.deepEqual(B.load(storage, 'v1', SLOTS), {});
  storage.setItem(B.storageKey('v1'), JSON.stringify({ 무기: null, 머리: { name: 'id 없음' }, 옷: { id: 5 } }));
  assert.deepEqual(B.load(storage, 'v1', SLOTS), { 옷: { id: '5', name: '' } });
});

test('히스토리: 기준 아이템 id·효율 %를 저장하고, 최고 효율순은 저장된 효율 %로 정렬', () => {
  const snap = B.snapshot(equipped, SLOTS);
  assert.deepEqual(snap.ids, { 무기: 'w1', 머리: 'h1', 옷: 'c1', 팔: 'a1', 다리: 'l1' });
  const r = F.calculate(items, inputs);
  const storage = memoryStorage();
  const mk = (pct, mode, t, ratio) => H.makeEntry({ equipped, inputs, result: { ...r, ratio }, baseline: snap,
    efficiency: { pct, mode }, now: new Date(t) });
  // 비율은 a가 가장 크지만 저장된 효율 %는 b가 가장 크다 → 효율순은 저장 % 기준
  const a = mk(90, 'baseline', '2026-10-16T01:00:00Z', 0.9);
  const b = mk(120, 'baseline', '2026-10-16T02:00:00Z', 0.1);
  const c = mk(null, 'baseline', '2026-10-16T03:00:00Z', 0.5); // 기준 가격 0 → "—", 맨 뒤
  const legacy = { ...mk(0, 'history', '2026-10-16T04:00:00Z', 0.45) };
  delete legacy.efficiencyPct; delete legacy.efficiencyMode; delete legacy.baselineIds; // 효율 % 저장 전 기록
  H.save(storage, [a, b, c, legacy]);
  const list = H.load(storage);
  const la = list.find((e) => e.id === a.id);
  assert.deepEqual(la.baselineIds, snap.ids);
  assert.deepEqual(la.baselineNames, snap.names);
  assert.equal(la.efficiencyPct, 90);
  assert.equal(la.efficiencyMode, 'baseline');
  // 예전 기록은 현재 최고 비율(0.9) 대비 50%
  assert.equal(H.entryPercent(list.find((e) => e.id === legacy.id), H.bestRatio(list)), 50);
  assert.equal(H.entryPercent(list.find((e) => e.id === c.id), 0.9), null);
  assert.deepEqual(H.sorted(list, 'efficiency').map((e) => e.id), [b.id, a.id, legacy.id, c.id]);
  // 이전 계산식 기록은 저장 %가 있어도 비교 제외
  assert.equal(H.entryPercent({ ...b, formulaVersion: 'old' }, 0.9), null);
  // 기준·효율을 넘기지 않으면 필드 없음(하위 호환)
  const plain = H.makeEntry({ equipped, inputs, result: r });
  assert.equal('baselineIds' in plain, false);
  assert.equal('efficiencyPct' in plain, false);
});

test('히스토리: 가격당 추가 데미지 기록은 방식을 저장하고, 최고 효율순은 같은 방식끼리 비교', () => {
  const snap = B.snapshot(equipped, SLOTS);
  const r = F.calculate(items, inputs);
  const storage = memoryStorage();
  const mk = (eff, t) => H.makeEntry({ equipped, inputs, result: r, baseline: snap, efficiency: eff, now: new Date(t) });
  const pctA = mk({ mode: 'baseline', kind: 'percent', pct: 90, value: 90 }, '2026-10-16T01:00:00Z');
  const pctB = mk({ mode: 'history', kind: 'percent', pct: 110, value: 110 }, '2026-10-16T02:00:00Z');
  const ppA = mk({ mode: 'baseline', kind: 'perPrice', pct: null, value: 0.0794 }, '2026-10-16T03:00:00Z');
  const ppB = mk({ mode: 'baseline', kind: 'perPrice', pct: null, value: 0.5 }, '2026-10-16T04:00:00Z');
  const ppNone = mk({ mode: 'baseline', kind: 'perPrice', pct: null, value: null }, '2026-10-16T05:00:00Z');
  const pctNone = mk({ mode: 'baseline', kind: 'percent', pct: null, value: null }, '2026-10-16T06:00:00Z');
  const legacy = mk({ mode: 'baseline', pct: 100 }, '2026-10-16T07:00:00Z'); // kind 없는 예전 호출 → %
  delete legacy.efficiencyKind; // 방식 표시 전 기록
  H.save(storage, [pctA, pctB, ppA, ppB, ppNone, pctNone, legacy]);
  const list = H.load(storage);
  const get = (x) => list.find((e) => e.id === x.id);
  assert.equal(get(ppA).efficiencyKind, 'perPrice');
  assert.equal(get(ppA).efficiencyPerPrice, 0.0794);
  assert.equal(get(ppA).efficiencyPct, null);
  assert.equal(get(pctA).efficiencyKind, 'percent');
  assert.equal('efficiencyPerPrice' in get(pctA), false);
  assert.deepEqual(H.entryEfficiency(get(ppA), 1), { kind: 'perPrice', value: 0.0794 });
  assert.deepEqual(H.entryEfficiency(get(legacy), 1), { kind: 'percent', value: 100 });
  assert.deepEqual(H.entryEfficiency({ ...get(ppB), formulaVersion: 'old' }, 1), { kind: 'perPrice', value: null });
  // 가격당 추가 데미지 0.5가 % 값들보다 수치는 작아도 섞지 않는다: % 그룹 → 가격당 그룹 → 값 없음(최근 먼저)
  assert.deepEqual(H.sorted(list, 'efficiency').map((e) => e.id),
    [pctB.id, legacy.id, pctA.id, ppB.id, ppA.id, pctNone.id, ppNone.id]);
  // v2 기록도 같은 방식 저장·정렬(음수는 양수 뒤, NaN은 값 없음)
  const H2 = H.forVariant('v2');
  const mk2 = (value, t) => H2.makeEntry({ equipped, inputs, result: r, efficiency: { mode: 'baseline', kind: 'perPrice', pct: null, value }, now: new Date(t) });
  const neg = mk2(-0.2, '2026-10-16T01:00:00Z');
  const pos = mk2(0.1, '2026-10-16T02:00:00Z');
  const nan = mk2(NaN, '2026-10-16T03:00:00Z');
  assert.equal(nan.efficiencyPerPrice, null);
  assert.deepEqual(H2.entryEfficiency(neg, null), { kind: 'perPrice', value: -0.2 });
  assert.deepEqual(H2.sorted([nan, neg, pos], 'efficiency').map((e) => e.id), [pos.id, neg.id, nan.id]);
});

test('계산 과정의 효율 줄: 기준 세트 대비 표기', () => {
  const r = F.calculate(items, inputs);
  const last = (refRatio, label) => E.lines(items, inputs, r, refRatio, label).at(-1);
  assert.match(last(r.ratio, '기준 세트'), /→ 기준 세트 [\d.,]+ 대비 100%$/);
  assert.match(last(r.ratio), /→ 최고 [\d.,]+ 대비 100%$/);
  assert.doesNotMatch(last(null, '기준 세트'), /대비/);
});
