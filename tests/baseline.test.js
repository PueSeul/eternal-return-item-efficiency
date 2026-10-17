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

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('효율 지표: 기준 세트가 있으면 효율 %·기준 대비 증가율·1,000당을 항상 함께', () => {
  const cur = { D: 300, price: 1000, ratio: 0.3 };
  const base = { D: 200, price: 1000, ratio: 0.2 };
  const e = B.efficiency(cur, base);
  assert.equal(e.mode, 'baseline');
  assert.equal(e.refRatio, 0.2);
  assert.equal(e.baseD, 200);
  near(e.pct, 150); // 0.3 ÷ 0.2 × 100
  near(e.gainPct, 50); // (300 ÷ 200 − 1) × 100
  near(e.per1000, 50); // 50 ÷ 1000 × 1000
  // 호스트 예시: 현재 D = 기준 D × 1.474, 가격 1,155 → "+47.4%", "1,000당 +41.0%"
  const ex = B.efficiency({ D: 1.474 * 265, price: 1155, ratio: (1.474 * 265) / 1155 }, { D: 265, price: 1000, ratio: 0.265 });
  assert.equal(B.signedPct(ex.gainPct), '+47.4%');
  assert.equal(B.per1000Text(ex.per1000), '1,000당 +41.0%');
  // 실제 계산 결과로도: 같은 세트면 100%, +0.0%
  const r = F.calculate(items, inputs);
  const same = B.efficiency(r, F.calculate(items, inputs));
  near(same.pct, 100);
  assert.equal(B.signedPct(same.gainPct), '0.0%');
});

test('효율 지표: 기준 세트 미완성(결과 없음)이면 모두 null("—")', () => {
  const cur = { D: 300, price: 1000, ratio: 0.3 };
  const e = B.efficiency(cur, null);
  assert.deepEqual([e.mode, e.pct, e.gainPct, e.per1000, e.refRatio], ['none', null, null, null, null]);
  assert.equal(B.pctText(e.pct), '—');
  assert.equal(B.signedPct(e.gainPct), '—');
  assert.equal(B.per1000Text(e.per1000), '1,000당 —');
  const partial = { ...equipped };
  delete partial['팔'];
  assert.equal(B.isComplete(partial, SLOTS), false);
  assert.equal(B.isComplete(equipped, SLOTS), true);
  assert.equal(B.isComplete({}, SLOTS), false);
});

test('가격 0: 기준 가격 합 0이면 효율 % "—", 기준 대비·1,000당은 계산; 현재 가격 0이면 1,000당 "—"', () => {
  const e = B.efficiency({ D: 391.66, price: 1155, ratio: 391.66 / 1155 }, { D: 300, price: 0, ratio: null });
  assert.equal(e.mode, 'baseline');
  assert.equal(e.pct, null);
  assert.equal(B.pctText(e.pct), '—');
  near(e.gainPct, (391.66 / 300 - 1) * 100);
  near(e.per1000, ((391.66 / 300 - 1) * 100 / 1155) * 1000);
  assert.equal(B.signedPct(e.gainPct), '+30.6%');
  assert.equal(B.per1000Text(e.per1000), '1,000당 +26.5%');
  // 현재 D가 기준보다 작으면 −
  const down = B.efficiency({ D: 100, price: 1000, ratio: 0.1 }, { D: 200, price: 1000, ratio: 0.2 });
  assert.equal(B.signedPct(down.gainPct), '−50.0%');
  assert.equal(B.per1000Text(down.per1000), '1,000당 −50.0%');
  // 현재 가격 합 0 → 1,000당 "—"(증가율은 계산)
  const both0 = B.efficiency({ D: 400, price: 0, ratio: null }, { D: 300, price: 0, ratio: null });
  assert.equal(both0.pct, null);
  near(both0.gainPct, (400 / 300 - 1) * 100);
  assert.equal(both0.per1000, null);
  // 기준 D 0이면 기준 대비 "—"
  assert.equal(B.efficiency({ D: 10, price: 100, ratio: 0.1 }, { D: 0, price: 0, ratio: null }).gainPct, null);
  // 반올림은 양·음 대칭(−6.25 → −6.3%), 아주 작은 음수는 0.0%
  const m = B.gainMetrics(15, 16, 1000);
  assert.equal(B.signedPct(m.gainPct), '−6.3%');
  assert.equal(B.signedPct(6.25), '+6.3%');
  assert.equal(B.signedPct(-0.04), '0.0%');
  assert.match(E.lines(items, inputs, F.calculate(items, inputs), null, '기준 세트', { baseD: 16, ...m }).at(-1), /= −6\.3%$/);
  assert.equal(B.pctText(150), '150%');
  assert.deepEqual(B.LABELS, { pct: '데미지 효율', gain: '기준 대비' });
});

test('가격 0: 실제 계산 결과로 기준 가격 0 → 효율 % 없음·증가율 0, 현재 가격 0(기준 가격 있음) → 효율 %·1,000당 "—"', () => {
  const free = F.calculate(items.map((it) => ({ ...it, price: 0 })), inputs);
  const paid = F.calculate(items, inputs);
  assert.equal(free.ratio, null);
  const e = B.efficiency(paid, free);
  assert.equal(e.mode, 'baseline');
  assert.equal(e.pct, null);
  assert.equal(e.gainPct, 0); // 같은 스탯이라 증가 0
  assert.equal(e.per1000, 0);
  const back = B.efficiency(free, paid);
  assert.equal(back.pct, null);
  assert.equal(back.gainPct, 0);
  assert.equal(back.per1000, null);
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

test('히스토리: 기준 아이템 id·세 지표를 저장하고, 최고 효율순은 효율 % → 1,000당 → 값 없음 묶음', () => {
  const snap = B.snapshot(equipped, SLOTS);
  assert.deepEqual(snap.ids, { 무기: 'w1', 머리: 'h1', 옷: 'c1', 팔: 'a1', 다리: 'l1' });
  const r = F.calculate(items, inputs);
  const storage = memoryStorage();
  const mk = (eff, t) => H.makeEntry({ equipped, inputs, result: r, baseline: snap, efficiency: eff, now: new Date(t) });
  const a = mk({ mode: 'baseline', pct: 90, gainPct: 80, per1000: 8 }, '2026-10-16T01:00:00Z');
  const b = mk({ mode: 'baseline', pct: 120, gainPct: -5, per1000: -0.5 }, '2026-10-16T02:00:00Z');
  const z1 = mk({ mode: 'baseline', pct: null, gainPct: 30, per1000: 300 }, '2026-10-16T03:00:00Z'); // 기준 가격 0
  const z2 = mk({ mode: 'baseline', pct: null, gainPct: 10, per1000: 400 }, '2026-10-16T04:00:00Z');
  const gainOnly = mk({ mode: 'baseline', pct: null, gainPct: 10, per1000: null }, '2026-10-16T05:00:00Z'); // 현재 가격 0
  const none = mk(B.efficiency(r, null), '2026-10-16T06:00:00Z'); // 기준 미완성
  H.save(storage, [a, b, z1, z2, gainOnly, none]);
  const list = H.load(storage);
  const la = list.find((e) => e.id === a.id);
  assert.deepEqual(la.baselineIds, snap.ids);
  assert.deepEqual(la.baselineNames, snap.names);
  assert.deepEqual([la.efficiencyMode, la.efficiencyPct, la.efficiencyGainPct, la.efficiencyPer1000], ['baseline', 90, 80, 8]);
  assert.deepEqual(H.entryEfficiency(la), { pct: 90, gainPct: 80, per1000: 8 });
  assert.deepEqual(H.entryEfficiency(list.find((e) => e.id === none.id)), { pct: null, gainPct: null, per1000: null });
  // 효율 % 그룹(120, 90) → 1,000당 그룹(400, 300) → 값 없음(최근 먼저)
  assert.deepEqual(H.sorted(list, 'efficiency').map((e) => e.id), [b.id, a.id, z2.id, z1.id, none.id, gainOnly.id]);
  // 이전 계산식 기록은 저장값이 있어도 비교 제외
  assert.deepEqual(H.entryEfficiency({ ...b, formulaVersion: 'old' }), { pct: null, gainPct: null, per1000: null });
  // 기준·효율을 넘기지 않으면 필드 없음(하위 호환)
  const plain = H.makeEntry({ equipped, inputs, result: r });
  assert.equal('baselineIds' in plain, false);
  assert.equal('efficiencyPct' in plain, false);
});

test('히스토리: 예전 기록은 저장된 값으로 새 지표를 재계산, 불가능하면 "—"', () => {
  const r = F.calculate(items, inputs); // D, price 1000
  const v = H.FORMULA_VERSION;
  const old = (extra) => ({ id: 'x', formulaVersion: v, itemIds: {}, result: { D: r.D, price: r.price, ratio: r.ratio }, ...extra });
  // 기준 가격 0 시절의 '가격당 추가 데미지' v = (D − 기준 D) ÷ 가격 → 기준 D = D − v × 가격
  const baseD = r.D / 1.25;
  const pp = H.entryEfficiency(old({ efficiencyMode: 'baseline', efficiencyKind: 'perPrice', efficiencyPct: null, efficiencyPerPrice: (r.D - baseD) / r.price }));
  assert.equal(pp.pct, null);
  near(pp.gainPct, 25);
  near(pp.per1000, 25);
  assert.deepEqual(H.entryEfficiency(old({ efficiencyKind: 'perPrice', efficiencyPerPrice: null })), { pct: null, gainPct: null, per1000: null });
  // 기준 세트 대비 효율 % 기록: 효율 %는 그대로, 기준 가격 미저장이라 기준 대비는 "—"
  assert.deepEqual(H.entryEfficiency(old({ efficiencyMode: 'baseline', efficiencyKind: 'percent', efficiencyPct: 90 })), { pct: 90, gainPct: null, per1000: null });
  // 히스토리 최고 대비였던 기록·효율 미저장 기록: 기준이 없었으므로 "—"
  assert.deepEqual(H.entryEfficiency(old({ efficiencyMode: 'history', efficiencyKind: 'percent', efficiencyPct: 110 })), { pct: null, gainPct: null, per1000: null });
  assert.deepEqual(H.entryEfficiency(old({})), { pct: null, gainPct: null, per1000: null });
  // v2 기록도 같은 저장·정렬(NaN은 값 없음)
  const H2 = H.forVariant('v2');
  const mk2 = (pct, t) => H2.makeEntry({ equipped, inputs, result: r, efficiency: { mode: 'baseline', pct, gainPct: 0, per1000: 0 }, now: new Date(t) });
  const lo = mk2(80, '2026-10-16T01:00:00Z');
  const hi = mk2(110, '2026-10-16T02:00:00Z');
  const nan = mk2(NaN, '2026-10-16T03:00:00Z');
  assert.equal(nan.efficiencyPct, null);
  assert.deepEqual(H2.sorted([nan, lo, hi], 'efficiency').map((e) => e.id), [hi.id, lo.id, nan.id]);
});

test('계산 과정: 효율 줄 + 기준 대비·1,000당 산출 줄', () => {
  const r = F.calculate(items, inputs);
  const eff = B.efficiency(r, F.calculate(items, inputs));
  const out = E.lines(items, inputs, r, eff.refRatio, '기준 세트', eff);
  assert.match(out.at(-3), /→ 기준 세트 [\d.,]+ 대비 100%$/);
  assert.match(out.at(-2), /^기준 대비 = \(D [\d.]+ ÷ 기준 D [\d.]+ − 1\) × 100 = 0\.0%$/);
  assert.match(out.at(-1), /^1,000당 = 0\.0% ÷ 가격 합 1000 \(.+\) × 1000 = 0\.0%$/);
  // 예: 기준 D가 현재의 1/1.474, 가격 1000 → +47.4%, 1,000당 +47.4%
  const ex = E.lines(items, inputs, r, null, '기준 세트', { baseD: r.D / 1.474, gainPct: 47.4, per1000: 47.4 });
  assert.match(ex.at(-3), /→ 기준 가격 합 0 — 효율 % 계산 제외$/);
  assert.match(ex.at(-2), /= \+47\.4%$/);
  // 기준 미완성
  assert.equal(E.lines(items, inputs, r, null, '기준 세트', B.efficiency(r, null)).at(-1), '기준 세트 미완성 — 효율·기준 대비 계산 제외');
  // gain 생략(기준 세트 자체의 계산 과정)·기존 호출: 효율 줄만
  assert.match(E.lines(items, inputs, r, r.ratio).at(-1), /→ 최고 [\d.,]+ 대비 100%$/);
  assert.doesNotMatch(E.lines(items, inputs, r, null, '기준 세트').at(-1), /대비/);
});
