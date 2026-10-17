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

  // 기준 가격 합 0일 때의 지표: 증가율 % = (현재 D ÷ 기준 D − 1) × 100(기준 D 0이면 null),
  // 1,000당 % = 증가율 ÷ 현재 가격 합 × 1000(현재 가격 합 0이면 null).
  function gainMetrics(curD, baseD, curPrice) {
    const gainPct = Number.isFinite(curD) && Number.isFinite(baseD) && baseD !== 0 ? (curD / baseD - 1) * 100 : null;
    const per1000 = gainPct != null && curPrice > 0 ? (gainPct / curPrice) * 1000 : null;
    return { gainPct, per1000 };
  }

  // 효율 지표(기준 세트 결과 base 대비, 항상 함께 계산):
  //   pct = 현재 가격당 데미지 ÷ 기준 가격당 데미지 × 100(기준 또는 현재 가격 합 0이면 null),
  //   gainPct·per1000 = gainMetrics. 기준 세트가 미완성(base 없음)이면 mode 'none', 모두 null.
  function efficiency(cur, base) {
    if (!base) return { mode: 'none', refRatio: null, baseD: null, pct: null, gainPct: null, per1000: null };
    const refRatio = base.price > 0 ? base.ratio : null;
    return { mode: 'baseline', refRatio, baseD: base.D, pct: percent(cur.ratio, refRatio), ...gainMetrics(cur.D, base.D, cur.price) };
  }

  const LABELS = { pct: '데미지 효율', gain: '기준 대비' };

  // 부호 붙은 % 소수 1자리("+47.4%", "−12.0%", "0.0%"). 없으면 '—'.
  function signedPct(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    // 절댓값을 반올림해 양·음 대칭(−6.25 → −6.3%).
    const s = Math.abs(v).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    if (s === '0.0') return '0.0%';
    return (v > 0 ? '+' : '−') + s + '%';
  }

  // 효율 % 표시: 소수 1자리 + '%'. 없으면 '—'.
  function pctText(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return value.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + '%';
  }

  // "1,000당 +41.0%"(없으면 "1,000당 —").
  const per1000Text = (v) => `1,000당 ${signedPct(v)}`;

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

  return { STORAGE_KEYS, storageKey, load, save, resolve, isComplete, snapshot, gainMetrics, efficiency, LABELS, signedPct, pctText, per1000Text, compareRows };
});
