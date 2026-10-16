// 데미지 효율 계산 기준 세트(5슬롯): 저장/복원과 기준 대비 효율 계산(브라우저/Node 테스트 공용).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERBaseline = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 계산식 변형마다 따로 저장한다.
  const STORAGE_KEYS = { v1: 'er-damage-calc-baseline-v1', v2: 'er-damage-calc-baseline-formula-v2' };
  const storageKey = (variant) => (variant === 'v2' ? STORAGE_KEYS.v2 : STORAGE_KEYS.v1);

  // 저장 형식: { 슬롯: { id, name } }. 깨진 값은 빈 기준.
  function load(storage, variant, slots) {
    try {
      const raw = JSON.parse(storage.getItem(storageKey(variant)) || '{}');
      const out = {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
      for (const slot of slots) {
        const v = raw[slot];
        if (v && typeof v === 'object' && v.id != null) out[slot] = { id: String(v.id), name: typeof v.name === 'string' ? v.name : '' };
      }
      return out;
    } catch {
      return {};
    }
  }

  // set: { 슬롯: item }
  function save(storage, variant, set, slots) {
    const out = {};
    for (const slot of slots) if (set[slot]) out[slot] = { id: String(set[slot].id), name: set[slot].name };
    storage.setItem(storageKey(variant), JSON.stringify(out));
  }

  // 저장된 { 슬롯: {id, name} }을 현재 데이터(byId)의 아이템으로 바꾼다. 없거나 부위가 다르면 missing.
  function resolve(saved, byId, slots) {
    const set = {};
    const missing = [];
    for (const slot of slots) {
      const v = saved && saved[slot];
      if (!v || v.id == null) continue;
      const item = byId.get(String(v.id));
      if (item && item.slot === slot) set[slot] = item;
      else missing.push(`${slot}(${v.name || v.id})`);
    }
    return { set, missing };
  }

  function isComplete(set, slots) {
    return slots.every((s) => set && set[s]);
  }

  // 히스토리 저장용 { ids, names } (채워진 슬롯만).
  function snapshot(set, slots) {
    const ids = {};
    const names = {};
    for (const slot of slots) {
      if (set && set[slot]) {
        ids[slot] = String(set[slot].id);
        names[slot] = set[slot].name;
      }
    }
    return { ids, names };
  }

  const percent = (ratio, ref) => (ratio == null || !ref ? null : (ratio / ref) * 100);

  // 효율: kind 'percent' = 효율 %, 'perPrice' = 가격당 추가 데미지. value가 그 값(없으면 null "—").
  // 기준 세트 결과(base)가 있으면 현재 가격당 데미지 ÷ 기준 가격당 데미지 × 100,
  // 기준 가격 합이 0이면 (현재 D − 기준 D) ÷ 현재 가격 합(현재 가격 합도 0이면 null),
  // 기준이 없으면(미완성) 히스토리 최고 비율(bestRatio) 대비 %.
  function efficiency(cur, base, bestRatio) {
    if (base && !(base.price > 0)) {
      const value = cur.price > 0 ? (cur.D - base.D) / cur.price : null;
      return { mode: 'baseline', kind: 'perPrice', refRatio: null, pct: null, value };
    }
    const refRatio = base ? base.ratio : bestRatio;
    const pct = percent(cur.ratio, refRatio);
    return { mode: base ? 'baseline' : 'history', kind: 'percent', refRatio, pct, value: pct };
  }

  const LABELS = { percent: '데미지 효율', perPrice: '가격당 추가 데미지' };

  // 효율 값 표시: % 는 소수 1자리 + '%', 가격당 추가 데미지는 소수 4자리. 없으면 '—'.
  function valueText(kind, value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    if (kind === 'perPrice') return value.toLocaleString('ko-KR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    return value.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + '%';
  }

  // 비교 표: 기준 / 현재 / 차이(현재 − 기준) × 가격 합 · 데미지 총량 · 가격당 데미지.
  function compareRows(cur, base) {
    const diff = (a, b) => (a == null || b == null ? null : a - b);
    const row = (label, r) => ({ label, price: r.price, D: r.D, ratio: r.ratio });
    return [
      row('기준', base),
      row('현재', cur),
      { label: '차이', price: diff(cur.price, base.price), D: diff(cur.D, base.D), ratio: diff(cur.ratio, base.ratio) },
    ];
  }

  return { STORAGE_KEYS, storageKey, load, save, resolve, isComplete, snapshot, efficiency, LABELS, valueText, compareRows };
});
